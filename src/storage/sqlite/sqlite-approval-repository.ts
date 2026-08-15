import { createHash } from "node:crypto";

import {
  stableIdSchema,
  utcTimestampSchema,
  type StableId,
  type StructuredError,
  type UtcTimestamp,
} from "../../shared/contracts.js";
import { canonicalJson } from "../../shared/json.js";
import { createOperationHash } from "../../policy/operation-hash.js";
import {
  ApprovalError,
  approvalRecordSchema,
  approvalSummarySchema,
  operationBindingSchema,
  PERMISSION_SCHEMA_VERSION,
  type ApprovalRecord,
  type ApprovalRepository,
  type ConsumeApprovalInput,
  type IssueApprovalInput,
  type ResolveApprovalInput,
} from "../../policy/permission-contracts.js";
import type { SqliteStorageDatabase } from "./sqlite-database.js";
import { StorageError, translateStorageError } from "./sqlite-errors.js";

interface ApprovalRow extends Readonly<Record<string, unknown>> {
  readonly approval_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly workspace_id: unknown;
  readonly tool_name: unknown;
  readonly operation_hash: unknown;
  readonly decision: unknown;
  readonly expires_at: unknown;
  readonly decided_at: unknown;
  readonly issued_at: unknown;
  readonly consumed_at: unknown;
  readonly record_hash: unknown;
  readonly record_json: unknown;
}

const APPROVAL_COLUMNS = `
approval_id, session_id, task_id, workspace_id, tool_name, operation_hash,
decision, expires_at, decided_at, issued_at, consumed_at, record_hash, record_json`;

export class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly storage: SqliteStorageDatabase) {}

  async issue(input: IssueApprovalInput): Promise<"inserted" | "duplicate"> {
    const checked = validateIssue(input);
    const operationHash = createOperationHash(checked.binding);

    return this.#transaction(() => {
      const existing = this.#loadRow(checked.approvalId);
      if (existing) {
        const persisted = decodeApproval(existing);
        if (sameIssueRequest(persisted, checked, operationHash)) return "duplicate";
        throw approvalError(
          "approval_id_conflict",
          `Approval ${checked.approvalId} is already bound to a different request.`,
          false,
          "Use the original request or allocate a new approval ID.",
        );
      }
      const now = this.storage.clock.utcNow();
      if (isExpired(checked.expiresAt, now)) {
        throw approvalError(
          "approval_expired",
          "An approval cannot be issued with an expiration at or before the current time.",
          true,
          "Create a new approval request with a future expiration.",
        );
      }
      const record = createApprovalRecord({
        schemaVersion: PERMISSION_SCHEMA_VERSION,
        approvalId: checked.approvalId,
        binding: checked.binding,
        operationHash,
        summary: checked.summary,
        state: "issued",
        issuedAt: now,
        expiresAt: checked.expiresAt,
        resolvedAt: null,
        consumedAt: null,
        decisionReason: null,
      });
      this.#assertBindingReferences(record);
      this.storage.database
        .prepare(`
INSERT INTO approvals(
  approval_id, session_id, schema_version, tool_name, operation_hash,
  decision, expires_at, decided_at, task_id, workspace_id, issued_at,
  consumed_at, record_hash, record_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run(
          record.approvalId,
          record.binding.sessionId,
          PERMISSION_SCHEMA_VERSION,
          record.binding.toolName,
          record.operationHash,
          record.state,
          record.expiresAt,
          record.issuedAt,
          record.binding.taskId,
          record.binding.workspaceId,
          record.issuedAt,
          recordHash(record),
          canonicalJson(record),
        );
      return "inserted";
    });
  }

  async get(approvalId: StableId): Promise<ApprovalRecord | null> {
    const checkedId = parseApprovalId(approvalId);
    try {
      const row = this.#loadRow(checkedId);
      if (!row) return null;
      const record = decodeApproval(row);
      if (!canExpire(record) || !isExpired(record.expiresAt, this.storage.clock.utcNow())) {
        return record;
      }
      return this.#transaction(() => {
        const current = this.#require(checkedId);
        const now = this.storage.clock.utcNow();
        if (!canExpire(current) || !isExpired(current.expiresAt, now)) return current;
        this.#assertSessionActive(current);
        const expired = transition(current, "expired", now, "Approval reached its expiration.");
        this.#write(expired);
        return expired;
      });
    } catch (error: unknown) {
      throw translateApprovalStorageError(error);
    }
  }

  async resolve(input: ResolveApprovalInput): Promise<ApprovalRecord> {
    const checkedId = parseApprovalId(input.approvalId);
    const reason = input.reason === null ? null : parseReason(input.reason);
    if (input.decision !== "approved" && input.decision !== "denied") {
      throw approvalError("approval_decision_invalid", "Approval decision is invalid.", false, null);
    }

    return this.#transaction(() => {
      const record = this.#require(checkedId);
      if (!canExpire(record)) {
        if (record.state === input.decision) return record;
        throw invalidTransition(record, input.decision);
      }
      this.#assertSessionActive(record);
      const now = this.storage.clock.utcNow();
      if (isExpired(record.expiresAt, now)) {
        const expired = transition(record, "expired", now, "Approval expired before a decision.");
        this.#write(expired);
        return expired;
      }
      if (record.state === input.decision) return record;
      if (record.state !== "issued") throw invalidTransition(record, input.decision);
      const resolved = transition(
        record,
        input.decision,
        now,
        reason ?? (input.decision === "approved" ? "User approved the operation." : "User denied the operation."),
      );
      this.#write(resolved);
      return resolved;
    });
  }

  async consume(input: ConsumeApprovalInput): Promise<ApprovalRecord> {
    const checked = validateConsume(input);
    let expired: ApprovalError | null = null;
    const record = this.#transaction(() => {
      const result = this.#consumeTransition(checked);
      expired = result.error;
      return result.record;
    });
    if (expired) throw expired;
    return record;
  }

  /**
   * C08 can call this only inside SqliteStorageDatabase.runImmediateTransaction,
   * which acquires the SQLite write lock before any approval state is read.
   */
  consumeWithinTransaction(input: ConsumeApprovalInput): ApprovalRecord {
    if (!this.storage.isImmediateTransactionActive) {
      throw approvalError(
        "approval_transaction_required",
        "Approval consumption requires an active BEGIN IMMEDIATE execution transaction.",
        false,
        "Use SqliteStorageDatabase.runImmediateTransaction before consuming the approval.",
      );
    }
    const checked = validateConsume(input);
    try {
      this.#acquireExecutionWriteLock();
      const result = this.#consumeTransition(checked);
      if (result.error) throw result.error;
      return result.record;
    } catch (error: unknown) {
      throw translateApprovalStorageError(error);
    }
  }

  async invalidate(approvalId: StableId, reason: string): Promise<ApprovalRecord> {
    const checkedId = parseApprovalId(approvalId);
    const checkedReason = parseReason(reason);
    return this.#transaction(() => {
      const record = this.#require(checkedId);
      if (record.state === "invalidated") return record;
      if (record.state !== "approved") throw invalidTransition(record, "invalidated");
      this.#assertSessionActive(record);
      const invalidated = transition(record, "invalidated", this.storage.clock.utcNow(), checkedReason);
      this.#write(invalidated);
      return invalidated;
    });
  }

  async expire(approvalId: StableId): Promise<ApprovalRecord> {
    const checkedId = parseApprovalId(approvalId);
    return this.#transaction(() => {
      const record = this.#require(checkedId);
      if (record.state === "expired") return record;
      if (record.state !== "issued" && record.state !== "approved") {
        throw invalidTransition(record, "expired");
      }
      this.#assertSessionActive(record);
      const now = this.storage.clock.utcNow();
      if (!isExpired(record.expiresAt, now)) {
        throw approvalError(
          "approval_not_expired",
          "The approval has not reached its expiration.",
          true,
          "Wait until the recorded expiration before expiring it.",
        );
      }
      const expired = transition(record, "expired", now, "Approval reached its expiration.");
      this.#write(expired);
      return expired;
    });
  }

  #consumeTransition(input: ConsumeApprovalInput): {
    readonly record: ApprovalRecord;
    readonly error: ApprovalError | null;
  } {
    const record = this.#require(input.approvalId);
    if (record.operationHash !== input.operationHash) {
      throw approvalError(
        "approval_binding_mismatch",
        "The approval is bound to different operation parameters.",
        false,
        "Request approval for the final normalized operation.",
      );
    }
    const now = this.storage.clock.utcNow();
    if (isExpired(record.expiresAt, now) && (record.state === "issued" || record.state === "approved")) {
      this.#assertSessionActive(record);
      const expired = transition(record, "expired", now, "Approval expired before consumption.");
      this.#write(expired);
      return {
        record: expired,
        error: approvalError(
          "approval_expired",
          "The approval expired before it could be consumed.",
          true,
          "Request a new approval for the current operation binding.",
        ),
      };
    }
    if (record.state === "consumed") {
      throw approvalError(
        "approval_already_consumed",
        "The single-use approval has already been consumed.",
        false,
        "Reconcile the previous operation before requesting a new approval.",
      );
    }
    if (record.state !== "approved") throw invalidTransition(record, "consumed");
    this.#assertSessionActive(record);
    assertTransitionTime(record, now);
    const consumed = createApprovalRecord({
      ...record,
      state: "consumed",
      consumedAt: now,
    });
    this.#write(consumed);
    return { record: consumed, error: null };
  }

  #assertBindingReferences(record: ApprovalRecord): void {
    const session = this.storage.database
      .prepare("SELECT workspace_id, deletion_state FROM sessions WHERE session_id = ?")
      .get(record.binding.sessionId);
    if (!session || session.deletion_state !== "active") {
      throw approvalError(
        "approval_session_unavailable",
        "The approval Session does not exist or is being deleted.",
        false,
        "Create approvals only for an active Session.",
      );
    }
    if (session.workspace_id !== record.binding.workspaceId) {
      throw approvalError(
        "approval_workspace_mismatch",
        "The operation workspace does not match the Session workspace.",
        false,
        "Rebuild the operation binding from the active Session snapshot.",
      );
    }
    const task = this.storage.database
      .prepare("SELECT session_id FROM tasks WHERE task_id = ?")
      .get(record.binding.taskId);
    if (!task || task.session_id !== record.binding.sessionId) {
      throw approvalError(
        "approval_task_mismatch",
        "The operation Task does not belong to the approval Session.",
        false,
        "Rebuild the operation binding from the active Task.",
      );
    }
  }

  #assertSessionActive(record: ApprovalRecord): void {
    const session = this.storage.database
      .prepare("SELECT deletion_state FROM sessions WHERE session_id = ?")
      .get(record.binding.sessionId);
    if (!session || session.deletion_state !== "active") {
      throw approvalError(
        "approval_session_unavailable",
        "The approval Session does not exist or is being deleted.",
        false,
        "Do not mutate or consume approvals after Session deletion begins.",
      );
    }
  }

  #acquireExecutionWriteLock(): void {
    const result = this.storage.database
      .prepare(`
UPDATE storage_installation
SET schema_version = schema_version
WHERE singleton = 1`)
      .run();
    if (result.changes !== 1) {
      throw approvalError(
        "approval_storage_corrupt",
        "The storage installation record is missing during approval consumption.",
        false,
        "Stop execution and inspect the storage installation metadata.",
      );
    }
  }

  #require(approvalId: StableId): ApprovalRecord {
    const row = this.#loadRow(approvalId);
    if (!row) {
      throw approvalError(
        "approval_not_found",
        `Approval ${approvalId} does not exist.`,
        false,
        "Issue a new approval request for this operation.",
      );
    }
    return decodeApproval(row);
  }

  #loadRow(approvalId: StableId): ApprovalRow | undefined {
    return this.storage.database
      .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE approval_id = ?`)
      .get(approvalId) as ApprovalRow | undefined;
  }

  #write(record: ApprovalRecord): void {
    const result = this.storage.database
      .prepare(`
UPDATE approvals SET
  decision = ?, expires_at = ?, decided_at = ?, consumed_at = ?,
  record_hash = ?, record_json = ?
WHERE approval_id = ? AND record_hash = ?`)
      .run(
        record.state,
        record.expiresAt,
        record.resolvedAt ?? record.issuedAt,
        record.consumedAt,
        recordHash(record),
        canonicalJson(record),
        record.approvalId,
        this.#storedHash(record.approvalId),
      );
    if (result.changes !== 1) {
      throw approvalError(
        "approval_state_conflict",
        "The approval changed concurrently or its stored integrity hash is invalid.",
        true,
        "Reload the durable approval state before retrying.",
      );
    }
  }

  #storedHash(approvalId: StableId): string {
    const row = this.storage.database
      .prepare("SELECT record_hash FROM approvals WHERE approval_id = ?")
      .get(approvalId);
    if (!row || typeof row.record_hash !== "string") throw corruptApproval(approvalId);
    return row.record_hash;
  }

  #transaction<T>(operation: () => T): T {
    try {
      this.storage.database.exec("BEGIN IMMEDIATE");
      const result = operation();
      this.storage.database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      if (this.storage.database.isTransaction) this.storage.database.exec("ROLLBACK");
      throw translateApprovalStorageError(error);
    }
  }
}

function validateIssue(input: IssueApprovalInput): IssueApprovalInput {
  const approvalId = parseApprovalId(input.approvalId);
  const bindingResult = operationBindingSchema.safeParse(input.binding);
  const expiresAtResult = utcTimestampSchema.safeParse(input.expiresAt);
  const summaryResult = approvalSummarySchema.safeParse(input.summary);
  if (!bindingResult.success || !expiresAtResult.success || !summaryResult.success) {
    throw approvalError(
      "approval_request_invalid",
      "The approval request does not match the current permission schema.",
      false,
      "Rebuild the request from validated policy inputs.",
    );
  }
  const binding = bindingResult.data;
  const expiresAt = expiresAtResult.data;
  const summary = summaryResult.data;
  if (
    summary.toolName !== binding.toolName ||
    summary.toolVersion !== binding.toolVersion ||
    summary.codeVersion !== binding.codeVersion ||
    summary.diffHash !== binding.diffHash ||
    summary.expiresAt !== expiresAt
  ) {
    throw approvalError(
      "approval_summary_mismatch",
      "The approval summary does not describe the exact operation binding and expiration.",
      false,
      "Regenerate the summary from the final OperationBinding.",
    );
  }
  return { approvalId, binding, expiresAt, summary };
}

function validateConsume(input: ConsumeApprovalInput): ConsumeApprovalInput {
  const approvalId = parseApprovalId(input.approvalId);
  if (!/^sha256:[0-9a-f]{64}$/.test(input.operationHash)) {
    throw approvalError("approval_binding_invalid", "The operation hash is invalid.", false, null);
  }
  return { approvalId, operationHash: input.operationHash };
}

function parseApprovalId(value: StableId): StableId {
  const parsed = stableIdSchema.safeParse(value);
  if (!parsed.success) {
    throw approvalError("approval_id_invalid", "The approval ID is invalid.", false, null);
  }
  return parsed.data;
}

function parseReason(value: string): string {
  const parsed = value.trim();
  if (parsed.length === 0 || parsed.length > 1_024) {
    throw approvalError("approval_reason_invalid", "Approval reason must contain 1-1024 characters.", false, null);
  }
  return parsed;
}

function transition(
  record: ApprovalRecord,
  state: "approved" | "denied" | "expired" | "invalidated",
  occurredAt: UtcTimestamp,
  reason: string,
): ApprovalRecord {
  assertTransitionTime(record, occurredAt);
  return createApprovalRecord({
    ...record,
    state,
    resolvedAt: occurredAt,
    consumedAt: null,
    decisionReason: reason,
  });
}

function createApprovalRecord(input: unknown): ApprovalRecord {
  const parsed = approvalRecordSchema.safeParse(input);
  if (!parsed.success) {
    throw approvalError(
      "approval_state_invalid",
      "The approval state transition does not satisfy the current permission schema.",
      false,
      "Stop the transition and inspect the approval inputs and injected Clock.",
    );
  }
  return parsed.data;
}

function assertTransitionTime(record: ApprovalRecord, occurredAt: UtcTimestamp): void {
  const previous = record.resolvedAt ?? record.issuedAt;
  if (Date.parse(occurredAt) < Date.parse(previous)) {
    throw approvalError(
      "approval_clock_regressed",
      "The injected Clock moved behind the previous durable approval transition.",
      true,
      "Restore a trustworthy wall clock before retrying the approval transition.",
    );
  }
}

function canExpire(record: ApprovalRecord): boolean {
  return record.state === "issued" || record.state === "approved";
}

function decodeApproval(row: ApprovalRow): ApprovalRecord {
  const approvalId = typeof row.approval_id === "string" ? row.approval_id : "unknown";
  if (typeof row.record_json !== "string" || typeof row.record_hash !== "string") {
    throw approvalError(
      "legacy_approval_unusable",
      `Approval ${approvalId} predates complete operation binding and cannot authorize execution.`,
      false,
      "Issue a new approval under the current permission schema.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(row.record_json);
  } catch {
    throw corruptApproval(approvalId);
  }
  const record = approvalRecordSchema.safeParse(value);
  if (!record.success || recordHash(record.data) !== row.record_hash) throw corruptApproval(approvalId);
  if (
    createOperationHash(record.data.binding) !== record.data.operationHash ||
    record.data.summary.toolName !== record.data.binding.toolName ||
    record.data.summary.toolVersion !== record.data.binding.toolVersion ||
    record.data.summary.codeVersion !== record.data.binding.codeVersion ||
    record.data.summary.diffHash !== record.data.binding.diffHash ||
    record.data.summary.expiresAt !== record.data.expiresAt
  ) {
    throw corruptApproval(record.data.approvalId);
  }
  const expectedDecidedAt = record.data.resolvedAt ?? record.data.issuedAt;
  if (
    row.approval_id !== record.data.approvalId ||
    row.session_id !== record.data.binding.sessionId ||
    row.task_id !== record.data.binding.taskId ||
    row.workspace_id !== record.data.binding.workspaceId ||
    row.tool_name !== record.data.binding.toolName ||
    row.operation_hash !== record.data.operationHash ||
    row.decision !== record.data.state ||
    row.expires_at !== record.data.expiresAt ||
    row.decided_at !== expectedDecidedAt ||
    row.issued_at !== record.data.issuedAt ||
    row.consumed_at !== record.data.consumedAt
  ) {
    throw corruptApproval(record.data.approvalId);
  }
  return record.data;
}

function sameIssueRequest(
  persisted: ApprovalRecord,
  requested: IssueApprovalInput,
  operationHash: string,
): boolean {
  return persisted.approvalId === requested.approvalId &&
    persisted.operationHash === operationHash &&
    persisted.expiresAt === requested.expiresAt &&
    canonicalJson(persisted.binding) === canonicalJson(requested.binding) &&
    canonicalJson(persisted.summary) === canonicalJson(requested.summary);
}

function recordHash(record: ApprovalRecord): string {
  return `sha256:${createHash("sha256").update(canonicalJson(record)).digest("hex")}`;
}

function invalidTransition(record: ApprovalRecord, target: string): ApprovalError {
  return approvalError(
    "approval_transition_invalid",
    `Approval ${record.approvalId} cannot transition from ${record.state} to ${target}.`,
    false,
    "Load the durable approval state and follow the fixed transition graph.",
  );
}

function corruptApproval(approvalId: string): ApprovalError {
  return approvalError(
    "approval_storage_corrupt",
    `Approval ${approvalId} failed its canonical record integrity check.`,
    false,
    "Stop authorization and inspect the approval database before continuing.",
  );
}

function approvalError(
  category: string,
  message: string,
  retryable: boolean,
  recovery: string | null,
): ApprovalError {
  return new ApprovalError({ category, message, retryable, sideEffectStatus: "none", recovery });
}

function translateApprovalStorageError(error: unknown): ApprovalError | StorageError {
  if (error instanceof ApprovalError || error instanceof StorageError) return error;
  return translateStorageError(error);
}

function isExpired(expiresAt: UtcTimestamp, now: UtcTimestamp): boolean {
  return Date.parse(expiresAt) <= Date.parse(now);
}

export function approvalFailure(error: unknown): StructuredError {
  if (error instanceof ApprovalError || error instanceof StorageError) return error.details;
  return {
    category: "approval_operation_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    sideEffectStatus: "none",
    recovery: "Inspect the approval operation before retrying.",
  };
}
