import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import {
  getHistorySelectionLimitForPromptStart,
  hasNonCollapsedSelectionInsideElement,
  isCommandWidgetSummaryOverflowing,
  normalizeInlineDiffRowText,
  prefixCopiedLinesInOrder,
  prefixCopiedUserMessageStarts,
  promptSeparatorClassesForInteractionMode,
  resolveCommandWidgetCopyRowFromNode,
  resolveCommandWidgetToggleSignatureFromEventTarget,
  resolveTranscriptLinkUrl,
  resolvePromptSelectionForDocument,
  shouldRenderCommandWidgetToggleRail,
  shouldRenderPromptSeparator,
  shouldUseCustomCommandWidgetCopy,
  shouldIgnoreCommandWidgetEvent,
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

describe("hasNonCollapsedSelectionInsideElement", () => {
  it("returns true when a non-collapsed selection endpoint is inside the element", () => {
    const insideNode = { nodeType: 3 };
    const element = {
      contains(node: Node | null) {
        return node === insideNode;
      },
    };

    expect(
      hasNonCollapsedSelectionInsideElement({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: insideNode,
        focusNode: null,
        getRangeAt() {
          return { startContainer: insideNode, endContainer: insideNode };
        },
      }, element),
    ).toBe(true);
  });

  it("returns false for collapsed or external selections", () => {
    const insideNode = { nodeType: 3 };
    const outsideNode = { nodeType: 3 };
    const element = {
      contains(node: Node | null) {
        return node === insideNode;
      },
    };

    expect(
      hasNonCollapsedSelectionInsideElement({
        isCollapsed: true,
        rangeCount: 1,
        anchorNode: insideNode,
        focusNode: insideNode,
        getRangeAt() {
          return { startContainer: insideNode, endContainer: insideNode };
        },
      }, element),
    ).toBe(false);

    expect(
      hasNonCollapsedSelectionInsideElement({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: outsideNode,
        focusNode: outsideNode,
        getRangeAt() {
          return { startContainer: outsideNode, endContainer: outsideNode };
        },
      }, element),
    ).toBe(false);
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

describe("resolveTranscriptLinkUrl", () => {
  it("passes through http urls and resolves absolute windows file paths", () => {
    expect(resolveTranscriptLinkUrl({ kind: "url", target: "https://example.com/docs" })).toBe(
      "https://example.com/docs",
    );
    expect(resolveTranscriptLinkUrl({ kind: "file", target: "C:\\Users\\Dario Costa\\Desktop\\report.xlsx" })).toBe(
      "file:///C:/Users/Dario%20Costa/Desktop/report.xlsx",
    );
  });

  it("resolves relative file paths against the session cwd", () => {
    expect(
      resolveTranscriptLinkUrl(
        { kind: "file", target: "src\\App.tsx" },
        "C:\\Projects\\t3code-copilot",
      ),
    ).toBe("file:///C:/Projects/t3code-copilot/src/App.tsx");
  });
});

describe("resolveCommandWidgetToggleSignatureFromEventTarget", () => {
  it("returns the widget signature only for rail targets", () => {
    const surface = { dataset: { commandWidgetSignature: "cmd-1" } };
    const rail = {
      closest(selector: string) {
        if (selector === ".cm-commandWidgetRail") {
          return rail;
        }
        if (selector === ".cm-commandWidgetSurface") {
          return surface;
        }
        return null;
      },
    };
    const railVisual = { parentElement: rail };
    const body = {
      closest() {
        return null;
      },
    };

    expect(resolveCommandWidgetToggleSignatureFromEventTarget(railVisual)).toBe("cmd-1");
    expect(resolveCommandWidgetToggleSignatureFromEventTarget(body)).toBeNull();
  });
});

describe("isCommandWidgetSummaryOverflowing", () => {
  it("detects when the collapsed summary is actually ellipsized", () => {
    expect(isCommandWidgetSummaryOverflowing({ clientWidth: 120, scrollWidth: 180 })).toBe(true);
    expect(isCommandWidgetSummaryOverflowing({ clientWidth: 120, scrollWidth: 121 })).toBe(false);
  });

  it("treats missing elements as not overflowing", () => {
    expect(isCommandWidgetSummaryOverflowing(null)).toBe(false);
  });
});

describe("shouldRenderCommandWidgetToggleRail", () => {
  it("keeps the rail when the widget is already expanded", () => {
    expect(
      shouldRenderCommandWidgetToggleRail({
        expanded: true,
        hasHiddenExpansionContent: false,
        summaryOverflowing: false,
      }),
    ).toBe(true);
  });

  it("shows the rail when expansion would reveal hidden body or diff content", () => {
    expect(
      shouldRenderCommandWidgetToggleRail({
        expanded: false,
        hasHiddenExpansionContent: true,
        summaryOverflowing: false,
      }),
    ).toBe(true);
  });

  it("shows the rail when the collapsed summary is ellipsized", () => {
    expect(
      shouldRenderCommandWidgetToggleRail({
        expanded: false,
        hasHiddenExpansionContent: false,
        summaryOverflowing: true,
      }),
    ).toBe(true);
  });

  it("hides the rail when expansion would not change anything", () => {
    expect(
      shouldRenderCommandWidgetToggleRail({
        expanded: false,
        hasHiddenExpansionContent: false,
        summaryOverflowing: false,
      }),
    ).toBe(false);
  });
});

describe("shouldIgnoreCommandWidgetEvent", () => {
  it("lets native selection handle command widget body mouse events", () => {
    const diffContent = {
      closest() {
        return null;
      },
    };

    expect(shouldIgnoreCommandWidgetEvent({ type: "mousedown", target: diffContent })).toBe(true);
  });

  it("keeps rail toggles and widget copy serialization routed through the editor", () => {
    const surface = { dataset: { commandWidgetSignature: "cmd-3" } };
    const rail = {
      closest(selector: string) {
        if (selector === ".cm-commandWidgetRail") {
          return rail;
        }
        if (selector === ".cm-commandWidgetSurface") {
          return surface;
        }
        return null;
      },
    };
    const body = {};

    expect(shouldIgnoreCommandWidgetEvent({ type: "mousedown", target: rail })).toBe(false);
    expect(shouldIgnoreCommandWidgetEvent({ type: "copy", target: body })).toBe(false);
  });
});

describe("resolveCommandWidgetCopyRowFromNode", () => {
  it("finds the nearest copy row from nested widget content", () => {
    const row = {
      dataset: { copyText: "row" },
      closest(selector: string) {
        return selector === ".cm-commandWidgetCopyRow" ? row : null;
      },
    };
    const nested = { parentElement: row };

    expect(resolveCommandWidgetCopyRowFromNode(nested)).toBe(row);
  });

  it("returns null for transcript content outside widget rows", () => {
    const textNodeParent = {
      closest() {
        return null;
      },
    };
    const textNodeLike = { parentElement: textNodeParent };

    expect(resolveCommandWidgetCopyRowFromNode(textNodeLike)).toBeNull();
  });
});

describe("shouldUseCustomCommandWidgetCopy", () => {
  it("uses custom widget copy only when the full selection stays inside widget rows", () => {
    const rowStart = {
      closest(selector: string) {
        return selector === ".cm-commandWidgetCopyRow" ? rowStart : null;
      },
    };
    const rowEnd = {
      closest(selector: string) {
        return selector === ".cm-commandWidgetCopyRow" ? rowEnd : null;
      },
    };

    expect(
      shouldUseCustomCommandWidgetCopy({
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt() {
          return { startContainer: rowStart, endContainer: rowEnd };
        },
      }),
    ).toBe(true);
  });

  it("falls back to normal copy for mixed transcript and widget selections", () => {
    const widgetNode = {
      closest(selector: string) {
        return selector === ".cm-commandWidgetCopyRow" ? widgetNode : null;
      },
    };
    const plainTranscriptNode = {
      closest() {
        return null;
      },
    };

    expect(
      shouldUseCustomCommandWidgetCopy({
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt() {
          return { startContainer: plainTranscriptNode, endContainer: widgetNode };
        },
      }),
    ).toBe(false);
  });
});

describe("prefixCopiedUserMessageStarts", () => {
  it("adds a > prefix when the copied selection includes the start of a history user prompt line", () => {
    const state = EditorState.create({
      doc: "Hello there\nSecond line",
      selection: { anchor: 0, head: "Hello there\nSecond line".length },
    });

    expect(
      prefixCopiedUserMessageStarts(
        "Hello there\nSecond line",
        state,
        [{ from: 0, extraClasses: ["cm-line-userMessageStart"] }, { from: "Hello there\n".length }],
      ),
    ).toBe("> Hello there\nSecond line");
  });

  it("does not prefix when the selection starts mid-line after the first word", () => {
    const state = EditorState.create({
      doc: "Hello there",
      selection: { anchor: 6, head: "Hello there".length },
    });

    expect(
      prefixCopiedUserMessageStarts(
        "there",
        state,
        [{ from: 0, extraClasses: ["cm-line-userMessageStart"] }],
      ),
    ).toBe("there");
  });

  it("still prefixes user prompt lines inside larger copied selections", () => {
    const state = EditorState.create({
      doc: "before\nHello there\nwidget backing text\nafter",
      selection: { anchor: 0, head: "before\nHello there\nwidget backing text\nafter".length },
    });

    expect(
      prefixCopiedUserMessageStarts(
        "before\nHello there\nvisible widget\nafter",
        state,
        [
          { from: 0 },
          { from: "before\n".length, extraClasses: ["cm-line-userMessageStart"] },
        ],
      ),
    ).toBe("before\n> Hello there\nvisible widget\nafter");
  });
});

describe("prefixCopiedLinesInOrder", () => {
  it("prefixes matching copied lines in order without changing unrelated lines", () => {
    expect(
      prefixCopiedLinesInOrder(
        "before\nHello there\nwidget line\nAfter",
        ["Hello there"],
        "> ",
      ),
    ).toBe("before\n> Hello there\nwidget line\nAfter");
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
