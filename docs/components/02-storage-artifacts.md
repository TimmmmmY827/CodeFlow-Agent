# C02 存储、EventStore 与 ArtifactStore

- 状态：SQLite schema、C01 内存 EventStore 和最小 storage 接口存在；SQLite/File 持久化、Session 元数据与恢复缺失
- 目标阶段：D7；接口应在 D3 前冻结
- 代码位置：`src/storage/`、`src/events/event-store.ts`
- 硬依赖：[C00](00-shared-contracts.md)、[C01](01-event-state.md)
- 下游消费者：C08、C10、C11、C12、C14、C15

## 1. 目标

在本机可靠保存 Workspace、Session、Task、事件、审批、用量和大结果，使进程崩溃后可以重放恢复，并使 pin、导出、30 天保留和彻底删除具有可验证语义。

## 2. 职责边界

### 必须负责

- SQLite 连接、迁移、事务、单写者和数据完整性。
- `SqliteEventStore`、`SqliteSessionRepository` 和文件型 `ArtifactStore`。
- Artifact hash、媒体类型、敏感级别、大小和相对路径。
- Session 级删除传播、保留期扫描、pin 和恢复查询。
- Windows 崩溃、锁、磁盘满和文件丢失处理。

### 明确不负责

- 决定事件内容、生成 UI、模型上下文压缩或长期用户记忆。
- 云端同步、遥测、多用户权限和跨设备一致性。

## 3. 前置依赖与解锁条件

| 依赖 | 需要稳定的能力 | 未满足时禁止 |
| --- | --- | --- |
| C00 | ID、时间、CodeSnapshot、ArtifactReference、错误格式 | 创建数据库迁移 |
| C01 | 事件 schema、sequence、主版本规则 | 实现持久化 EventStore |

C08 可先依赖 `ArtifactStore` 接口开发；C14 的恢复、删除和保留期必须等待真实实现通过崩溃测试。

## 4. 存储布局

```text
<data-dir>/
├─ codeflow.sqlite
├─ codeflow.sqlite-wal
├─ codeflow.sqlite-shm
└─ artifacts/
   └─ <session-id>/
      └─ <artifact-id>.<ext>
```

数据库保存元数据、状态和引用；长命令输出、patch、网页正文、测试日志和导出文件保存为 Artifact。事件不得内嵌超限内容。

## 5. 公开接口

### 5.1 当前可编译基线

`EventStore` 已由 C01 提供内存实现；`src/storage/storage.ts` 目前只有供 C08 使用的最小接口，没有 Session 元数据、读取/校验 Artifact、pin、retention 或删除收据：

```ts
interface SessionRepository {
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(sessionId: StableId): Promise<readonly AgentEvent[]>;
  deleteSession(sessionId: StableId): Promise<void>;
}

interface ArtifactStore {
  write(sessionId: StableId, mediaType: string, content: Uint8Array,
        sensitivity: "normal" | "sensitive"): Promise<ArtifactReference>;
  deleteSessionArtifacts(sessionId: StableId): Promise<void>;
}
```

### 5.2 目标接口（规划中）

以下接口是 C02 的完成目标，尚不能被下游当作已存在的代码导入：

```ts
interface EventStore {
  append(event: AgentEvent): Promise<"inserted" | "duplicate">;
  list(sessionId: StableId, afterSequence?: number): Promise<readonly AgentEvent[]>;
  latestSequence(sessionId: StableId): Promise<number | null>;
}

interface SessionRepository {
  create(input: CreateSessionRecord): Promise<void>;
  get(sessionId: StableId): Promise<SessionRecord | null>;
  list(filter: SessionFilter): Promise<SessionSummary[]>;
  setPinned(sessionId: StableId, pinned: boolean): Promise<void>;
  delete(sessionId: StableId): Promise<DeleteReceipt>;
}

interface ArtifactStore {
  write(sessionId: StableId, mediaType: string, content: Uint8Array,
        sensitivity: "normal" | "sensitive"): Promise<ArtifactReference>;
  read(ref: ArtifactReference): Promise<Uint8Array>;
  verify(ref: ArtifactReference): Promise<boolean>;
  deleteSessionArtifacts(sessionId: StableId): Promise<DeleteReceipt>;
}
```

## 6. 功能需求

- `STORE-FR-001`：数据库启动时按顺序执行版本化 migration，失败时不启动 Agent。
- `STORE-FR-002`：事件 append 与 Session `updated_at/status` 更新在同一事务完成。
- `STORE-FR-003`：相同 event ID 或 Session+sequence 的完全相同事件幂等；内容不同则报完整性错误。
- `STORE-FR-004`：Artifact 先写临时文件、fsync/关闭、计算 hash，再原子重命名并登记数据库。
- `STORE-FR-005`：读取 Artifact 必须验证路径仍位于 data dir 且 hash 匹配。
- `STORE-FR-006`：删除 Session 同时删除事件、任务、审批、用量、Artifact 元数据与文件，并返回逐项收据。
- `STORE-FR-007`：默认 30 天到期，pinned Session 不被清理；清理任务可重复运行。
- `STORE-FR-008`：恢复查询返回最后稳定状态、最新 sequence、未完成外部操作和缺失 Artifact 清单。
- `STORE-FR-009`：所有写操作在单进程内串行；多进程争用时第二实例只读或明确拒绝。

## 7. 一致性与崩溃恢复

- SQLite 使用 WAL、foreign keys 和 busy timeout。
- 数据库记录存在但文件缺失：标记 Artifact 损坏，不能伪造工具成功。
- 文件存在但数据库记录缺失：作为 orphan，延迟清理，不自动纳入 Session。
- 外部写事件处于 `unknown`：恢复只加载事实，由 C09 Provider 查询真实状态。
- 删除中断：使用 delete receipt/墓碑继续传播，直到数据库和文件都不存在。

## 8. 错误分类

| category | 重试 | 恢复 |
| --- | --- | --- |
| `storage_busy` | 有界重试 | 指数退避后提示用户 |
| `storage_corrupt` | 否 | 停止写入，保留文件供诊断 |
| `disk_full` | 用户处理后 | 暂停 Session，不删除证据 |
| `artifact_hash_mismatch` | 否 | 标记损坏，禁止完成 |
| `migration_failed` | 否 | 保持旧版本，终止启动 |
| `delete_incomplete` | 是 | 根据收据继续删除 |

## 9. 安全与隐私

- `STORE-SR-001`：data dir 和 Artifact 路径必须阻止 `..`、junction/symlink 越界。
- `STORE-SR-002`：API Key 不入库；敏感 Artifact 在导出时默认排除。
- `STORE-SR-003`：SQL 只使用参数化查询。
- `STORE-SR-004`：普通删除必须覆盖所有引用；无法保证物理擦除时在产品说明中明确。

## 10. 验收标准

- `STORE-AC-001`：进程在任意事件写入点终止，重启后得到完整旧状态或完整新状态。
- `STORE-AC-002`：一万事件追加、分页、重放顺序正确且无重复。
- `STORE-AC-003`：长输出写入后数据库 hash、文件 hash 和读取内容一致。
- `STORE-AC-004`：Session 删除后数据库查询、文件扫描和导出均找不到关联内容。
- `STORE-AC-005`：30 天清理跳过 pinned Session，重复运行结果相同。
- `STORE-AC-006`：Windows 文件锁、磁盘满、数据库 busy 和损坏 fixture 有明确错误。

## 11. 实现任务建议

1. 建 migration runner 和连接配置。
2. 实现 SqliteEventStore 与幂等/顺序测试。
3. 实现 SessionRepository 和 usage/approval repository。
4. 实现 FileArtifactStore 的原子写、hash 和边界检查。
5. 实现恢复摘要、retention 和删除传播。
6. 做崩溃、锁、磁盘与 orphan 故障注入。
