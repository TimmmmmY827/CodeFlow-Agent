import { render, type Instance } from "ink";
import React from "react";

import {
  startProductionReadonlySession,
  type ProductionReadonlySessionOptions,
  type RunningReadonlySession,
  type StartReadonlySessionRequest,
} from "../app/readonly-session-runner.js";
import type { RunReadonlySessionResult } from "../agent/agent-event-loop.js";
import {
  SessionTaskTree,
  buildSessionTaskTreeLines,
  consumeSessionEvents,
  sanitizeTerminalText,
} from "./ui/session-task-tree.js";
import { SessionTaskTreeProjector, type SessionTaskTreeViewModel } from "./ui/session-task-tree-projector.js";

export interface ExecuteReadonlyRunInput extends StartReadonlySessionRequest, ProductionReadonlySessionOptions {
  readonly interactive: boolean;
  readonly terminalWidth?: number;
}

export interface ExecuteReadonlyRunDependencies {
  readonly startSession?: (
    request: StartReadonlySessionRequest,
    options: ProductionReadonlySessionOptions,
  ) => Promise<RunningReadonlySession>;
  readonly writeLine?: (line: string) => void;
}

export interface ExecuteReadonlyRunResult {
  readonly exitCode: 0 | 1 | 4;
  readonly sessionId: string;
  readonly result: RunReadonlySessionResult;
  readonly view: SessionTaskTreeViewModel;
}

export async function executeReadonlyRun(
  input: ExecuteReadonlyRunInput,
  dependencies: ExecuteReadonlyRunDependencies = {},
): Promise<ExecuteReadonlyRunResult> {
  const startSession = dependencies.startSession ?? startProductionReadonlySession;
  const writeLine = dependencies.writeLine ?? console.log;
  const running = await startSession(
    {
      goal: input.goal,
      workspace: input.workspace,
      signal: input.signal,
      deadlineAt: input.deadlineAt ?? null,
    },
    {
      dataDirectory: input.dataDirectory,
      apiKey: input.apiKey,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
  );

  const inkRef: { current: Instance | null } = { current: null };
  const presentationController = new AbortController();
  try {
    writeLine(`Session ${running.sessionId}`);
    const projector = new SessionTaskTreeProjector();
    const presentation = consumeSessionEvents(
      running,
      projector,
      (view) => {
        if (!input.interactive) return;
        const element = React.createElement(SessionTaskTree, {
          model: view,
          width: input.terminalWidth ?? process.stdout.columns ?? 80,
        });
        if (inkRef.current) inkRef.current.rerender(element);
        else inkRef.current = render(element, { exitOnCtrlC: false });
      },
      presentationController.signal,
    );
    let result: RunReadonlySessionResult;
    try {
      [result] = await Promise.all([running.completion, presentation]);
    } catch (error: unknown) {
      // A projection/stream failure must not close SQLite beneath an in-flight
      // paid call. Let the runner reach and persist its own terminal boundary.
      await running.completion.catch(() => undefined);
      throw error;
    }
    const view = projector.snapshot();
    if (!view) throw new Error("The Session ended without any durable events.");

    if (inkRef.current) {
      await inkRef.current.waitUntilRenderFlush();
      inkRef.current.unmount();
      inkRef.current = null;
    } else {
      for (const line of buildSessionTaskTreeLines(view, input.terminalWidth ?? 100)) writeLine(line.text);
    }
    if (result.outputText) writeLine(`结果 ${sanitizeTerminalText(result.outputText)}`);
    return {
      exitCode: result.status === "completed" ? 0 : result.status === "cancelled" ? 4 : 1,
      sessionId: running.sessionId,
      result,
      view,
    };
  } finally {
    presentationController.abort();
    if (inkRef.current) inkRef.current.unmount();
    running.close();
  }
}
