# C02 存储、EventStore 与 ArtifactStore

- 状态：C02 核心 SQLite/Event/Session/Task/File Artifact、迁移、删除/保留与恢复检查已实现；C08/C11 journal adapter、原生 Windows handle-relative 加固与跨进程强杀验收仍延期
- 目标阶段：D7；接口应在 D3 前冻结
- 代码位置：`src/storage/`、`src/events/event-store.ts`
- 测试位置：`tests/sqlite-*.test.ts`、`tests/file-artifact-store.test.ts`、`tests/artifact-file-deleter.test.ts`、`tests/session-deletion-service.test.ts`、`tests/retention-service.test.ts`、`tests/storage-recovery-inspector.test.ts`
- 硬依赖：[C00](00-shared-contracts.md)、[C01](01-event-state.md)
- 参考 ADR：[ADR-0004](../decisions/0004-node-sqlite-storage-runtime.md)
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

C08 可先依赖 `ArtifactStore` 接口开发；C14 的恢复、删除和保留期必须等待真实实现通过崩溃测试。C08/C11 分别拥有 execution/model journal 端口，C02 的基础 repository 不反向导入业务组件；这些端口冻结后，由 `src/storage/` 中的 SQLite adapter 实现并在 C12 组装，因此依赖反转不形成核心接口循环。

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

### 5.1 已实现基线

`EventStore` 由 C01 拥有语义；C02 已提供 SQLite provider、Session/Task repository、文件 ArtifactStore、迁移和恢复协议。`ToolRuntime` 只依赖最小 Artifact 写入端口：

```ts
interface ArtifactWriter {
  write(sessionId: StableId, mediaType: string, content: Uint8Array,
        sensitivity: "normal" | "sensitive"): Promise<ArtifactReference>;
}
```

### 5.2 C02 公开接口

以下接口由 C02 代码拥有；下游只能导入，不得重新定义：

```ts
interface WorkspaceRecord {
  schemaVersion: number;
  workspaceId: StableId;
  root: PathReference;
  fingerprint: string;
  createdAt: UtcTimestamp;
}

interface CreateSessionRecord {
  schemaVersion: number;
  sessionId: StableId;
  workspace: WorkspaceRecord;
  goal: string;
  createdAt: UtcTimestamp;
  expiresAt: UtcTimestamp | null;
  configVersion: string;
  toolCatalogHash: string;
}

interface RootTaskRecord {
  schemaVersion: number;
  taskId: StableId;
  actorId: string;
  title: string;
  createdAt: UtcTimestamp;
}

interface TaskRecord extends RootTaskRecord {
  sessionId: StableId;
  parentTaskId: StableId | null;
}

interface CreateSessionBundle {
  session: CreateSessionRecord;
  rootTask: RootTaskRecord;
  createdEvent: AgentEvent;
}

interface SessionRecord extends CreateSessionRecord {
  lifecycle: SessionLifecycle;
  updatedAt: UtcTimestamp;
  pinned: boolean;
  lastSequence: number;
}

interface SessionFilter {
  lifecycle?: SessionLifecycle[];
  workspaceId?: StableId;
  pinned?: boolean;
  updatedBefore?: UtcTimestamp;
  limit: number;
  cursor?: string;
}

interface SessionSummary {
  sessionId: StableId;
  workspaceId: StableId;
  goal: string;
  lifecycle: SessionLifecycle;
  updatedAt: UtcTimestamp;
  pinned: boolean;
  lastSequence: number;
}

interface DeleteReceiptItem {
  target: "session" | "event" | "approval" | "usage" |
          "transcript" | "artifact_metadata" | "artifact_file";
  referenceHash: string;
  status: "pending" | "deleted" | "missing" | "failed";
  error: StructuredError | null;
}

interface DeleteReceipt {
  schemaVersion: number;
  receiptId: StableId;
  sessionId: StableId;
  status: "in_progress" | "complete" | "failed";
  startedAt: UtcTimestamp;
  completedAt: UtcTimestamp | null;
  error: StructuredError | null;
  items: DeleteReceiptItem[];
}

interface ArtifactRecord {
  schemaVersion: number;
  reference: ArtifactReference;
  sessionId: StableId;
  state: "staged" | "ready" | "corrupt" | "deleting";
  stagedRelativePath: string | null;
  readyRelativePath: string;
  createdAt: UtcTimestamp;
  verifiedAt: UtcTimestamp | null;
  error: StructuredError | null;
}

interface SessionRepository {
  create(input: CreateSessionBundle): Promise<"inserted" | "duplicate">;
  get(sessionId: StableId): Promise<SessionRecord | null>;
  list(filter: SessionFilter): Promise<SessionSummary[]>;
  setPinned(sessionId: StableId, pinned: boolean,
            unpinnedExpiresAt?: UtcTimestamp): Promise<void>;
  delete(sessionId: StableId): Promise<DeleteReceipt>;
}

interface SessionDeletionCoordinator {
  delete(sessionId: StableId): Promise<DeleteReceipt>;
}

interface DeletedSessionIdentity {
  hasDeletedSessionIdentity(sessionId: StableId): boolean;
}

interface TaskRepository {
  create(input: TaskRecord): Promise<"inserted" | "duplicate">;
  get(taskId: StableId): Promise<TaskRecord | null>;
  list(sessionId: StableId): Promise<TaskRecord[]>;
}

`TaskRepository.create` 只创建带 `parentTaskId` 的子任务；唯一 root Task 必须随 `CreateSessionBundle` 原子创建。同 task ID 与完整记录相同为幂等，内容不同或父 Task 属于另一 Session 时拒绝。

interface ArtifactWriter {
  write(sessionId: StableId, mediaType: string, content: Uint8Array,
        sensitivity: "normal" | "sensitive"): Promise<ArtifactReference>;
}

interface ArtifactStore extends ArtifactWriter {
  read(sessionId: StableId, ref: ArtifactReference): Promise<Uint8Array>;
  verify(sessionId: StableId, ref: ArtifactReference): Promise<boolean>;
}
```

C01 是 `EventStore` 语义接口和 `AgentEvent` schema 的唯一所有者；C02 实现 `SqliteEventStore`，不得另建一个含义不同的同名接口。`append` 使用 `BEGIN IMMEDIATE` 和 Session `lastSequence` CAS，遵循 C01“严格递增但允许缺口”的契约；缺口作为事实保存并由 trace integrity gate 报告。相同 event ID/完整内容返回 `duplicate`；相同 ID 内容不同或相同 Session+sequence 被另一事件占用返回完整性错误。

`SessionRepository.create` 必须在一个事务中创建/校验 Workspace、Session、root Task 和 sequence 0 的 `session.created`。三者的 Session/Task/workspace/goal 必须一致；不得由 EventStore 根据陌生 task ID 隐式伪造 Task。Session lifecycle 是 C01 reducer 的派生事实；C02 append 只原子更新 `lastSequence/updatedAt`，不复制状态机。需要缓存 lifecycle 时，必须由版本化 C01 projector 写入并可从事件重建。

`SqliteSessionRepository` 组装时必须注入与当前安装删除密钥一致的 `DeletedSessionIdentity`，生产代码应直接使用同一 `SessionDeletionService`。创建事务在写入前检查不可逆墓碑，已彻底删除的 Session ID 永远不得复用；该依赖不能省略或用恒假替身装配生产实例。

`WorkspaceRecord`、Session 输入/记录/筛选/摘要、`ArtifactRecord` 和 `DeleteReceipt` 由 C02 拥有，C12/C14 只能导入，不得在下游重新定义。所有顶层记录都带独立主版本；cursor 是不透明、版本化且绑定筛选条件的值。删除首次完成时返回内存中的完整逐项 receipt；完成后持久 work record 会被压缩，重复删除只返回相同 receipt ID、时间和终态且 `items = []` 的墓碑摘要。
`ToolRuntime` 只依赖最小 `ArtifactWriter`；完整 `ArtifactStore` 负责写、读、校验和崩溃恢复，但不公开整 Session 删除入口。完整 Session `DeleteReceipt` 只能由删除协调器组装，并通过只删除已验证文件的窄端口驱动文件 provider，避免绕过 durable intent 或产生两份互相矛盾的收据。
保留期扫描只对 active Session 应用 `pinned = false`、`expiresAt <= cutoff`。一旦 Session 已进入 deleting 且存在 `failed/in_progress` durable receipt，删除意图已经成为权威事实，后续扫描必须忽略新的 pin/expiry 值并续跑同一 receipt，不能留下半删除 Session。单项或协调器级失败进入版本化报告而不阻断后续 Session。
pin 必须把 `expiresAt` 清为 null；unpin 必须由调用方按当前保留策略与注入 Clock 提供新的 `expiresAt`，不得恢复已经过期的旧值或在 repository 内硬编码 30 天。

## 6. 功能需求

- `STORE-FR-001`：数据库启动时按顺序执行版本化 migration，失败时不启动 Agent。
- `STORE-FR-002`：事件 append 与 Session `last_sequence/updated_at` 更新在同一事务完成；lifecycle/status 只能来自版本化 C01 投影，不能根据 event type 在存储层猜测。
- `STORE-FR-003`：相同 event ID 或 Session+sequence 的完全相同事件幂等；内容不同则报完整性错误。
- `STORE-FR-004`：Artifact 按第 7 节 `temporary -> staged -> ready` 协议提交；只有 ready 记录可以被事件、证据或工具结果引用。
- `STORE-FR-005`：读取 Artifact 必须验证路径仍位于 data dir 且 hash 匹配。
- `STORE-FR-006`：删除 Session 同时删除事件、任务、审批、用量、Artifact 元数据与文件，并返回逐项收据。
- `STORE-FR-007`：默认 30 天到期，pinned Session 不被清理；清理任务可重复运行。
- `STORE-FR-008`：恢复查询返回最后稳定状态、最新 sequence、未完成外部操作和缺失 Artifact 清单。
- `STORE-FR-009`：所有写操作在单进程内串行；多进程争用时第二实例只读或明确拒绝。
- `STORE-FR-010`：C03/C04/C08/C11 定义的批准、预算、工具 execution journal 和模型 call journal 端口由 SQLite adapter 实现；同一工具开始边界中的批准消费、预算预留、operation 状态和 `tool.started`，以及同一模型开始边界中的预算预留与 `model.started`，必须分别在一个 SQLite 事务提交。
- `STORE-FR-011`：数据库 migration、事件、Session、Artifact 元数据、删除收据和下游 journal 记录分别带主版本；恢复报告必须区分可迁移、只读兼容和阻塞三种结果。

当前 `StorageRecoveryInspector` 已从 canonical events 报告 lifecycle、持久水位、最后连续稳定 sequence、首个缺口、Artifact 缺失/损坏/未 ready、删除 receipt 的 item/协调器级错误，以及全局 `purge_state = pending` 墓碑。receipt 查询必须要求存在 `target = session`，与删除协调器使用同一身份规则；`deletion_reference_lost` 必须作为结构化恢复错误显式返回。C08/C11 durable journal 尚未实现前，外部 operation 能力必须明确返回 `unavailable` 与原因，不能从事件文字猜测真实外部状态。

## 7. 一致性与崩溃恢复

- SQLite 使用 WAL、foreign keys 和 busy timeout。
- `src/storage/sqlite/migrations.ts` 是唯一运行时 schema 来源；`schema_migrations` 记录版本、名称与 checksum，历史 checksum 漂移、版本缺口、数据库新于应用或 `user_version` 不一致均 fail closed。旧 `schema.sql` 只保留为 D1 历史快照，不参与启动。
- v3 migration 为 C04 创建 `budget_accounts`，并为既有 `usage_entries` 增加 operation/idempotency/kind/ledger sequence/reservation、canonical hash 与首次结果快照字段。C04 adapter 对每条索引列、canonical JSON/hash、连续 sequence 和 account watermark fail closed；旧 usage 行仍可由删除传播管理，但不冒充 C04 ledger fact。
- Artifact 采用 `temporary -> staged -> ready` 协议：先在目标目录写随机临时文件、flush/关闭并计算 hash；随后登记 `staged` 元数据；原子重命名成功并再次验证 hash 后，以 `state = staged` 且 Session 仍 active 的 CAS 标记 `ready`。CAS 失败不得返回引用，恢复程序也不得复活 deleting Artifact。恢复和普通读取必须复用同一 no-follow 路径解析，不能让 symlink 目标保持 ready。事件和工具结果只能引用 `ready` Artifact。
- Artifact root 只允许由写入/恢复路径首次绑定；绑定后的普通 `read/inspect` 只执行指纹读查询，不申请 SQLite 写锁。普通 `read` 验证本次返回字节但不更新 `verifiedAt`；显式 `verify` 才持久化验证水位。
- 崩溃后临时文件无记录：按 TTL 清理；`staged` 记录和临时文件都存在：继续原子重命名；最终文件存在但仍为 `staged`：验证后标记 `ready`；`ready` 记录对应文件缺失或 hash 不符：标记损坏，不能伪造工具成功。
- 文件存在但数据库记录缺失：作为 orphan，延迟清理，不自动纳入 Session；不得仅凭文件名恢复归属。
- 外部写事件处于 `unknown`：恢复只加载事实，由 C09 Provider 查询真实状态。
- 删除开始时先持久化 receipt，再逐项删除；同一 Session 只能有一个进行中 work record，并发调用复用同一 receipt。中断后只按 receipt 继续传播，直到业务记录和文件都不存在。完成后销毁含原始 locator 的 work record，只保留 C14 定义的不可逆最小审计墓碑。
- Artifact 文件删除器必须由同一个 `SqliteStorageDatabase` 和安装时绑定的权威 Artifact root 构造。元数据删除前必须清除该 Session 目录内全部 provider-owned ready/staged 文件并删除含原始 Session ID 的空目录；发现未知目录项时 fail closed，保留目录和收据供人工检查。
- 数据库元数据删除提交后，墓碑先进入 `purge_state = pending`。只有 `secure_delete` 已启用且 `wal_checkpoint(TRUNCATE)` 成功清空当前 WAL 后，才能把墓碑推进为 `complete` 并向调用方报告完成。活跃 reader 阻塞 checkpoint 时删除调用返回可重试的 `physical_purge_pending`，但数据库仍允许以可检查状态打开；显式删除重试、retention 和恢复入口继续清理 pending purge，且不得重新执行已完成的文件删除。损坏或非临时 purge 错误仍阻止打开。

### 7.1 故障切点

| 切点 | 恢复后的合法状态 |
| --- | --- |
| Session 写入前/事务中 | 完整旧状态；不能出现半个 Session |
| 事件插入与 Session 摘要更新之间 | 事务回滚，或两者都存在 |
| Artifact 临时文件写入后 | 无引用临时文件，按 TTL 清理 |
| Artifact staged 后、rename 前 | 恢复程序继续提交 |
| Artifact rename 后、ready 前 | hash 正确则标记 ready，否则损坏 |
| 删除墓碑后任一删除项之间 | receipt 保留逐项状态并可幂等续跑 |

## 8. 错误分类

| category | 重试 | 恢复 |
| --- | --- | --- |
| `storage_busy` | 有界重试 | 指数退避后提示用户 |
| `storage_corrupt` | 否 | 停止写入，保留文件供诊断 |
| `disk_full` | 用户处理后 | 暂停 Session，不删除证据 |
| `artifact_hash_mismatch` | 否 | 标记损坏，禁止完成 |
| `migration_failed` | 否 | 保持旧版本，终止启动 |
| `delete_incomplete` | 是 | 根据收据继续删除 |
| `physical_purge_pending` | 是 | 关闭活跃 reader 后续跑 WAL 清理 |
| `artifact_root_mismatch` | 否 | 使用与安装记录绑定的权威 Artifact root |

## 9. 安全与隐私

- `STORE-SR-001`：data dir 和 Artifact 路径必须阻止 `..`、junction/symlink 越界。
- `STORE-SR-002`：API Key 不入库；敏感 Artifact 在导出时默认排除。
- `STORE-SR-003`：SQL 只使用参数化查询。
- `STORE-SR-004`：普通删除必须覆盖所有引用；无法保证物理擦除时在产品说明中明确。

MVP 的 data dir 是应用独占的本机目录：安装/启动必须用 ACL 阻止非应用主体替换其中目录，并把权威 Artifact root 身份绑定到安装元数据。纯 Node 路径校验无法在恶意同机写者持续替换 Windows reparse point 时提供无竞态的 handle-relative 保证；在引入原生 `OPEN_REPARSE_POINT`/handle-relative provider 前，该场景明确不属于受支持威胁模型。实现仍须逐级拒绝 symlink/junction、操作前后复核边界，且 root 不可访问时 fail closed，不能把它当作目标文件已不存在。

## 10. 验收标准

- `STORE-AC-001`：进程在任意事件写入点终止，重启后得到完整旧状态或完整新状态。
- `STORE-AC-002`：一万事件追加、按 `afterSequence` 增量读取、重放顺序正确且无重复；真正 limit/cursor 分页需先升级 C01 EventReader 契约。
- `STORE-AC-003`：长输出写入后数据库 hash、文件 hash 和读取内容一致。
- `STORE-AC-004`：Session 删除完成后数据库查询、Artifact Session 目录、SQLite 主库/WAL 字节扫描和导出均找不到关联内容；物理清理未完成时只能返回 pending/failed，不能返回 complete。
- `STORE-AC-005`：30 天清理跳过 pinned Session，重复运行结果相同。
- `STORE-AC-006`：Windows 文件锁、磁盘满、数据库 busy 和损坏 fixture 有明确错误。
- `STORE-AC-007`：上述每个故障切点均有注入测试，恢复结果只落入表中的合法状态。
- `STORE-AC-008`：C08 开始事务在任意语句后崩溃时，批准、预算、operation 和 `tool.started` 要么全部提交，要么全部回滚。

## 11. 实现任务建议

1. 建 migration runner 和连接配置。
2. 实现 SqliteEventStore 与幂等/顺序测试。
3. 实现 Workspace/Session/root Task/created event 原子创建，以及 SessionRepository。
4. 实现 FileArtifactStore 的原子写、hash 和边界检查。
5. 实现恢复摘要、retention 和删除传播。
6. 做崩溃、锁、磁盘与 orphan 故障注入。

## 12. 已登记的后续优化

- Session 列表当前为正确性优先，会对候选 Session 重放事件；大规模数据下的 lifecycle 版本化投影和 SQL 分页下推在独立性能 PR 中实现。
- prepared statement cache、`SQLITE_CONSTRAINT_*` 扩展码细分和 task/deleting 查询语义需要统一 repository 策略后再落地。
- Windows `EBUSY/EPERM` 的稳定重试策略依赖文件锁预算与取消策略；原生 handle-relative provider 一并解决强对抗路径和文件占用语义。
- `corrupt` Artifact 的 `.bin` 仍受 Session retention/删除传播管理；若产品需要提前销毁，必须新增可审计 quarantine/GC receipt，不能由 orphan 扫描静默删除关联文件。
