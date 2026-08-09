# C13 CLI/TUI、实时任务树与 HITL

- 状态：Commander 命令和静态 Ink 组件骨架
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

脚本友好模式使用 `--json`/NDJSON，不输出 ANSI；交互模式使用 Ink。

## 4. 实时视图

至少展示：

- Session ID、目标、workspace、生命周期。
- 当前计划和 revision，当前步骤突出。
- 模型/工具调用树：名称、状态、耗时、重试、错误。
- 读取/修改文件、diff 摘要和 codeVersion。
- 验证证据与 `COMPLETION_CLAIMED`/`VERIFIED` 区别。
- token、费用、工具次数、时间和剩余预算。
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

## 6. HITL 状态

```text
RUNNING
  -> WAITING_USER      普通信息不足
  -> WAITING_APPROVAL  高风险最终操作
  -> UNKNOWN           外部真实状态需对账
```

三者交互必须不同：普通回答不能充当批准；批准界面不能用于外部状态对账。

## 7. 退出码建议

| code | 含义 |
| --- | --- |
| 0 | 命令完成/任务 verified |
| 1 | 任务 failed 或验证未通过 |
| 2 | 参数/配置错误 |
| 3 | 需要用户输入且当前模式不可交互 |
| 4 | 用户取消 |
| 5 | 外部状态 unknown/需对账 |

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

## 10. 实现任务建议

1. 定义 ViewModel，只接受 reducer/session handle 输出。
2. 实现非交互 NDJSON renderer，先固定语义。
3. 实现 Ink task tree、预算和错误面板。
4. 实现 ask/approval/cancel/unknown 对账交互。
5. 接 Session list/resume/trace/export。
6. 做终端 snapshot、延迟、控制字符和用户任务测试。
