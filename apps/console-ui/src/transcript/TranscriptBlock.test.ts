import { describe, expect, it } from "vitest";

import { blockToLines } from "./TranscriptBlock";

type TranscriptLine = ReturnType<typeof blockToLines>[number];

function highlightClassNames(line: TranscriptLine) {
  return new Set((line.highlightSpans ?? []).map((span) => span.className));
}

function expectHighlightClasses(line: TranscriptLine, ...classNames: string[]) {
  const classes = highlightClassNames(line);
  for (const className of classNames) {
    expect(classes.has(className)).toBe(true);
  }
}

describe("blockToLines", () => {
  it("wraps user messages in prompt separators", () => {
    const lines = blockToLines({
      type: "user-message",
      text: "hello",
    });

    expect(lines.map((line) => line.kind)).toEqual([
      "userPromptSeparator",
      "userMessage",
      "userPromptSeparator",
    ]);
    expect(lines[1]?.text).toBe("hello");
    expect(lines[1]?.extraClasses).toContain("cm-line-userMessageStart");
  });

  it("preserves user input question and option refs", () => {
    const lines = blockToLines({
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
    });

    expect(lines.map((line) => line.kind)).toEqual([
      "approvalPrompt",
      "approvalPrompt",
      "approvalPrompt",
      "approvalPrompt",
    ]);
    expect(lines[0]?.text).toContain("User input requested");
    expect(lines[1]?.text).toContain("Source");
    expect(lines[1]?.userInputRef).toEqual({ requestId: "req-1", questionIndex: 0 });
    expect(lines[2]?.text).toContain("Demo");
    expect(lines[2]?.userInputRef).toEqual({
      requestId: "req-1",
      questionIndex: 0,
      optionIndex: 0,
    });
    expect(lines[3]?.text).toContain("Live");
    expect(lines[3]?.userInputRef).toEqual({
      requestId: "req-1",
      questionIndex: 0,
      optionIndex: 1,
    });
  });

  it("appends resolved custom answers as plain user text", () => {
    const lines = blockToLines({
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
    });

    expect(lines[0]?.text).toContain("User input answered");
    expect(lines[0]?.extraClasses).toContain("cm-line-userInputResolved");
    expect(lines[1]?.extraClasses).toEqual(
      expect.arrayContaining(["cm-line-userInputQuestion", "cm-line-userInputResolved"]),
    );
    expect(lines[2]?.extraClasses).toEqual(
      expect.arrayContaining([
        "cm-line-userInputOption",
        "cm-line-userInputResolved",
        "cm-line-userInputResolvedOption",
      ]),
    );
    expect(lines.slice(-3).map((line) => line.kind)).toEqual([
      "userPromptSeparator",
      "userMessage",
      "userPromptSeparator",
    ]);
    expect(lines.at(-2)?.text).toBe("Staging");
  });

  it("emits stable plan step kinds instead of relying on exact glyph formatting", () => {
    const lines = blockToLines({
      type: "plan-update",
      explanation: "Reshape the UI around a single conversation scroll owner.",
      steps: [
        { step: "Unify transcript scrolling.", status: "completed" },
        { step: "Render tool activity inline.", status: "inProgress" },
        { step: "Tighten prompt layout.", status: "pending" },
      ],
    });

    expect(lines.map((line) => line.kind)).toEqual([
      "planSeparator",
      "planHeader",
      "planExplanation",
      "meta",
      "planStepCompleted",
      "planStepInProgress",
      "planStepPending",
      "planSeparator",
    ]);
    expect(lines[1]?.text).toContain("Plan");
    expect(lines[2]?.text).toContain("single conversation scroll owner");
    expect(lines[4]?.text).toContain("Unify transcript scrolling.");
    expect(lines[5]?.text).toContain("Render tool activity inline.");
    expect(lines[6]?.text).toContain("Tighten prompt layout.");
  });

  it("keeps edited-file widget metadata and diff payloads", () => {
    const diff =
      "diff --git a/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt b/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n"
      + "--- a/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n"
      + "+++ b/C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt\n"
      + "@@ -1 +1,3 @@\n"
      + "-old line\n"
      + "+new line\n"
      + "+extra line\n";
    const lines = blockToLines({
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
          inlineUnifiedDiff: diff,
        },
      ],
    });

    const widgetLine = lines[0]!;
    expect(widgetLine.kind).toBe("commandExec");
    expect(widgetLine.text).toContain("Edited");
    expect(widgetLine.text).toContain("lorem-ipsum.txt");
    expect(widgetLine.text).toContain("Completed in");
    expect(widgetLine.extraClasses).toEqual(
      expect.arrayContaining(["cm-line-workItemDone", "cm-line-commandWidget"]),
    );
    expect(widgetLine.commandWidgetSignature).toEqual(expect.any(String));
    expect(widgetLine.inlineUnifiedDiff).toBe(diff);
    expect(widgetLine.inlineDiffChangedFiles).toEqual(["C:\\Users\\Dario Costa\\Desktop\\lorem-ipsum.txt"]);
    expectHighlightClasses(
      widgetLine,
      "tok-commandWidgetGlyph",
      "tok-commandWidgetPrefix",
      "tok-added",
      "tok-removed",
      "tok-commandWidgetMeta",
    );
    expect(lines[1]).toEqual({ text: "", kind: "workGroupSeparator" });
  });

  it("preserves lazy diff lookup metadata on edited-file widgets", () => {
    const lines = blockToLines({
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
    });

    expect(lines[0]).toEqual(
      expect.objectContaining({
        kind: "commandExec",
        inlineDiffLookup: {
          threadId: "thread-1",
          fromTurnCount: 0,
          toTurnCount: 1,
        },
      }),
    );
    expect(lines[0]?.text).toContain("Edited");
    expect(lines[0]?.text).toContain("src/example.ts");
  });

  it("shows elapsed timing only on the last command in a completed edit batch", () => {
    const lines = blockToLines({
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
            "diff --git a/src/one.ts b/src/one.ts\n--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1,2 @@\n-old one\n+new one\n+extra one\n",
        },
        {
          kind: "file-change",
          label: "File change",
          status: "done",
          changedFiles: ["src/two.ts"],
          additions: 4,
          deletions: 0,
          inlineUnifiedDiff:
            "diff --git a/src/two.ts b/src/two.ts\n--- a/src/two.ts\n+++ b/src/two.ts\n@@ -3 +3 @@\n-old two\n+new two\n",
        },
      ],
    });

    expect(lines[0]?.kind).toBe("commandExec");
    expect(lines[0]?.text).toContain("src/one.ts");
    expect(lines[0]?.text).not.toContain("Completed in");
    expect(lines[1]?.kind).toBe("commandExec");
    expect(lines[1]?.text).toContain("src/two.ts");
    expect(lines[1]?.text).toContain("Completed in");
    expect(lines[2]).toEqual({ text: "", kind: "workGroupSeparator" });
  });

  it("renders read-file work groups as command widgets without pinning signature format", () => {
    const lines = blockToLines({
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
    });

    const widgetLine = lines[0]!;
    expect(widgetLine.kind).toBe("commandExec");
    expect(widgetLine.text).toContain("Read");
    expect(widgetLine.text).toContain("src/example.ts");
    expect(widgetLine.text).toContain("Completed in");
    expect(widgetLine.commandWidgetSignature).toEqual(expect.any(String));
    expectHighlightClasses(widgetLine, "tok-commandWidgetGlyph", "tok-commandWidgetPrefix", "tok-commandWidgetMeta");
  });

  it("does not duplicate command detail when it matches the command text", () => {
    const command = "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'Write-Output $env:USERPROFILE'";
    const lines = blockToLines({
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
          command,
          detail: command,
        },
      ],
    });

    const widgetLine = lines[0]!;
    expect(widgetLine.kind).toBe("commandExec");
    expect(widgetLine.text).toContain(command);
    expect(widgetLine.text.split(command)).toHaveLength(2);
  });

  it("marks running commands with pulse highlight classes", () => {
    const lines = blockToLines({
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
    });

    const widgetLine = lines[0]!;
    expect(widgetLine.kind).toBe("commandExec");
    expect(widgetLine.text).toContain("Running");
    expect(widgetLine.text).toContain("Get-Location");
    expect(widgetLine.text).toContain("Running for");
    expect(widgetLine.extraClasses).toEqual(
      expect.arrayContaining(["cm-line-workItemRunning", "cm-line-commandWidget"]),
    );
    expectHighlightClasses(
      widgetLine,
      "tok-commandWidgetGlyph",
      "tok-commandWidgetPrefix",
      "tok-commandWidgetMeta",
      "tok-workingPulseCore",
      "tok-workingPulseMid",
      "tok-workingPulseEdge",
    );
  });

  it("widens the pulse core for longer running commands", () => {
    const shortLine = blockToLines({
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
    })[0]!;
    const longLine = blockToLines({
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
    })[0]!;

    const shortCoreWidth =
      (shortLine.highlightSpans ?? []).filter((span) => span.className === "tok-workingPulseCore").length;
    const longCoreWidth =
      (longLine.highlightSpans ?? []).filter((span) => span.className === "tok-workingPulseCore").length;

    expect(longCoreWidth).toBeGreaterThan(shortCoreWidth);
  });

  it("adds elapsed timing only to the last command in a completed command batch", () => {
    const lines = blockToLines({
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
    });

    expect(lines[0]?.text).toContain("Get-Location");
    expect(lines[0]?.text).not.toContain("Completed in");
    expect(lines[1]?.text).toContain("git status --short");
    expect(lines[1]?.text).toContain("Completed in");
  });

  it("renders tool work groups as command widgets without pinning optional output layout", () => {
    const lines = blockToLines({
      type: "work-group",
      title: "glob",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:00.300Z",
      items: [
        {
          kind: "tool",
          label: "glob",
          status: "done",
          detail: "**/*.ts",
          output: "src/App.tsx\nsrc/transcript/TranscriptRenderer.tsx",
        },
      ],
    });

    expect(lines[0]).toEqual(
      expect.objectContaining({
        kind: "commandExec",
        extraClasses: expect.arrayContaining(["cm-line-workItemDone", "cm-line-commandWidget"]),
      }),
    );
    expect(lines[0]?.text).toContain("Glob");
    expect(lines[0]?.text).toContain("**/*.ts");
    expect(lines.at(-1)).toEqual({ text: "", kind: "workGroupSeparator" });
  });

  it("renders standalone tool calls and results with command-style rows", () => {
    const toolCallLines = blockToLines({
      type: "tool-call",
      label: "report_intent",
      status: "done",
      detail: "Exploring transcript widgets",
    });
    const toolResultLines = blockToLines({
      type: "tool-result",
      summary: "Output",
      output: "first\nsecond",
    });

    expect(toolCallLines[0]).toEqual(
      expect.objectContaining({
        kind: "commandExec",
        extraClasses: expect.arrayContaining(["cm-line-workItemDone", "cm-line-commandWidget"]),
      }),
    );
    expect(toolCallLines[0]?.text).toContain("Report Intent");
    expect(toolCallLines[0]?.text).toContain("Exploring transcript widgets");
    expect(toolResultLines).toEqual([
      { text: "  first", kind: "commandOutput" },
      { text: "  second", kind: "commandOutput" },
    ]);
  });

  it("keeps markdown tables as table lines without pinning box layout", () => {
    const lines = blockToLines({
      type: "assistant-text",
      text:
        "| Name | Role | Status |\n"
        + "| --- | --- | --- |\n"
        + "| Alice | Developer | Active |\n"
        + "| Bob | Designer | Inactive |",
      streaming: false,
    });

    expect(lines.every((line) => line.kind === "table")).toBe(true);
    expect(lines.some((line) => line.text.includes("Name") && line.text.includes("Role"))).toBe(true);
    expect(lines.some((line) => line.text.includes("Alice") && line.text.includes("Active"))).toBe(true);
    expect(lines.some((line) => line.text.includes("Bob") && line.text.includes("Inactive"))).toBe(true);
  });

  it("renders closed fenced code blocks as structured code sections", () => {
    const lines = blockToLines({
      type: "assistant-text",
      text:
        "Before\n"
        + "```ts\n"
        + "const x = 1;\n"
        + "console.log(x);\n"
        + "```\n"
        + "After",
      streaming: false,
    });

    expect(lines.map((line) => line.kind)).toEqual([
      "body",
      "codeFenceSeparator",
      "codeFenceHeader",
      "codeFenceBody",
      "codeFenceBody",
      "codeFenceSeparator",
      "body",
    ]);
    expect(lines[0]?.text).toBe("Before");
    expect(lines[2]?.text).toContain("ts");
    expect(lines[3]?.text).toContain("const x = 1;");
    expect(lines[4]?.text).toContain("console.log(x);");
    expect((lines[3]?.highlightSpans ?? []).some((span) => span.className.includes("tok-keyword"))).toBe(true);
    expect((lines[4]?.highlightSpans ?? []).some((span) => span.className.includes("tok-variableName"))).toBe(true);
    expect(lines[6]?.text).toBe("After");
  });

  it("keeps unfinished fenced code blocks as plain body text while streaming", () => {
    const lines = blockToLines({
      type: "assistant-text",
      text: "```ts\nconst x = 1;",
      streaming: true,
    });

    expect(lines).toEqual([
      { text: "```ts", kind: "body" },
      { text: "const x = 1;", kind: "body" },
    ]);
  });

  it("maps markdown blockquotes and lists to the right semantic line kinds", () => {
    const lines = blockToLines({
      type: "assistant-text",
      text:
        "> quoted line\n"
        + "- first item\n"
        + "  - nested item\n"
        + "1. ordered item",
      streaming: false,
    });

    expect(lines.map((line) => line.kind)).toEqual(["blockquote", "list", "list", "list"]);
    expect(lines[0]?.text).toContain("quoted line");
    expect(lines[1]?.text).toContain("first item");
    expect(lines[2]?.text).toContain("nested item");
    expect(lines[3]?.text).toContain("ordered item");
  });

  it("renders proposed plans with header and list body lines", () => {
    const lines = blockToLines({
      type: "proposed-plan",
      title: "Console UI migration",
      body: "- Bind the prototype to the orchestration read model.\n- Keep transcript rendering text-first.",
    });

    expect(lines.map((line) => line.kind)).toEqual([
      "planSeparator",
      "planHeader",
      "list",
      "list",
      "planSeparator",
    ]);
    expect(lines[1]?.text).toContain("Console UI migration");
    expect(lines[1]?.extraClasses).toContain("cm-line-proposedPlanHeader");
    expect(lines[2]?.text).toContain("Bind the prototype");
    expect(lines[3]?.text).toContain("Keep transcript rendering text-first.");
  });

  it("renders checkpoint summaries with aggregate totals and file entries", () => {
    const lines = blockToLines({
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
    });

    expect(lines.map((line) => line.kind)).toEqual([
      "checkpointSeparator",
      "checkpointHeader",
      "checkpointSummary",
      "checkpointFile",
      "checkpointFile",
      "checkpointSeparator",
    ]);
    expect(lines[1]?.text).toContain("#3");
    expect(lines[2]?.text).toContain("2 files changed");
    expect(lines[2]?.text).toContain("+40");
    expect(lines[2]?.text).toContain("-19");
    expect(lines[3]?.text).toContain("apps/console-ui/src/App.tsx");
    expect(lines[4]?.text).toContain("apps/console-ui/src/index.css");
  });

  it("renders a working-state block with pulse highlights", () => {
    const lines = blockToLines({
      type: "working-state",
      startedAt: "1970-01-01T00:00:00.000Z",
      now: "1970-01-01T00:00:00.180Z",
    });

    expect(lines[0]?.kind).toBe("workingLine");
    expect(lines[0]?.text).toContain("Working for");
    expectHighlightClasses(lines[0]!, "tok-workingPulseCore", "tok-workingPulseMid", "tok-workingPulseEdge");
  });

  it("renders a sending-state block with pulse highlights", () => {
    const lines = blockToLines({
      type: "sending-state",
      startedAt: "1970-01-01T00:00:00.000Z",
      now: "1970-01-01T00:00:00.180Z",
    });

    expect(lines[0]?.kind).toBe("workingLine");
    expect(lines[0]?.text).toContain("Sending prompt for");
    expectHighlightClasses(lines[0]!, "tok-workingPulseCore", "tok-workingPulseMid", "tok-workingPulseEdge");
  });

  it("renders an interrupted-state block with the frozen elapsed time", () => {
    const lines = blockToLines({
      type: "interrupted-state",
      startedAt: "1970-01-01T00:00:00.000Z",
      interruptedAt: "1970-01-01T00:00:01.250Z",
    });

    expect(lines).toEqual([
      expect.objectContaining({
        kind: "workingLine",
        text: "Interrupted after 1.3s",
      }),
    ]);
  });
});
