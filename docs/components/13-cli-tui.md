# C13 CLI/TUI、实时任务树与 HITL

- 状态：Commander 命令骨架 + Issue #7 最简实时 Ink 任务树；命令接线与 HITL 交互仍待开发
- 目标阶段：D5，Session 命令随 D7 完善
- 代码位置：`src/cli/`
- 硬依赖：[C01](01-event-state.md)、[C03](03-permission-engine.md)、[C04](04-budget-controller.md)、[C11](11-agent-event-loop.md)、[C12](12-application-service.md)、[C14](14-session-trace.md)
- 下游消费者：用户、C15

## 1. 目标

让用户实时理解 Agent 当前目标、计划、模型/工具调用关系、文件变更、验证、预算和首次错误，并能安全回答问题、批准/拒绝高风险操作、取消和恢复。

## 2. 职责边界

### 必须负责

- 命令解析、TTY/非 TTY 输出和稳定退出码。
- 从 StateReducer 投影实时任务树，不维护另一套事实状态。
- 用户输入、批准摘要、拒绝、取消和恢复交互。
- Trace 查看、Session 管理、配置检查和 Eval 入口。
- 屏幕刷新节流、可访问性和日志模式。

### 明确不负责

- 决定工具权限、任务完成、Coding 策略或解析 SDK 响应。
- 显示原始 reasoning/chain-of-thought。

## 3. 命令契约

当前 Commander 已注册这些命令名称，但除 `run --prompt` 创建内存 Session 和 `config` 显示基础配置外，其余命令只输出骨架提示；下表描述目标行为（规划中）。

| 命令 | 输入 | 成功输出 | 主要依赖 |
| --- | --- | --- | --- |
| `codeflow run [workspace]` | goal、验收、预算、授权 | Session UI/ID | C12/C11 |
| `resume <session>` | Session ID | 恢复 UI | C14/C12 |
| `sessions` | filter/json | 摘要列表 | C14 |
| `trace <session>` | format/redaction | 事件树/导出 | C14 |
| `config` | check/set/show | 脱敏配置 | C12 |
| `eval` | suite/filter/baseline | run/report | C15 |

脚本友好模式使用 `--json`/NDJSON，不输出 ANSI；交互模式使用 Ink。NDJSON 的 stdout 只允许出现下述版本化记录，诊断日志写 stderr：

```ts
interface CliRecord {
  schemaVersion: 1;
  kind: "session" | "event" | "prompt" | "approval" | "result" | "error";
  emittedAt: UtcTimestamp;
  sessionId: StableId | null;
  sequence: number | null;
  requestId: StableId | null;
  data: JsonValue;
}
```

消费者必须忽略同主版本新增的未知可选字段，并拒绝未知主版本。`event` 记录中的 sequence 可作为恢复游标；普通日志、spinner、进度字符和 ANSI 永不混入 stdout。

## 4. 实时视图

### 4.1 Issue #7 已交付切片

当前 `SessionTaskTreeProjector` 逐条接收 C01 `AgentEvent`，并以同一个 `StateReducer` 作为生命周期、计划、验证和预算的语义权威；额外的操作树只保存事件已经公开的模型/工具名称、span、状态、耗时和结构化错误，不读取或展示 reasoning 原文。

`LiveSessionTaskTree` 只依赖与 C12 `SessionHandle.streamEvents({afterSequence, signal})` 同形的 `SessionEventSource`。一个组件实例固定绑定一个逻辑 Session；上层即使重建等价 source 对象也不会导致断流重放，切换 Session 必须更换 React `key` 以显式重建投影器。它从 sequence `-1` 请求完整 replay-then-tail 流，不在 CLI 内组合 `list()` 与 `subscribe()`。相同 event ID 与完全相同内容的重复投递为幂等；event ID 或 sequence 冲突、operation hash 多候选以及 trace gap 会停止视图并显示安全错误，而不是猜测状态。

最简 Ink 视图已经展示 Session/目标/workspace/生命周期、计划 revision、模型与工具树、验证、预算、UNKNOWN 对账状态和首次错误。所有动态文本在进入 Ink 前转义终端控制字符，并按当前宽度截断。当前流失败会 fail-closed 并提示恢复；带退避、取消和 last-sequence 游标的自动重连仍随生产 `run/resume` 组合延期。完整 `run/resume` 命令接线、文件/diff 面板、NDJSON、ask/approval/cancel 输入和 C14 Session 管理仍按后续切片推进。

至少展示：

- Session ID、目标、workspace、生命周期。
- 当前计划和 revision，当前步骤突出。
- 模型/工具调用树：名称、状态、耗时、重试、错误。
- 读取/修改文件、diff 摘要和 codeVersion。
- 验证证据与 `COMPLETION_CLAIMED`/`VERIFIED` 区别。
- 直接从 C01 `SessionView.budget` 的 C04 `BudgetSnapshot` 展示 committed/reserved、八维上限与剩余量，以及持久化的 `limitStatus/limitDimensions`；费用同时显示 known/partial/unknown，unknown 不得格式化成 `$0`。活动时间与等待时间分列，并按 `countWaitingTime` 说明哪个值计入硬限。存在 open reservation 时显示恢复中/未结算，不把 reserved 当作已消费或可用余额。
- WAITING_USER、WAITING_APPROVAL、UNKNOWN、取消状态。

默认折叠成功的低价值细节，保留首次错误和所有安全事件。用户可展开 Artifact。

## 5. 功能需求

- `CLI-FR-001`：事件到屏幕的 P95 延迟不超过 1 秒。
- `CLI-FR-002`：刷新不得阻塞事件写入、模型流或取消处理。
- `CLI-FR-003`：批准界面显示固定工具名、最终参数摘要、code/diff version、remote/path、过期时间和风险。
- `CLI-FR-004`：批准前若绑定字段变化，界面废弃旧请求并展示原因。
- `CLI-FR-005`：Ctrl+C 第一次请求优雅取消，第二次可强制终止 UI，但仍显示副作用未知警告。
- `CLI-FR-006`：非 TTY 模式遇到需要用户/批准时退出特定码或按显式 policy 处理，不能默认批准。
- `CLI-FR-007`：恢复后 UI 先重放历史，再订阅新事件，不能丢失交界事件。
- `CLI-FR-008`：Trace 视图能跳到首次错误、首次偏离和相关 parent span。
- `CLI-FR-009`：所有命令提供 `--help`，无效参数不创建 Session。
- `CLI-FR-010`：UI 使用计划、动作和决策摘要解释行为，不展示 reasoning item 原文。
- `CLI-FR-011`：ask/approval 输出稳定 request ID；答复必须显式引用该 ID，已解决、过期或绑定已变化的请求返回稳定错误，不能作用于“当前看起来最像”的请求。
- `CLI-FR-012`：`config set` 只接受非秘密字段；credential 只能通过环境变量或系统凭证引用配置，CLI 不把秘密写入配置文件、shell history 建议或导出。
- `CLI-FR-013`：非 TTY 默认在需要输入/批准时输出一条 prompt/approval 记录并以 code 3 退出；显式 policy 只能自动拒绝或读取绑定 request ID 的预先决策，禁止 blanket auto-approve。

## 6. HITL 状态

```text
RUNNING
  -> WAITING_USER      普通信息不足
  -> WAITING_APPROVAL  高风险最终操作
  -> UNKNOWN           外部真实状态需对账
```

三者交互必须不同：普通回答不能充当批准；批准界面不能用于外部状态对账。

## 7. 稳定退出码

| code | 含义 |
| --- | --- |
| 0 | 命令完成/任务 verified |
| 1 | 任务 failed 或验证未通过 |
| 2 | 参数/配置错误 |
| 3 | 需要用户输入且当前模式不可交互 |
| 4 | 用户取消 |
| 5 | 外部状态 unknown/需对账 |
| 6 | 存储、Provider 或其他基础设施故障，任务结果未确定 |

退出码属于脚本兼容契约，同一主版本不得改变含义。若命令成功生成 Session 但任务仍在等待，非交互模式按等待原因返回 3 或 5，而不是 0。

## 7.1 Replay 与订阅交界

CLI 只调用 C12 `SessionHandle.streamEvents({afterSequence})` 或 C14 等价查询，不自行实现“先 list、后 subscribe”。Application/EventStore 必须提供单一逻辑游标保证交界无遗漏；CLI 对重复 event ID/sequence 做幂等呈现，并在断连时从最后已渲染 sequence 继续。

## 8. 安全与隐私

- `CLI-SR-001`：默认输出和历史不显示 Key、token、原始 reasoning 和敏感 Artifact 内容。
- `CLI-SR-002`：复制/导出批准摘要不包含批准 token。
- `CLI-SR-003`：终端宽度、ANSI 和控制字符经过转义，工具输出不能注入 UI 控制。
- `CLI-SR-004`：非交互模式永不使用“yes by default”。

## 9. 验收标准

- `CLI-AC-001`：Scripted Loop 的全部生命周期在 Ink snapshot 中正确呈现。
- `CLI-AC-002`：用户在 30 秒内能从失败 trace 定位首次错误。
- `CLI-AC-003`：批准参数变化后旧批准按钮/输入无效。
- `CLI-AC-004`：TTY、重定向、Windows Terminal 和窄终端模式正常。
- `CLI-AC-005`：取消达到 2 秒停止新调用、5 秒终止可控进程。
- `CLI-AC-006`：JSON 模式可由脚本解析且不混入日志/ANSI。
- `CLI-AC-007`：UX 评估“理解当前状态”和“定位失败”至少比 OpenCode 高 1 分。
- `CLI-AC-008`：NDJSON golden tests 固定 schema、stdout/stderr 分离、控制字符转义和全部退出码。
- `CLI-AC-009`：历史重放与实时事件在每个 sequence 交界注入并发事件时均无遗漏；重复投递不会重复显示副作用。
- `CLI-AC-010`：非 TTY、过期 request ID 和预先拒绝 policy 的测试证明不存在默认批准路径。

当前 Issue #7 切片以 `tests/session-task-tree.test.ts` 固定以下证据：完整 model/tool/verification 生命周期的 ViewModel 与 Ink snapshot、重复/冲突事件、C12 形状流消费、UNKNOWN 对账、首次错误保留，以及窄终端和控制字符转义。该证据覆盖 `CLI-AC-001` 的最简实时树范围和 `CLI-SR-003`；其余验收项保持未完成，不以占位实现计入。

## 10. 实现任务建议

1. 定义 ViewModel，只接受 reducer/session handle 输出。
2. 实现非交互 NDJSON renderer，先固定语义。
3. 实现 Ink task tree、预算和错误面板。
4. 实现 ask/approval/cancel/unknown 对账交互。
5. 接 Session list/resume/trace/export。
6. 做终端 snapshot、延迟、控制字符和用户任务测试。
