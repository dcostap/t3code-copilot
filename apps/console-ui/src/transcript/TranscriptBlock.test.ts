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

function highlightedTextForClass(line: TranscriptLine, className: string) {
  return (line.highlightSpans ?? [])
    .filter((span) => span.className === className)
    .map((span) => line.text.slice(span.from, span.to));
}

function linkSpans(line: TranscriptLine) {
  return (line.highlightSpans ?? []).filter((span) => span.link);
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
    ]);
    expect(lines[0]?.text).toBe("    Source: Which mode should this console stay in?");
    expect(lines[0]?.userInputRef).toEqual({ requestId: "req-1", questionIndex: 0 });
    expect(lines[1]?.text).toBe("      1  Demo: Keep using local orchestration fixtures.");
    expect(lines[1]?.userInputRef).toEqual({
      requestId: "req-1",
      questionIndex: 0,
      optionIndex: 0,
    });
    expect(lines[2]?.text).toBe("      2  Live: Connect to the orchestration websocket.");
    expect(lines[2]?.userInputRef).toEqual({
      requestId: "req-1",
      questionIndex: 0,
      optionIndex: 1,
    });
  });

  it("omits the generic Question header and avoids duplicating identical option descriptions", () => {
    const lines = blockToLines({
      type: "user-input-request",
      requestId: "req-dup",
      questions: [
        {
          header: "Question",
          question: "Is the ask_user tool working as expected?",
          options: [
            { label: "Yes", description: "Yes" },
            { label: "No", description: "No" },
          ],
        },
      ],
    });

    expect(lines.map((line) => line.text)).toEqual([
      "    Is the ask_user tool working as expected?",
      "      1  Yes",
      "      2  No",
    ]);
  });

  it("keeps resolved user input questions highlighted without appending a duplicate answer line", () => {
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

    expect(lines[0]?.extraClasses).toEqual(
      expect.arrayContaining(["cm-line-userInputQuestion", "cm-line-userInputResolved"]),
    );
    expect(lines[1]?.extraClasses).toEqual(
      expect.arrayContaining([
        "cm-line-userInputOption",
        "cm-line-userInputResolved",
        "cm-line-userInputResolvedOption",
      ]),
    );
    expect(lines.map((line) => line.kind)).toEqual([
      "approvalPrompt",
      "approvalPrompt",
      "approvalPrompt",
    ]);
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
    expect(widgetLine.text).not.toContain("Completed in");
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
    expect(lines[1]?.text).not.toContain("Completed in");
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
    expect(widgetLine.text).not.toContain("Completed in");
    expect(widgetLine.commandWidgetSignature).toEqual(expect.any(String));
    expectHighlightClasses(widgetLine, "tok-commandWidgetGlyph", "tok-commandWidgetPrefix");
    expect(lines[1]).toEqual({ text: "", kind: "workGroupSeparator" });
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

  it("marks running commands with running classes", () => {
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
    expect(widgetLine.extraClasses).toEqual(
      expect.arrayContaining(["cm-line-workItemRunning", "cm-line-commandWidget"]),
    );
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
    expect(lines[1]?.text).not.toContain("Completed in");
    expect(lines[2]).toEqual({ text: "", kind: "workGroupSeparator" });
  });

  it("omits done work-group footers at exactly one second", () => {
    const lines = blockToLines({
      type: "work-group",
      title: "Command run",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:01.000Z",
      items: [
        {
          kind: "command",
          label: "Command run",
          status: "done",
          command: "Get-Location",
        },
      ],
    });

    expect(lines).toEqual([
      expect.objectContaining({
        kind: "commandExec",
      }),
      { text: "", kind: "workGroupSeparator" },
    ]);
  });

  it("keeps done work-group footers once they exceed one second", () => {
    const lines = blockToLines({
      type: "work-group",
      title: "Command run",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:01.100Z",
      items: [
        {
          kind: "command",
          label: "Command run",
          status: "done",
          command: "Get-Location",
        },
      ],
    });

    expect(lines[1]).toEqual({ text: "Completed in 1.1s", kind: "workingLine" });
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

  it("renders inline code, bold, and italics as styled plain text", () => {
    const lines = blockToLines({
      type: "assistant-text",
      text: "Use `bun run test`, stay **focused**, and be *careful*.",
      streaming: false,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe("body");
    expect(lines[0]?.text).toBe("Use bun run test, stay focused, and be careful.");
    expect(highlightedTextForClass(lines[0]!, "tok-inlineCode")).toEqual(["bun run test"]);
    expect(highlightedTextForClass(lines[0]!, "tok-markdownStrong")).toEqual(["focused"]);
    expect(highlightedTextForClass(lines[0]!, "tok-markdownEmphasis")).toEqual(["careful"]);
  });

  it("applies inline markdown styling inside list and blockquote content", () => {
    const lines = blockToLines({
      type: "assistant-text",
      text: "- **ship it**\n> use `bun run test`\nLiteral \\*stars\\* stay literal.",
      streaming: false,
    });

    expect(lines.map((line) => line.kind)).toEqual(["list", "blockquote", "body"]);
    expect(lines[0]?.text).toBe("• ship it");
    expect(highlightedTextForClass(lines[0]!, "tok-markdownStrong")).toEqual(["ship it"]);
    expect(lines[1]?.text).toBe("│ use bun run test");
    expect(highlightedTextForClass(lines[1]!, "tok-inlineCode")).toEqual(["bun run test"]);
    expect(lines[2]?.text).toBe("Literal *stars* stay literal.");
    expect(lines[2]?.highlightSpans).toBeUndefined();
  });

  it("renders markdown headings as styled plain text lines", () => {
    const lines = blockToLines({
      type: "assistant-text",
      text: "# Overview\n## Details\n### Notes",
      streaming: false,
    });

    expect(lines.map((line) => line.text)).toEqual(["Overview", "Details", "Notes"]);
    expect(lines[0]?.extraClasses).toEqual(
      expect.arrayContaining(["cm-line-markdownHeading", "cm-line-markdownHeading1"]),
    );
    expect(lines[1]?.extraClasses).toEqual(
      expect.arrayContaining(["cm-line-markdownHeading", "cm-line-markdownHeading2"]),
    );
    expect(lines[2]?.extraClasses).toEqual(
      expect.arrayContaining(["cm-line-markdownHeading", "cm-line-markdownHeading3"]),
    );
  });

  it("captures markdown links, bare urls, and file paths as interactive spans", () => {
    const lines = blockToLines({
      type: "assistant-text",
      text:
        "Open [repo](https://github.com/example/repo), visit https://example.com/docs, and inspect `C:\\Users\\Dario Costa\\Desktop\\report.xlsx` plus src\\App.tsx and apps/console-ui but not word1/word2 or WSL/Hyper-V",
      streaming: false,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("Open repo");
    expect(lines[0]?.text).toContain("https://example.com/docs");
    expect(lines[0]?.text).toContain("C:\\Users\\Dario Costa\\Desktop\\report.xlsx");

    const interactiveSpans = linkSpans(lines[0]!);
    expect(interactiveSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          link: {
            kind: "url",
            target: "https://github.com/example/repo",
          },
        }),
        expect.objectContaining({
          link: {
            kind: "url",
            target: "https://example.com/docs",
          },
        }),
        expect.objectContaining({
          link: {
            kind: "file",
            target: "C:\\Users\\Dario Costa\\Desktop\\report.xlsx",
          },
        }),
        expect.objectContaining({
          link: {
            kind: "file",
            target: "src\\App.tsx",
          },
        }),
        expect.objectContaining({
          link: {
            kind: "file",
            target: "apps/console-ui",
          },
        }),
      ]),
    );
    expect(interactiveSpans).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          link: {
            kind: "file",
            target: "word1/word2",
          },
        }),
        expect.objectContaining({
          link: {
            kind: "file",
            target: "WSL/Hyper-V",
          },
        }),
      ]),
    );
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

  it("renders a working-state block with animated loading text", () => {
    const lines = blockToLines({
      type: "working-state",
      startedAt: "1970-01-01T00:00:00.000Z",
      now: "1970-01-01T00:00:00.180Z",
    });

    expect(lines[0]).toEqual({ text: "", kind: "meta" });
    expect(lines[1]?.kind).toBe("workingLine");
    expect(lines[1]?.text).toContain("Working for");
    expect(lines[1]?.animatedText).toEqual({ kind: "loading", from: 0, to: "Working for ".length });
  });

  it("renders a waiting-state block with animated loading text", () => {
    const lines = blockToLines({
      type: "waiting-state",
      startedAt: "1970-01-01T00:00:00.000Z",
      now: "1970-01-01T00:00:00.180Z",
    });

    expect(lines[0]).toEqual({ text: "", kind: "meta" });
    expect(lines[1]?.kind).toBe("workingLine");
    expect(lines[1]?.text).toContain("Waiting for agent for");
    expect(lines[1]?.animatedText).toEqual({ kind: "loading", from: 0, to: "Waiting for agent for ".length });
  });

  it("renders a finished-state block with the same spacing as the working widget", () => {
    const lines = blockToLines({
      type: "finished-state",
      startedAt: "1970-01-01T00:00:00.000Z",
      finishedAt: "1970-01-01T00:00:01.250Z",
    });

    expect(lines[0]).toEqual({ text: "", kind: "meta" });
    expect(lines[1]?.kind).toBe("workingLine");
    expect(lines[1]?.text).toBe("Finished in 1.3s");
    expect(lines[1]?.animatedText).toBeUndefined();
    expect(lines[1]?.highlightSpans).toBeUndefined();
  });

  it("renders a sending-state block with animated loading text", () => {
    const lines = blockToLines({
      type: "sending-state",
      startedAt: "1970-01-01T00:00:00.000Z",
      now: "1970-01-01T00:00:00.180Z",
    });

    expect(lines[0]).toEqual({ text: "", kind: "meta" });
    expect(lines[1]?.kind).toBe("workingLine");
    expect(lines[1]?.text).toContain("Sending prompt for");
    expect(lines[1]?.animatedText).toEqual({ kind: "loading", from: 0, to: "Sending prompt for ".length });
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
