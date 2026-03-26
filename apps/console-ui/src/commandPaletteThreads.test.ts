import { describe, expect, it } from "vitest";

import {
  formatPaletteThreadLabel,
  getPaletteThreadIndicator,
  isThreadPickerQuery,
  stripThreadPickerQueryPrefix,
} from "./commandPaletteThreads";

describe("commandPaletteThreads", () => {
  it("detects thread picker queries by the leading @ prefix", () => {
    expect(isThreadPickerQuery("@")).toBe(true);
    expect(isThreadPickerQuery("   @bug")).toBe(true);
    expect(isThreadPickerQuery("provider")).toBe(false);
  });

  it("strips the leading @ prefix before filtering thread labels", () => {
    expect(stripThreadPickerQueryPrefix("@thread")).toBe("thread");
    expect(stripThreadPickerQueryPrefix("  @thread name")).toBe("thread name");
  });

  it("formats thread labels with the requested unicode status dots", () => {
    expect(getPaletteThreadIndicator("idle")).toBe("⚪");
    expect(getPaletteThreadIndicator("unread")).toBe("🟢");
    expect(getPaletteThreadIndicator("working")).toBe("🔵");
    expect(formatPaletteThreadLabel({
      projectTitle: "Console UI",
      threadTitle: "Gemini bug",
      indicatorTone: "idle",
    })).toBe("Console UI - Gemini bug");
    expect(formatPaletteThreadLabel({
      projectTitle: "Console UI",
      threadTitle: "Gemini bug",
      indicatorTone: "working",
      workingLabel: "Calling tools",
    })).toBe("Console UI - Gemini bug - 🔵 Calling tools");
  });
});
