import { describe, expect, it } from "vitest";

import {
  flattenBlocks,
  readConversationScrollOffsetFromBottom,
  resolveConversationScrollTopForOffsetFromBottom,
  shouldRedirectHistoryTypingToPrompt,
  shouldRedirectPlainTextPasteToPrompt,
  shouldSelectAllHistoryFromHistoryKeydown,
  shouldSelectAllPromptFromPromptKeydown,
  shouldUseNativePromptCaret,
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
        endedAt: "2026-03-22T01:00:01.100Z",
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

describe("shouldRedirectHistoryTypingToPrompt", () => {
  it("redirects plain typed characters from history", () => {
    expect(shouldRedirectHistoryTypingToPrompt({
      key: "a",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    })).toBe(true);
  });

  it("does not redirect while prompt focus is disabled", () => {
    expect(shouldRedirectHistoryTypingToPrompt({
      key: "a",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    }, {
      promptFocusDisabled: true,
    })).toBe(false);
  });

  it("does not redirect while prompt input is disabled", () => {
    expect(shouldRedirectHistoryTypingToPrompt({
      key: "a",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    }, {
      promptInputDisabled: true,
    })).toBe(false);
  });
});

describe("history shortcut routing", () => {
  it("routes ctrl+a only when actual focus is in history", () => {
    expect(shouldSelectAllHistoryFromHistoryKeydown({
      key: "a",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
    }, "history")).toBe(true);
    expect(shouldSelectAllHistoryFromHistoryKeydown({
      key: "a",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
    }, "prompt")).toBe(false);
  });

  it("routes ctrl+a in the prompt so the textarea can own select-all synchronously", () => {
    expect(shouldSelectAllPromptFromPromptKeydown({
      key: "a",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
    })).toBe(true);
    expect(shouldSelectAllPromptFromPromptKeydown({
      key: "a",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    })).toBe(false);
  });

  it("prefers the native prompt caret when block shape and manual animation are supported", () => {
    expect(shouldUseNativePromptCaret((property, value) => (
      (property === "caret-shape" && value === "block")
      || (property === "caret-animation" && value === "manual")
    ))).toBe(true);
    expect(shouldUseNativePromptCaret((property, value) => (
      property === "caret-shape" && value === "block"
    ))).toBe(false);
  });

  it("redirects plain-text paste to the prompt only when the prompt is not already the target", () => {
    expect(shouldRedirectPlainTextPasteToPrompt({
      targetIsPrompt: false,
      hasFiles: false,
      promptInputDisabled: false,
      text: "hello",
    })).toBe(true);
    expect(shouldRedirectPlainTextPasteToPrompt({
      targetIsPrompt: true,
      hasFiles: false,
      promptInputDisabled: false,
      text: "hello",
    })).toBe(false);
    expect(shouldRedirectPlainTextPasteToPrompt({
      targetIsPrompt: false,
      hasFiles: false,
      promptInputDisabled: true,
      text: "hello",
    })).toBe(false);
  });
});
