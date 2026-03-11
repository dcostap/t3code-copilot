import { describe, expect, it } from "vitest";

import { blockToLines } from "./TranscriptBlock";

describe("blockToLines", () => {
  it("renders user messages with shared separators", () => {
    expect(
      blockToLines({
        type: "user-message",
        text: "hello",
      }),
    ).toEqual([
      { text: "", kind: "userPromptSeparator" },
      { text: "hello", kind: "userMessage" },
      { text: "", kind: "userPromptSeparator" },
    ]);
  });

  it("numbers user-input request options in the transcript", () => {
    expect(
      blockToLines({
        type: "user-input-request",
        requestId: "req-1",
        questions: [
          {
            header: "Source",
            question: "Which mode should this console stay in?",
            options: [
              { label: "Demo", description: "Keep using local orchestration fixtures." },
              { label: "Live", description: "Connect to the orchestration websocket." },
            ],
          },
        ],
      }),
    ).toEqual([
      { text: "[?] User input requested", kind: "approvalPrompt" },
      {
        text: "    Source: Which mode should this console stay in?",
        kind: "approvalPrompt",
        extraClasses: ["cm-line-userInputQuestion"],
        userInputRef: {
          requestId: "req-1",
          questionIndex: 0,
        },
      },
      {
        text: "      1  Demo: Keep using local orchestration fixtures.",
        kind: "approvalPrompt",
        extraClasses: ["cm-line-userInputOption"],
        userInputRef: {
          requestId: "req-1",
          questionIndex: 0,
          optionIndex: 0,
        },
      },
      {
        text: "      2  Live: Connect to the orchestration websocket.",
        kind: "approvalPrompt",
        extraClasses: ["cm-line-userInputOption"],
        userInputRef: {
          requestId: "req-1",
          questionIndex: 0,
          optionIndex: 1,
        },
      },
    ]);
  });

  it("renders resolved custom answers as plain user text after the faded options", () => {
    expect(
      blockToLines({
        type: "user-input-request",
        requestId: "req-2",
        resolved: true,
        answers: { source: "Staging" },
        questions: [
          {
            id: "source",
            header: "Source",
            question: "Which mode should this console stay in?",
            options: [
              { label: "Demo", description: "Keep using local orchestration fixtures." },
              { label: "Live", description: "Connect to the orchestration websocket." },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        text: "[✓] User input answered",
        kind: "approvalPrompt",
        extraClasses: ["cm-line-userInputResolved"],
      },
      {
        text: "    Source: Which mode should this console stay in?",
        kind: "approvalPrompt",
        extraClasses: ["cm-line-userInputQuestion", "cm-line-userInputResolved"],
        userInputRef: {
          requestId: "req-2",
          questionIndex: 0,
        },
      },
      {
        text: "      1  Demo: Keep using local orchestration fixtures.",
        kind: "approvalPrompt",
        extraClasses: [
          "cm-line-userInputOption",
          "cm-line-userInputResolved",
          "cm-line-userInputResolvedOption",
        ],
        userInputRef: {
          requestId: "req-2",
          questionIndex: 0,
          optionIndex: 0,
        },
      },
      {
        text: "      2  Live: Connect to the orchestration websocket.",
        kind: "approvalPrompt",
        extraClasses: [
          "cm-line-userInputOption",
          "cm-line-userInputResolved",
          "cm-line-userInputResolvedOption",
        ],
        userInputRef: {
          requestId: "req-2",
          questionIndex: 0,
          optionIndex: 1,
        },
      },
      { text: "", kind: "userPromptSeparator" },
      { text: "Staging", kind: "userMessage" },
      { text: "", kind: "userPromptSeparator" },
    ]);
  });
});
