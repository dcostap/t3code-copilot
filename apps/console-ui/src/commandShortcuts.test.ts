import { describe, expect, it } from "vitest";

import {
  APP_COMMAND_SHORTCUTS,
  findAppCommandShortcutByActionId,
  findMatchingAppCommandShortcut,
  formatAppCommandShortcutLabel,
} from "./commandShortcuts";

describe("commandShortcuts", () => {
  it("formats the shortcut label from the wired binding", () => {
    const binding = findAppCommandShortcutByActionId("pane.split");
    expect(binding).not.toBeNull();
    expect(formatAppCommandShortcutLabel(binding!)).toBe("Ctrl+0");
  });

  it("formats the pane close shortcut label from the wired binding", () => {
    const binding = findAppCommandShortcutByActionId("pane.close");
    expect(binding).not.toBeNull();
    expect(formatAppCommandShortcutLabel(binding!)).toBe("Ctrl+W");
  });

  it("formats the new tab shortcut label from the wired binding", () => {
    const binding = findAppCommandShortcutByActionId("tab.create");
    expect(binding).not.toBeNull();
    expect(formatAppCommandShortcutLabel(binding!)).toBe("Ctrl+T");
  });

  it("matches the wired pane split shortcut by action id", () => {
    expect(findMatchingAppCommandShortcut({
      key: "0",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
    } as KeyboardEvent)?.actionId).toBe("pane.split");
  });

  it("matches the wired pane close shortcut by action id", () => {
    expect(findMatchingAppCommandShortcut({
      key: "w",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
    } as KeyboardEvent)?.actionId).toBe("pane.close");
  });

  it("matches the wired new tab shortcut by action id", () => {
    expect(findMatchingAppCommandShortcut({
      key: "t",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
    } as KeyboardEvent)?.actionId).toBe("tab.create");
  });

  it("keeps the registry scoped to stable shortcut-targetable commands", () => {
    expect(APP_COMMAND_SHORTCUTS.map((binding) => binding.actionId)).toEqual(["pane.split", "pane.close", "tab.create"]);
  });
});
