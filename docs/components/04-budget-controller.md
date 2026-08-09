# C04 BudgetController

- 状态：四维静态判断已实现，消费与预留未接线
- 目标阶段：D3–D5
- 代码位置：`src/policy/budget-controller.ts`
- 硬依赖：[C00 共享契约](00-shared-contracts.md)
- 下游消费者：C11、C13、C15

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

当前 `BudgetLimits`/`BudgetUsage` 只实现 steps、toolCalls、durationMs、costUsd 四维快照和静态 `evaluate`。下列八维 limits 是目标契约（规划中），token、重试、无进展、预留/结算和事件恢复尚未实现：

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
```

MVP 默认单任务最长 20 分钟、已验收任务平均不超过 1 美元；实现默认值必须由 config 提供，不能散落在循环中。

## 4. 功能需求

- `BUDGET-FR-001`：每次模型调用前根据请求上限预留 token/费用，响应后按实际 usage 结算差额。
- `BUDGET-FR-002`：每次工具执行前预留一次 tool call；未开始执行的审批等待不重复计数。
- `BUDGET-FR-003`：step 的定义是一次模型决策周期，不等同于每条流式事件。
- `BUDGET-FR-004`：时间使用单调时钟，从 Session 开始到终态，等待用户时间单独记录并可配置是否计入。
- `BUDGET-FR-005`：重试按 operation hash 计数；外部写 `UNKNOWN` 不允许自动重试。
- `BUDGET-FR-006`：无进展判定至少考虑重复 tool+input、重复错误和代码版本未变化。
- `BUDGET-FR-007`：达到软阈值发 warning，达到硬阈值停止新调用并请求用户选择扩容或结束。
- `BUDGET-FR-008`：预算更新产生事件，CLI 显示已用/上限/预估剩余。

## 5. 并发与原子性

- 并行只读工具必须先原子预留各自调用额度。
- 模型流中断仍记录已产生的 usage。
- 预留成功但操作未开始时可释放；操作开始后由完成/失败结算。
- 预算状态从事件或 usage ledger 恢复，不能只存在内存计数器。

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

## 9. 实现任务建议

1. 扩展 limits/usage/reservation 数据模型。
2. 实现 reserve/commit/release 原子 API。
3. 接 ModelAdapter usage 和 ToolRuntime lifecycle。
4. 实现 retry/no-progress tracker。
5. 接 EventStore/CLI，并做并发与崩溃测试。
