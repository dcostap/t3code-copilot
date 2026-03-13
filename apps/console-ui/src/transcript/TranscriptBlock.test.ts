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

  it("renders plan updates as structured step rows", () => {
    expect(
      blockToLines({
        type: "plan-update",
        explanation: "Reshape the UI around a single conversation scroll owner.",
        steps: [
          { step: "Unify transcript scrolling.", status: "completed" },
          { step: "Render tool activity inline.", status: "inProgress" },
          { step: "Tighten prompt layout.", status: "pending" },
        ],
      }),
    ).toEqual([
      { text: "", kind: "planSeparator" },
      { text: "Plan update", kind: "planHeader" },
      { text: "Reshape the UI around a single conversation scroll owner.", kind: "planExplanation" },
      { text: "", kind: "meta" },
      { text: "[x] Unify transcript scrolling.", kind: "planStepCompleted" },
      { text: "[~] Render tool activity inline.", kind: "planStepInProgress" },
      { text: "[ ] Tighten prompt layout.", kind: "planStepPending" },
      { text: "", kind: "planSeparator" },
    ]);
  });

  it("renders markdown tables in assistant text as unicode box tables", () => {
    expect(
      blockToLines({
        type: "assistant-text",
        text:
          "| Name | Role | Status |\n"
          + "| --- | --- | --- |\n"
          + "| Alice | Developer | Active |\n"
          + "| Bob | Designer | Inactive |",
        streaming: false,
      }),
    ).toEqual([
      { text: "┌───────┬───────────┬──────────┐", kind: "table" },
      { text: "│ Name  │ Role      │ Status   │", kind: "table" },
      { text: "├───────┼───────────┼──────────┤", kind: "table" },
      { text: "│ Alice │ Developer │ Active   │", kind: "table" },
      { text: "├───────┼───────────┼──────────┤", kind: "table" },
      { text: "│ Bob   │ Designer  │ Inactive │", kind: "table" },
      { text: "└───────┴───────────┴──────────┘", kind: "table" },
    ]);
  });

  it("renders closed fenced code blocks as transcript-native code sections", () => {
    expect(
      blockToLines({
        type: "assistant-text",
        text:
          "Before\n"
          + "```ts\n"
          + "const x = 1;\n"
          + "console.log(x);\n"
          + "```\n"
          + "After",
        streaming: false,
      }).map((line) => {
        const simplified: {
          text: string;
          kind: string;
          highlightSpans?: typeof line.highlightSpans;
        } = {
          text: line.text,
          kind: line.kind,
        };
        if (line.highlightSpans) {
          simplified.highlightSpans = line.highlightSpans;
        }
        return simplified;
      }),
    ).toEqual([
      { text: "Before", kind: "body" },
      {
        text: "╭──────────────────────────────────────────────────────────────────────────────",
        kind: "codeFenceSeparator",
      },
      { text: "code · ts", kind: "codeFenceHeader" },
      {
        text: "const x = 1;",
        kind: "codeFenceBody",
        highlightSpans: expect.arrayContaining([
          expect.objectContaining({ className: expect.stringContaining("tok-keyword") }),
        ]),
      },
      {
        text: "console.log(x);",
        kind: "codeFenceBody",
        highlightSpans: expect.arrayContaining([
          expect.objectContaining({ className: expect.stringContaining("tok-variableName") }),
        ]),
      },
      {
        text: "╰──────────────────────────────────────────────────────────────────────────────",
        kind: "codeFenceSeparator",
      },
      { text: "After", kind: "body" },
    ]);
  });

  it("keeps unfinished fenced code blocks as plain text while streaming", () => {
    expect(
      blockToLines({
        type: "assistant-text",
        text: "```ts\nconst x = 1;",
        streaming: true,
      }),
    ).toEqual([
      { text: "```ts", kind: "body" },
      { text: "const x = 1;", kind: "body" },
    ]);
  });

  it("renders markdown blockquotes and lists as cleaner transcript text", () => {
    expect(
      blockToLines({
        type: "assistant-text",
        text:
          "> quoted line\n"
          + "- first item\n"
          + "  - nested item\n"
          + "1. ordered item",
        streaming: false,
      }),
    ).toEqual([
      { text: "│ quoted line", kind: "blockquote" },
      { text: "• first item", kind: "list" },
      { text: "  • nested item", kind: "list" },
      { text: "1. ordered item", kind: "list" },
    ]);
  });

  it("renders proposed plans with a distinct header and body", () => {
    expect(
      blockToLines({
        type: "proposed-plan",
        title: "Console UI migration",
        body: "- Bind the prototype to the orchestration read model.\n- Keep transcript rendering text-first.",
      }),
    ).toEqual([
      { text: "", kind: "planSeparator" },
      {
        text: "Console UI migration",
        kind: "planHeader",
        extraClasses: ["cm-line-proposedPlanHeader"],
      },
      {
        text: "• Bind the prototype to the orchestration read model.",
        kind: "list",
      },
      {
        text: "• Keep transcript rendering text-first.",
        kind: "list",
      },
      { text: "", kind: "planSeparator" },
    ]);
  });

  it("renders checkpoint summaries as a compact summary plus file list", () => {
    expect(
      blockToLines({
        type: "checkpoint-summary",
        status: "ready",
        checkpointTurnCount: 3,
        files: [
          {
            path: "apps/console-ui/src/App.tsx",
            kind: "modified",
            additions: 18,
            deletions: 10,
          },
          {
            path: "apps/console-ui/src/index.css",
            kind: "modified",
            additions: 22,
            deletions: 9,
          },
        ],
      }),
    ).toEqual([
      { text: "", kind: "checkpointSeparator" },
      { text: "Checkpoint captured · #3", kind: "checkpointHeader" },
      { text: "2 files changed (+40 -19)", kind: "checkpointSummary" },
      { text: "  apps/console-ui/src/App.tsx  (+18 -10)", kind: "checkpointFile" },
      { text: "  apps/console-ui/src/index.css  (+22 -9)", kind: "checkpointFile" },
      { text: "", kind: "checkpointSeparator" },
    ]);
  });

  it("renders a working-state block with elapsed time", () => {
    expect(
      blockToLines({
        type: "working-state",
        startedAt: "2026-03-12T09:00:00.000Z",
        now: "2026-03-12T09:00:04.200Z",
      }),
    ).toEqual([
      { text: "", kind: "workingSeparator" },
      { text: "Working", kind: "workingHeader" },
      { text: "running for 4.2s", kind: "workingFooter" },
      { text: "", kind: "workingSeparator" },
    ]);
  });
});
