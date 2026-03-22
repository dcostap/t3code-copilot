import { describe, expect, it } from "vitest";

import {
  flattenBlocks,
  readConversationScrollOffsetFromBottom,
  resolveConversationScrollTopForOffsetFromBottom,
} from "./TranscriptRenderer";
import type { TranscriptBlock } from "./TranscriptBlock";

describe("flattenBlocks", () => {
  it("inserts an explicit gap line before a widget block", () => {
    const blocks: TranscriptBlock[] = [
      {
        type: "assistant-text",
        text: "Done.",
        streaming: false,
      },
      {
        type: "work-group",
        title: "report_intent",
        status: "done",
        startedAt: "2026-03-22T01:00:00.000Z",
        endedAt: "2026-03-22T01:00:01.000Z",
        items: [
          {
            kind: "tool",
            label: "report_intent",
            status: "done",
            detail: "intent=Listing files",
          },
        ],
      },
    ];

    const { lines } = flattenBlocks(blocks);

    expect(lines.map((line) => line.kind)).toEqual([
      "body",
      "blockGap",
      "commandExec",
      "workingLine",
    ]);
  });

  it("uses the same explicit gap line before a trailing ask_user block and assistant footer", () => {
    const blocks: TranscriptBlock[] = [
      {
        type: "assistant-text",
        text: "I need one more thing.",
        streaming: false,
      },
      {
        type: "user-input-request",
        requestId: "req-1",
        questions: [
          {
            header: "Question",
            question: "Which option do you prefer?",
            options: [
              { label: "Option A", description: "Option A" },
              { label: "Option B", description: "Option B" },
            ],
          },
        ],
      },
      {
        type: "finished-state",
        startedAt: "2026-03-22T01:00:00.000Z",
        finishedAt: "2026-03-22T01:00:04.000Z",
      },
    ];

    const { lines } = flattenBlocks(blocks);

    expect(lines.map((line) => line.kind)).toEqual([
      "body",
      "blockGap",
      "approvalPrompt",
      "approvalPrompt",
      "approvalPrompt",
      "blockGap",
      "workingLine",
    ]);
  });
});

describe("conversation scroll state helpers", () => {
  it("reads distance from the bottom of the conversation scroll container", () => {
    expect(readConversationScrollOffsetFromBottom({
      scrollHeight: 1200,
      scrollTop: 650,
      clientHeight: 400,
    })).toBe(150);
  });

  it("restores scrollTop from a stored bottom offset", () => {
    expect(resolveConversationScrollTopForOffsetFromBottom({
      scrollHeight: 1200,
      clientHeight: 400,
    }, 150)).toBe(650);
  });
});
