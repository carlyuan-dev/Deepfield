import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentWorkerEvent, ChatTranscriptMessage } from "@deepfield/contracts";
import { transcriptMessage } from "./pi-session-transcript.js";

export interface PiSessionCheckpointCollector {
  record(message: AgentMessage): void;
}

export function createPiSessionCheckpointCollector(
  requestId: string,
  emit: (event: AgentWorkerEvent) => void,
): PiSessionCheckpointCollector {
  const transcript: ChatTranscriptMessage[] = [];
  return {
    record(message) {
      const persisted = transcriptMessage(message);
      if (persisted === undefined) return;
      transcript.push(persisted);
      emit({ requestId, type: "transcript_checkpoint", messages: structuredClone(transcript) });
    },
  };
}
