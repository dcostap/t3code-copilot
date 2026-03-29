import type { OrchestrationEvent, OrchestrationThread } from "@t3tools/contracts";

import { blockToLines, type AnnotatedLine, type TranscriptBlock } from "./TranscriptBlock";
import { threadToTranscriptBlocks } from "./orchestrationTranscript";
import { deriveTranscriptBlockRowDefinitions, type TranscriptBlockRowDefinition } from "./transcriptRows";

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
  readonly blockLines: ReadonlyArray<ReadonlyArray<AnnotatedLine>>;
  readonly blockRows: ReadonlyArray<ReadonlyArray<TranscriptBlockRowDefinition>>;
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

export interface ThreadTranscriptBlocksBuildResult {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly blockLines: ReadonlyArray<ReadonlyArray<AnnotatedLine>>;
  readonly blockRows: ReadonlyArray<ReadonlyArray<TranscriptBlockRowDefinition>>;
}

export function buildThreadTranscriptBlocksResult({
  thread,
  orchestrationEvents,
  attachmentPreviewBaseUrl,
  now,
}: ThreadTranscriptBlocksComputationInput): ThreadTranscriptBlocksBuildResult {
  const blocks = threadToTranscriptBlocks(thread, {
    resolveAttachmentPreviewUrl: (attachmentId) =>
      `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
    orchestrationEvents,
    ...(now ? { now } : {}),
  });
  const blockLines = blocks.map((block) => blockToLines(block));
  return {
    blocks,
    blockLines,
    blockRows: blockLines.map((lines) => deriveTranscriptBlockRowDefinitions(lines)),
  };
}

export function buildThreadTranscriptBlocks(input: ThreadTranscriptBlocksComputationInput): ReadonlyArray<TranscriptBlock> {
  return buildThreadTranscriptBlocksResult(input).blocks;
}
