import type { OrchestrationEvent, OrchestrationThread } from "@t3tools/contracts";

import type { TranscriptBlock } from "./TranscriptBlock";
import { threadToTranscriptBlocks } from "./orchestrationTranscript";

export interface ThreadTranscriptBlocksComputationInput {
  readonly thread: OrchestrationThread;
  readonly orchestrationEvents: ReadonlyArray<OrchestrationEvent>;
  readonly attachmentPreviewBaseUrl: string;
  readonly now?: string;
}

export interface ThreadTranscriptBlocksComputationRequest extends ThreadTranscriptBlocksComputationInput {
  readonly requestId: number;
  readonly threadId: OrchestrationThread["id"];
}

interface ThreadTranscriptBlocksReadyResponse {
  readonly kind: "ready";
  readonly requestId: number;
  readonly threadId: OrchestrationThread["id"];
  readonly blocks: ReadonlyArray<TranscriptBlock>;
}

interface ThreadTranscriptBlocksErrorResponse {
  readonly kind: "error";
  readonly requestId: number;
  readonly threadId: OrchestrationThread["id"];
  readonly error: string;
}

export type ThreadTranscriptBlocksComputationResponse =
  | ThreadTranscriptBlocksReadyResponse
  | ThreadTranscriptBlocksErrorResponse;

export function buildThreadTranscriptBlocks({
  thread,
  orchestrationEvents,
  attachmentPreviewBaseUrl,
  now,
}: ThreadTranscriptBlocksComputationInput): ReadonlyArray<TranscriptBlock> {
  return threadToTranscriptBlocks(thread, {
    resolveAttachmentPreviewUrl: (attachmentId) =>
      `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
    orchestrationEvents,
    ...(now ? { now } : {}),
  });
}
