import { createHash } from "node:crypto";

import {
  BUDGET_SCHEMA_VERSION,
  BudgetError,
  ZERO_BUDGET_USAGE,
  budgetDeltaSchema,
  budgetCostReconciliationSchema,
  budgetEvidenceSchema,
  budgetLedgerEntrySchema,
  budgetPolicySchema,
  budgetSnapshotSchema,
  createBudgetError,
  type AdjustBudgetInput,
  type BudgetDelta,
  type BudgetLedger,
  type BudgetLedgerEntry,
  type BudgetMutationResult,
  type BudgetPolicy,
  type BudgetSnapshot,
  type BudgetUsage,
  type CommitBudgetInput,
  type InitializeBudgetInput,
  type ReleaseBudgetInput,
  type ReserveBudgetInput,
} from "../../policy/budget-contracts.js";
import { BudgetController, addUsage } from "../../policy/budget-controller.js";
import { stableIdSchema, utcTimestampSchema, versionIdentifierSchema, type StableId, type UtcTimestamp } from "../../shared/contracts.js";
import { canonicalJson } from "../../shared/json.js";
import type { SqliteStorageDatabase } from "./sqlite-database.js";
import { StorageError, translateStorageError } from "./sqlite-errors.js";

interface AccountRow extends Readonly<Record<string, unknown>> {
  readonly session_id: unknown;
  readonly schema_version: unknown;
  readonly policy_json: unknown;
  readonly policy_hash: unknown;
  readonly pricing_version: unknown;
  readonly last_ledger_sequence: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface LedgerRow extends Readonly<Record<string, unknown>> {
  readonly usage_id: unknown;
  readonly session_id: unknown;
  readonly schema_version: unknown;
  readonly entry_json: unknown;
  readonly occurred_at: unknown;
  readonly operation_id: unknown;
  readonly idempotency_key: unknown;
  readonly entry_kind: unknown;
  readonly ledger_sequence: unknown;
  readonly reservation_id: unknown;
  readonly request_hash: unknown;
  readonly entry_hash: unknown;
  readonly result_snapshot_json: unknown;
  readonly result_snapshot_hash: unknown;
}

const ACCOUNT_COLUMNS = `
session_id, schema_version, policy_json, policy_hash, pricing_version,
last_ledger_sequence, created_at, updated_at`;
const LEDGER_COLUMNS = `
usage_id, session_id, schema_version, entry_json, occurred_at, operation_id,
idempotency_key, entry_kind, ledger_sequence, reservation_id, request_hash,
entry_hash, result_snapshot_json, result_snapshot_hash`;

export class SqliteBudgetLedger implements BudgetLedger {
  constructor(private readonly storage: SqliteStorageDatabase) {}

  async initialize(input: InitializeBudgetInput): Promise<BudgetSnapshot> {
    const checked = validateInitialization(input);
    return this.#transaction(() => {
      this.#assertSessionActive(checked.sessionId);
      const existing = this.#loadAccount(checked.sessionId);
      if (existing) {
        const account = decodeAccount(existing);
        if (
          canonicalJson(account.policy) !== canonicalJson(checked.policy) ||
          account.pricingVersion !== checked.pricingVersion
        ) {
          throw budgetFailure(
            "budget_account_conflict",
            "The Session budget was already initialized with a different policy or pricing version.",
            false,
            "Use the durable Session policy; budget increases require a separate user-controlled event.",
          );
        }
        return this.#project(account);
      }
      const now = this.storage.clock.utcNow();
      const policyJson = canonicalJson(checked.policy);
      const policyHash = accountHash(checked.policy, checked.pricingVersion);
      this.storage.database.prepare(`
INSERT INTO budget_accounts(
  session_id, schema_version, policy_json, policy_hash, pricing_version,
  last_ledger_sequence, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, -1, ?, ?)`)
        .run(
          checked.sessionId,
          BUDGET_SCHEMA_VERSION,
          policyJson,
          policyHash,
          checked.pricingVersion,
          now,
          now,
        );
      const created = this.#loadAccount(checked.sessionId);
      if (!created) throw corruptLedger("The initialized budget account could not be reloaded.");
      return this.#project(decodeAccount(created));
    });
  }

  async getSnapshot(sessionId: StableId): Promise<BudgetSnapshot | null> {
    const checkedId = parseSessionId(sessionId);
    try {
      const row = this.#loadAccount(checkedId);
      return row ? this.#project(decodeAccount(row)) : null;
    } catch (error: unknown) {
      throw translateBudgetError(error);
    }
  }

  async listEntries(sessionId: StableId): Promise<readonly BudgetLedgerEntry[]> {
    const checkedId = parseSessionId(sessionId);
    try {
      const account = this.#loadAccount(checkedId);
      if (!account) return [];
      const decoded = decodeAccount(account);
      return this.#loadEntries(checkedId, decoded.lastLedgerSequence);
    } catch (error: unknown) {
      throw translateBudgetError(error);
    }
  }

  async listOpenReservations(sessionId: StableId): Promise<readonly BudgetLedgerEntry[]> {
    const checkedId = parseSessionId(sessionId);
    try {
      const accountRow = this.#loadAccount(checkedId);
      if (!accountRow) return [];
      const account = decodeAccount(accountRow);
      this.#project(account);
      const entries = this.#loadEntries(checkedId, account.lastLedgerSequence);
      const resolved = new Set(entries.flatMap((entry) =>
        entry.reservationId === null ? [] : [entry.reservationId]));
      return entries.filter((entry) => entry.kind === "reserve" && !resolved.has(entry.entryId));
    } catch (error: unknown) {
      throw translateBudgetError(error);
    }
  }

  async reserve(input: ReserveBudgetInput): Promise<BudgetMutationResult> {
    const checked = validateReserve(input);
    return this.#transaction(() => this.#append(checked, "reserve", checked.delta, null, "estimated", false, checked.evidence ?? null));
  }

  async commit(input: CommitBudgetInput): Promise<BudgetMutationResult> {
    const checked = validateCommit(input);
    return this.#transaction(() => this.#commit(checked));
  }

  async release(input: ReleaseBudgetInput): Promise<BudgetMutationResult> {
    const checked = validateRelease(input);
    return this.#transaction(() => this.#release(checked));
  }

  async adjust(input: AdjustBudgetInput): Promise<BudgetMutationResult> {
    const checked = validateAdjust(input);
    return this.#transaction(() => this.#append(checked, "adjust", checked.delta, null, "actual", false, checked.evidence ?? null));
  }

  /** C08 uses this only after opening its execution transaction. */
  reserveWithinTransaction(input: ReserveBudgetInput): BudgetMutationResult {
    if (!this.storage.isImmediateTransactionActive) {
      throw budgetFailure(
        "budget_transaction_required",
        "Budget reservation requires an active BEGIN IMMEDIATE execution transaction.",
        false,
        "Use SqliteStorageDatabase.runImmediateTransaction before reserving budget.",
      );
    }
    const checked = validateReserve(input);
    try {
      this.#acquireExecutionWriteLock();
      return this.#append(checked, "reserve", checked.delta, null, "estimated", false, checked.evidence ?? null);
    } catch (error: unknown) {
      throw translateBudgetError(error);
    }
  }

  commitWithinTransaction(input: CommitBudgetInput): BudgetMutationResult {
    return this.#withinExistingTransaction(() => this.#commit(validateCommit(input)));
  }

  releaseWithinTransaction(input: ReleaseBudgetInput): BudgetMutationResult {
    return this.#withinExistingTransaction(() => this.#release(validateRelease(input)));
  }

  adjustWithinTransaction(input: AdjustBudgetInput): BudgetMutationResult {
    return this.#withinExistingTransaction(() => {
      const checked = validateAdjust(input);
      return this.#append(checked, "adjust", checked.delta, null, "actual", false, checked.evidence ?? null);
    });
  }

  #commit(checked: CommitBudgetInput): BudgetMutationResult {
    const duplicate = this.#duplicateResult(checked, "commit");
    if (duplicate) return duplicate;
    const reservation = this.#requireOpenReservation(checked.sessionId, checked.operationId, checked.reservationId);
    const delta = checked.actual ?? reservation.delta;
    return this.#append(
      checked,
      "commit",
      delta,
      checked.reservationId,
      checked.actual === null ? "conservative" : "actual",
      checked.actual === null,
      checked.evidence ?? null,
    );
  }

  #release(checked: ReleaseBudgetInput): BudgetMutationResult {
    const duplicate = this.#duplicateResult(checked, "release");
    if (duplicate) return duplicate;
    this.#requireOpenReservation(checked.sessionId, checked.operationId, checked.reservationId);
    return this.#append(
      checked,
      "release",
      budgetDeltaSchema.parse({}),
      checked.reservationId,
      "not_applicable",
      false,
      null,
    );
  }

  #withinExistingTransaction<T>(operation: () => T): T {
    if (!this.storage.isImmediateTransactionActive) {
      throw budgetFailure(
        "budget_transaction_required",
        "The budget mutation requires an active BEGIN IMMEDIATE execution transaction.",
        false,
        "Use SqliteStorageDatabase.runImmediateTransaction for the C08/C11 journal boundary.",
      );
    }
    try {
      this.#acquireExecutionWriteLock();
      return operation();
    } catch (error: unknown) {
      throw translateBudgetError(error);
    }
  }

  #append(
    input: ReserveBudgetInput | CommitBudgetInput | ReleaseBudgetInput | AdjustBudgetInput,
    kind: BudgetLedgerEntry["kind"],
    delta: BudgetDelta,
    reservationId: StableId | null,
    usageBasis: BudgetLedgerEntry["usageBasis"],
    reconciliationRequired: boolean,
    evidence: BudgetLedgerEntry["evidence"],
  ): BudgetMutationResult {
    const duplicate = this.#duplicateResult(input, kind);
    if (duplicate) return duplicate;
    const conflictingId = this.#loadEntryById(input.entryId);
    if (conflictingId) {
      decodeEntry(conflictingId);
      throw budgetFailure("budget_entry_id_conflict", "The budget entry ID is already in use.", false, "Allocate a new entry ID for the distinct mutation.");
    }
    this.#assertSessionActive(input.sessionId);
    const accountRow = this.#loadAccount(input.sessionId);
    if (!accountRow) {
      throw budgetFailure("budget_not_initialized", "The Session budget has not been initialized.", false, "Initialize the durable budget before starting operations.");
    }
    const account = decodeAccount(accountRow);
    const current = this.#project(account);
    let admission: BudgetLedgerEntry["admission"] = "recorded";
    let warningDimensions: BudgetLedgerEntry["warningDimensions"] = [];
    if (kind === "reserve") {
      const decision = new BudgetController(account.policy).evaluate(current, delta);
      if (!decision.allowed) {
        const pricingUnknown = decision.violations.some((violation) => violation.category === "pricing_unknown");
        throw budgetFailure(
          pricingUnknown ? "pricing_unknown" : "budget_hard_limit",
          pricingUnknown
            ? "The cost of the requested operation is unknown, so the configured cost limit cannot be enforced safely."
            : "The requested operation would reach or exceed a hard budget limit.",
          false,
          "Ask the user to increase the budget or end the Session.",
        );
      }
      admission = decision.outcome === "warn" ? "warn" : "allow";
      warningDimensions = decision.violations.map((violation) => violation.dimension);
    }
    const costReconciliation = kind === "adjust"
      ? (input as AdjustBudgetInput).costReconciliation ?? null
      : null;
    if (costReconciliation !== null && current.usage.costStatus === "known") {
      throw budgetFailure(
        "budget_cost_reconciliation_invalid",
        "Cost reconciliation is only valid while committed cost is partial or unknown.",
        false,
        "Use ordinary usage adjustments while the cumulative cost is already known.",
      );
    }
    const createdAt = this.storage.clock.utcNow();
    const entry = budgetLedgerEntrySchema.parse({
      schemaVersion: BUDGET_SCHEMA_VERSION,
      entryId: input.entryId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      kind,
      ledgerSequence: account.lastLedgerSequence + 1,
      reservationId,
      delta,
      usageBasis,
      admission,
      warningDimensions,
      costReconciliation,
      reconciliationRequired,
      evidence,
      createdAt,
    });
    const requestHash = mutationRequestHash(input, kind);
    const entryJson = canonicalJson(entry);
    this.storage.database.prepare(`
INSERT INTO usage_entries(
  usage_id, session_id, schema_version, entry_json, occurred_at, operation_id,
  idempotency_key, entry_kind, ledger_sequence, reservation_id, request_hash,
  entry_hash, result_snapshot_json, result_snapshot_hash
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(
        entry.entryId,
        entry.sessionId,
        entry.schemaVersion,
        entryJson,
        entry.createdAt,
        entry.operationId,
        entry.idempotencyKey,
        entry.kind,
        entry.ledgerSequence,
        entry.reservationId,
        requestHash,
        sha256(entryJson),
      );
    const nextPricingVersion = costReconciliation?.pricingVersion ?? account.pricingVersion;
    const updated = this.storage.database.prepare(`
UPDATE budget_accounts
SET last_ledger_sequence = ?, updated_at = ?, pricing_version = ?, policy_hash = ?
WHERE session_id = ? AND last_ledger_sequence = ?`)
      .run(
        entry.ledgerSequence,
        createdAt,
        nextPricingVersion,
        accountHash(account.policy, nextPricingVersion),
        entry.sessionId,
        account.lastLedgerSequence,
      );
    if (updated.changes !== 1) {
      throw budgetFailure("budget_state_conflict", "The budget ledger changed concurrently.", true, "Reload the durable budget snapshot and retry with the same idempotency key.");
    }
    const nextAccount = {
      ...account,
      pricingVersion: nextPricingVersion,
      lastLedgerSequence: entry.ledgerSequence,
      updatedAt: createdAt,
    };
    const snapshot = this.#project(nextAccount, true);
    const snapshotJson = canonicalJson(snapshot);
    const result = this.storage.database.prepare(`
UPDATE usage_entries SET result_snapshot_json = ?, result_snapshot_hash = ?
WHERE usage_id = ? AND result_snapshot_json IS NULL`)
      .run(snapshotJson, sha256(snapshotJson), entry.entryId);
    if (result.changes !== 1) throw corruptLedger("The budget result snapshot could not be bound to its ledger entry.");
    return { status: "inserted", entry, snapshot };
  }

  #duplicateResult(
    input: ReserveBudgetInput | CommitBudgetInput | ReleaseBudgetInput | AdjustBudgetInput,
    kind: BudgetLedgerEntry["kind"],
  ): BudgetMutationResult | null {
    const row = this.storage.database.prepare(`
SELECT ${LEDGER_COLUMNS} FROM usage_entries
WHERE session_id = ? AND idempotency_key = ?`)
      .get(input.sessionId, input.idempotencyKey) as LedgerRow | undefined;
    if (!row) return null;
    const entry = decodeEntry(row);
    if (row.request_hash !== requestHashFromEntry(entry)) {
      throw corruptLedger("A budget idempotency binding failed its integrity check.");
    }
    if (row.request_hash !== mutationRequestHash(input, kind)) {
      throw budgetFailure(
        "budget_idempotency_conflict",
        "The idempotency key is already bound to different budget parameters.",
        false,
        "Reuse the original parameters or allocate a new idempotency key.",
      );
    }
    const snapshot = decodeResultSnapshot(row);
    if (
      snapshot.sessionId !== entry.sessionId ||
      snapshot.lastLedgerSequence !== entry.ledgerSequence ||
      snapshot.updatedAt !== entry.createdAt
    ) {
      throw corruptLedger("A replayed budget result is not bound to its ledger entry.");
    }
    return { status: "duplicate", entry, snapshot };
  }

  #requireOpenReservation(sessionId: StableId, operationId: StableId, reservationId: StableId): BudgetLedgerEntry {
    const row = this.#loadEntryById(reservationId);
    if (!row) throw budgetFailure("budget_reservation_not_found", "The referenced reservation does not exist.", false, "Use the reservation returned by the successful reserve call.");
    const reservation = decodeEntry(row);
    if (reservation.kind !== "reserve" || reservation.sessionId !== sessionId || reservation.operationId !== operationId) {
      throw budgetFailure("budget_reservation_mismatch", "The reservation is bound to a different Session or operation.", false, "Settle only the reservation created for this operation.");
    }
    const resolution = this.storage.database.prepare(`
SELECT ${LEDGER_COLUMNS} FROM usage_entries
WHERE session_id = ? AND reservation_id = ? AND entry_kind IN ('commit', 'release')
ORDER BY ledger_sequence LIMIT 1`)
      .get(sessionId, reservationId) as LedgerRow | undefined;
    if (resolution) {
      decodeEntry(resolution);
      throw budgetFailure("budget_reservation_settled", "The reservation has already been committed or released.", false, "Use the original settlement idempotency key to replay its result.");
    }
    return reservation;
  }

  #project(account: DecodedAccount, allowPendingFinalResult = false): BudgetSnapshot {
    const entries = this.#loadEntries(account.sessionId, account.lastLedgerSequence, allowPendingFinalResult);
    let usage: BudgetUsage = ZERO_BUDGET_USAGE;
    const reservations = new Map<StableId, BudgetDelta>();
    for (const entry of entries) {
      if (entry.kind === "reserve") reservations.set(entry.entryId, entry.delta);
      if (entry.kind === "commit") {
        if (!entry.reservationId || !reservations.delete(entry.reservationId)) throw corruptLedger("A commit does not resolve an open reservation.");
        usage = addUsage(usage, entry.delta);
      }
      if (entry.kind === "release") {
        if (!entry.reservationId || !reservations.delete(entry.reservationId)) throw corruptLedger("A release does not resolve an open reservation.");
      }
      if (entry.kind === "adjust") usage = addUsage(usage, entry.delta);
      if (entry.kind === "adjust" && entry.costReconciliation !== null) {
        usage = {
          ...usage,
          costUsd: entry.costReconciliation.resolvedCostUsd,
          costStatus: entry.costReconciliation.costStatus,
        };
      }
    }
    let reserved: BudgetUsage = ZERO_BUDGET_USAGE;
    for (const delta of reservations.values()) reserved = addUsage(reserved, delta);
    const provisional = budgetSnapshotSchema.parse({
      schemaVersion: BUDGET_SCHEMA_VERSION,
      sessionId: account.sessionId,
      usage,
      reserved,
      limits: account.policy.limits,
      pricingVersion: account.pricingVersion,
      countWaitingTime: account.policy.countWaitingTime,
      softLimitRatio: account.policy.softLimitRatio,
      limitStatus: "within",
      limitDimensions: [],
      updatedAt: account.updatedAt,
      lastLedgerSequence: account.lastLedgerSequence,
    });
    const decision = new BudgetController(account.policy).evaluate(provisional);
    const limitStatus = decision.violations.some((violation) => violation.category === "pricing_unknown")
      ? "pricing_unknown"
      : decision.outcome === "deny"
      ? "hard_limit"
      : decision.outcome === "warn"
      ? "soft_limit"
      : "within";
    return budgetSnapshotSchema.parse({
      ...provisional,
      limitStatus,
      limitDimensions: decision.violations.map((violation) => violation.dimension),
    });
  }

  #loadEntries(
    sessionId: StableId,
    lastLedgerSequence: number,
    allowPendingFinalResult = false,
  ): readonly BudgetLedgerEntry[] {
    const rows = this.storage.database.prepare(`
SELECT ${LEDGER_COLUMNS} FROM usage_entries
WHERE session_id = ? AND ledger_sequence IS NOT NULL
ORDER BY ledger_sequence`)
      .all(sessionId) as LedgerRow[];
    const entries = rows.map((row, index) =>
      decodeEntry(row, allowPendingFinalResult && index === rows.length - 1));
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index]?.ledgerSequence !== index) throw corruptLedger("The budget ledger has a sequence gap or duplicate.");
    }
    if ((entries.at(-1)?.ledgerSequence ?? -1) !== lastLedgerSequence) {
      throw corruptLedger("The budget account watermark disagrees with its ledger.");
    }
    return entries;
  }

  #loadAccount(sessionId: StableId): AccountRow | undefined {
    return this.storage.database.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM budget_accounts WHERE session_id = ?`)
      .get(sessionId) as AccountRow | undefined;
  }

  #loadEntryById(entryId: StableId): LedgerRow | undefined {
    return this.storage.database.prepare(`SELECT ${LEDGER_COLUMNS} FROM usage_entries WHERE usage_id = ?`)
      .get(entryId) as LedgerRow | undefined;
  }

  #assertSessionActive(sessionId: StableId): void {
    const row = this.storage.database.prepare("SELECT deletion_state FROM sessions WHERE session_id = ?").get(sessionId);
    if (!row || row.deletion_state !== "active") {
      throw budgetFailure("budget_session_unavailable", "The budget Session does not exist or is being deleted.", false, "Use an active durable Session.");
    }
  }

  #acquireExecutionWriteLock(): void {
    const result = this.storage.database.prepare("UPDATE storage_installation SET schema_version = schema_version WHERE singleton = 1").run();
    if (result.changes !== 1) throw corruptLedger("The storage installation record is missing.");
  }

  #transaction<T>(operation: () => T): T {
    try {
      this.storage.database.exec("BEGIN IMMEDIATE");
      const result = operation();
      this.storage.database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      if (this.storage.database.isTransaction) this.storage.database.exec("ROLLBACK");
      throw translateBudgetError(error);
    }
  }
}

interface DecodedAccount {
  readonly sessionId: StableId;
  readonly policy: BudgetPolicy;
  readonly pricingVersion: string | null;
  readonly lastLedgerSequence: number;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

function decodeAccount(row: AccountRow): DecodedAccount {
  if (typeof row.policy_json !== "string" || typeof row.policy_hash !== "string") throw corruptLedger("A budget policy failed its integrity hash.");
  let raw: unknown;
  try { raw = JSON.parse(row.policy_json); } catch { throw corruptLedger("A budget policy is not valid JSON."); }
  const policy = budgetPolicySchema.safeParse(raw);
  const sessionId = stableIdSchema.safeParse(row.session_id);
  const pricingVersion = row.pricing_version === null ? null : versionIdentifierSchema.safeParse(row.pricing_version);
  const createdAt = utcTimestampSchema.safeParse(row.created_at);
  const updatedAt = utcTimestampSchema.safeParse(row.updated_at);
  if (!policy.success || !sessionId.success || !createdAt.success || !updatedAt.success || (pricingVersion !== null && !pricingVersion.success)) throw corruptLedger("A budget account does not match the current schema.");
  const decodedPricingVersion = pricingVersion === null ? null : pricingVersion.data;
  if (accountHash(policy.data, decodedPricingVersion) !== row.policy_hash) throw corruptLedger("A budget policy or pricing version failed its integrity hash.");
  if (canonicalJson(policy.data) !== row.policy_json || row.schema_version !== BUDGET_SCHEMA_VERSION || !Number.isSafeInteger(row.last_ledger_sequence)) throw corruptLedger("A budget account index disagrees with its canonical policy.");
  return {
    sessionId: sessionId.data,
    policy: policy.data,
    pricingVersion: decodedPricingVersion,
    lastLedgerSequence: row.last_ledger_sequence as number,
    createdAt: createdAt.data,
    updatedAt: updatedAt.data,
  };
}

function decodeEntry(row: LedgerRow, allowPendingResult = false): BudgetLedgerEntry {
  if (typeof row.entry_json !== "string" || typeof row.entry_hash !== "string" || sha256(row.entry_json) !== row.entry_hash) throw corruptLedger("A budget entry failed its integrity hash.");
  let raw: unknown;
  try { raw = JSON.parse(row.entry_json); } catch { throw corruptLedger("A budget entry is not valid JSON."); }
  const parsed = budgetLedgerEntrySchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.entry_json) throw corruptLedger("A budget entry does not match the current canonical schema.");
  const entry = parsed.data;
  if (row.usage_id !== entry.entryId || row.session_id !== entry.sessionId || row.schema_version !== entry.schemaVersion || row.occurred_at !== entry.createdAt || row.operation_id !== entry.operationId || row.idempotency_key !== entry.idempotencyKey || row.entry_kind !== entry.kind || row.ledger_sequence !== entry.ledgerSequence || row.reservation_id !== entry.reservationId) throw corruptLedger("A budget entry index disagrees with its canonical fact.");
  if (row.request_hash !== requestHashFromEntry(entry)) throw corruptLedger("A budget entry idempotency binding disagrees with its canonical fact.");
  if (allowPendingResult && row.result_snapshot_json === null && row.result_snapshot_hash === null) return entry;
  const snapshot = decodeResultSnapshot(row);
  if (
    snapshot.sessionId !== entry.sessionId ||
    snapshot.lastLedgerSequence !== entry.ledgerSequence ||
    snapshot.updatedAt !== entry.createdAt
  ) {
    throw corruptLedger("A budget result snapshot is not bound to its ledger entry.");
  }
  return entry;
}

function decodeResultSnapshot(row: LedgerRow): BudgetSnapshot {
  if (typeof row.result_snapshot_json !== "string" || typeof row.result_snapshot_hash !== "string" || sha256(row.result_snapshot_json) !== row.result_snapshot_hash) throw corruptLedger("A budget mutation result failed its integrity hash.");
  let raw: unknown;
  try { raw = JSON.parse(row.result_snapshot_json); } catch { throw corruptLedger("A budget mutation result is not valid JSON."); }
  const parsed = budgetSnapshotSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.result_snapshot_json) throw corruptLedger("A budget mutation result does not match the current schema.");
  return parsed.data;
}

function validateInitialization(input: InitializeBudgetInput): InitializeBudgetInput {
  const sessionId = parseSessionId(input.sessionId);
  const policy = budgetPolicySchema.safeParse(input.policy);
  const pricingVersion = input.pricingVersion === null ? null : versionIdentifierSchema.safeParse(input.pricingVersion);
  if (!policy.success || (pricingVersion !== null && !pricingVersion.success)) throw invalidRequest();
  return { sessionId, policy: policy.data, pricingVersion: pricingVersion === null ? null : pricingVersion.data };
}

function validateReserve(input: ReserveBudgetInput): ReserveBudgetInput {
  const common = validateMutation(input);
  const delta = budgetDeltaSchema.safeParse(input.delta);
  if (!delta.success) throw invalidRequest();
  const evidence = input.evidence === undefined || input.evidence === null ? null : budgetEvidenceSchema.safeParse(input.evidence);
  if (evidence !== null && !evidence.success) throw invalidRequest();
  return { ...common, delta: delta.data, evidence: evidence === null ? null : evidence.data };
}

function validateCommit(input: CommitBudgetInput): CommitBudgetInput {
  const common = validateMutation(input);
  const reservationId = parseEntryId(input.reservationId);
  const actual = input.actual === null ? null : budgetDeltaSchema.safeParse(input.actual);
  if (actual !== null && !actual.success) throw invalidRequest();
  const evidence = input.evidence === undefined || input.evidence === null ? null : budgetEvidenceSchema.safeParse(input.evidence);
  if (evidence !== null && !evidence.success) throw invalidRequest();
  return { ...common, reservationId, actual: actual === null ? null : actual.data, evidence: evidence === null ? null : evidence.data };
}

function validateRelease(input: ReleaseBudgetInput): ReleaseBudgetInput {
  if (input.operationStarted !== false) throw invalidRequest();
  return { ...validateMutation(input), reservationId: parseEntryId(input.reservationId), operationStarted: false };
}

function validateAdjust(input: AdjustBudgetInput): AdjustBudgetInput {
  const common = validateMutation(input);
  const delta = budgetDeltaSchema.safeParse(input.delta);
  if (!delta.success) throw invalidRequest();
  const evidence = input.evidence === undefined || input.evidence === null ? null : budgetEvidenceSchema.safeParse(input.evidence);
  const costReconciliation = input.costReconciliation === undefined || input.costReconciliation === null
    ? null
    : budgetCostReconciliationSchema.safeParse(input.costReconciliation);
  if (
    (evidence !== null && !evidence.success) ||
    (costReconciliation !== null && !costReconciliation.success)
  ) throw invalidRequest();
  return {
    ...common,
    delta: delta.data,
    evidence: evidence === null ? null : evidence.data,
    costReconciliation: costReconciliation === null ? null : costReconciliation.data,
  };
}

function validateMutation(input: ReserveBudgetInput | CommitBudgetInput | ReleaseBudgetInput | AdjustBudgetInput) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 256) throw invalidRequest();
  return {
    entryId: parseEntryId(input.entryId),
    sessionId: parseSessionId(input.sessionId),
    operationId: parseEntryId(input.operationId),
    idempotencyKey,
  };
}

function mutationRequestHash(
  input: ReserveBudgetInput | CommitBudgetInput | ReleaseBudgetInput | AdjustBudgetInput,
  kind: BudgetLedgerEntry["kind"],
): string {
  return sha256(canonicalJson({ ...input, kind }));
}

function requestHashFromEntry(entry: BudgetLedgerEntry): string {
  const common = {
    entryId: entry.entryId,
    sessionId: entry.sessionId,
    operationId: entry.operationId,
    idempotencyKey: entry.idempotencyKey,
  };
  switch (entry.kind) {
    case "reserve":
      return mutationRequestHash({ ...common, delta: entry.delta, evidence: entry.evidence }, "reserve");
    case "commit":
      if (!entry.reservationId) throw corruptLedger("A commit is missing its reservation identity.");
      return mutationRequestHash({
        ...common,
        reservationId: entry.reservationId,
        actual: entry.usageBasis === "conservative" ? null : entry.delta,
        evidence: entry.evidence,
      }, "commit");
    case "release":
      if (!entry.reservationId) throw corruptLedger("A release is missing its reservation identity.");
      return mutationRequestHash({ ...common, reservationId: entry.reservationId, operationStarted: false }, "release");
    case "adjust":
      return mutationRequestHash({
        ...common,
        delta: entry.delta,
        evidence: entry.evidence,
        costReconciliation: entry.costReconciliation,
      }, "adjust");
  }
}

function parseSessionId(value: StableId): StableId {
  const parsed = stableIdSchema.safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

function parseEntryId(value: StableId): StableId {
  const parsed = stableIdSchema.safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

function invalidRequest(): BudgetError {
  return budgetFailure("budget_request_invalid", "The budget request does not match the current schema.", false, "Rebuild the request from validated operation inputs.");
}

function corruptLedger(message: string): BudgetError {
  return budgetFailure("budget_storage_corrupt", message, false, "Stop new operations and inspect the durable budget ledger.");
}

function budgetFailure(category: string, message: string, retryable: boolean, recovery: string | null): BudgetError {
  return createBudgetError(category, message, retryable, recovery);
}

function translateBudgetError(error: unknown): BudgetError | StorageError {
  if (error instanceof BudgetError || error instanceof StorageError) return error;
  return translateStorageError(error);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function accountHash(policy: BudgetPolicy, pricingVersion: string | null): string {
  return sha256(canonicalJson({ policy, pricingVersion }));
}
