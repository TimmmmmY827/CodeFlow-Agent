# C08 ToolRuntime

- 状态：输入校验、权限、hash、执行、JSON 边界和 Artifact 外置基础已实现；toolVersion、outputSchema、timeout、预算/事件持久化和故障恢复缺失
- 目标阶段：D3–D4
- 代码位置：`src/tools/tool-runtime.ts`
- 硬依赖：[C00](00-shared-contracts.md)、[C01](01-event-state.md)、[C02](02-storage-artifacts.md)、[C03](03-permission-engine.md)、[C04](04-budget-controller.md)、[C07](07-tool-registry.md)
- 下游消费者：C09、C11、C14、C15

## 1. 目标

作为所有工具调用的唯一执行入口，按固定顺序完成 schema 校验、操作身份计算、权限、预算/取消边界、执行、输出限制、错误归一化和 trace 生命周期，防止各工具重复或绕过安全逻辑。

## 2. 职责边界

### 必须负责

- 从 Registry 取定义，校验输入，计算 operation hash。
- 调 PermissionEngine 并消费匹配批准。
- 建 ToolExecutionContext，执行工具并遵守 AbortSignal/timeout。
- 输出统一 ToolResultEnvelope；长结果写 ArtifactStore。
- 根据 sideEffect/retry policy 产生 failed/cancelled/unknown。
- 通过持久化 execution journal 写入权威 started/finished 事实；observer 只用于非权威通知。

### 明确不负责

- 决定调用哪个工具、与用户交互批准、实现具体工具或自动对账外部状态。

## 3. 执行流水线

### 3.1 当前可编译流水线

```text
lookup -> validate input -> canonical operation hash -> cancellation check
 -> legacy permission adapter -> check/consume in-memory approval -> emit started
 -> execute -> JSON serialization boundary -> inline or ArtifactStore
 -> emit finished -> return envelope
```

当前 Runtime 尚未接 budget reservation、per-tool timeout、outputSchema 或持久化 event；observer/ArtifactStore 失败后的证据恢复也未完成。C03 已提供完整 OperationBinding、持久审批 repository 和 SQLite 消费原语，C04 已提供 `SqliteBudgetLedger.reserveWithinTransaction/commitWithinTransaction` 等同步事务原语，但当前 Runtime 尚未组装，仍使用显式 legacy hash/permission 入口与进程内消费；该入口不得被新调用方采用。

### 3.2 目标流水线（规划中）

```text
lookup
 -> validate input
 -> normalize input + transformation ledger
 -> allocate operation ID / compute versioned operation hash
 -> permission decision
 -> acquire resource/workspace lock
 -> journal.begin transaction:
      commit fence(snapshot/config/tool/approval/cancel/idempotency)
      + consume approval
      + reserve budget
      + persist operation=started
      + append tool.started
 -> require durable begin acknowledgement
 -> execute with timeout
 -> validate output
 -> inline or ArtifactStore
 -> classify side effect
 -> journal.finish transaction: settle budget + operation terminal + append finished
 -> return envelope
```

目标顺序是安全契约。Runtime 是工具生命周期事件的唯一写入者，Loop 不得再写一份 `tool.started/completed/failed`。`journal.begin` 由 C08 定义端口、C02 提供 SQLite adapter；只有它返回 durable acknowledgement 后才能调用 `execute`。对于 workspace write，资源锁从 commit fence 前一直持有到 finish，避免 started 落盘后代码版本立即漂移。

```ts
interface PreparedToolOperation<I> {
  sessionId: StableId;
  runId: StableId;
  spanId: StableId;
  toolCallId: StableId;
  operationId: StableId;        // 一次逻辑操作的稳定身份
  attempt: number;
  tool: ToolContractIdentity;
  requestedInputHash: string;
  effectiveInput: I;            // 仅运行时持有
  effectiveInputHash: string;
  transformations: InputTransformation[];
  operationHash: string;        // 批准/版本绑定，不作为数据库主键
  resourceClaims: ResourceClaim[];
  snapshot: CodeSnapshot;
  idempotencyKey: string;
}

interface DurableToolExecutionJournal {
  begin(operation: PreparedToolOperation<unknown>, approvalId: StableId | null):
    Promise<{ startedEventId: StableId; reservationId: StableId }>;
  finish(result: ToolResultEnvelope<unknown>): Promise<{ finishedEventId: StableId }>;
  requestCancellation(operationId: StableId, at: UtcTimestamp): Promise<void>;
}

type DurableToolOperationState =
  | "prepared"
  | "started"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown"
  | "compensated";
```

`operationId` 跨恢复保持不变，attempt 每次安全重试递增；`operationHash` 随有效参数或绑定版本变化。外部操作的 idempotency key 绑定 caller、tool version、业务对象和 effective input，不得只使用随机 request ID。

合法状态转换为 `prepared -> started -> succeeded|failed|cancelled|unknown`，`started -> cancel_requested -> cancelled|succeeded|failed|unknown`，以及 `unknown -> succeeded|failed|compensated|unknown`（只允许可信对账推动）。终态结果晚到时只能追加 reconciliation 事实，不能覆盖历史记录。

journal 只能写 C01 已登记的事件：succeeded 映射 `tool.completed`；failed/cancelled 映射带结构化 error/cancellation context 的 `tool.failed`；unknown 追加 `operation.unknown`。不得为内部 state 发明 `tool.cancelled`、`tool.succeeded` 等新事件名。

## 4. 结果信封

### 4.1 当前可编译基线

当前 `ToolResultEnvelope` 没有 `toolVersion`；Runtime 只验证输出可 JSON 序列化，没有 `outputSchema`。默认 inline 上限和 Artifact 外置已实现，但 per-tool timeout、环境 allowlist、预算 reservation、持久化批准消费与事件 writer 尚未接入。

```ts
interface ToolResultEnvelope {
  toolName: string;
  operationHash: string;
  status: "completed" | "failed" | "approval_required" |
          "denied" | "cancelled" | "unknown";
  durationMs: number;
  sideEffectStatus: SideEffectStatus;
  output: JsonValue | null;
  artifact: ArtifactReference | null;
  error: StructuredError | null;
}
```

journal adapter 必须通过 C02 `SqliteStorageDatabase.runImmediateTransaction()` 在任何业务读取前取得 IMMEDIATE 写锁，再调用 C03 `consumeWithinTransaction` 和 C04 `reserveWithinTransaction`，随后写 operation 与 `tool.started` 并统一提交；finish/fail 则调用 C04 `commitWithinTransaction`（已开始，即使 usage 缺失也保守结算），只有明确未开始才允许 `releaseWithinTransaction`。这些方法都是同步事务片段，事务体不得跨 `await`；普通 DEFERRED transaction 不被接受。

### 4.2 目标接口（规划中）

```ts
interface ToolResultEnvelope<O = unknown> {
  sessionId: StableId;
  runId: StableId;
  spanId: StableId;
  toolCallId: StableId;
  operationId: StableId;
  attempt: number;
  toolName: string;
  toolVersion: string;
  operationHash: string;
  status: "completed" | "failed" | "approval_required" |
          "denied" | "cancelled" | "unknown";
  durationMs: number;
  sideEffectStatus: "none" | "not_started" | "applied" | "unknown" | "compensated";
  outputValidation: "valid" | "invalid" | "not_available";
  output: O | null;
  artifact: ArtifactReference | null;
  error: StructuredError | null;
}
```

## 5. 功能需求

- `RUNTIME-FR-001`：未知工具和非法输入不得进入权限或 execute。
- `RUNTIME-FR-002`：output 必须通过 output schema；失败保留原始结果为敏感 Artifact 供诊断，不传模型。
- `RUNTIME-FR-003`：每个工具有默认 timeout 和最大 inline bytes，配置可按工具收紧。
- `RUNTIME-FR-004`：stdout/stderr、网页和 diff 超限时写 Artifact，context 只含摘要、hash、大小和引用。
- `RUNTIME-FR-005`：调用 started/finished 必须带相同 operation hash/span。
- `RUNTIME-FR-006`：无副作用工具失败按 retry policy 返回 retryable；可能已写的工具失败返回 `unknown` 或 `applied`，不得自动标 safe retry。
- `RUNTIME-FR-007`：批准 required/denied 不调用 execute，不计为实际工具副作用。
- `RUNTIME-FR-008`：取消发生在执行前返回 not_started；执行中写工具的取消可能返回 unknown。
- `RUNTIME-FR-009`：observer、ArtifactStore 或事件写入失败不得让已经发生的副作用被描述为未发生。
- `RUNTIME-FR-010`：Runtime 不把环境变量全集传给子进程；按工具 allowlist 构造环境。
- `RUNTIME-FR-011`：requested/effective 参数分别计算 hash，所有默认值和规范化进入 transformation ledger；权限、预算、执行和批准只使用 effective 参数。
- `RUNTIME-FR-012`：`accepted`、`started/executed`、`output verified` 是不同事实；只有 output schema 通过且 finish 事件已持久化才返回 `completed`。
- `RUNTIME-FR-013`：取消请求先持久化为 `CANCEL_REQUESTED`；只有执行明确未开始或已终止且副作用可判定时才记录 `CANCELLED`，否则进入 `UNKNOWN`。
- `RUNTIME-FR-014`：journal/ArtifactStore 在副作用后失败时不得返回 completed；Runtime 返回 unknown 或 evidence-pending 结构化错误，并保留当前进程可用的 operation/provider identity 供恢复对账。

## 6. 错误与恢复矩阵

| side effect | 执行前失败 | 执行中失败/断连 | 重试 |
| --- | --- | --- | --- |
| none | failed/none | failed/none | policy=safe 时有界重试 |
| workspace_write | failed/not_started | unknown 或 applied | 先检查 codeVersion/diff |
| external_write | failed/not_started | unknown | Provider 对账后决定 |

## 7. 并发

- 默认串行执行模型返回的多个 tool call。
- 只有 Registry 标记为 `none + safe` 且路径/资源集合互不冲突的只读调用可并行。
- 并行前由 C04 原子预留预算；事件仍通过 C01 单写者排序。
- 写工具同一 workspace 互斥。

## 8. 安全要求

- `RUNTIME-SR-001`：任何工具都不能绕过 Registry/Permission/Budget/事件入口直接被 Loop 调用。
- `RUNTIME-SR-002`：工作区路径在 execute 前和文件打开后都校验，防止 symlink/junction TOCTOU。
- `RUNTIME-SR-003`：错误 message、输出和 observer 事件经过秘密处理。
- `RUNTIME-SR-004`：批准 token 不传给工具实现，仅由 Runtime 消费。

## 9. 验收标准

Provider 可抛出只携带 `StructuredError` 的 `ToolExecutionError`；Runtime 必须保留其稳定 category、retryable 与 side-effect status，禁止把工作区边界、编码或 provider availability 错误压扁成通用异常。该错误不携带 SDK/CLI 原生类型。

- `RUNTIME-AC-001`：流水线每一阶段的失败都不执行后续阶段。
- `RUNTIME-AC-002`：参数重排 hash 稳定；参数或 codeVersion 改变使批准失效。
- `RUNTIME-AC-003`：同一批准第二次使用被拒绝。
- `RUNTIME-AC-004`：长结果正确外置，缺 ArtifactStore 时安全失败不静默截断。
- `RUNTIME-AC-005`：外部写在响应丢失 fixture 中返回 unknown/retryable=false。
- `RUNTIME-AC-006`：取消、timeout、observer 失败和 ArtifactStore 失败的副作用状态准确。
- `RUNTIME-AC-007`：18 个工具契约测试都只能通过 Runtime 执行。
- `RUNTIME-AC-008`：未收到 durable begin acknowledgement 时每类工具的 execute 次数均为零。
- `RUNTIME-AC-009`：requested 参数经默认值/路径规范化后，批准 hash 只绑定 effective 参数且 transformation ledger 可重放。
- `RUNTIME-AC-010`：取消请求、晚到成功结果和 finish 落库失败的组合不会把已应用副作用标为 cancelled/not_started。

## 10. 实现任务建议

1. 补 tool version/output schema 和稳定错误类型。
2. 接持久化批准消费、事件 writer 和 Budget reservation。
3. 增加 timeout、环境 allowlist 和输出摘要器。
4. 增加路径/资源冲突描述和安全只读并行。
5. 用每类副作用工具做故障注入和对账测试。
