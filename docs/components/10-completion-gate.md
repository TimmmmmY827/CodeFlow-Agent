# C10 CompletionGate 与完成声明

- 状态：旧版 CompletionClaim 基础校验、可审计 SafetyVeto 和 `finish_task` 工厂已实现；CompletionIntent/GateContext、完整 evidence、稳定 reason code 和真实证据 Provider 未接
- 目标阶段：D4
- 代码位置：`src/completion/completion-gate.ts`、`src/tools/builtin/finish-task.ts`
- 硬依赖：[C00](00-shared-contracts.md)、[C01](01-event-state.md)、[C02](02-storage-artifacts.md)
- 下游消费者：C09 `finish_task`、C11、C13、C15

## 1. 目标

把“模型认为做完了”转换为可验证完成：模型只提交完成意图和证据引用，系统独立取得当前代码版本、验证证据、trace 完整性和安全否决；任一硬门不满足就拒绝完成并返回可操作原因。

## 2. 职责边界

### 必须负责

- CompletionIntent 与 CompletionGateContext schema、版本和可信来源。
- 代码/diff 快照绑定、必需验证器、证据、trace 完整性和安全否决检查。
- 区分阻塞与非阻塞未验证项。
- 输出 verified/rejected 及稳定 reason codes。

### 明确不负责

- 自己运行测试、生成 diff、决定工具调用、伪造用户验收或修改代码。
- 用 LLM Judge 推翻硬规则。

## 3. 输入契约与信任边界

```ts
interface CompletionIntent {
  intentVersion: number;
  observedCodeVersion: CodeSnapshot["codeVersion"];
  observedDiffHash: CodeSnapshot["diffHash"];
  evidenceIds: StableId[];
  unverifiedItems: { description: string; blocking: boolean }[];
  summary: string;
}

interface VerificationEvidence {
  schemaVersion: number;
  id: StableId;
  name: string;
  kind: "test" | "build" | "lint" | "static" | "manual" | "runtime";
  required: boolean;
  status: "passed" | "failed" | "not_run";
  commandOrProcedure: string;
  artifact: ArtifactReference | null;
  codeVersion: CodeSnapshot["codeVersion"];
  diffHash: CodeSnapshot["diffHash"];
  producedBy: { kind: "tool" | "user" | "system"; referenceId: StableId };
  verifiedAt: UtcTimestamp;
}

interface SafetyVeto {
  code: string;
  description: string;
  eventId: StableId | null;
  artifact: ArtifactReference | null;
}

interface CompletionGateContext {
  schemaVersion: number;
  gateVersion: string;
  sessionId: StableId;
  runId: StableId;
  snapshot: CodeSnapshot;
  traceIntegrity: TraceIntegrityReport;
  evidence: VerificationEvidence[];
  safetyVetoes: SafetyVeto[];
  activeOperationIds: StableId[];
  unknownOperationIds: StableId[];
}
```

`CompletionIntent` 来自模型，因此所有字段都不具备事实权威性；observed version 只用于检测陈旧意图，evidence ID 必须由系统解析。`CompletionGateContext` 只能由 C11 从 C01 trace integrity、C02 Artifact verifier、当前 CodeSnapshot 和 C03/C08 安全/operation ledger 组装。模型不能提交、覆盖或删减 `traceIntegrity`、`safetyVetoes`、活动操作和未知操作。

当前实现仍使用可自报 `traceComplete`、verification 和 safetyVetoes 的 `CompletionClaim`，只代表可编译基线；接线真实 `finish_task` 前必须迁移到上述目标契约。当前 `SafetyVeto` 至少引用 event 或 Artifact 的校验继续保留。

## 4. 判定顺序

1. intent/context schema 合法且版本受支持。
2. intent observed version 与 context 最新 CodeSnapshot 一致。
3. context 没有 active/unknown operation。
4. 系统取得的安全否决为空。
5. 系统取得的关键 trace 完整。
6. 至少一个系统认可的 required verifier。
7. 所有 required verifier passed、有可验证 Artifact/过程证据且绑定最新 code/diff。
8. intent 没有 blocking unverified item。
9. 输出 verified；否则一次返回全部可修复原因。

安全否决优先级最高，但 Gate 仍可收集其他原因用于调试。

## 5. Outcome 规则

### Bug 修复

- 原问题可复现或已有明确失败证据。
- 修复后失败消失，相关测试/构建/静态检查通过。
- 没有明显回归和无关改动。
- diff、证据、未验证项和 trace 完整。

### 功能实现

- 用户验收条件映射为 verifier 或明确的 manual evidence。
- 项目可构建或运行，新增/相关测试通过。
- 无法自动验证的非阻塞条件明确列出；阻塞条件必须由用户完成验收。

## 6. 功能需求

- `GATE-FR-001`：Gate 是纯判定组件，相同 intent/context 得到相同结果；证据获取在 Gate 外完成。
- `GATE-FR-002`：passed 但无 Artifact/过程证据的 verifier 被拒绝。
- `GATE-FR-003`：代码或 diff 在验证后变化使旧证据失效。
- `GATE-FR-004`：安全否决不可由平均分、用户体验或 Judge 抵消。
- `GATE-FR-005`：rejected 返回稳定 codes、用户文案和建议下一动作。
- `GATE-FR-006`：verified 决策进入事件后不可被普通摘要覆盖；后续代码变化必须开启新运行状态。
- `GATE-FR-007`：manual evidence 记录验收者、时间、条件和对应版本，不只保存“用户说可以”。
- `GATE-FR-008`：CompletionIntent、GateContext 和 Gate 版本进入事件与导出，但不复制敏感证据正文。
- `GATE-FR-009`：未找到、损坏、来源不可信或不在 intent 引用集合中的证据不能成为通过依据；系统安全否决即使未被 intent 引用也必须生效。
- `GATE-FR-010`：GateContext 组装失败按 fail-closed 返回 rejected，不允许退回使用模型自报字段。

## 7. 安全否决

至少包括：越界修改、覆盖无关用户改动、泄密、未授权高风险操作、破坏性 Git、伪造验证、关键 trace 缺失、取消后继续产生副作用。

否决来源必须引用事件或 Artifact，不能只保存自然语言标签；当前 `safetyVetoSchema` 已执行这一最小门禁。

## 8. 错误与恢复

| 情况 | 结果 | 后续 |
| --- | --- | --- |
| intent schema 无效 | rejected | 模型按字段重提 |
| GateContext 无法取得 | rejected | 修复 trace/storage/provider，不信任 intent 自报 |
| snapshot 已变化 | rejected | 重新 diff/验证 |
| verifier failed | rejected | 回 RUNNING 修复 |
| verifier not_run | rejected | 执行验证或用户接受为非阻塞 |
| Artifact 缺失/损坏 | rejected | 重新运行验证 |
| 安全否决 | rejected/FAILED | 根据否决类型停止或人工处理 |
| Provider 状态 unknown | rejected | 对账后再 claim |

## 9. 事件要求

- `completion.claimed`：intent hash、模型观察到的 code/diff version、evidence IDs。
- `completion.rejected`：稳定 reason codes 和证据引用。
- `completion.verified`：Gate/context 版本、可信 snapshot、证据集合 hash和 trace integrity report 引用。
- 不在事件中复制长测试日志或秘密。

## 10. 验收标准

- `GATE-AC-001`：版本/diff、证据、trace、安全、未验证项的组合表驱动测试。
- `GATE-AC-002`：测试通过后修改任一文件，旧 claim 被拒绝。
- `GATE-AC-003`：安全否决存在时 Judge 高分仍不能通过。
- `GATE-AC-004`：Artifact 删除/损坏使完成失败并指出具体 evidence ID。
- `GATE-AC-005`：六任务 fixture 的规则结果可确定重放。
- `GATE-AC-006`：从 finish_task 到 completion.verified/rejected 形成完整事件链。
- `GATE-AC-007`：恶意 intent 无法通过自报 traceComplete=true、空 veto 或伪造 passed evidence 绕过系统 Context。
- `GATE-AC-008`：存在未结束/UNKNOWN operation 时，即使全部测试通过也拒绝完成。

## 11. 实现任务建议

1. 将旧 CompletionClaim 迁移为 CompletionIntent/GateContext，并扩展 evidence/reason schema 和版本。
2. 实现 Git/空目录 CodeSnapshotProvider。
3. 实现 trace completeness 与 Artifact verifier。
4. 将 finish_task 注册并接 C11 事件转换。
5. 建 Bug/功能两类 Gate fixture 和安全否决测试。
