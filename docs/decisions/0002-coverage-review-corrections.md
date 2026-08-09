# ADR-0002：覆盖度审查后的契约修正

- 状态：接受
- 日期：2026-08-09

## 背景

首次框架覆盖度审查确认 D1 骨架的依赖方向正确，但指出两项已实现契约偏离蓝图：生命周期缺少等待用户和完成声明状态；审计关键字段集中在自由 `payload`。审查同时指出 `ToolRuntime` 与 `CompletionGate` 尚不存在。

## 决策

1. `SessionLifecycle` 增加 `WAITING_USER` 与 `COMPLETION_CLAIMED`，完成声明只能通过 `completion.verified` 进入 `COMPLETION_VERIFIED`。
2. 每条 `AgentEvent` 强制携带结构化 `context`，覆盖版本、操作、用量、授权、错误和副作用状态。
3. 提前建立可测试的 `ToolRuntime`：统一完成输入校验、operation hash、权限判断、一次性批准消费、取消、执行、结果信封和长输出外置。
4. 提前建立 `CompletionGate` 和 `finish_task` 工具工厂：完成声明绑定代码版本、diff、验证证据、未验证项、trace 完整性和安全否决项。
5. SQLite 基础 schema 增加对应审计列，避免结构化字段持久化后重新退回不透明 JSON。

## 保持延后的范围

本决策不把阶段性缺口伪装成已实现。模型 tool calling 和 SSE 属于 D2；真实 Agent 循环和只读工具属于 D3；写工具与完成链路接通属于 D4；Ink/HITL、搜索/GitHub、SQLite 实现和评估 fixtures 继续分别属于 D5–D8。

## 后果

- 后续循环、工具和 UI 可以依赖稳定的事件与完成契约，减少返工。
- `ToolRuntime` 当前没有注册完整工具目录，也没有默认持久化 ArtifactStore；组件存在不等于端到端 Agent 已可运行。
- `finish_task` 已有工具契约，但必须注入真实代码快照提供器并由事件循环处理验证结果后才构成完整完成门。
