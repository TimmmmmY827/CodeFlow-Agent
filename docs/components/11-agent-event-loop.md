# C11 AgentEventLoop

- 状态：只有 `createSession`；真实循环缺失
- 目标阶段：D3–D4，D5–D7 接入 UI/持久化
- 代码位置：`src/agent/agent-event-loop.ts`
- 硬依赖：[C01](01-event-state.md)、[C02](02-storage-artifacts.md)、[C03](03-permission-engine.md)、[C04](04-budget-controller.md)、[C05](05-model-adapter.md)、[C06](06-context-assembler.md)、[C08](08-tool-runtime.md)、[C09](09-built-in-tools.md)、[C10](10-completion-gate.md)
- 下游消费者：C12、C13、C14、C15

## 1. 目标

驱动模型—工具—观察—重规划循环，在每个模型、工具、批准、预算、取消和完成边界产生事实事件。循环只规定安全与生命周期，不规定“修 Bug 第一步必须做什么”等 Coding 策略。

## 2. 职责边界

### 必须负责

- Session/Task 生命周期、循环调度和 sequence/span 关联。
- 调 C06 组上下文、C05 调模型、C08 执行工具。
- 处理 tool calls、工具结果、计划更新、ask/approval/finish 控制结果。
- 在每个边界检查取消、预算和终态。
- 暂停、恢复、失败、UNKNOWN 和 CompletionGate 接线。

### 明确不负责

- 直接读写文件、解析供应商 SSE、展示 Ink UI、实现数据库或硬编码语言工作流。
- 展示/保存原始 chain-of-thought 作为用户解释。

## 3. 前置依赖门

| 依赖 | 最低可用条件 | 未满足时 Loop 只能做什么 |
| --- | --- | --- |
| C01/C02 | 生命周期、持久化事件 writer、reducer 和恢复查询稳定 | 创建内存 Session |
| C03/C04 | 权限和 reserve/commit 预算 API | 不得执行工具/模型 |
| C05 | 非流式文本/tool call/usage 契约通过 fixtures；一次调用仅一个 provider attempt | 不得进入 Issue #7 的最小真实模型循环 |
| C06 | ContextManifest 和溢出策略 | 不得发送项目上下文 |
| C08/C09 | Runtime + 六只读工具 | 只允许解释固定输入 |
| C10 | finish_task/Gate 事件链 | 不得宣称 verified completion |

## 4. 循环伪代码

当前 `AgentEventLoop` 只实现 `createSession` 并追加 `session.created`；下列循环是 C11 目标调度语义（规划中），不是当前可调用实现。

```ts
while (!terminal) {
  assertNotCancelled();
  const context = await contextAssembler.assemble(state);
  const modelCall = await modelJournal.begin({
    contextManifest: context.manifest,
    reservation: "model-call upper bound",
    event: "model.started"
  }); // reservation + model.started 同事务并持久化确认
  const modelResult = await model.generate({ ...context, signal, deadlineAt });
  await modelJournal.finish(modelCall, modelResult); // usage 结算 + model.completed

  publishVisiblePlanAndSummary(modelResult);

  if (modelResult.toolCalls.length > 0) {
    for (const call of scheduleSafely(modelResult.toolCalls)) {
      assertNotCancelled();
      const result = await toolRuntime.execute(call); // C08 持久化 tool lifecycle
      appendTranscriptObservation(result);            // 仅模型 transcript 投影
      if (result.status === "approval_required" || result.status === "unknown") pause();
    }
    continue;
  }

  if (modelRequestedUserInput) pauseWaitingUser();
  else if (completionVerified) terminal = true;
  else if (noProgressOrNoAction) requestReplanOrStop();
}
```

伪代码表达调度边界，不限制模型对代码任务的具体探索方案。

### 4.1 单步调度接口

```ts
interface AdvanceRequest {
  sessionId: StableId;
  expectedLastSequence: number;
  trigger: "start" | "model_event" | "tool_result" | "user_answer" |
           "approval_decision" | "reconcile_result" | "resume";
  triggerId: StableId;
}

interface AdvanceResult {
  sessionId: StableId;
  lastSequence: number;
  lifecycle: SessionLifecycle;
  disposition: "continue" | "waiting" | "terminal" | "blocked";
  pendingRequestId: StableId | null;
}

interface DurableModelCallJournal {
  begin(input: ModelCallStart): Promise<ModelCallLease>;
  finish(lease: ModelCallLease, result: CollectedModelResult): Promise<StableId>;
  fail(lease: ModelCallLease, error: StructuredError, partialUsage: UsageRecord | null):
    Promise<StableId>;
}
```

`advance()` 是唯一调度入口；同一 trigger ID 幂等。一次调用最多启动一个新的模型调用或一个工具 operation，返回前必须把由该步产生的事实落盘。Loop 是 Session 的单写调度者，但工具 started/finished 由 C08 journal 权威写入，Loop 只消费结果并更新 transcript/下一步，不能重复追加工具生命周期事件。

`DurableModelCallJournal.begin` 在一个 C02 事务中预留 C04 预算并追加 `model.started`，返回的 lease 包含 C05 所需 run/step/span/modelCall/attempt 身份。只有 begin 持久化确认后才允许发送模型网络请求；finish/fail 结算 usage 并追加唯一 `model.completed`。

实现时 begin/finish 必须由 C02 `runImmediateTransaction()` 承载并使用 C04 `reserveWithinTransaction/commitWithinTransaction`，而不是先调用独立异步 ledger 再写事件。provider 缺失 usage 时，先按版本化本地 pricing table 计算费用；仍无法计价则 commit `costStatus = unknown` 并暂停新付费调用。完全缺失 usage 时 commit 传 `actual = null`，由 ledger 以完整 reservation 生成 `usageBasis = conservative` 和 `reconciliationRequired = true`；不得 release 已经发送的模型调用。恢复时先调用 `listOpenReservations`，用 started/operation journal 判定 settle/release，不能因进程内 lease 丢失让预算永久悬挂。每个重试使用同一 operationId、递增 attempt、独立幂等键，并把 operationHash/副作用状态写入 retry evidence；`UNKNOWN` 直接阻断自动重试。

## 5. 功能需求

- `LOOP-FR-001`：每次模型周期分配 step ID；模型、tool call 和结果通过 span/call ID 关联。
- `LOOP-FR-002`：模型返回多个工具时默认串行；只读无冲突工具经 C08 证明后才并行。
- `LOOP-FR-003`：每个完整工具结果作为下一轮 observation，本地 transcript 是事实源。
- `LOOP-FR-004`：计划和决策摘要来自显式输出，不展示 reasoning 原文。
- `LOOP-FR-005`：approval_required 进入 WAITING_APPROVAL；用户答复或拒绝后从同一 operation 继续/重规划。
- `LOOP-FR-006`：ask_user 进入 WAITING_USER；恢复时不重复问题。
- `LOOP-FR-007`：finish_task 进入 COMPLETION_CLAIMED，经 C10 产生 verified/rejected。
- `LOOP-FR-008`：任何 `unknown` 停止自动循环，调用对应 Provider 的只读对账路径。
- `LOOP-FR-009`：取消后 2 秒内停止新模型/工具调用，并向运行中工具传播 signal。
- `LOOP-FR-010`：达到预算、无进展或协议错误时暂停而不是伪造失败/成功。
- `LOOP-FR-011`：恢复由事件重放重建，不从内存闭包或 UI 文本恢复。
- `LOOP-FR-012`：每轮捕获 config/tool/model/code version；变化触发上下文重建和旧批准失效。
- `LOOP-FR-013`：ask/approval 请求使用稳定 request ID 和 resume token；相同 trigger/reply 重放只产生一次状态转换。
- `LOOP-FR-014`：Runtime 的晚到结果按 operation ID 与 attempt 关联；旧 attempt 结果不得覆盖新 attempt，已终态 Session 收到晚到副作用结果时必须追加安全事实并重新进入 UNKNOWN/FAILED，而不是丢弃。
- `LOOP-FR-015`：Runtime/Adapter 只翻译错误和给出 retry advice；是否重试由 Loop 单点决定并经 C04 reservation/no-progress 门，避免组件嵌套重试。
- `LOOP-FR-016`：RuntimeEventLog 是事实源，ModelTranscriptProjection 只从已持久化事件生成；合成占位、摘要和 UI 文本不得反向成为事实。

## 6. 调度状态

```text
idle
 -> assembling_context
 -> calling_model
 -> applying_model_events
 -> executing_tools
 -> recording_observations
 -> checking_completion
 -> next_step / waiting / terminal
```

调度状态可作为内部字段，用户生命周期仍使用 C01 状态机。

## 7. 错误与恢复策略

| 来源 | 分类 | Loop 行为 |
| --- | --- | --- |
| Context | overflow | checkpoint 后重试一次 |
| Model | retryable | 模型策略默认最多 2 次，且不得超过 C04 `maxRetriesPerOperation` |
| Model | invalid tool call | 写观察并要求模型重规划 |
| Runtime | approval_required | WAITING_APPROVAL |
| Runtime | denied | 写观察，不自动重复请求 |
| Runtime | failed safe | 按策略有限重试或重规划 |
| Runtime | unknown | 停止并对账 |
| Gate | rejected | RUNNING，提供缺失证据 |
| Storage | write failed | 停止新副作用，保留当前进程证据 |
| Cancel | requested | CANCELLING → CANCELLED/UNKNOWN |

模型和工具的 retry owner 均为 Loop；Adapter/Provider 不在内部再次发起完整业务调用。仅允许 Provider 在尚未发送请求体、尚未收到任何响应且协议明确幂等时做透明连接重建，并必须向 Loop 报告 attempt。

## 8. 并发与取消

- 单 Session 单调度器；MVP 不运行多个 Agent actor。
- 并行调用必须有资源集合和预算预留，完成事件仍串行写入。
- 取消检查点：开始组上下文、模型请求前/流中、每个工具前/执行中、重试前、完成门前。
- 子进程终止失败时不能直接标 CANCELLED，应记录残留并进入 FAILED/UNKNOWN。

## 9. 事件与可观测性

每步至少产生：plan/budget、`model.started`/`model.completed`、tool started/completed/failed、approval/user wait、verification、completion 和取消事件。模型失败/取消写入 `model.completed` 的结构化 operation/error context；不得发明 C01 目录之外的 `model.failed` 或 `step` 事件。UI 当前状态必须能从事件投影，不依赖 Loop 私有变量。

## 10. 安全要求

- `LOOP-SR-001`：只通过 ModelAdapter 和 ToolRuntime 访问外部能力。
- `LOOP-SR-002`：模型文本不能直接修改权限、预算、状态或事件历史。
- `LOOP-SR-003`：未持久化 started 事件前不开始外部副作用。
- `LOOP-SR-004`：关键事件落库失败后停止新副作用。
- `LOOP-SR-005`：不得以超预算、取消或工具失败为由跳过 CompletionGate。
- `LOOP-SR-006`：每次外部调用前执行 safe-point；C08 commit fence 负责在持锁状态下再次核验 code/config/tool/approval/cancel/idempotency，Loop 不能用较早快照替代。
- `LOOP-SR-007`：CompletionGateContext 必须从可信 repository/provider 组装；模型提交的 CompletionIntent 不能成为 trace、安全或验证事实源。

## 11. 验收标准

- `LOOP-AC-001`：固定模型 fixtures 能完成“读取两个文件并解释”的多轮只读 trace。
- `LOOP-AC-002`：模型返回非法参数后 Runtime 拒绝，下一轮模型收到结构化观察并重规划。
- `LOOP-AC-003`：approval/user wait 可跨进程恢复且不重复副作用。
- `LOOP-AC-004`：外部写 unknown fixture 不发生第二次写，先执行对账。
- `LOOP-AC-005`：取消门槛达到 2 秒/5 秒要求。
- `LOOP-AC-006`：预算、无进展、上下文溢出和模型断流均产生可定位首错 trace。
- `LOOP-AC-007`：finish_task rejected 后继续修复，verified 后无新模型/工具调用。
- `LOOP-AC-008`：Loop 代码中不存在按 TypeScript/Python/Go 分支的固定解题步骤。
- `LOOP-AC-009`：相同 advance trigger、用户回答和批准决策重复投递不会追加重复事实或执行第二次副作用。
- `LOOP-AC-010`：在模型 started、tool journal.begin、execute 返回和 finish 事务各切点杀进程，恢复不会盲重试未知副作用。
- `LOOP-AC-011`：Adapter 报告两次 retryable failure 时总业务 attempt 不超过 Loop 配置上限，不发生 Adapter×Loop 嵌套倍增。

## 12. 实现任务建议

1. 定义 LoopDependencies、LoopState 与单步 `advance()`。
2. 用 ScriptedModelAdapter 接只读 ToolRuntime 做确定性循环。
3. 接计划/用户/审批/预算/取消事件。
4. 接 CompletionGate 与 UNKNOWN reconciliation。
5. 接真实 DeepSeek Adapter。
6. 增加崩溃恢复、无进展和并行只读测试。

### Issue #7 首个可运行纵向切片

`runReadonlySession()` 只装配 C09 已冻结的六个只读工具。首轮强制至少一次 tool call，后续轮次允许模型给出最终答复；每个模型/工具 operation 均先通过 `SqliteExecutionJournal.begin()` 在同一事务预留 C04 预算并写 started fact，完成后以实际 usage/cost 同事务结算并写 terminal fact。模型 Adapter 保持单次业务尝试且禁用 SDK 自动重试。当前切片串行执行并把完整工具 envelope 投影回 transcript，不记录 reasoning 原文。

模型 journal 的每条 finish 路径都必须把持久化失败归一化为 `model_journal_finish_failed`，并在 storage 仍可写时追加 `session.failed`；即使该 terminal fact 也因存储故障无法落盘，Loop 仍只能返回结构化失败并停止新调用，不能让原始异常逃逸后继续执行。

DeepSeek 本地价格表版本为 `deepseek-pricing:2026-08-15`，来源是官方 Models & Pricing 页面；未知模型在网络调用前 fail-closed。provider usage 无法按可信价格核对时，用完整 reservation 保守结算并终止 Session，禁止继续付费调用。

完成判断不是模型权威：循环先写 verification facts，检查 C01 trace integrity、至少一个成功只读工具证据，再由 C10 对当前 codeVersion/diffHash 快照验收，最后才写 `completion.claimed -> completion.verified`。确定性 E2E 覆盖完整 replay；真实 DeepSeek 验收仅在显式 `RUN_DEEPSEEK_LIVE=1` 且环境提供 key 时运行，不进入默认 CI。

仍延期：完整 `advance(trigger)` 幂等恢复、approval/user wait、写工具、UNKNOWN reconciliation、no-progress/retry policy、跨进程恢复与 C06 完整 context manifest。特别是进程在 durable begin 后、finish 前崩溃时，会留下 started fact 与 open reservation；当前切片不会自动释放或重试，后续恢复入口必须通过 `listOpenReservations` 与 operation journal 对账后保守 settle/reconcile。上述能力不得由本切片的内存 transcript 冒充完成。
