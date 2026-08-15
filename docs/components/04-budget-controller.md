# C04 BudgetController

- 状态：C04 核心已实现；八维策略、版本化快照、SQLite 可恢复账本、原子预留/结算/释放、重试/无进展判定和单调计时已交付，C08/C11/C13 组装接线按各自组件推进
- 目标阶段：D3–D5
- 代码位置：`src/policy/budget-contracts.ts`、`src/policy/budget-controller.ts`、`src/storage/sqlite/sqlite-budget-ledger.ts`
- 测试位置：`tests/budget-controller.test.ts`、`tests/sqlite-budget-ledger.test.ts`、`tests/state-reducer-contract.test.ts`
- 硬依赖：核心策略依赖 [C00 共享契约](00-shared-contracts.md)；SQLite ledger adapter 依赖 [C02 存储](02-storage-artifacts.md)
- 下游消费者：C01 预算投影、C08、C11、C12、C13、C15

## 1. 目标

限制 Agent 的步骤、工具调用、时间、token、费用、重试和无进展循环，在每个可产生新成本或副作用的边界提前阻止超预算行为。

## 2. 职责边界

### 必须负责

- Session/Task 预算配置、当前消费和剩余量。
- 模型请求、工具调用和重试前的预算预留。
- 完成、释放、超额和无进展判断。
- 向事件和 CLI 提供一致预算快照。

### 明确不负责

- 供应商计价抓取、模型选择、取消进程或完成质量判断。
- 用预算门替代 PermissionEngine。

## 3. 预算维度

预算契约主版本为 `BUDGET_SCHEMA_VERSION = 1`。limits 覆盖八个硬边界；用量把活动时间与等待时间分开，并显式携带费用可信度：

```ts
interface BudgetLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxRetriesPerOperation: number;
  maxNoProgressCycles: number;
}

interface BudgetUsage {
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  noProgressCycles: number;
  activeDurationMs: number;
  waitingDurationMs: number;
  costUsd: number | null;
  costStatus: "known" | "partial" | "unknown";
}

interface BudgetSnapshot {
  schemaVersion: number;
  sessionId: StableId;
  usage: BudgetUsage;
  reserved: BudgetUsage;
  limits: BudgetLimits;
  pricingVersion: string | null;
  countWaitingTime: boolean;
  softLimitRatio: number;
  limitStatus: "within" | "soft_limit" | "hard_limit" | "pricing_unknown";
  limitDimensions: BudgetDimension[];
  updatedAt: UtcTimestamp;
  lastLedgerSequence: number;
}

interface BudgetLedgerEntry {
  schemaVersion: number;
  entryId: StableId;
  sessionId: StableId;
  operationId: StableId;
  idempotencyKey: string;
  kind: "reserve" | "commit" | "release" | "adjust";
  ledgerSequence: number;
  reservationId: StableId | null;
  delta: BudgetDelta;
  usageBasis: "estimated" | "actual" | "conservative" | "not_applicable";
  admission: "allow" | "warn" | "recorded";
  warningDimensions: BudgetDimension[];
  costReconciliation: CostReconciliation | null;
  reconciliationRequired: boolean;
  evidence: RetryEvidence | NoProgressEvidence | null;
  createdAt: UtcTimestamp;
}
```

MVP 默认单任务最长 20 分钟、已验收任务平均不超过 1 美元；实现默认值必须由 config 提供，不能散落在循环中。

`BudgetSnapshot` 是 C04 的唯一预算投影契约；C01 `budget.updated` 的 `context.budgetSnapshot`、C13 和 C15 必须使用同一结构或稳定引用，不能维护另一套四维含义。C01 的旧 `context.budget` 仅为已持久化 v1 事件保留解析兼容，不再驱动 `budget.updated` 或 `SessionView`。未知费用始终是 `null + costStatus = unknown`，不能写成 0；partial 可保存已知小计但不能冒充完整费用。

`BudgetLedger.initialize` 把 policy 与 pricingVersion 完整绑定到 Session；同 Session 不允许用不同参数再次初始化。`reserve/commit/release/adjust` 均由调用方提供 entry ID、稳定 operation ID 和幂等键。相同键与相同内容返回首次持久化的 entry 及当时 snapshot；相同键不同内容返回 `budget_idempotency_conflict`。commit/release 必须引用仍 open 且属于同一 Session/operation 的 reservation。

`listOpenReservations(sessionId)` 从 durable ledger 计算所有尚未被 commit/release 的 reserve fact。恢复入口不得依赖调用方进程内 lease：即使调用方日志在 reserve 后丢失，C11/C08 也必须先列出这些 reservation，结合对应 started/operation journal 决定保守 commit 或仅在确认未开始时 release。

reserve 到达软阈值时仍提交，但 entry 固化 `admission = warn` 与 `warningDimensions`；到达现有硬限或请求会超过硬限时不写 entry 并返回 `budget_hard_limit`。commit/adjust 记录已经发生的真实或保守 usage，即使它使快照超限也不能丢弃事实，后续 reserve 会被硬门阻止。

每个 snapshot 固化 `limitStatus/limitDimensions`，因此 commit/adjust 导致的实际超限不需要下游自行重算。费用一旦 unknown，会以 `pricing_unknown` 阻止新的付费调用；恢复必须追加带 `resolvedCostUsd`（累计已提交费用）、`known|partial`、稳定 pricingVersion 和非空 reason 的 cost reconciliation adjustment。该事实可以替换累计费用可信状态、推进 account/snapshot 的 pricingVersion，但不会改写旧 commit。C11 正常路径必须使用版本化本地定价表，DeepSeek provider 的 `costUsd = null` 不能未经本地计价就直接作为最终结算；定价仍不可得时保持阻断而不是伪造 0。

## 4. 功能需求

- `BUDGET-FR-001`：每次模型调用前根据请求上限预留 token/费用，响应后按实际 usage 结算差额。
- `BUDGET-FR-002`：每次工具执行前预留一次 tool call；未开始执行的审批等待不重复计数。
- `BUDGET-FR-003`：step 的定义是一次模型决策周期，不等同于每条流式事件。
- `BUDGET-FR-004`：时间使用单调时钟，从 Session 开始到终态，等待用户时间单独记录并可配置是否计入。
- `BUDGET-FR-005`：重试按稳定 operation ID 和 attempt 计数，并保存当时的 operation hash；外部写 `UNKNOWN` 不允许自动重试。
- `BUDGET-FR-006`：无进展判定至少考虑重复 tool+input、重复错误和代码版本未变化。
- `BUDGET-FR-007`：达到软阈值发 warning，达到硬阈值停止新调用并请求用户选择扩容或结束。
- `BUDGET-FR-008`：预算更新产生事件，CLI 显示已用/上限/预估剩余。
- `BUDGET-FR-009`：reserve/commit/release 使用调用方提供的幂等键；相同键和相同内容重复调用返回旧结果，内容不同返回完整性错误。
- `BUDGET-FR-010`：每个 reservation 绑定稳定 operation ID，不使用可因参数规范化变化而改变的显示文本作为主键。

## 5. 并发与原子性

- 并行只读工具必须先原子预留各自调用额度。
- 模型流中断仍记录已产生的 usage。
- 预留成功但操作未开始时可释放；操作开始后由完成/失败结算。
- 预算状态从事件或 usage ledger 恢复，不能只存在内存计数器。
- C08 工具开始边界中的 reservation 与批准消费、operation 状态、`tool.started` 同事务；模型调用 reservation 则与 `model.started` 同事务。
- `SqliteBudgetLedger` 的普通异步方法自行使用 `BEGIN IMMEDIATE`；`reserveWithinTransaction/commitWithinTransaction/releaseWithinTransaction/adjustWithinTransaction` 只加入 `SqliteStorageDatabase.runImmediateTransaction()` 已打开的事务。任意普通/DEFERRED transaction 会被拒绝，事务体不得跨 `await`。C08/C11 journal 必须使用后一组同步原语。
- v3 migration 在 `budget_accounts` 保存 policy/watermark，在 `usage_entries` 保存 canonical ledger fact、hash、索引列和首次结果快照；当前快照总是从 ledger 重放并核验连续 sequence 与 account watermark，不信任内存计数器。

## 6. 错误与恢复

| category | 行为 |
| --- | --- |
| `budget_soft_limit` | 发 warning，允许当前操作 |
| `budget_hard_limit` | 禁止新调用，进入 WAITING_USER |
| `usage_missing` | 使用保守预留值并标记需对账 |
| `pricing_unknown` | 记录 token，费用标记 unknown，不伪造 0 |
| `no_progress` | 停止自动循环，展示重复证据 |

## 7. 安全要求

- `BUDGET-SR-001`：模型不能通过输出要求提高预算。
- `BUDGET-SR-002`：提高预算是用户控制操作并写入事件。
- `BUDGET-SR-003`：达到取消或硬预算后不得发起新的模型、搜索或工具调用。

## 8. 验收标准

- `BUDGET-AC-001`：并行预留不会使实际调用超过硬上限。
- `BUDGET-AC-002`：流中断、重试和缺失 usage 的账本结果可解释且不低估。
- `BUDGET-AC-003`：重复相同失败达到阈值后停止，trace 指出首次和最后一次重复。
- `BUDGET-AC-004`：恢复 Session 后剩余预算与崩溃前事件重放一致。
- `BUDGET-AC-005`：CLI 在 1 秒内显示最新预算事件。
- `BUDGET-AC-006`：未知、部分和已知费用可确定重放，任何报告都不会把 unknown 聚合为 0。
- `BUDGET-AC-007`：reserve/commit/release 重放不会重复计费，幂等键冲突会显式失败。

已交付证据：

- `budget-controller.test.ts` 覆盖八维软/硬门、unknown 费用、UNKNOWN 禁止自动重试、相同失败的首末证据与单调活动/等待计时。
- `sqlite-budget-ledger.test.ts` 覆盖 policy 初始化冲突、预留/实际结算、未结算 reservation 恢复、缺失 usage 保守结算、unknown cost 阻断与审计 reconciliation、未开始释放、跨连接持锁竞争、二次结算/mismatch/entry ID 冲突、重启后 mutation 回放、水位/索引篡改拒绝、加入 IMMEDIATE 上游事务及整体回滚。
- `state-reducer-contract.test.ts` 用同一 `BudgetSnapshot` 重放 10,000 个 `budget.updated`，证明批量与增量投影一致。
- `BUDGET-AC-005` 的实时 UI 延迟属于 C13 集成验收；C04 已提供持久 snapshot/event payload 契约，不以空 CLI 实现提前宣称完成。

## 9. 实现任务建议

1. C08 用 transactional API 接工具批准/started/预算的同事务开始与结算。
2. C11 用 transactional API 接模型 started/usage/重试与无进展证据。
3. C12 从版本化 config 提供 policy/pricingVersion，禁止继续使用散落默认值。
4. C13 直接渲染 C01 `SessionView.budget`，并完成 1 秒延迟验收。
5. C15 用 `BudgetSnapshot` 判断费用 known/partial/unknown 与发布门。
