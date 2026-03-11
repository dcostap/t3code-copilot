import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import {
  getHistorySelectionLimitForPromptStart,
  resolveTranscriptRegionForPointer,
  resolveTranscriptRegionForPosition,
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
