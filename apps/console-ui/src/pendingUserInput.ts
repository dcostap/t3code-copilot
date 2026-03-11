import type { UserInputQuestion } from "@t3tools/contracts";

export interface PendingUserInputShortcutMatch {
  readonly option: UserInputQuestion["options"][number];
  readonly optionIndex: number;
}

function parseExactPositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolvePendingUserInputShortcut(
  prompt: string,
  options: ReadonlyArray<UserInputQuestion["options"][number]>,
): PendingUserInputShortcutMatch | null {
  const selectedNumber = parseExactPositiveInteger(prompt);
  if (selectedNumber === null) {
    return null;
  }

  const optionIndex = selectedNumber - 1;
  const option = options[optionIndex];
  if (!option) {
    return null;
  }

  return {
    option,
    optionIndex,
  };
}

export function resolvePendingUserInputAnswer(
  prompt: string,
  question: UserInputQuestion,
): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const shortcut = resolvePendingUserInputShortcut(trimmed, question.options);
  return shortcut?.option.label ?? trimmed;
}
