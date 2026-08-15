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
- 暴露 run/resume/list/config 用例；C14 提供 trace/export/delete/pin，C15 提供 eval，避免 Application 与下游治理组件形成类型循环。
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

### 4.1 当前可编译基线

当前 `createApplication()` 只组装内存 EventStore、空 ToolRegistry、基础 Runtime/Policy/Budget/Context/Gate 和只会创建 Session 的 Loop；返回对象暴露这些内部组件，没有生产配置、Provider、存储生命周期或用例 facade。

### 4.2 目标接口（规划中）

下列用例 facade 只有在 C02–C11 的依赖门满足后才能替换当前组装对象：

```ts
interface CodeFlowApplication {
  run(request: RunTaskRequest): Promise<SessionHandle>;
  resume(sessionId: StableId): Promise<SessionHandle>;
  listSessions(filter: SessionFilter): Promise<SessionSummary[]>;
  updateConfig(patch: ConfigPatch): Promise<ConfigUpdateResult>;
  shutdown(reason: string): Promise<void>;
}

interface RunTaskRequest {
  requestId: StableId;
  workspace: PathReference;
  goal: string;
  acceptanceCriteria: string[];
  budget: BudgetLimits;
  taskWriteAuthorized: boolean;
}

interface SessionHandle {
  sessionId: StableId;
  streamEvents(options: { afterSequence: number; signal: AbortSignal }):
    AsyncIterable<AgentEvent>;
  answer(requestId: StableId, answer: UserAnswer): Promise<CommandReceipt>;
  decideApproval(requestId: StableId, decision: ApprovalDecision): Promise<CommandReceipt>;
  cancel(requestId: StableId, reason: string): Promise<CommandReceipt>;
  waitForTerminal(signal: AbortSignal): Promise<SessionSummary>;
}

interface CommandReceipt {
  commandId: StableId;
  accepted: boolean;
  resultingSequence: number | null;
  error: StructuredError | null;
}

interface UserAnswer {
  value: string;
  selectedChoiceId: string | null;
}

interface ApprovalDecision {
  decision: "approved" | "denied";
  operationHash: string;
}

interface ConfigPatch {
  expectedConfigVersion: string;
  values: JsonObject; // 仅允许 AppConfig schema 中的非秘密字段
}

interface ConfigUpdateResult {
  configVersion: string;
  changedFields: string[];
  restartRequired: boolean;
}
```

`budget` 只包含用户可控的八维硬 limits；`softLimitRatio`、`countWaitingTime` 与 `pricingVersion` 来自版本化 `AppConfig`/定价目录。C12 创建 Session 时必须初始化同一个 C04 durable budget account，并把完整 policy hash 纳入行为配置版本；不得继续组装旧四维 `BudgetController` 或在 Loop 中散落默认值。

这些 DTO 的所有者是 C12；`SessionFilter`、`SessionSummary` 和 Workspace/Session 记录从 C02 导入，不能重定义。SessionHandle 不暴露 Loop、repository 或 Provider。`requestId/commandId` 是幂等键：重复提交相同内容返回旧 receipt，不同内容冲突则拒绝。

`streamEvents(afterSequence)` 必须由持久 EventStore 提供 replay-then-tail 语义：先建立受 sequence 保护的订阅游标，再补齐历史，最后无缝切换实时事件。慢消费者使用持久 sequence 重连；内存缓冲达到上限时断开并返回最后成功 sequence，不得阻塞事件写入。

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
- `APP-FR-010`：应用生命周期固定为 `new -> starting -> ready -> stopping -> stopped|failed`；非 ready 状态拒绝新的 run/resume。
- `APP-FR-011`：启动阶段每成功创建一个资源就登记对应关闭动作；后续失败按逆序回滚，回滚失败进入诊断但不能把应用标为 ready。
- `APP-FR-012`：同一 Session 只允许一个可写调度 lease；多个 SessionHandle 可读，但 answer/approval/cancel 必须经 request ID 和当前待处理请求校验。

## 6. 配置模型

至少包含：模型/provider、reasoning、预算、权限默认值、数据目录、保留期、搜索 Provider、工具超时/输出上限、UI 偏好。配置分为可序列化 `AppConfig` 与不可序列化 `CredentialProvider`；前者只保存 credential reference/availability，不包含 Key、token 或 Authorization header。

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
- `APP-AC-007`：每个启动阶段故障注入后已创建资源按逆序关闭，应用不接受命令且数据锁不会泄漏。
- `APP-AC-008`：慢订阅者断开重连后按 sequence 收到无遗漏、无重复的事件，且不会阻塞 Loop。
- `APP-AC-009`：answer/approval/cancel 重复投递幂等，错误 request ID 不能影响当前等待状态。

## 10. 实现任务建议

1. 定义 AppConfig schema、redacted view 和 configVersion。
2. 把当前 `createApplication` 改为显式 dependencies/options。
3. 建生产/测试 composition factories。
4. 实现 use-case facade 和 SessionHandle。
5. 接 instance lock、startup/shutdown 和错误边界。
