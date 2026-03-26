import { describe, expect, it } from "vitest";

import {
  flattenPaletteThreadPickerGroups,
  formatPaletteProjectLabel,
  formatPaletteThreadLabel,
  getPaletteThreadIndicator,
  hasThreadPickerSearchQuery,
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

  it("stays in project overview mode until the thread query has real content", () => {
    expect(hasThreadPickerSearchQuery("@")).toBe(false);
    expect(hasThreadPickerSearchQuery("@   ")).toBe(false);
    expect(hasThreadPickerSearchQuery("@bug")).toBe(true);
    expect(hasThreadPickerSearchQuery("@ bug")).toBe(true);
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

  it("formats project labels with the full workspace path and aggregate counts", () => {
    expect(formatPaletteProjectLabel({
      projectTitle: "Console UI",
      workspaceRoot: "C:\\Projects\\webdev\\t3code-copilot",
      workingThreadCount: 2,
      unreadThreadCount: 1,
    })).toBe("Console UI - C:\\Projects\\webdev\\t3code-copilot - 🔵 2 - 🟢 1");

    expect(formatPaletteProjectLabel({
      projectTitle: "Console UI",
      workspaceRoot: "C:\\Projects\\webdev\\t3code-copilot",
      workingThreadCount: 0,
      unreadThreadCount: 0,
    })).toBe("Console UI - C:\\Projects\\webdev\\t3code-copilot");
  });

  it("inserts project commands above each matching thread group", () => {
    expect(flattenPaletteThreadPickerGroups([
      {
        projectCommand: "project-a",
        threadCommands: ["thread-a1", "thread-a2"],
      },
      {
        projectCommand: "project-b",
        threadCommands: [],
      },
      {
        projectCommand: "project-c",
        threadCommands: ["thread-c1"],
      },
    ])).toEqual(["project-a", "thread-a1", "thread-a2", "project-c", "thread-c1"]);
  });
});
