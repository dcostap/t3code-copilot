import { describe, expect, it } from "vitest";

import {
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

  it("treats non-exact numeric prompt text as freeform", () => {
    expect(resolvePendingUserInputShortcut("2 because live", QUESTION.options)).toBeNull();
    expect(resolvePendingUserInputAnswer("2 because live", QUESTION)).toBe("2 because live");
  });

  it("resolves exact numeric prompt text to the selected option label", () => {
    expect(resolvePendingUserInputAnswer("1", QUESTION)).toBe("Demo");
  });
});
