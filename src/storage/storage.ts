import type { AgentEvent } from "../events/agent-event.js";

export interface ArtifactReference {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly sensitivity: "normal" | "sensitive";
}

export interface SessionRepository {
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(sessionId: string): Promise<readonly AgentEvent[]>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface ArtifactStore {
  write(
    sessionId: string,
    mediaType: string,
    content: Uint8Array,
    sensitivity: ArtifactReference["sensitivity"],
  ): Promise<ArtifactReference>;
  deleteSessionArtifacts(sessionId: string): Promise<void>;
}
