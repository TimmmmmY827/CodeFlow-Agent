import { z } from "zod";

import { agentEventSchema } from "../events/agent-event.js";
import {
  pathReferenceSchema,
  stableIdSchema,
  utcTimestampSchema,
  versionIdentifierSchema,
} from "../shared/contracts.js";
import { STORAGE_RECORD_SCHEMA_VERSION } from "./contracts.js";

export const workspaceRecordSchema = z.object({
  schemaVersion: z.literal(STORAGE_RECORD_SCHEMA_VERSION),
  workspaceId: stableIdSchema,
  root: pathReferenceSchema,
  fingerprint: z.string().min(1),
  createdAt: utcTimestampSchema,
});

export const createSessionRecordSchema = z.object({
  schemaVersion: z.literal(STORAGE_RECORD_SCHEMA_VERSION),
  sessionId: stableIdSchema,
  workspace: workspaceRecordSchema,
  goal: z.string().trim().min(1),
  createdAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema.nullable(),
  configVersion: versionIdentifierSchema,
  toolCatalogHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected a canonical SHA-256 digest."),
});

const taskFields = {
  schemaVersion: z.literal(STORAGE_RECORD_SCHEMA_VERSION),
  taskId: stableIdSchema,
  sessionId: stableIdSchema,
  parentTaskId: stableIdSchema.nullable(),
  actorId: z.string().min(1),
  title: z.string().min(1),
  createdAt: utcTimestampSchema,
} as const;

export const taskRecordSchema = z.object(taskFields);

export const rootTaskRecordSchema = z.object({
  schemaVersion: taskFields.schemaVersion,
  taskId: taskFields.taskId,
  actorId: taskFields.actorId,
  title: taskFields.title,
  createdAt: taskFields.createdAt,
});

export const createSessionBundleSchema = z
  .object({
    session: createSessionRecordSchema,
    rootTask: rootTaskRecordSchema,
    createdEvent: agentEventSchema,
  })
  .superRefine((bundle, refinement) => {
    const { createdEvent, rootTask, session } = bundle;
    const failures: Array<[boolean, string, (string | number)[]]> = [
      [createdEvent.type === "session.created", "Initial event must be session.created.", ["createdEvent", "type"]],
      [createdEvent.sequence === 0, "Initial event sequence must be zero.", ["createdEvent", "sequence"]],
      [createdEvent.sessionId === session.sessionId, "Session IDs must match.", ["createdEvent", "sessionId"]],
      [createdEvent.taskId === rootTask.taskId, "Root task IDs must match.", ["createdEvent", "taskId"]],
      [createdEvent.actorId === rootTask.actorId, "Root task actor must match the event actor.", ["createdEvent", "actorId"]],
      [createdEvent.context.workspacePath === session.workspace.root.normalizedPath, "Workspace paths must match.", ["createdEvent", "context", "workspacePath"]],
      [createdEvent.context.configVersion === session.configVersion, "Config versions must match.", ["createdEvent", "context", "configVersion"]],
      [createdEvent.payload.goal === session.goal, "Session goal must match the initial event.", ["createdEvent", "payload", "goal"]],
    ];
    for (const [success, message, path] of failures) {
      if (!success) refinement.addIssue({ code: "custom", message, path });
    }
  });
