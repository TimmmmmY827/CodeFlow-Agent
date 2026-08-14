import type { AgentEvent } from "../events/agent-event.js";
import type { SessionLifecycle } from "../events/state-reducer.js";
import type {
  ArtifactReference,
  PathReference,
  StableId,
  StructuredError,
  UtcTimestamp,
} from "../shared/contracts.js";

export const STORAGE_RECORD_SCHEMA_VERSION = 1;

export interface WorkspaceRecord {
  readonly schemaVersion: typeof STORAGE_RECORD_SCHEMA_VERSION;
  readonly workspaceId: StableId;
  readonly root: PathReference;
  readonly fingerprint: string;
  readonly createdAt: UtcTimestamp;
}

export interface CreateSessionRecord {
  readonly schemaVersion: typeof STORAGE_RECORD_SCHEMA_VERSION;
  readonly sessionId: StableId;
  readonly workspace: WorkspaceRecord;
  readonly goal: string;
  readonly createdAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp | null;
  readonly configVersion: string;
  readonly toolCatalogHash: string;
}

export interface TaskRecord {
  readonly schemaVersion: typeof STORAGE_RECORD_SCHEMA_VERSION;
  readonly taskId: StableId;
  readonly sessionId: StableId;
  readonly parentTaskId: StableId | null;
  readonly actorId: string;
  readonly title: string;
  readonly createdAt: UtcTimestamp;
}

export type RootTaskRecord = Omit<TaskRecord, "sessionId" | "parentTaskId">;

export interface CreateSessionBundle {
  readonly session: CreateSessionRecord;
  readonly rootTask: RootTaskRecord;
  readonly createdEvent: AgentEvent;
}

export interface SessionRecord extends CreateSessionRecord {
  readonly lifecycle: SessionLifecycle;
  readonly updatedAt: UtcTimestamp;
  readonly pinned: boolean;
  readonly lastSequence: number;
}

export interface SessionFilter {
  readonly lifecycle?: readonly SessionLifecycle[];
  readonly workspaceId?: StableId;
  readonly pinned?: boolean;
  readonly updatedBefore?: UtcTimestamp;
  readonly limit: number;
  readonly cursor?: string;
}

export interface SessionSummary {
  readonly sessionId: StableId;
  readonly workspaceId: StableId;
  readonly goal: string;
  readonly lifecycle: SessionLifecycle;
  readonly updatedAt: UtcTimestamp;
  readonly pinned: boolean;
  readonly lastSequence: number;
}

export type DeleteTarget =
  | "session"
  | "event"
  | "approval"
  | "usage"
  | "transcript"
  | "artifact_metadata"
  | "artifact_file";

export interface DeleteReceiptItem {
  readonly target: DeleteTarget;
  readonly referenceHash: string;
  readonly status: "pending" | "deleted" | "missing" | "failed";
  readonly error: StructuredError | null;
}

export interface DeleteReceipt {
  readonly schemaVersion: typeof STORAGE_RECORD_SCHEMA_VERSION;
  readonly receiptId: StableId;
  readonly sessionId: StableId;
  readonly status: "in_progress" | "complete" | "failed";
  readonly startedAt: UtcTimestamp;
  readonly completedAt: UtcTimestamp | null;
  /** Coordinator-level failure not attributable to one delete item. */
  readonly error: StructuredError | null;
  readonly items: readonly DeleteReceiptItem[];
}

export interface SessionRepository {
  create(input: CreateSessionBundle): Promise<"inserted" | "duplicate">;
  get(sessionId: StableId): Promise<SessionRecord | null>;
  list(filter: SessionFilter): Promise<readonly SessionSummary[]>;
  setPinned(
    sessionId: StableId,
    pinned: boolean,
    unpinnedExpiresAt?: UtcTimestamp,
  ): Promise<void>;
  delete(sessionId: StableId): Promise<DeleteReceipt>;
}

export interface SessionDeletionCoordinator {
  delete(sessionId: StableId): Promise<DeleteReceipt>;
}

export interface DeletedSessionIdentity {
  hasDeletedSessionIdentity(sessionId: StableId): boolean;
}

export interface TaskRepository {
  create(input: TaskRecord): Promise<"inserted" | "duplicate">;
  get(taskId: StableId): Promise<TaskRecord | null>;
  list(sessionId: StableId): Promise<readonly TaskRecord[]>;
}

export interface ArtifactWriter {
  write(
    sessionId: StableId,
    mediaType: string,
    content: Uint8Array,
    sensitivity: ArtifactReference["sensitivity"],
  ): Promise<ArtifactReference>;
}

export interface ArtifactStore extends ArtifactWriter {
  read(sessionId: StableId, reference: ArtifactReference): Promise<Uint8Array>;
  verify(sessionId: StableId, reference: ArtifactReference): Promise<boolean>;
}

export interface StorageFaultInjector {
  hit(point: StorageFaultPoint): void | Promise<void>;
}

export type StorageFaultPoint =
  | "event_after_insert"
  | "artifact_after_temp_write"
  | "artifact_after_staged"
  | "artifact_after_rename"
  | "delete_after_receipt"
  | "delete_after_artifact_files"
  | "delete_before_final_commit";
