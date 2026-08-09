# C15 Evaluation Harness 与发布门

- 状态：任务/结果类型和 5/6 总门槛存在，Runner/fixture/验证器缺失
- 目标阶段：D8–D10
- 代码位置：`src/eval/`、建议 `eval/fixtures/`、`eval/verifiers/`
- 硬依赖：C01–C14 的可执行契约
- 下游消费者：MVP 发布决策、回归开发

## 1. 目标

用六个可重置 Coding 任务、隐藏验证器、安全规则、trace 检查、成本和用户评分，回答 CodeFlow Agent 是否真正完成任务，以及是否比 OpenCode 更容易理解和调试。

## 2. 职责边界

### 必须负责

- fixture 定义、环境重置、任务运行、验证器、指标和报告。
- 规则验证、辅助 LLM Judge、用户评分的职责分离。
- CodeFlow 可视化消融和 OpenCode 外部对照。
- bad case 固化为组件/端到端回归。

### 明确不负责

- 为了通过评估修改 Agent 权限、隐藏安全失败或让 Judge 覆盖硬规则。
- 在线 A/B、多租户平台和生产遥测。

## 3. 六任务集合

| 生态 | 已有仓库 Bug | 空目录小功能 |
| --- | --- | --- |
| TypeScript | 真实失败测试 + 有限修改边界 | 初始化最小项目并满足功能/测试 |
| Python | 真实失败测试 + 有限修改边界 | 初始化最小项目并满足功能/测试 |
| Go | 真实失败测试 + 有限修改边界 | 初始化最小项目并满足功能/测试 |

每个 fixture 固定：Git/目录快照、可见任务说明、可见验收条件、隐藏测试、允许/禁止动作、网络策略、预期修改边界和最大预算。

## 4. EvaluationTask 契约

当前 `EvaluationTask` 只有 id/language/scenario/fixture、可见验收、单个 hiddenVerifier 和动作白名单/黑名单；`EvaluationResult` 只有 pass、安全标签、trace、耗时和成本，`passesMvpGate` 仅检查 6 项/5 项通过、安全标签为空和 trace 完整。下列版本化任务、预算和 verifier 引用是目标契约（规划中）：

目标 `EvaluationResult` 还必须把安全否决升级为 C10 `SafetyVeto` 或稳定事件引用，不能长期保留无来源的自然语言字符串。

```ts
interface EvaluationTask {
  id: string;
  version: string;
  language: "typescript" | "python" | "go";
  scenario: "existing-repository-bug" | "new-project-feature";
  fixture: FixtureRef;
  prompt: string;
  visibleAcceptanceCriteria: string[];
  hiddenVerifiers: VerifierRef[];
  allowedActions: string[];
  forbiddenActions: string[];
  limits: BudgetLimits;
}
```

任务版本或验证器变化后不能直接与旧 run 横向比较。

## 5. 验证职责

### 确定性规则

- 测试、构建、lint/static check。
- 文件/diff 范围、用户改动保护。
- 安全否决、审批、取消、外部副作用。
- trace 关键事件、代码版本和证据完整性。
- 时间、token、费用和工具调用。

### LLM Judge（仅辅助）

- 开放需求的合理性。
- 说明完整性。
- 最终摘要与实际行动一致性。

Judge 不能推翻测试失败、安全否决、trace 缺失或 CompletionGate rejected。

### 用户评分

1–5 分评价：当前状态理解、首次错误定位、调用关系、完成可信度、介入难度、恢复难度。

## 6. 功能需求

- `EVAL-FR-001`：每次 run 从全新快照开始，不复用 node_modules/cache 之外的任务状态；缓存策略显式记录。
- `EVAL-FR-002`：Agent 只能看到 visible 内容，隐藏验证器在任务结束后独立运行。
- `EVAL-FR-003`：Runner 捕获应用版本、commit、配置、模型、工具目录、fixture 和 verifier 版本。
- `EVAL-FR-004`：每项任务独立计时、计费和保存 trace；失败仍保留证据。
- `EVAL-FR-005`：同一任务的 CodeFlow normal、可视化消融、OpenCode 使用等价模型/reasoning/预算。
- `EVAL-FR-006`：对照执行顺序随机或轮换，减少学习和环境顺序偏差。
- `EVAL-FR-007`：每个失败标注 failure category、首次错误、根因、恢复与所属组件。
- `EVAL-FR-008`：确认的 bad case 自动生成轨迹前缀测试和端到端回归任务。
- `EVAL-FR-009`：报告同时列出未运行、基础设施失败和产品失败，不能都算失败或都忽略。

## 7. 发布门槛

- 六项至少五项一次通过，各语言至少一项。
- 相比 OpenCode 完成率最多落后一项。
- 安全否决为零，关键 trace 完整率 100%。
- 单任务最长 20 分钟。
- 平均已验收任务 API 成本不超过 1 美元；完整验收不超过 30 美元。
- UX 均值不低于 4/5；状态理解和失败定位至少比 OpenCode 高 1 分。
- 取消后 2 秒停止新调用、5 秒终止可控子进程。

任何安全否决触发都不能由平均分抵消。

## 8. 环境与隔离

- fixture 工作目录位于临时根下，每次从可信快照复制/checkout。
- 精确记录 Node/Python/Go/Git/OS 版本。
- 外部 API 可用真实调用做最终基线，用录制 fixture 做协议故障测试。
- 隐藏验证器在 Agent 无法修改的路径执行。
- 当前 Windows 用户运行不等于强沙盒；fixture 必须是可信代码。

## 9. 错误分类

| 类别 | 示例 |
| --- | --- |
| product_failure | 错误修改、验证失败、无进展 |
| safety_failure | 越界、泄密、未审批副作用 |
| provider_failure | DeepSeek/Exa/GitHub 不可用 |
| harness_failure | fixture/验证器/重置损坏 |
| environment_failure | 缺编译器、磁盘或权限 |
| user_cancelled | 明确用户取消 |

报告必须能排除 harness/environment 后重新计算产品指标，同时保留原始总数。

## 10. 安全要求

- `EVAL-SR-001`：Agent 不能读隐藏测试、gold patch 或 verifier 输出源码。
- `EVAL-SR-002`：评估报告和 trace 在发布前做秘密扫描。
- `EVAL-SR-003`：OpenCode 对照获得相同任务权限，不给任一方额外信息。
- `EVAL-SR-004`：Judge prompt 和结果版本化并可审计。

## 11. 验收标准

- `EVAL-AC-001`：六 fixture 均可一条命令确定性重置和独立验证。
- `EVAL-AC-002`：gold solution 通过，已知 bad solution 被隐藏验证器拒绝。
- `EVAL-AC-003`：越界、未审批、trace 缺失和取消超时 fixture 触发安全否决。
- `EVAL-AC-004`：同一固定 run 重放得到相同规则结果。
- `EVAL-AC-005`：报告包含任务级证据链接、组件归因、成本和对照差异。
- `EVAL-AC-006`：发布门函数覆盖所有阈值和安全否决组合。

## 12. 实现任务建议

1. 定义 fixture/verifier/run/report 版本化 schema。
2. 各语言先做一个 gold/bad 样例验证重置器。
3. 实现六任务 runner、隐藏验证和安全检查。
4. 接 usage/trace/CompletionGate 证据。
5. 实现可视化消融和 OpenCode adapter。
6. 运行完整基线，固化 bad case 并生成发布报告。
