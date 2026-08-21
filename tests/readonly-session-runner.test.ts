import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startReadonlySession } from "../src/app/readonly-session-runner.js";
import { reduceAgentEvents } from "../src/events/state-reducer.js";
import { MODEL_ADAPTER_PROTOCOL_VERSION, type ModelAdapter, type ModelRequest, type ModelResponse } from "../src/model/model-adapter.js";
import type { Clock } from "../src/shared/contracts.js";
import { SqliteStorageDatabase } from "../src/storage/sqlite/sqlite-database.js";
import { SqliteEventStore } from "../src/storage/sqlite/sqlite-event-store.js";

const NOW = "2026-08-15T00:00:00.000Z" as const;
const clock: Clock = { utcNow: () => NOW, monotonicNowMs: () => 0 };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("production-shaped read-only Session runner", () => {
  it("persists one replayable run and streams the same terminal trace", async () => {
    const fixture = await createFixture();
    const model = new ScriptedModelAdapter();
    const running = await startReadonlySession(
      { goal: "Identify one top-level file", workspace: fixture.workspace, signal: new AbortController().signal },
      { dataDirectory: fixture.dataDirectory, modelAdapter: model, clock, maxSteps: 4, maxOutputTokens: 128 },
    );
    const streamed = collect(running);

    const result = await running.completion;
    const facts = await streamed;
    running.close();

    expect(result).toMatchObject({ status: "completed", outputText: "README.md", modelAttempts: 2, toolCalls: 1 });
    expect(facts.map((event) => event.type)).toEqual([
      "session.created",
      "session.started",
      "model.started",
      "model.completed",
      "tool.started",
      "tool.completed",
      "model.started",
      "model.completed",
      "verification.started",
      "verification.completed",
      "completion.claimed",
      "completion.verified",
    ]);
    expect(reduceAgentEvents(facts)).toMatchObject({ status: "COMPLETION_VERIFIED", traceComplete: true });

    using reopened = new SqliteStorageDatabase(path.join(fixture.dataDirectory, "codeflow.sqlite"), { clock });
    const persisted = await new SqliteEventStore(reopened).list(running.sessionId);
    expect(persisted).toEqual(facts);
  });

  it("reuses the stable Workspace identity across sequential Sessions", async () => {
    const fixture = await createFixture();
    const changingClock = incrementingClock();
    const first = await runOnce(fixture, new ScriptedModelAdapter(), changingClock);
    const second = await runOnce(fixture, new ScriptedModelAdapter(), changingClock);

    expect(first.sessionId).not.toBe(second.sessionId);
    using storage = new SqliteStorageDatabase(path.join(fixture.dataDirectory, "codeflow.sqlite"), { clock });
    const rows = storage.database.prepare("SELECT session_id, workspace_id FROM sessions ORDER BY created_at, session_id").all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.workspace_id)).size).toBe(1);
  });

  it("keeps an in-workspace .codeflow database outside model reads and completion diffs", async () => {
    const fixture = await createFixture();
    const running = await startReadonlySession(
      { goal: "Identify one top-level file", workspace: fixture.workspace, signal: new AbortController().signal },
      { dataDirectory: path.join(fixture.workspace, ".codeflow"), modelAdapter: new ScriptedModelAdapter(), clock, maxSteps: 4, maxOutputTokens: 128 },
    );
    const facts = collect(running);

    const result = await running.completion;
    await facts;
    running.close();

    expect(result.status).toBe("completed");
  });

  it("rejects a model-visible data directory inside the workspace", async () => {
    const fixture = await createFixture();

    await expect(startReadonlySession(
      { goal: "Inspect", workspace: fixture.workspace, signal: new AbortController().signal },
      { dataDirectory: path.join(fixture.workspace, "private-data"), modelAdapter: new ScriptedModelAdapter(), clock },
    )).rejects.toThrow("must be nested under .codeflow");
  });

  it("rejects an in-workspace data directory reached through a filesystem alias", async () => {
    const fixture = await createFixture();
    const workspaceAlias = path.join(path.dirname(fixture.workspace), "workspace-alias");
    await symlink(fixture.workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir");

    await expect(startReadonlySession(
      { goal: "Inspect", workspace: fixture.workspace, signal: new AbortController().signal },
      { dataDirectory: path.join(workspaceAlias, "private-data"), modelAdapter: new ScriptedModelAdapter(), clock },
    )).rejects.toThrow("must be nested under .codeflow");
  });
});

async function runOnce(fixture: Fixture, model: ModelAdapter, runClock: Clock) {
  const running = await startReadonlySession(
    { goal: "Identify one top-level file", workspace: fixture.workspace, signal: new AbortController().signal },
    { dataDirectory: fixture.dataDirectory, modelAdapter: model, clock: runClock, maxSteps: 4, maxOutputTokens: 128 },
  );
  const facts = collect(running);
  const result = await running.completion;
  await facts;
  running.close();
  expect(result.status).toBe("completed");
  return running;
}

function incrementingClock(): Clock {
  let milliseconds = Date.parse(NOW);
  return {
    utcNow: () => new Date(milliseconds++).toISOString() as typeof NOW,
    monotonicNowMs: () => milliseconds,
  };
}

async function collect(source: { streamEvents(options: { afterSequence: number; signal: AbortSignal }): AsyncIterable<import("../src/events/agent-event.js").AgentEvent> }) {
  const events = [];
  for await (const event of source.streamEvents({ afterSequence: -1, signal: new AbortController().signal })) events.push(event);
  return events;
}

interface Fixture {
  readonly workspace: string;
  readonly dataDirectory: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "codeflow-runner-"));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const dataDirectory = path.join(root, "data");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "README.md"), "# Fixture\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspace, windowsHide: true });
  return { workspace, dataDirectory };
}

class ScriptedModelAdapter implements ModelAdapter {
  readonly provider = "deepseek";
  readonly model = "deepseek-v4-flash";
  readonly requests: ModelRequest[] = [];

  capabilities() {
    return {
      protocolVersion: MODEL_ADAPTER_PROTOCOL_VERSION,
      streaming: false as const,
      toolCalling: true as const,
      parallelToolCalls: true as const,
      reasoningContinuation: false as const,
      serverSideTools: false as const,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        responseId: "runner-tool",
        model: this.model,
        outputText: "",
        toolCalls: [{ callId: "call-list", name: "list_files", argumentsJson: "{\"path\":\".\",\"maxDepth\":1}", arguments: { path: ".", maxDepth: 1 } }],
        finishReason: "tool_calls",
        usage: usage(20, 5),
      };
    }
    return {
      responseId: "runner-final",
      model: this.model,
      outputText: "README.md",
      toolCalls: [],
      finishReason: "stop",
      usage: usage(22, 8),
    };
  }
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cachedTokens: 0,
    totalTokens: inputTokens + outputTokens,
    costUsd: null,
    durationMs: 10,
    providerUsage: {},
  };
}
