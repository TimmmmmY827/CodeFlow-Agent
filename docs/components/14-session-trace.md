# C14 Session、Trace 与生命周期治理

- 状态：内存事件、最小存储接口和基础 JSON 脱敏存在；Session repository、恢复、retention 和删除传播缺失
- 目标阶段：D7
- 代码位置：`src/storage/`、`src/trace/`、Application Session use cases
- 硬依赖：[C01](01-event-state.md)、[C02](02-storage-artifacts.md)、[C03](03-permission-engine.md)、[C12](12-application-service.md)
- 下游消费者：C13、C15、恢复流程

## 1. 目标

管理 Session 从创建、运行、暂停、恢复、pin、导出到删除的完整生命周期，并提供可审计、可脱敏、可定位首错的 trace，而不演变成跨任务长期记忆。

## 2. 职责边界

### 必须负责

- Session 元数据、列表、恢复检查点和状态摘要。
- Trace 查询、树化、过滤、首错定位和脱敏导出。
- 30 天保留、pin、删除传播与删除收据。
- 敏感 reasoning transcript 与普通 trace 的隔离。
- 恢复前工具/配置版本检查和 UNKNOWN 对账入口。

### 明确不负责

- 自动把旧 Session 检索进新任务、长期偏好学习、RAG 或云同步。

## 3. Session 契约

当前没有 `SessionRecord` repository 或恢复用例；仅有最小 `SessionRepository` 接口、内存事件和基础 JSON 脱敏导出。WorkspaceRecord、CreateSessionRecord、SessionRecord、SessionFilter、SessionSummary 和 DeleteReceipt 的唯一目标定义位于 C02；C14 只实现生命周期用例和派生视图，不重新定义存储记录。

```ts
interface SessionGovernanceService {
  pin(sessionId: StableId): Promise<SessionSummary>;
  unpin(sessionId: StableId): Promise<SessionSummary>;
  delete(sessionId: StableId): Promise<DeleteReceipt>;
  getTrace(sessionId: StableId, options: TraceOptions): AsyncIterable<TraceItem>;
  export(sessionId: StableId, options: ExportOptions): Promise<ArtifactReference>;
  inspectRecovery(sessionId: StableId): Promise<RecoveryReport>;
}

interface TraceOptions {
  afterSequence?: number;
  kinds?: string[];
  redaction: "default" | "metadata_only";
}

interface TraceItem {
  event: AgentEvent;
  depth: number;
  firstError: boolean;
  relatedArtifactRefs: ArtifactReference[];
}

interface ExportOptions {
  format: "json" | "ndjson";
  includeNormalArtifacts: boolean;
  destination: PathReference;
}

interface RecoveryCheck {
  area: "schema" | "event_sequence" | "config" | "tool_catalog" |
        "model_protocol" | "artifact" | "provider_operation";
  status: "compatible" | "migrated" | "read_only" |
          "reconcile_required" | "blocked";
  recordedVersion: string | null;
  currentVersion: string | null;
  reasonCode: string;
  action: string;
}

interface RecoveryReport {
  schemaVersion: number;
  sessionId: StableId;
  checks: RecoveryCheck[];
  resumable: boolean;
}

interface SensitiveTranscriptRecord {
  schemaVersion: number;
  recordId: StableId;
  sessionId: StableId;
  provider: string;
  protocolVersion: string;
  encryptedArtifact: ArtifactReference;
  contentHash: string;
  createdAt: UtcTimestamp;
}
```

新任务默认创建新 Session，不搜索旧 Session；用户只能显式 resume 或引用旧 Artifact。

## 4. Trace 视图

Trace 是事件的派生表示，至少支持：

- 按时间/sequence 列表。
- 按 span/parent span 的调用树。
- 计划 revision 和任务树。
- 文件/代码版本变化时间线。
- 审批、预算、验证、安全和错误过滤。
- 首次错误、首次偏离、最后恢复动作。
- JSON/NDJSON 脱敏导出。

导出保留事件 ID、hash 和 Artifact 元数据，敏感 Artifact 内容默认不包含。

## 5. 功能需求

- `SESSION-FR-001`：create 返回持久化 Session 后才能启动模型。
- `SESSION-FR-002`：resume 重放全部事件并验证 sequence、schema、config/tool version。
- `SESSION-FR-003`：存在 unknown 外部操作时先对账，禁止直接继续模型循环。
- `SESSION-FR-004`：pin 清除自动 expiresAt；unpin 重新按策略计算。
- `SESSION-FR-005`：export 使用版本化格式和 redaction manifest，列出排除项。
- `SESSION-FR-006`：delete 需要明确 Session ID，传播到 reasoning、events、approvals、usage 和 artifacts。
- `SESSION-FR-007`：删除失败返回逐项 receipt，可安全重试直到完成。
- `SESSION-FR-008`：首错定位基于结构化 error/category/span，不依赖字符串搜索。
- `SESSION-FR-009`：Trace 完整性检查结果可被 C10/C15 机器读取。
- `SESSION-FR-010`：新 Session 不读取旧 Session，除非用户显式传引用。
- `SESSION-FR-011`：Workspace 使用 C02 生成的稳定 workspace ID 和 `PathReference`；路径移动、Git remote/根 fingerprint 变化产生显式重新绑定，不用路径字符串冒充 ID。
- `SESSION-FR-012`：恢复兼容检查分别报告 event/schema、config、tool catalog、model protocol、Artifact 和 Provider operation；不得用一个布尔值掩盖需要对账的部分。

## 6. 恢复流程

```text
load Session
 -> verify schema/migrations
 -> verify event sequence
 -> replay StateReducer
 -> verify config/tool versions
 -> verify Artifact hashes
 -> reconcile UNKNOWN operations
 -> rebuild transcript/checkpoint
 -> expose resumable handle or blocking report
```

`RecoveryReport` 对每一项返回 `compatible | migrated | read_only | reconcile_required | blocked`、当前/记录版本、reason code 和建议动作。`read_only` 允许查看/导出但不继续模型；`reconcile_required` 必须完成对应 Provider 只读查询后才能继续；`blocked` 不得绕过。

### 6.1 敏感 transcript

- 普通 RuntimeEventLog 与 ModelTranscriptProjection 分库存储/分访问接口；普通 trace projector 永不读取敏感 blob。
- provider continuation/reasoning 以 `SensitiveTranscriptRecord` 元数据和加密 blob 保存，只在恢复同一 Session 的 ModelAdapter 时按 handle 读取。
- MVP Windows 实现使用每安装数据加密 key，并由 Windows 用户级数据保护机制保护该 key；若保护机制不可用，禁用“跨进程 reasoning continuation”能力并明确阻止恢复，不能降级为明文持久化。
- 密文仍按敏感数据处理：不进普通备份/导出，删除传播覆盖元数据、blob、临时文件和 key reference。

## 7. 脱敏规则

- 永久排除 API Key、token、password、secret、Authorization header 和 reasoning 原文。
- 保留 authorizationId/approvalId 作为审计引用，但不保留批准 token。
- 文件内容、网页和命令输出默认只导出摘要/Artifact 元数据；用户显式选择后才含正文。
- 每次导出生成 redaction manifest，说明规则版本和排除数量。

删除完成后只允许保留最小审计墓碑：schema version、delete receipt ID、带安装级盐的 Session ID 摘要、请求/完成时间、最终状态和各 target 的数量；不得保留 goal、路径、事件、批准摘要、Artifact 名称或 reasoning。墓碑只能证明“删除流程发生并完成”，不能恢复 Session。

## 8. 错误与恢复

| category | 行为 |
| --- | --- |
| `session_not_found` | 明确不存在，不新建同 ID |
| `trace_incomplete` | 允许查看，禁止 verified completion |
| `artifact_missing` | 标记证据损坏，尝试重新验证 |
| `version_incompatible` | 生成迁移/阻止报告 |
| `external_state_unknown` | 运行只读对账 |
| `delete_incomplete` | 返回 receipt，继续传播 |

## 9. 安全要求

- `SESSION-SR-001`：Session ID 不作为权限；所有路径仍按当前授权工作区验证。
- `SESSION-SR-002`：导出文件默认写入应用数据或用户明确路径，不覆盖已有文件。
- `SESSION-SR-003`：删除和导出操作写审计，但删除完成后不保留可恢复的敏感内容副本。
- `SESSION-SR-004`：恢复不能复活已消费批准或已取消调用。

## 10. 验收标准

- `SESSION-AC-001`：在模型、工具、审批、验证各阶段杀进程，恢复状态正确。
- `SESSION-AC-002`：unknown 发布恢复先对账且不创建重复 PR。
- `SESSION-AC-003`：导出中找不到秘密/reasoning，审批引用和首错证据仍完整。
- `SESSION-AC-004`：删除传播后数据库、Artifact 目录、导出和恢复都找不到 Session。
- `SESSION-AC-005`：30 天 retention 和 pin/unpin 的时间边界可用虚拟时钟测试。
- `SESSION-AC-006`：新任务默认不会把旧 Session 内容送给模型。
- `SESSION-AC-007`：兼容矩阵覆盖可迁移、只读、需对账和阻塞；任一阻塞项都不会创建新模型/工具调用。
- `SESSION-AC-008`：敏感 continuation 的普通 trace/导出/搜索均不可见；保护机制不可用时不会写明文替代品。
- `SESSION-AC-009`：删除后仅存在最小墓碑，秘密扫描和恢复尝试都无法还原 goal、路径、事件或 reasoning。

## 11. 实现任务建议

1. 实现 SessionRepository/use cases 和恢复报告。
2. 实现 trace query/tree/first-error projector。
3. 扩展 exporter 与 redaction manifest。
4. 实现 retention/pin/delete receipt。
5. 接 UNKNOWN reconciliation 和版本兼容检查。
6. 做跨进程恢复、删除与秘密扫描测试。
