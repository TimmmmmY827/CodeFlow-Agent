# CodeFlow Agent 组件需求设计索引

本目录把总体蓝图拆成可以由后续 Agent 独立领取、实现和验收的组件任务。每份文档都定义目标边界、前后依赖、公开契约、错误与恢复、安全约束、事件要求、测试门和完成条件。

> 当前基线：文档基于覆盖度修正分支中的结构化 `AgentEvent`、`ToolRuntime`、operation hash 和 `CompletionGate` 契约。存在文件或接口不代表组件已经接通。

## 阅读与领取规则

后续 Agent 在实现任何组件前必须按顺序阅读：

1. 仓库根目录 `AGENTS.md`。
2. 本索引中的系统依赖图、共享完成标准和目标组件行。
3. 目标组件文档。
4. 目标组件的所有“硬依赖”文档。
5. `docs/decisions/` 中被引用的 ADR。

禁止只根据目录名或当前占位接口猜测需求。若实现需要改变上游契约，必须先修改上游文档和测试，再修改下游。

### 接口与状态标注规则

- 标记为“已实现”的组件，其公开接口必须与当前可编译代码一致。
- 尚未完成的组件同时保留“当前基线接口”和“目标接口（规划中）”；后者是验收目标，不表示代码已经存在。
- 需求条目和验收标准默认描述目标形态；只有列出测试证据并通过统一完成门，才能把状态改为“已实现”。
- 后续 Agent 不得引用目标接口直接接线，必须先完成目标组件的依赖门并把对应契约落到代码和测试。

## 组件目录

| ID | 组件文档 | 目标阶段 | 当前基线 | 硬依赖 | 主要下游 |
| --- | --- | --- | --- | --- | --- |
| C00 | [共享契约](00-shared-contracts.md) | D1–D2 | 已实现 | 无 | 全部组件 |
| C01 | [事件事实层与 StateReducer](01-event-state.md) | D1–D3 | 已实现 | C00 | Storage、Loop、CLI、Trace、Eval |
| C02 | [存储与 ArtifactStore](02-storage-artifacts.md) | D7 | 核心持久化、可续跑物理删除、保留与恢复检查已实现；C08/C11 journal 和原生 Windows 路径加固延期 | C00、C01 | Runtime、Session、Loop、Trace |
| C03 | [PermissionEngine](03-permission-engine.md) | D1–D6 | 权限契约与持久审批已实现；C08 接线待完成 | C00 | Runtime、Loop、CLI、发布工具 |
| C04 | [BudgetController](04-budget-controller.md) | D3–D5 | 核心已实现，待下游接线 | C00；SQLite adapter 使用 C02 | Loop、CLI、Eval |
| C05 | [ModelAdapter](05-model-adapter.md) | D2 | 最小非流式实现 | C00、C01 | Context、Loop、成本账本 |
| C06 | [ContextAssembler](06-context-assembler.md) | D3 | 排序骨架 | C00、C01、C05、C07 | Model、Loop |
| C07 | [ToolDefinition 与 ToolRegistry](07-tool-registry.md) | D1–D3 | 基础实现 | C00 | Runtime、Context、Loop |
| C08 | [ToolRuntime](08-tool-runtime.md) | D3–D4 | 基础流水线；版本/输出 schema 等缺失 | C00–C04、C07（不含 C05/C06） | 内置工具、Loop、Trace |
| C09 | [18 个内置工具与外部 Provider](09-built-in-tools.md) | D3–D6 | 仅 `finish_task` 工厂 | C00、C02、C03、C07、C08；finish 依赖 C10 | Loop、CLI、Eval |
| C10 | [CompletionGate](10-completion-gate.md) | D4 | 旧版 Gate；可信 Context/evidence 缺失 | C00、C01、C02 | 内置 finish、Loop、CLI、Eval |
| C11 | [AgentEventLoop](11-agent-event-loop.md) | D3–D4 | 仅创建 Session | C01–C10 | Application、CLI、Eval |
| C12 | [Application Service](12-application-service.md) | D3–D7 | 基础依赖组装 | C02–C11 | CLI、Session 命令、Eval |
| C13 | [CLI/TUI 与 HITL](13-cli-tui.md) | D5 | 命令骨架 | C01、C03、C04、C11、C12、C14 | 用户、Eval |
| C14 | [Session、Trace 与生命周期治理](14-session-trace.md) | D7 | 接口/脱敏骨架 | C01、C02、C03、C12 | CLI、Eval、恢复 |
| C15 | [Evaluation Harness](15-evaluation.md) | D8–D10 | 类型和总门槛 | C01–C14 | 发布决策 |

## 总体依赖图

```mermaid
flowchart LR
    C00["C00 共享契约"] --> C01["C01 事件与状态"]
    C00 --> C03["C03 权限"]
    C00 --> C04["C04 预算"]
    C00 --> C05["C05 模型适配"]
    C00 --> C07["C07 工具定义/注册"]
    C01 --> C02["C02 存储/Artifact"]
    C01 --> C06["C06 上下文"]
    C05 --> C06
    C07 --> C06
    C02 --> C08["C08 ToolRuntime"]
    C01 --> C08
    C03 --> C08
    C04 --> C08
    C07 --> C08
    C08 --> C09["C09 内置工具/Provider"]
    C01 --> C10["C10 CompletionGate"]
    C02 --> C10
    C10 --> C09
    C01 --> C11["C11 AgentEventLoop"]
    C03 --> C11
    C04 --> C11
    C05 --> C11
    C06 --> C11
    C08 --> C11
    C09 --> C11
    C10 --> C11
    C02 --> C11
    C02 --> C12["C12 Application"]
    C11 --> C12
    C01 --> C14["C14 Session/Trace"]
    C02 --> C14
    C12 --> C14
    C03 --> C13["C13 CLI/TUI/HITL"]
    C04 --> C13
    C11 --> C13
    C12 --> C13
    C14 --> C13
    C01 --> C15["C15 Evaluation"]
    C09 --> C15
    C10 --> C15
    C11 --> C15
    C13 --> C15
    C14 --> C15
```

## 关键路径与可并行工作

### 必须串行的关键路径

1. C00 共享契约稳定。
2. C01 事件/状态与 C07 工具定义稳定。
3. C03 权限 + C08 Runtime 形成安全执行边界。
4. C05 模型 tool calling + C06 上下文形成模型请求边界。
5. C09 至少六个只读工具可用。
6. C11 接通最小模型—工具—观察循环。
7. C10 完成门接入 `finish_task`。
8. C13 实时视图与审批接入。
9. C14 持久化恢复接入。
10. C15 用六任务评估决定是否发布。

### 可并行但必须在接口处会合

- C03 PermissionEngine 与 C04 BudgetController 可并行，均在 C11 会合。
- C05 ModelAdapter 与 C08 ToolRuntime 可并行，均在 C11 会合。
- C02 SQLite 实现可与 D2–D4 并行开发，但 C14 恢复前必须完成。
- C13 Ink 纯视图可在事件投影稳定后并行，审批和取消交互必须等待 C03/C11。
- C15 fixture 可在真实工具目录稳定后并行准备，端到端 runner 必须等待 C11–C14。

## 统一完成标准

任何组件只有同时满足以下条件才可标记完成：

- 公开接口与本文档一致，未把供应商 SDK 类型泄漏到核心层。
- 正常、失败、取消、超时和恢复路径都有确定语义。
- 会产生状态变化的路径发出结构化 `AgentEvent`，或明确由上层负责发出。
- 安全边界、权限和秘密处理有负向测试。
- 确定性单元测试通过；涉及跨组件的组件有契约测试。
- `pnpm check` 和 `codeflow --help` 通过。
- 文档中的验收项有真实证据；未运行的验证必须明确标记。
- 没有把 D2–D8 延后能力用空实现标记为完成。

## 跨组件权威来源

组件可以投影、缓存或摘要其他组件的数据，但安全决策必须回到下表的权威来源。模型输出、仓库/网页文本、UI 状态、observer 通知和 LLM Judge 均不是授权或事实来源。

| 事实 | 唯一权威来源 | 允许的派生消费者 |
| --- | --- | --- |
| 事件顺序与生命周期事实 | C01 schema/reducer + C02 durable EventStore | C06、C11、C13–C15 |
| Workspace/Session/Artifact/删除收据 | C02 versioned repository | C08、C10、C12、C14、C15 |
| 授权与批准状态 | C03 policy + approval repository | C08、C11、C13、C14 |
| 预算消费与剩余量 | C04 ledger/snapshot | C01、C08、C11、C13、C15 |
| 模型协议事件 | C05 normalized stream；持久事实由 C11 写 C01 | C06、C11、C14 |
| 模型实际看到的上下文 | C06 ContextManifest | C11、C14、C15 |
| 工具版本/schema/availability | C07 ToolCatalogManifest | C03、C06、C08、C11、C15 |
| 工具 operation 与副作用状态 | C08 durable execution journal | C01、C10、C11、C14、C15 |
| 完成证据与安全否决 | C10 CompletionGateContext 的可信 Provider | C11、C13、C15 |
| Session 恢复/导出/删除治理 | C14 基于 C01/C02 的派生服务 | C13、C15 |
| 评估结果与发布门 | C15 versioned manifest/verifier/result | 发布决策 |

详见 [ADR-0003](../decisions/0003-trusted-facts-and-durable-side-effects.md)。

## 运行记录与故障切点约定

- 每个顶层持久记录独立带主版本；接口示例中未写出的版本字段不得据此省略。
- 不可逆操作固定使用 prepare、durable begin、execute、durable finish/reconcile；未落盘 started 不得开始副作用。
- operation ID、attempt、operation hash、idempotency key 和 provider external ID 含义不同，禁止复用一个字符串代替。
- 涉及数据库、文件或外部 Provider 的组件必须列出可注入崩溃切点，以及每个切点恢复后的合法状态集合。
- `UNKNOWN` 不是普通失败或可重试状态，只能通过可信只读对账转为 applied/not_applied，或保持阻塞。
- C01 EventStore provider 必须运行同一套契约测试；sequence gap、duplicate/conflict、增量读取和 listener 语义不得因内存/SQLite 实现而变化。

## 变更控制

- 修改 C00、C01、C03、C07 的公共契约属于高影响变更，必须检查所有下游文档和测试。
- 新增工具必须同时更新 C09 工具清单、权限级别、side-effect/retry 策略和 Context 工具 schema。
- 新增事件必须更新 C01 状态投影、C02 持久化、C13 UI 表示和 C15 trace 完整性检查。
- 新增外部写操作必须定义 prepare/commit、批准绑定、幂等键、状态查询和 `UNKNOWN` 对账。
- 修改权威来源、持久执行边界或 CompletionGate 信任模型必须新增 ADR；不得只修改某个下游调用示例。

新组件文档应从 [组件文档模板](component-design-template.md)复制结构。
