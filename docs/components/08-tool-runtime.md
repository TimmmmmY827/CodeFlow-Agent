# C08 ToolRuntime

- 状态：输入校验、权限、hash、执行、JSON 边界和 Artifact 外置基础已实现；toolVersion、outputSchema、timeout、预算/事件持久化和故障恢复缺失
- 目标阶段：D3–D4
- 代码位置：`src/tools/tool-runtime.ts`
- 硬依赖：[C00](00-shared-contracts.md)、[C02](02-storage-artifacts.md)、[C03](03-permission-engine.md)、[C07](07-tool-registry.md)
- 下游消费者：C09、C11、C14、C15

## 1. 目标

作为所有工具调用的唯一执行入口，按固定顺序完成 schema 校验、操作身份计算、权限、预算/取消边界、执行、输出限制、错误归一化和 trace 生命周期，防止各工具重复或绕过安全逻辑。

## 2. 职责边界

### 必须负责

- 从 Registry 取定义，校验输入，计算 operation hash。
- 调 PermissionEngine 并消费匹配批准。
- 建 ToolExecutionContext，执行工具并遵守 AbortSignal/timeout。
- 输出统一 ToolResultEnvelope；长结果写 ArtifactStore。
- 根据 sideEffect/retry policy 产生 failed/cancelled/unknown。
- 发出可转换为 AgentEvent 的 started/finished 生命周期。

### 明确不负责

- 决定调用哪个工具、与用户交互批准、实现具体工具或自动对账外部状态。

## 3. 执行流水线

### 3.1 当前可编译流水线

```text
lookup -> validate input -> canonical operation hash -> cancellation check
 -> permission decision -> check/consume in-memory approval -> emit started
 -> execute -> JSON serialization boundary -> inline or ArtifactStore
 -> emit finished -> return envelope
```

当前没有 budget reservation、per-tool timeout、outputSchema 或持久化 event/approval；observer/ArtifactStore 失败后的证据恢复也未完成。

### 3.2 目标流水线（规划中）

```text
lookup
 -> validate input
 -> canonical operation hash
 -> permission decision
 -> budget reservation（由 Loop 注入/协调）
 -> cancellation check
 -> consume approval
 -> emit started
 -> execute with timeout
 -> validate output
 -> inline or ArtifactStore
 -> classify side effect
 -> emit finished
 -> return envelope
```

目标顺序是安全契约。尤其批准必须绑定解析后的最终输入，并在副作用开始前完成事务性消费。

## 4. 结果信封

### 4.1 当前可编译基线

当前 `ToolResultEnvelope` 没有 `toolVersion`；Runtime 只验证输出可 JSON 序列化，没有 `outputSchema`。默认 inline 上限和 Artifact 外置已实现，但 per-tool timeout、环境 allowlist、预算 reservation、持久化批准消费与事件 writer 尚未接入。

```ts
interface ToolResultEnvelope {
  toolName: string;
  operationHash: string;
  status: "completed" | "failed" | "approval_required" |
          "denied" | "cancelled" | "unknown";
  durationMs: number;
  sideEffectStatus: SideEffectStatus;
  output: JsonValue | null;
  artifact: ArtifactReference | null;
  error: StructuredError | null;
}
```

### 4.2 目标接口（规划中）

```ts
interface ToolResultEnvelope<O = unknown> {
  toolName: string;
  toolVersion: string;
  operationHash: string;
  status: "completed" | "failed" | "approval_required" |
          "denied" | "cancelled" | "unknown";
  durationMs: number;
  sideEffectStatus: "none" | "not_started" | "applied" | "unknown";
  output: O | null;
  artifact: ArtifactReference | null;
  error: StructuredError | null;
}
```

## 5. 功能需求

- `RUNTIME-FR-001`：未知工具和非法输入不得进入权限或 execute。
- `RUNTIME-FR-002`：output 必须通过 output schema；失败保留原始结果为敏感 Artifact 供诊断，不传模型。
- `RUNTIME-FR-003`：每个工具有默认 timeout 和最大 inline bytes，配置可按工具收紧。
- `RUNTIME-FR-004`：stdout/stderr、网页和 diff 超限时写 Artifact，context 只含摘要、hash、大小和引用。
- `RUNTIME-FR-005`：调用 started/finished 必须带相同 operation hash/span。
- `RUNTIME-FR-006`：无副作用工具失败按 retry policy 返回 retryable；可能已写的工具失败返回 `unknown` 或 `applied`，不得自动标 safe retry。
- `RUNTIME-FR-007`：批准 required/denied 不调用 execute，不计为实际工具副作用。
- `RUNTIME-FR-008`：取消发生在执行前返回 not_started；执行中写工具的取消可能返回 unknown。
- `RUNTIME-FR-009`：observer、ArtifactStore 或事件写入失败不得让已经发生的副作用被描述为未发生。
- `RUNTIME-FR-010`：Runtime 不把环境变量全集传给子进程；按工具 allowlist 构造环境。

## 6. 错误与恢复矩阵

| side effect | 执行前失败 | 执行中失败/断连 | 重试 |
| --- | --- | --- | --- |
| none | failed/not_started | failed/none | policy=safe 时有界重试 |
| workspace_write | failed/not_started | unknown 或 applied | 先检查 codeVersion/diff |
| external_write | failed/not_started | unknown | Provider 对账后决定 |

## 7. 并发

- 默认串行执行模型返回的多个 tool call。
- 只有 Registry 标记为 `none + safe` 且路径/资源集合互不冲突的只读调用可并行。
- 并行前由 C04 原子预留预算；事件仍通过 C01 单写者排序。
- 写工具同一 workspace 互斥。

## 8. 安全要求

- `RUNTIME-SR-001`：任何工具都不能绕过 Registry/Permission/Budget/事件入口直接被 Loop 调用。
- `RUNTIME-SR-002`：工作区路径在 execute 前和文件打开后都校验，防止 symlink/junction TOCTOU。
- `RUNTIME-SR-003`：错误 message、输出和 observer 事件经过秘密处理。
- `RUNTIME-SR-004`：批准 token 不传给工具实现，仅由 Runtime 消费。

## 9. 验收标准

- `RUNTIME-AC-001`：流水线每一阶段的失败都不执行后续阶段。
- `RUNTIME-AC-002`：参数重排 hash 稳定；参数或 codeVersion 改变使批准失效。
- `RUNTIME-AC-003`：同一批准第二次使用被拒绝。
- `RUNTIME-AC-004`：长结果正确外置，缺 ArtifactStore 时安全失败不静默截断。
- `RUNTIME-AC-005`：外部写在响应丢失 fixture 中返回 unknown/retryable=false。
- `RUNTIME-AC-006`：取消、timeout、observer 失败和 ArtifactStore 失败的副作用状态准确。
- `RUNTIME-AC-007`：18 个工具契约测试都只能通过 Runtime 执行。

## 10. 实现任务建议

1. 补 tool version/output schema 和稳定错误类型。
2. 接持久化批准消费、事件 writer 和 Budget reservation。
3. 增加 timeout、环境 allowlist 和输出摘要器。
4. 增加路径/资源冲突描述和安全只读并行。
5. 用每类副作用工具做故障注入和对账测试。
