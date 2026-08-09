# ADR-0003：可信事实与持久副作用边界

- 状态：接受
- 日期：2026-08-09
- 修正：[ADR-0002](0002-coverage-review-corrections.md) 中把模型 CompletionClaim 直接携带 trace/safety 事实的边界

## 背景

覆盖度审查后的首版 `CompletionClaim` 允许模型提交 `traceComplete`、验证结果和安全否决。首版 ToolRuntime 也只通过 observer 发出 started/finished，不能证明 started 已持久化后才执行副作用。这两种设计都把不可信声明或易丢失通知放到了安全决策路径上。

## 决策

1. 模型、仓库和网页内容只能提交意图、摘要和事实引用，不能成为权限、预算、trace 完整性、安全否决、验证通过或外部副作用状态的权威来源。
2. CompletionGate 接收模型 `CompletionIntent` 与系统组装的 `CompletionGateContext`。后者从事件、Artifact、批准/预算/operation ledger 和当前 CodeSnapshot 独立取得。
3. 每个不可逆操作使用 `prepare -> durable begin -> execute -> durable finish/reconcile`。`durable begin` 在一个事务内完成批准消费、预算预留、operation started 和 started 事件；未收到提交确认不得 execute。
4. operation ID 是跨恢复稳定身份；operation hash 是绑定工具版本、schema、normalization、有效参数、workspace、代码/diff 和行为配置的批准指纹，两者不能混用。
5. 工具生命周期事实由 ToolRuntime execution journal 唯一写入；AgentEventLoop 负责编排和 transcript 投影，不重复写 started/finished。
6. 任何 unknown、未结束操作、缺失/损坏证据或无法取得可信 Context 都 fail closed，并通过只读 Provider 对账或重新验证恢复。

## 后果

- C02 必须提供支持下游 journal 端口的 SQLite 事务和崩溃恢复能力。
- C03/C04/C07 的版本、批准和预算契约进入 C08 commit fence。
- `finish_task` 输入从 `CompletionClaim` 改为 `CompletionIntent`；当前可编译基线需在接真实循环前迁移。
- observer、UI 文本、模型 transcript 和 LLM Judge 都不是事实源。
- 故障注入必须覆盖 durable begin 前后、execute 响应丢失和 durable finish 失败。
