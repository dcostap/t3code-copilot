import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import {
  getHistorySelectionLimitForPromptStart,
  normalizeInlineDiffRowText,
  promptSeparatorClassesForInteractionMode,
  resolvePromptSelectionForDocument,
  shouldRenderPromptSeparator,
  resolveTranscriptRegionForPointer,
  resolveTranscriptRegionForPosition,
  shouldKeepCursorPaddingForTransactions,
  shouldRedirectHistoryTypingToPrompt,
} from "./TranscriptRenderer";

describe("resolveTranscriptRegionForPosition", () => {
  it("treats positions before the separator as history", () => {
    expect(resolveTranscriptRegionForPosition(10, 4)).toBe("history");
  });

  it("treats positions after the history limit as prompt", () => {
    expect(resolveTranscriptRegionForPosition(10, 11)).toBe("prompt");
  });

  it("returns null when the click does not resolve to a document position", () => {
    expect(resolveTranscriptRegionForPosition(10, null)).toBeNull();
  });
});

describe("resolveTranscriptRegionForPointer", () => {
  it("falls back to the estimated position when the precise hit test misses", () => {
    expect(resolveTranscriptRegionForPointer(10, null, 12)).toBe("prompt");
  });

  it("keeps returning null when neither hit test resolves", () => {
    expect(resolveTranscriptRegionForPointer(10, null, null)).toBeNull();
  });
});

describe("getHistorySelectionLimit", () => {
  it("stops history selection before the prompt separator line", () => {
    const state = EditorState.create({ doc: "assistant line\n\nprompt" });

    expect(getHistorySelectionLimitForPromptStart(state.doc, "assistant line\n\n".length)).toBe(
      "assistant line".length,
    );
  });

  it("returns zero when the prompt starts on the first line", () => {
    const state = EditorState.create({ doc: "prompt" });

    expect(getHistorySelectionLimitForPromptStart(state.doc, 0)).toBe(0);
  });
});

describe("promptSeparatorClassesForInteractionMode", () => {
  it("adds the plan-mode separator class only in plan mode", () => {
    expect(promptSeparatorClassesForInteractionMode("default")).toEqual([]);
    expect(promptSeparatorClassesForInteractionMode("plan")).toEqual(["cm-line-promptSeparatorPlan"]);
  });
});

describe("normalizeInlineDiffRowText", () => {
  it("removes a trailing line terminator without touching the diff content", () => {
    expect(normalizeInlineDiffRowText("+added line\n")).toBe("+added line");
    expect(normalizeInlineDiffRowText(" context line\r\n")).toBe(" context line");
  });

  it("preserves intentional blank diff lines as empty strings", () => {
    expect(normalizeInlineDiffRowText("\n")).toBe("");
    expect(normalizeInlineDiffRowText("\r\n")).toBe("");
  });
});

describe("shouldRenderPromptSeparator", () => {
  it("hides the separator when there is no transcript history above the prompt", () => {
    expect(shouldRenderPromptSeparator(0)).toBe(false);
  });

  it("shows the separator once there is transcript history above the prompt", () => {
    expect(shouldRenderPromptSeparator(1)).toBe(true);
  });
});

describe("resolvePromptSelectionForDocument", () => {
  it("preserves the prompt-relative caret when history growth shifts promptStart", () => {
    expect(
      resolvePromptSelectionForDocument(42, 47, {
        anchorOffset: 3,
        headOffset: 3,
      }),
    ).toEqual({ anchor: 45, head: 45 });
  });

  it("falls back to the end of the prompt when no stored selection exists", () => {
    expect(resolvePromptSelectionForDocument(12, 16, null)).toEqual({ anchor: 16, head: 16 });
  });

  it("clamps stale offsets to the new prompt bounds", () => {
    expect(
      resolvePromptSelectionForDocument(30, 32, {
        anchorOffset: 8,
        headOffset: 8,
      }),
    ).toEqual({ anchor: 32, head: 32 });
  });
});

describe("shouldRedirectHistoryTypingToPrompt", () => {
  it("redirects plain printable keys", () => {
    expect(
      shouldRedirectHistoryTypingToPrompt({ key: "a", ctrlKey: false, metaKey: false, altKey: false }),
    ).toBe(true);
    expect(
      shouldRedirectHistoryTypingToPrompt({ key: "A", ctrlKey: false, metaKey: false, altKey: false }),
    ).toBe(true);
  });

  it("ignores modifier shortcuts and non-printable keys", () => {
    expect(
      shouldRedirectHistoryTypingToPrompt({ key: "a", ctrlKey: true, metaKey: false, altKey: false }),
    ).toBe(false);
    expect(
      shouldRedirectHistoryTypingToPrompt({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false }),
    ).toBe(false);
  });
});

describe("shouldKeepCursorPaddingForTransactions", () => {
  it("applies viewport padding for keyboard selection changes", () => {
    expect(
      shouldKeepCursorPaddingForTransactions([
        {
          isUserEvent(event: string) {
            return event === "select.keyboard";
          },
        },
      ]),
    ).toBe(true);
  });

  it("ignores pointer-driven selection changes", () => {
    expect(
      shouldKeepCursorPaddingForTransactions([
        {
          isUserEvent() {
            return false;
          },
        },
      ]),
    ).toBe(false);
  });
});
