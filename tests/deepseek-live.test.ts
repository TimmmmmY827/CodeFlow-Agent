import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startProductionReadonlySession } from "../src/app/readonly-session-runner.js";
import { reduceAgentEvents } from "../src/events/state-reducer.js";
import { SqliteBudgetLedger } from "../src/storage/sqlite/sqlite-budget-ledger.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";

const live = process.env.RUN_DEEPSEEK_LIVE === "1";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe.skipIf(!live)("DeepSeek live read-only acceptance", () => {
  it("runs the production composition through a real tool call and replayable terminal state", async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required when RUN_DEEPSEEK_LIVE=1.");
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "codeflow-live-"));
    temporaryDirectories.push(dataDirectory);
    const workspace = path.resolve(process.cwd());
    const signal = AbortSignal.timeout(90_000);
    const running = await startProductionReadonlySession(
      {
        goal: "Use list_files to identify one top-level repository entry, then answer with only that entry name.",
        workspace,
        signal,
      },
      { dataDirectory, apiKey, model: "deepseek-v4-flash", timeoutMs: 60_000 },
    );

    try {
      const streamed = collect(running, signal);
      const result = await running.completion;
      const facts = await streamed;

      expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" });
      expect(result.toolCalls).toBeGreaterThan(0);
      expect(reduceAgentEvents(facts)).toMatchObject({ status: "COMPLETION_VERIFIED", traceComplete: true });

      running.close();
      using storage = new SqliteStorageDatabase(path.join(dataDirectory, "codeflow.sqlite"));
      const ledger = new SqliteBudgetLedger(storage);
      expect(await ledger.listOpenReservations(running.sessionId)).toEqual([]);
      const snapshot = await ledger.getSnapshot(running.sessionId);
      const completedModels = facts.filter((event) => event.type === "model.completed");
      console.info("DEEPSEEK_LIVE_EVIDENCE", JSON.stringify({
        model: "deepseek-v4-flash",
        sessionId: running.sessionId,
        responseIds: completedModels.map((event) => event.payload.responseId),
        modelAttempts: result.modelAttempts,
        toolCalls: result.toolCalls,
        eventCount: facts.length,
        usage: snapshot?.usage ?? null,
      }));
    } finally {
      running.close();
    }
  }, 120_000);
});

async function collect(
  source: { streamEvents(options: { afterSequence: number; signal: AbortSignal }): AsyncIterable<import("../src/events/agent-event.js").AgentEvent> },
  signal: AbortSignal,
) {
  const events = [];
  for await (const event of source.streamEvents({ afterSequence: -1, signal })) events.push(event);
  return events;
}
