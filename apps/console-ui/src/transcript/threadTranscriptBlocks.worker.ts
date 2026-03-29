import {
  buildThreadTranscriptBlocksResult,
  type ThreadTranscriptBlocksComputationRequest,
  type ThreadTranscriptBlocksComputationResponse,
} from "./threadTranscriptBlocksLoader";

const workerScope = globalThis as typeof globalThis & {
  postMessage(message: ThreadTranscriptBlocksComputationResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ThreadTranscriptBlocksComputationRequest>) => void,
  ): void;
};

function postThreadTranscriptBlocksResponse(message: ThreadTranscriptBlocksComputationResponse) {
  const postMessage = Reflect.get(workerScope, "postMessage") as (payload: ThreadTranscriptBlocksComputationResponse) => void;
  postMessage.call(workerScope, message);
}

workerScope.addEventListener("message", (event) => {
  const request = event.data;

  try {
    const result = buildThreadTranscriptBlocksResult(request);
    postThreadTranscriptBlocksResponse({
      kind: "ready",
      requestId: request.requestId,
      threadId: request.threadId,
      blocks: result.blocks,
      blockLines: result.blockLines,
      blockRows: result.blockRows,
    });
  } catch (error) {
    postThreadTranscriptBlocksResponse({
      kind: "error",
      requestId: request.requestId,
      threadId: request.threadId,
      error: error instanceof Error ? error.message : "Failed to build transcript blocks.",
    });
  }
});
