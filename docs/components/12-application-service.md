# C12 Application Service 与 Composition Root

- 状态：基础对象组装存在，生产 Provider 和用例服务未接
- 目标阶段：D3–D7
- 代码位置：`src/app/application.ts`
- 硬依赖：[C02](02-storage-artifacts.md)至[C11](11-agent-event-loop.md)
- 下游消费者：C13、C14、C15

## 1. 目标

作为唯一 Composition Root 读取配置、创建 Provider、注册工具、组装 AgentEventLoop，并向 CLI 暴露稳定用例。核心组件不自行读取全局环境、构造 SDK 或查找单例。

## 2. 职责边界

### 必须负责

- 配置加载、验证、版本 hash 和数据目录选择。
- 生产/测试依赖组装、启动顺序和优雅关闭。
- 注册固定工具目录并验证能力/策略。
- 暴露 run/resume/list/trace/config/eval 用例。
- 进程级锁、全局取消和未捕获错误转结构化事件。

### 明确不负责

- Coding 策略、UI 渲染、数据库 SQL、供应商协议解析或权限决策。

## 3. 启动顺序

```text
load raw config
 -> validate and redact
 -> resolve data/workspace paths
 -> acquire instance lock
 -> migrate/open storage
 -> create ArtifactStore/EventStore
 -> create Model/Search/Git/GitHub providers
 -> register and validate tools
 -> create Policy/Budget/Context/Gate/Loop
 -> expose application use cases
```

任一步失败都不得留下可接受用户命令但缺少安全组件的半初始化应用。

## 4. 公开用例

```ts
interface CodeFlowApplication {
  run(request: RunTaskRequest): Promise<SessionHandle>;
  resume(sessionId: string): Promise<SessionHandle>;
  listSessions(filter: SessionFilter): Promise<SessionSummary[]>;
  getTrace(sessionId: string, options: TraceOptions): AsyncIterable<TraceItem>;
  updateConfig(patch: ConfigPatch): Promise<ConfigUpdateResult>;
  evaluate(request: EvaluationRequest): Promise<EvaluationRun>;
  shutdown(reason: string): Promise<void>;
}
```

SessionHandle 提供事件流、用户答复、审批决策、取消和最终状态；CLI 不直接持有 Loop 内部对象。

## 5. 功能需求

- `APP-FR-001`：配置来源优先级固定：CLI 参数 > 项目配置 > 用户配置 > 默认值；Key 只从环境/系统凭证。
- `APP-FR-002`：配置验证失败时输出字段级错误，不创建模型或数据库写连接。
- `APP-FR-003`：生产组装使用 SQLite/File ArtifactStore；测试组装允许注入内存/fixture Provider。
- `APP-FR-004`：工具 Registry 在接受任务前完成全量校验和目录 hash。
- `APP-FR-005`：同一 data dir 默认只允许一个写实例；第二实例明确只读或拒绝。
- `APP-FR-006`：run 创建持久 Session 后才启动 Loop；创建失败不调用模型。
- `APP-FR-007`：resume 先重放和对账 unknown，再允许新调用。
- `APP-FR-008`：shutdown 先停止接收新命令，再取消/等待活动 Session，最后关闭存储。
- `APP-FR-009`：未捕获错误写入结构化失败事件；存储不可用时至少输出本地诊断，不伪造已保存。

## 6. 配置模型

至少包含：模型/provider、reasoning、预算、权限默认值、数据目录、保留期、搜索 Provider、工具超时/输出上限、UI 偏好。配置导出永不包含 Key。

`configVersion` 必须由影响行为的非秘密配置和工具目录共同计算。

## 7. 错误与恢复

| 启动阶段 | 失败行为 |
| --- | --- |
| 配置 | 字段错误，退出码 2 |
| instance lock | 提示已有实例，不争抢写入 |
| migration/storage | 停止启动，保留数据 |
| optional Exa/gh | 标记相应工具 unavailable，离线能力继续 |
| DeepSeek Key 缺失 | config/list/trace 可用，run 明确拒绝 |
| shutdown timeout | 记录未终止资源，退出非零 |

## 8. 安全要求

- `APP-SR-001`：Provider 只接收所需最小配置；Key 不进入通用 config 对象的可序列化部分。
- `APP-SR-002`：不能以“开发模式”绕过权限、trace 或 CompletionGate。
- `APP-SR-003`：测试替身不得改变生产接口语义，特别是副作用和重试状态。

## 9. 验收标准

- `APP-AC-001`：生产/测试 composition graph 的必需依赖完整且无循环。
- `APP-AC-002`：缺 DeepSeek Key 时只读命令可用，run 不发网络请求。
- `APP-AC-003`：可选 Exa/gh 缺失只禁用对应工具并展示原因。
- `APP-AC-004`：两个实例争用 data dir 不产生并发写。
- `APP-AC-005`：shutdown 期间不再接受新 Session，活动调用收到取消。
- `APP-AC-006`：核心组件测试不直接读取 `process.env`。

## 10. 实现任务建议

1. 定义 AppConfig schema、redacted view 和 configVersion。
2. 把当前 `createApplication` 改为显式 dependencies/options。
3. 建生产/测试 composition factories。
4. 实现 use-case facade 和 SessionHandle。
5. 接 instance lock、startup/shutdown 和错误边界。
