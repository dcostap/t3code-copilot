import type { UserInputQuestion } from "@t3tools/contracts";

const STALE_COPILOT_USER_INPUT_RESPONSE_DETAIL = "Unknown pending GitHub Copilot user-input request";

export interface PendingUserInputShortcutMatch {
  readonly option: UserInputQuestion["options"][number];
  readonly optionIndex: number;
}

function parseExactPositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+\.?$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed.replace(/\.$/, ""), 10);
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

export function parsePendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  prompt: string,
): Record<string, string> | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || questions.length === 0) {
    return null;
  }

  if (questions.length === 1) {
    const question = questions[0];
    if (!question) {
      return null;
    }
    const answer = resolvePendingUserInputAnswer(trimmed, question);
    return answer ? { [question.id]: answer } : null;
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < questions.length) {
    return null;
  }

  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const line = lines[index];
    if (!line) {
      return;
    }

    const match = /^([^:]+):\s*(.+)$/.exec(line);
    const answer = resolvePendingUserInputAnswer(match ? (match[2]?.trim() ?? "") : line, question);
    if (!answer) {
      return;
    }
    answers[question.id] = answer;
  });

  return Object.keys(answers).length === questions.length ? answers : null;
}

export function formatPendingUserInputAnswersAsPrompt(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: Readonly<Record<string, unknown>>,
): string | null {
  if (questions.length === 0) {
    return null;
  }

  const lines = questions.flatMap((question) => {
    const rawAnswer = answers[question.id];
    if (typeof rawAnswer !== "string") {
      return [];
    }

    const answer = rawAnswer.trim();
    if (answer.length === 0) {
      return [];
    }

    return questions.length === 1 ? [answer] : [`${question.header}: ${answer}`];
  });

  if (lines.length === 0) {
    return null;
  }

  return questions.length === 1 ? (lines[0] ?? null) : lines.join("\n");
}

export function isStaleCopilotUserInputResponseDetail(detail: string | null | undefined): boolean {
  return typeof detail === "string" && detail.includes(STALE_COPILOT_USER_INPUT_RESPONSE_DETAIL);
}

export function isStaleCopilotUserInputResponseError(error: unknown): boolean {
  return error instanceof Error && isStaleCopilotUserInputResponseDetail(error.message);
}
