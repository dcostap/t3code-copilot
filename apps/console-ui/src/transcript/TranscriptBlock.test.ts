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
      { text: "hello", kind: "userMessage", extraClasses: ["cm-line-userMessageStart"] },
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
      { text: "Staging", kind: "userMessage", extraClasses: ["cm-line-userMessageStart"] },
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

  it("renders single file-change work groups as bounded edit blocks", () => {
    expect(
      blockToLines({
        type: "work-group",
        title: "File change",
        status: "done",
        startedAt: "2026-03-13T10:57:31.912Z",
        endedAt: "2026-03-13T10:57:31.931Z",
        items: [
          {
            kind: "file-change",
            label: "File change",
            status: "done",
            changedFiles: ["C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt"],
            additions: 3,
            deletions: 0,
            inlineUnifiedDiff:
              'diff --git a/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt b/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n--- a/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n+++ b/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n@@ -1 +1,3 @@\n-old line\n+new line\n+extra line\n',
          },
        ],
      }),
    ).toEqual([
      {
        text: '✓ Edited (+3, -0)  C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt  Completed in 0.0s',
        kind: "commandExec",
        extraClasses: ["cm-line-workItemDone", "cm-line-commandWidget"],
        commandWidgetSignature:
          '2026-03-13T10:57:31.912Z:0:C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt',
        inlineUnifiedDiff: 'diff --git a/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt b/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n--- a/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n+++ b/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n@@ -1 +1,3 @@\n-old line\n+new line\n+extra line\n',
        inlineDiffChangedFiles: ["C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt"],
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 8, className: "tok-commandWidgetPrefix" },
          { from: 10, to: 12, className: "tok-added" },
          { from: 14, to: 16, className: "tok-removed" },
          { from: 65, to: 82, className: "tok-commandWidgetMeta" },
        ],
      },
      { text: "", kind: "workGroupSeparator" },
    ]);
  });

  it("preserves lazy diff lookup metadata on edited-file widgets", () => {
    expect(
      blockToLines({
        type: "work-group",
        title: "File change",
        status: "done",
        startedAt: "2026-03-13T10:57:31.912Z",
        endedAt: "2026-03-13T10:57:31.931Z",
        items: [
          {
            kind: "file-change",
            label: "File change",
            status: "done",
            changedFiles: ["src/example.ts"],
            additions: 2,
            deletions: 1,
            inlineDiffLookup: {
              threadId: "thread-1",
              fromTurnCount: 0,
              toTurnCount: 1,
            },
          },
        ],
      }),
    ).toEqual([
      {
        text: '✓ Edited (+2, -1)  src/example.ts  Completed in 0.0s',
        kind: "commandExec",
        extraClasses: ["cm-line-workItemDone", "cm-line-commandWidget"],
        commandWidgetSignature: "2026-03-13T10:57:31.912Z:0:src/example.ts",
        inlineDiffLookup: {
          threadId: "thread-1",
          fromTurnCount: 0,
          toTurnCount: 1,
        },
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 8, className: "tok-commandWidgetPrefix" },
          { from: 10, to: 12, className: "tok-added" },
          { from: 14, to: 16, className: "tok-removed" },
          { from: 35, to: 52, className: "tok-commandWidgetMeta" },
        ],
      },
      { text: "", kind: "workGroupSeparator" },
    ]);
  });

  it("renders consecutive file-change items under one edited-files block", () => {
    expect(
      blockToLines({
        type: "work-group",
        title: "File change",
        status: "done",
        startedAt: "2026-03-13T10:57:31.912Z",
        endedAt: "2026-03-13T10:57:32.512Z",
        items: [
          {
            kind: "file-change",
            label: "File change",
            status: "done",
            changedFiles: ["src/one.ts"],
            additions: 2,
            deletions: 1,
            inlineUnifiedDiff:
              'diff --git a/src/one.ts b/src/one.ts\n--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1,2 @@\n-old one\n+new one\n+extra one\n',
          },
          {
            kind: "file-change",
            label: "File change",
            status: "done",
            changedFiles: ["src/two.ts"],
            additions: 4,
            deletions: 0,
            inlineUnifiedDiff:
              'diff --git a/src/two.ts b/src/two.ts\n--- a/src/two.ts\n+++ b/src/two.ts\n@@ -3 +3 @@\n-old two\n+new two\n',
          },
        ],
      }),
    ).toEqual([
      {
        text: '✓ Edited (+2, -1)  src/one.ts',
        kind: "commandExec",
        extraClasses: ["cm-line-workItemDone", "cm-line-commandWidget"],
        commandWidgetSignature: "2026-03-13T10:57:31.912Z:0:src/one.ts",
        inlineUnifiedDiff: 'diff --git a/src/one.ts b/src/one.ts\n--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1,2 @@\n-old one\n+new one\n+extra one\n',
        inlineDiffChangedFiles: ["src/one.ts"],
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 8, className: "tok-commandWidgetPrefix" },
          { from: 10, to: 12, className: "tok-added" },
          { from: 14, to: 16, className: "tok-removed" },
        ],
      },
      {
        text: '✓ Edited (+4, -0)  src/two.ts  Completed in 0.6s',
        kind: "commandExec",
        extraClasses: ["cm-line-workItemDone", "cm-line-commandWidget"],
        commandWidgetSignature: "2026-03-13T10:57:31.912Z:1:src/two.ts",
        inlineUnifiedDiff: 'diff --git a/src/two.ts b/src/two.ts\n--- a/src/two.ts\n+++ b/src/two.ts\n@@ -3 +3 @@\n-old two\n+new two\n',
        inlineDiffChangedFiles: ["src/two.ts"],
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 8, className: "tok-commandWidgetPrefix" },
          { from: 10, to: 12, className: "tok-added" },
          { from: 14, to: 16, className: "tok-removed" },
          { from: 31, to: 48, className: "tok-commandWidgetMeta" },
        ],
      },
      { text: "", kind: "workGroupSeparator" },
    ]);
  });

  it("renders read-file work groups as read widgets", () => {
    expect(
      blockToLines({
        type: "work-group",
        title: "Read file",
        status: "done",
        startedAt: "2026-03-13T10:57:31.912Z",
        endedAt: "2026-03-13T10:57:32.512Z",
        items: [
          {
            kind: "tool",
            label: "Read file",
            status: "done",
            detail: "src/example.ts",
          },
        ],
      }),
    ).toEqual([
      {
        text: "✓ Read  src/example.ts  Completed in 0.6s",
        kind: "commandExec",
        extraClasses: ["cm-line-workItemDone", "cm-line-commandWidget"],
        commandWidgetSignature: "2026-03-13T10:57:31.912Z:0:src/example.ts",
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 6, className: "tok-commandWidgetPrefix" },
          { from: 24, to: 41, className: "tok-commandWidgetMeta" },
        ],
      },
      { text: "", kind: "workGroupSeparator" },
    ]);
  });

  it("does not repeat command detail when it matches the command text", () => {
    expect(
      blockToLines({
        type: "work-group",
        title: "Command run",
        status: "done",
        startedAt: "2026-03-13T10:57:31.912Z",
        endedAt: "2026-03-13T10:57:32.512Z",
        items: [
          {
            kind: "command",
            label: "Command run",
            status: "done",
            command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'Write-Output $env:USERPROFILE\'',
            detail: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'Write-Output $env:USERPROFILE\'',
          },
        ],
      }),
    ).toEqual([
      {
        text: '✓ Ran  "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'Write-Output $env:USERPROFILE\'  Completed in 0.6s',
        kind: "commandExec",
        extraClasses: ["cm-line-workItemDone", "cm-line-commandWidget"],
        commandWidgetSignature:
          '2026-03-13T10:57:31.912Z:0:"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'Write-Output $env:USERPROFILE\'',
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 5, className: "tok-commandWidgetPrefix" },
          { from: 90, to: 107, className: "tok-commandWidgetMeta" },
        ],
      },
      { text: "", kind: "workGroupSeparator" },
    ]);
  });

  it("renders running commands without a spinner glyph and pulses the command text", () => {
    expect(
      blockToLines({
        type: "work-group",
        title: "Command run",
        status: "running",
        startedAt: "1970-01-01T00:00:00.000Z",
        endedAt: "1970-01-01T00:00:00.180Z",
        now: "1970-01-01T00:00:00.180Z",
        items: [
          {
            kind: "command",
            label: "Command run",
            status: "running",
            command: "Get-Location",
          },
        ],
      }),
    ).toEqual([
      {
        text: "◓ Running  Get-Location  Running for 0.2s",
        kind: "commandExec",
        extraClasses: ["cm-line-workItemRunning", "cm-line-commandWidget"],
        commandWidgetSignature: "1970-01-01T00:00:00.000Z:0:Get-Location",
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 9, className: "tok-commandWidgetPrefix" },
          { from: 25, to: 41, className: "tok-commandWidgetMeta" },
          { from: 11, to: 12, className: "tok-workingPulseMid" },
          { from: 12, to: 13, className: "tok-workingPulseCore" },
          { from: 13, to: 14, className: "tok-workingPulseMid" },
          { from: 14, to: 15, className: "tok-workingPulseEdge" },
          { from: 15, to: 16, className: "tok-workingPulseEdge" },
        ],
      },
      { text: "", kind: "workGroupSeparator" },
    ]);
  });

  it("widens the solid pulse core for longer running commands", () => {
    expect(
      blockToLines({
        type: "work-group",
        title: "Command run",
        status: "running",
        startedAt: "1970-01-01T00:00:00.000Z",
        endedAt: "1970-01-01T00:00:00.180Z",
        now: "1970-01-01T00:00:00.180Z",
        items: [
          {
            kind: "command",
            label: "Command run",
            status: "running",
            command: "abcdefghijklmnopqrstuvwxyzAB",
          },
        ],
      }),
    ).toEqual([
      {
        text: "◓ Running  abcdefghijklmnopqrstuvwxyzAB  Running for 0.2s",
        kind: "commandExec",
        extraClasses: ["cm-line-workItemRunning", "cm-line-commandWidget"],
        commandWidgetSignature: "1970-01-01T00:00:00.000Z:0:abcdefghijklmnopqrstuvwxyzAB",
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 9, className: "tok-commandWidgetPrefix" },
          { from: 41, to: 57, className: "tok-commandWidgetMeta" },
          { from: 11, to: 12, className: "tok-workingPulseEdge" },
          { from: 12, to: 13, className: "tok-workingPulseMid" },
          { from: 13, to: 14, className: "tok-workingPulseCore" },
          { from: 14, to: 15, className: "tok-workingPulseCore" },
          { from: 15, to: 16, className: "tok-workingPulseCore" },
          { from: 16, to: 17, className: "tok-workingPulseMid" },
          { from: 17, to: 18, className: "tok-workingPulseEdge" },
          { from: 18, to: 19, className: "tok-workingPulseEdge" },
        ],
      },
      { text: "", kind: "workGroupSeparator" },
    ]);
  });

  it("adds the elapsed label to the last command when a command group contains multiple entries", () => {
    expect(
      blockToLines({
        type: "work-group",
        title: "Command run",
        status: "done",
        startedAt: "2026-03-13T12:00:00.000Z",
        endedAt: "2026-03-13T12:00:00.300Z",
        items: [
          {
            kind: "command",
            label: "Command run",
            status: "done",
            command: "Get-Location",
          },
          {
            kind: "command",
            label: "Command run",
            status: "done",
            command: "git status --short",
          },
        ],
      }),
    ).toEqual([
      {
        text: "✓ Ran  Get-Location",
        kind: "commandExec",
        extraClasses: ["cm-line-workItemDone", "cm-line-commandWidget"],
        commandWidgetSignature: "2026-03-13T12:00:00.000Z:0:Get-Location",
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 5, className: "tok-commandWidgetPrefix" },
        ],
      },
      {
        text: "✓ Ran  git status --short  Completed in 0.3s",
        kind: "commandExec",
        extraClasses: ["cm-line-workItemDone", "cm-line-commandWidget"],
        commandWidgetSignature: "2026-03-13T12:00:00.000Z:1:git status --short",
        highlightSpans: [
          { from: 0, to: 1, className: "tok-commandWidgetGlyph" },
          { from: 2, to: 5, className: "tok-commandWidgetPrefix" },
          { from: 27, to: 44, className: "tok-commandWidgetMeta" },
        ],
      },
      { text: "", kind: "workGroupSeparator" },
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
        startedAt: "1970-01-01T00:00:00.000Z",
        now: "1970-01-01T00:00:00.180Z",
      }),
    ).toEqual([
      {
        text: "Working for 0.2s",
        kind: "workingLine",
        highlightSpans: [
          { from: 0, to: 1, className: "tok-workingPulseMid" },
          { from: 1, to: 2, className: "tok-workingPulseCore" },
          { from: 2, to: 3, className: "tok-workingPulseMid" },
          { from: 3, to: 4, className: "tok-workingPulseEdge" },
          { from: 4, to: 5, className: "tok-workingPulseEdge" },
        ],
      },
    ]);
  });

  it("renders a sending-state block with elapsed time and pulse highlights", () => {
    expect(
      blockToLines({
        type: "sending-state",
        startedAt: "1970-01-01T00:00:00.000Z",
        now: "1970-01-01T00:00:00.180Z",
      }),
    ).toEqual([
      {
        text: "Sending prompt for 0.2s",
        kind: "workingLine",
        highlightSpans: [
          { from: 0, to: 1, className: "tok-workingPulseEdge" },
          { from: 1, to: 2, className: "tok-workingPulseMid" },
          { from: 2, to: 3, className: "tok-workingPulseCore" },
          { from: 3, to: 4, className: "tok-workingPulseMid" },
          { from: 4, to: 5, className: "tok-workingPulseEdge" },
          { from: 5, to: 6, className: "tok-workingPulseEdge" },
        ],
      },
    ]);
  });

  it("renders an interrupted-state block with frozen elapsed time", () => {
    expect(
      blockToLines({
        type: "interrupted-state",
        startedAt: "1970-01-01T00:00:00.000Z",
        interruptedAt: "1970-01-01T00:00:01.250Z",
      }),
    ).toEqual([
      {
        text: "Interrupted after 1.3s",
        kind: "workingLine",
      },
    ]);
  });
});
