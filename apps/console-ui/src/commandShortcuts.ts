export type AppCommandActionId = "pane.split" | "pane.close" | "tab.create";

interface AppCommandShortcut {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

export interface AppCommandShortcutBinding {
  readonly actionId: AppCommandActionId;
  readonly shortcut: AppCommandShortcut;
}

export const APP_COMMAND_SHORTCUTS = [
  {
    actionId: "pane.split",
    shortcut: {
      key: "0",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
    },
  },
  {
    actionId: "pane.close",
    shortcut: {
      key: "w",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
    },
  },
  {
    actionId: "tab.create",
    shortcut: {
      key: "t",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
    },
  },
] as const satisfies ReadonlyArray<AppCommandShortcutBinding>;

export function matchesAppCommandShortcut(
  binding: AppCommandShortcutBinding,
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">,
) {
  return event.ctrlKey === binding.shortcut.ctrlKey
    && event.shiftKey === binding.shortcut.shiftKey
    && event.metaKey === binding.shortcut.metaKey
    && event.altKey === binding.shortcut.altKey
    && event.key.toLowerCase() === binding.shortcut.key.toLowerCase();
}

export function formatAppCommandShortcutLabel(binding: AppCommandShortcutBinding): string {
  const parts: string[] = [];
  if (binding.shortcut.ctrlKey) {
    parts.push("Ctrl");
  }
  if (binding.shortcut.shiftKey) {
    parts.push("Shift");
  }
  if (binding.shortcut.altKey) {
    parts.push("Alt");
  }
  if (binding.shortcut.metaKey) {
    parts.push("Meta");
  }
  parts.push(binding.shortcut.key.length === 1 ? binding.shortcut.key.toUpperCase() : binding.shortcut.key);
  return parts.join("+");
}

export function findAppCommandShortcutByActionId(actionId: AppCommandActionId) {
  return APP_COMMAND_SHORTCUTS.find((binding) => binding.actionId === actionId) ?? null;
}

export function findMatchingAppCommandShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">,
) {
  return APP_COMMAND_SHORTCUTS.find((binding) => matchesAppCommandShortcut(binding, event)) ?? null;
}
