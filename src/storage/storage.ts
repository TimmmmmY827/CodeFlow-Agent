import type { AgentEvent } from "../events/agent-event.js";
import type { ArtifactReference, StableId } from "../shared/contracts.js";

export type { ArtifactReference } from "../shared/contracts.js";

export interface SessionRepository {
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(sessionId: StableId): Promise<readonly AgentEvent[]>;
  deleteSession(sessionId: StableId): Promise<void>;
}

export interface ArtifactStore {
  write(
    sessionId: StableId,
    mediaType: string,
    content: Uint8Array,
    sensitivity: ArtifactReference["sensitivity"],
  ): Promise<ArtifactReference>;
  deleteSessionArtifacts(sessionId: StableId): Promise<void>;
}
