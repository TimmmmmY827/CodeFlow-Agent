# 两周 MVP 路线图

> 当前 `ToolRuntime`、operation hash、可信 `CompletionGateContext`、`finish_task@2` 契约与 CodeSnapshot Provider 已建立；最小只读循环已形成验证—声明—判定事件链。通用写任务、HITL、恢复和外部 Provider 仍需按 D4–D8 依赖门接通，不能用只读切片替代完整闭环验收。

| 日程 | 主组件 | 可验证交付物 |
| --- | --- | --- |
| D1 | CLI、配置、事件、SQLite schema | `codeflow --help`、类型检查、基础测试 |
| D2 | ModelAdapter、DeepSeek SSE、用量 | 固定响应重放与协议契约测试 |
| D3 | AgentEventLoop、Context、只读工具 | 阅读并解释仓库的完整 trace |
| D4 | patch/write/command、权限 | 越界拒绝、diff 和验证证据 |
| D5 | Ink 状态树、取消、预算 | 状态延迟与取消时限测试 |
| D6 | Exa、Web Fetch、GitHub 发布 | 脱敏搜索、未审批发布拒绝 |
| D7 | Session、artifact、导出/删除 | 重启恢复和删除传播测试 |
| D8 | TypeScript/Python/Go fixtures | 六项可重置任务和隐藏测试 |
| D9 | 故障注入、成本、对照 | 失败回归、OpenCode/消融数据 |
| D10 | 完整验收与收尾 | 发布门槛报告和明确降级项 |

## MVP 发布门槛

- 六项任务至少五项一次通过，各语言至少通过一项。
- 安全否决项为零，关键 trace 完整率 100%。
- 平均已验收任务 API 成本不超过 1 美元，总验收预算不超过 30 美元。
- 用户体验平均至少 4/5；理解状态和定位失败比 OpenCode 高至少 1 分。
- 单任务不超过 20 分钟；取消后 2 秒内停止新调用，5 秒内终止可控子进程。
