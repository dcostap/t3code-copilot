import { describe, expect, it } from "vitest";

import {
  findTranscriptSearchMatches,
  formatCommandWidgetOutputLine,
  flattenBlocks,
  getNextTranscriptSearchMatchIndex,
  layoutMarkdownTable,
  parseInlineDiffFiles,
  readConversationScrollOffsetFromBottom,
  relativizeProjectPath,
  resolveInitialConversationScrollTop,
  resolveConversationScrollTopForOffsetFromBottom,
  shouldRedirectHistoryTypingToPrompt,
  shouldRedirectPlainTextPasteToPrompt,
  shouldShowCustomPromptCaret,
  shouldSuppressCustomPromptCaretForFocusedElement,
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

  it("does not insert a block gap between a reasoning summary and following reasoning text", () => {
    const blocks: TranscriptBlock[] = [
      {
        type: "reasoning-summary",
        text: "Summarizing missing prompts",
      },
      {
        type: "reasoning-text",
        text: "Checking the existing flows before adding anything.",
      },
    ];

    const { lines } = flattenBlocks(blocks);

    expect(lines.map((line) => line.kind)).toEqual([
      "reasoningSummary",
      "reasoning",
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

describe("project path formatting", () => {
  const projectRoot = "C:\\Projects\\webdev\\t3code-copilot";

  it("shortens standalone in-project absolute paths", () => {
    expect(relativizeProjectPath("C:\\Projects\\webdev\\t3code-copilot\\src\\file.ts", projectRoot))
      .toBe("src\\file.ts");
    expect(relativizeProjectPath("  \"C:\\Projects\\webdev\\t3code-copilot\\README.md\"  ", projectRoot))
      .toBe("  \"README.md\"  ");
  });

  it("leaves command text and out-of-project paths untouched", () => {
    expect(relativizeProjectPath("Get-Content -Path C:\\Projects\\webdev\\t3code-copilot\\README.md", projectRoot))
      .toBe("Get-Content -Path C:\\Projects\\webdev\\t3code-copilot\\README.md");
    expect(relativizeProjectPath("C:\\Other\\notes.txt", projectRoot)).toBe("C:\\Other\\notes.txt");
  });

  it("shortens changed output lines without touching other output", () => {
    expect(formatCommandWidgetOutputLine(
      "changed: C:\\Projects\\webdev\\t3code-copilot\\apps\\console-ui\\src\\App.tsx",
      projectRoot,
    )).toBe("changed: apps\\console-ui\\src\\App.tsx");
    expect(formatCommandWidgetOutputLine(
      "updated C:\\Projects\\webdev\\t3code-copilot\\apps\\console-ui\\src\\App.tsx",
      projectRoot,
    )).toBe("updated C:\\Projects\\webdev\\t3code-copilot\\apps\\console-ui\\src\\App.tsx");
  });
});

describe("layoutMarkdownTable", () => {
  it("wraps cell content into a responsive unicode table widget layout", () => {
    const lines = layoutMarkdownTable({
      headers: ["File", "Status"],
      rows: [["very-long-component-name.tsx", "done"]],
      alignments: ["left", "right"],
    }, 28);

    expect(lines[0]?.text.startsWith("┌")).toBe(true);
    expect(lines.at(-1)?.text.startsWith("└")).toBe(true);
    expect(lines.filter((line) => line.kind === "body").length).toBeGreaterThan(1);
    expect(lines.some((line) => line.text.includes("very-long"))).toBe(true);
    expect(lines.some((line) => line.text.includes("done │"))).toBe(true);
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

  it("keeps the custom prompt caret visible while pane focus stays in history", () => {
    expect(shouldShowCustomPromptCaret({
      paneHasFocus: true,
      paneActive: true,
      activeRegion: "history",
      promptHasFocus: false,
      promptInputDisabled: false,
      useNativePromptCaret: true,
      focusedEditableOwnsTyping: false,
    })).toBe(true);
  });

  it("hides the custom prompt caret when the native prompt caret can own a focused textarea", () => {
    expect(shouldShowCustomPromptCaret({
      paneHasFocus: true,
      paneActive: true,
      activeRegion: "prompt",
      promptHasFocus: true,
      promptInputDisabled: false,
      useNativePromptCaret: true,
      focusedEditableOwnsTyping: false,
    })).toBe(false);
  });

  it("hides the custom prompt caret when another editable control in the pane owns typing", () => {
    expect(shouldShowCustomPromptCaret({
      paneHasFocus: false,
      paneActive: true,
      activeRegion: "history",
      promptHasFocus: false,
      promptInputDisabled: false,
      useNativePromptCaret: false,
      focusedEditableOwnsTyping: true,
    })).toBe(false);
  });

  it("keeps the custom prompt caret visible for the active pane history even without DOM focus", () => {
    expect(shouldShowCustomPromptCaret({
      paneHasFocus: false,
      paneActive: true,
      activeRegion: "history",
      promptHasFocus: false,
      promptInputDisabled: false,
      useNativePromptCaret: true,
      focusedEditableOwnsTyping: false,
    })).toBe(true);
  });

  it("does not suppress the custom prompt caret when transcript history has focus", () => {
    expect(shouldSuppressCustomPromptCaretForFocusedElement({
      isEditable: true,
      isPromptElement: false,
      isHistoryElement: true,
    })).toBe(false);
  });

  it("suppresses the custom prompt caret when another editable control has focus", () => {
    expect(shouldSuppressCustomPromptCaretForFocusedElement({
      isEditable: true,
      isPromptElement: false,
      isHistoryElement: false,
    })).toBe(true);
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
