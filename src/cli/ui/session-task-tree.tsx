import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";

import type { AgentEvent } from "../../events/agent-event.js";
import { structuredErrorSchema, type StructuredError } from "../../shared/contracts.js";
import {
  SessionTaskTreeProjector,
  type SessionOperationNode,
  type SessionTaskTreeViewModel,
} from "./session-task-tree-projector.js";

export interface SessionEventStreamOptions {
  readonly afterSequence: number;
  readonly signal: AbortSignal;
}

/** Structurally compatible with the C12 SessionHandle streaming boundary. */
export interface SessionEventSource {
  streamEvents(options: SessionEventStreamOptions): AsyncIterable<AgentEvent>;
}

export type SessionTaskTreeTone = "normal" | "muted" | "success" | "warning" | "danger" | "accent";

export interface SessionTaskTreeLine {
  readonly text: string;
  readonly tone: SessionTaskTreeTone;
}

export interface SessionTaskTreeProps {
  readonly model: SessionTaskTreeViewModel;
  readonly width?: number;
}

export interface LiveSessionTaskTreeProps {
  /** One logical Session source. Change the React key to bind the view to another Session. */
  readonly source: SessionEventSource;
  readonly width?: number;
}

export function SessionTaskTree({ model, width = 80 }: SessionTaskTreeProps): React.JSX.Element {
  const lines = buildSessionTaskTreeLines(model, width);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {lines.map((line, index) => (
        <Text key={`${index}:${line.text}`} {...toneProps(line.tone)}>{line.text}</Text>
      ))}
    </Box>
  );
}

export function LiveSessionTaskTree({ source, width = 80 }: LiveSessionTaskTreeProps): React.JSX.Element {
  const [projector] = useState(() => new SessionTaskTreeProjector());
  const [model, setModel] = useState<SessionTaskTreeViewModel | null>(null);
  const [error, setError] = useState<StructuredError | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    const controller = new AbortController();
    void consumeSessionEvents(sourceRef.current, projector, setModel, controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(toStructuredError(reason));
    });
    return () => controller.abort();
  }, [projector]);

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
        <Text color="red">实时任务树已停止</Text>
        <Text>{sanitizeTerminalText(`[${error.category}] ${error.message}`)}</Text>
      </Box>
    );
  }
  if (!model) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text dimColor>等待 Session 事件…</Text>
      </Box>
    );
  }
  return <SessionTaskTree model={model} width={width} />;
}

export async function consumeSessionEvents(
  source: SessionEventSource,
  projector: SessionTaskTreeProjector,
  onUpdate: (model: SessionTaskTreeViewModel) => void,
  signal: AbortSignal,
): Promise<void> {
  for await (const event of source.streamEvents({ afterSequence: -1, signal })) {
    if (signal.aborted) return;
    onUpdate(projector.apply(event));
  }
}

export function buildSessionTaskTreeLines(
  model: SessionTaskTreeViewModel,
  requestedWidth = 80,
): readonly SessionTaskTreeLine[] {
  const width = Math.max(24, requestedWidth - 4);
  const lines: SessionTaskTreeLine[] = [
    line(`CodeFlow Session ${shortId(model.sessionId)}`, "accent", width),
    line(`${statusMark(model.status)} ${model.status} · seq ${model.lastSequence} · trace ${model.traceComplete ? "完整" : "不完整"}`, statusTone(model.status), width),
    line(`目标 ${model.goal ?? "（未记录）"}`, "normal", width),
    line(`工作区 ${model.workspacePath}`, "muted", width),
  ];

  if (model.plan.length > 0) {
    lines.push(line(`计划 r${model.planRevision}`, "accent", width));
    model.plan.forEach((step, index) => {
      lines.push(line(`  ${index + 1}. ${step}`, index === 0 && model.status === "RUNNING" ? "accent" : "normal", width));
    });
  }

  lines.push(line("执行", "accent", width));
  if (model.operations.length === 0) {
    lines.push(line("  └─ 尚无模型或工具调用", "muted", width));
  } else {
    model.operations.forEach((operation, index) => {
      const branch = index === model.operations.length - 1 ? "└─" : "├─";
      lines.push(line(`  ${branch} ${operationMark(operation)} ${operation.kind} ${operation.name}${operationDuration(operation)}`, operationTone(operation), width));
      if (operation.error) {
        lines.push(line(`     错误 [${operation.error.category}] ${operation.error.message}`, "danger", width));
      }
    });
  }

  if (model.verificationPassed !== null) {
    lines.push(line(`验证 ${model.verificationPassed ? "通过" : "失败"}`, model.verificationPassed ? "success" : "danger", width));
  }
  if (model.budget) lines.push(line(formatBudget(model.budget), budgetTone(model.budget.limitStatus), width));
  if (model.firstError) {
    lines.push(line(`首错 #${model.firstError.sequence} [${model.firstError.category}] ${model.firstError.message}`, "danger", width));
  }
  return lines;
}

export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function line(text: string, tone: SessionTaskTreeTone, width: number): SessionTaskTreeLine {
  const safe = sanitizeTerminalText(text);
  return {
    text: truncateTerminalText(safe, width),
    tone,
  };
}

function truncateTerminalText(value: string, width: number): string {
  if (terminalTextWidth(value) <= width) return value;
  const targetWidth = Math.max(1, width - 1);
  let result = "";
  let usedWidth = 0;
  for (const character of value) {
    const characterWidth = terminalCharacterWidth(character);
    if (usedWidth + characterWidth > targetWidth) break;
    result += character;
    usedWidth += characterWidth;
  }
  return `${result}…`;
}

function terminalTextWidth(value: string): number {
  return [...value].reduce((width, character) => width + terminalCharacterWidth(character), 0);
}

function terminalCharacterWidth(character: string): number {
  if (/\p{Mark}/u.test(character)) return 0;
  const codePoint = character.codePointAt(0) ?? 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

// Covers the East Asian wide/full-width and emoji ranges used by the TUI.
function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function operationMark(operation: SessionOperationNode): string {
  switch (operation.status) {
    case "running": return "●";
    case "completed": return "✓";
    case "reconciled": return "↺";
    case "cancelled": return "■";
    case "unknown": return "?";
    case "failed": return "✗";
  }
}

function operationTone(operation: SessionOperationNode): SessionTaskTreeTone {
  switch (operation.status) {
    case "completed":
    case "reconciled": return "success";
    case "running": return "accent";
    case "unknown": return "warning";
    case "cancelled": return "muted";
    case "failed": return "danger";
  }
}

function operationDuration(operation: SessionOperationNode): string {
  return operation.durationMs === null ? "" : ` · ${formatDuration(operation.durationMs)}`;
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

function formatBudget(budget: NonNullable<SessionTaskTreeViewModel["budget"]>): string {
  const cost = budget.usage.costStatus === "unknown" || budget.usage.costUsd === null
    ? "费用 unknown"
    : `费用 $${budget.usage.costUsd.toFixed(6)}`;
  return [
    `预算 ${budget.limitStatus}`,
    `steps ${budget.usage.steps}+${budget.reserved.steps}/${budget.limits.maxSteps}`,
    `tools ${budget.usage.toolCalls}+${budget.reserved.toolCalls}/${budget.limits.maxToolCalls}`,
    cost,
  ].join(" · ");
}

function budgetTone(status: NonNullable<SessionTaskTreeViewModel["budget"]>["limitStatus"]): SessionTaskTreeTone {
  if (status === "within") return "muted";
  if (status === "soft_limit") return "warning";
  return "danger";
}

function statusMark(status: SessionTaskTreeViewModel["status"]): string {
  if (status === "COMPLETION_VERIFIED") return "✓";
  if (["FAILED", "UNKNOWN"].includes(status)) return "!";
  if (["CANCELLED", "CANCELLING"].includes(status)) return "■";
  return "●";
}

function statusTone(status: SessionTaskTreeViewModel["status"]): SessionTaskTreeTone {
  if (status === "COMPLETION_VERIFIED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "UNKNOWN" || status === "WAITING_APPROVAL" || status === "WAITING_USER") return "warning";
  if (status === "CANCELLED" || status === "CANCELLING") return "muted";
  return "accent";
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function toneProps(tone: SessionTaskTreeTone): { readonly color?: string; readonly dimColor?: boolean; readonly bold?: boolean } {
  switch (tone) {
    case "accent": return { color: "cyan", bold: true };
    case "success": return { color: "green" };
    case "warning": return { color: "yellow" };
    case "danger": return { color: "red" };
    case "muted": return { dimColor: true };
    case "normal": return {};
  }
}

function toStructuredError(error: unknown): StructuredError {
  if (typeof error === "object" && error !== null && "details" in error) {
    const details = (error as { readonly details?: unknown }).details;
    const parsed = structuredErrorSchema.safeParse(details);
    if (parsed.success) return parsed.data;
  }
  return {
    category: "session_event_stream_failed",
    message: error instanceof Error ? error.message : "The Session event stream failed.",
    retryable: true,
    sideEffectStatus: "none",
    recovery: "Restore the event stream and remount the task tree; replayed duplicate events are idempotent.",
  };
}
