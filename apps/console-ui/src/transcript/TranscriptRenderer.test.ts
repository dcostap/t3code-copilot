import { describe, expect, it } from "vitest";

import {
  findTranscriptSearchMatches,
  flattenBlocks,
  getNextTranscriptSearchMatchIndex,
  parseInlineDiffFiles,
  readConversationScrollOffsetFromBottom,
  resolveInitialConversationScrollTop,
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

describe("parseInlineDiffFiles", () => {
  it("inserts a gap row between non-contiguous hunks and preserves deleted line numbers", () => {
    const [file] = parseInlineDiffFiles([
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,2 +1,2 @@",
      " line 1",
      "-old line 2",
      "+new line 2",
      "@@ -10,1 +10,2 @@",
      "-old line 10",
      "+new line 10",
      "+new line 11",
    ].join("\n"));

    expect(file).toBeDefined();
    expect(file?.hunks.flatMap((hunk) => hunk.rows.map((row) => row.kind))).toEqual([
      "context",
      "deletion",
      "addition",
      "gap",
      "deletion",
      "addition",
      "addition",
    ]);
    expect(file?.hunks[0]?.rows[1]).toMatchObject({
      kind: "deletion",
      oldLineNumber: 2,
      text: "old line 2",
    });
    expect(file?.hunks[1]?.rows[0]).toMatchObject({
      kind: "gap",
      text: "",
    });
    expect(file?.hunks[1]?.rows[1]).toMatchObject({
      kind: "deletion",
      oldLineNumber: 10,
      text: "old line 10",
    });
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

  it("resolves the initial scrollTop before paint using the stored bottom offset when present", () => {
    expect(resolveInitialConversationScrollTop({
      scrollHeight: 1200,
      clientHeight: 400,
    }, 150)).toBe(650);
  });

  it("resolves the initial scrollTop to the bottom when no stored offset exists", () => {
    expect(resolveInitialConversationScrollTop({
      scrollHeight: 1200,
      clientHeight: 400,
    }, null)).toBe(800);
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

describe("transcript search helpers", () => {
  it("finds matches case-insensitively in transcript history only", () => {
    expect(findTranscriptSearchMatches(
      "Alpha beta\nbeta prompt",
      "BETA",
      "Alpha beta\nbeta".length,
    )).toEqual([
      { from: 6, to: 10 },
      { from: 11, to: 15 },
    ]);
  });

  it("returns no matches for an empty query", () => {
    expect(findTranscriptSearchMatches("alpha beta", "", 10)).toEqual([]);
  });

  it("wraps when advancing through search matches", () => {
    expect(getNextTranscriptSearchMatchIndex({
      currentIndex: 1,
      matchCount: 3,
      direction: 1,
    })).toBe(2);
    expect(getNextTranscriptSearchMatchIndex({
      currentIndex: 2,
      matchCount: 3,
      direction: 1,
    })).toBe(0);
    expect(getNextTranscriptSearchMatchIndex({
      currentIndex: 0,
      matchCount: 3,
      direction: -1,
    })).toBe(2);
  });
});
