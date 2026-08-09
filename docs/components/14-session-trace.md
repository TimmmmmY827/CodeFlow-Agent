# C14 Session、Trace 与生命周期治理

- 状态：内存 Session、存储接口和基础 JSON 脱敏存在
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

```ts
interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  goal: string;
  lifecycle: SessionLifecycle;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  pinned: boolean;
  configVersion: string;
  toolCatalogHash: string;
  lastSequence: number;
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

## 7. 脱敏规则

- 永久排除 API Key、token、password、secret、Authorization header 和 reasoning 原文。
- 保留 authorizationId/approvalId 作为审计引用，但不保留批准 token。
- 文件内容、网页和命令输出默认只导出摘要/Artifact 元数据；用户显式选择后才含正文。
- 每次导出生成 redaction manifest，说明规则版本和排除数量。

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

## 11. 实现任务建议

1. 实现 SessionRepository/use cases 和恢复报告。
2. 实现 trace query/tree/first-error projector。
3. 扩展 exporter 与 redaction manifest。
4. 实现 retention/pin/delete receipt。
5. 接 UNKNOWN reconciliation 和版本兼容检查。
6. 做跨进程恢复、删除与秘密扫描测试。
