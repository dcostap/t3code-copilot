import { describe, expect, it } from "vitest";

import {
  formatPendingUserInputAnswersAsPrompt,
  isStaleCopilotUserInputResponseDetail,
  isStaleCopilotUserInputResponseError,
  parsePendingUserInputAnswers,
  resolvePendingUserInputAnswer,
  resolvePendingUserInputShortcut,
} from "./pendingUserInput";

const QUESTION = {
  id: "mode",
  header: "Mode",
  question: "Choose a mode",
  options: [
    { label: "Demo", description: "Keep using demo fixtures." },
    { label: "Live", description: "Connect to the live backend." },
  ],
} as const;

describe("pendingUserInput helpers", () => {
  it("maps an exact numeric shortcut to an option", () => {
    expect(resolvePendingUserInputShortcut(" 2 ", QUESTION.options)).toEqual({
      option: QUESTION.options[1],
      optionIndex: 1,
    });
  });

  it("treats dotted numeric shortcuts as option picks too", () => {
    expect(resolvePendingUserInputShortcut("1.", QUESTION.options)).toEqual({
      option: QUESTION.options[0],
      optionIndex: 0,
    });
    expect(resolvePendingUserInputAnswer("2.", QUESTION)).toBe("Live");
  });

  it("treats non-exact numeric prompt text as freeform", () => {
    expect(resolvePendingUserInputShortcut("2 because live", QUESTION.options)).toBeNull();
    expect(resolvePendingUserInputAnswer("2 because live", QUESTION)).toBe("2 because live");
  });

  it("resolves exact numeric prompt text to the selected option label", () => {
    expect(resolvePendingUserInputAnswer("1", QUESTION)).toBe("Demo");
  });

  it("formats a single answered question as a plain prompt", () => {
    expect(formatPendingUserInputAnswersAsPrompt([QUESTION], { mode: "Live" })).toBe("Live");
  });

  it("formats multiple answered questions with headers", () => {
    expect(formatPendingUserInputAnswersAsPrompt([
      QUESTION,
      {
        id: "scope",
        header: "Scope",
        question: "Choose a scope",
        options: [],
      },
    ], {
      mode: "Demo",
      scope: "Current thread only",
    })).toBe("Mode: Demo\nScope: Current thread only");
  });

  it("recognizes stale Copilot ask_user response failures", () => {
    const detail = "Provider adapter request failed (copilot) for session.userInput.respond: Unknown pending GitHub Copilot user-input request 'copilot-user-input-1'.";
    expect(isStaleCopilotUserInputResponseDetail(detail)).toBe(true);
    expect(isStaleCopilotUserInputResponseError(new Error(detail))).toBe(true);
  });

  it("parses multiple question fallback prompts back into structured answers", () => {
    expect(parsePendingUserInputAnswers([
      QUESTION,
      {
        id: "scope",
        header: "Scope",
        question: "Choose a scope",
        options: [
          { label: "Current thread only", description: "Current thread only" },
          { label: "Whole app", description: "Whole app" },
        ],
      },
    ], "Mode: 1.\nScope: 2")).toEqual({
      mode: "Demo",
      scope: "Whole app",
    });
  });
});
