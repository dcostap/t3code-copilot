import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  estimateTranscriptHistoryBlockHeight,
  findTranscriptHistoryBlockSearchMatches,
  getTranscriptHistoryBlockMeasurementKey,
  TranscriptHistoryBlocks,
} from "./TranscriptHistoryBlocks";
import { blockToLines, type TranscriptBlock } from "./TranscriptBlock";

describe("TranscriptHistoryBlocks", () => {
  it("renders text-oriented transcript blocks into DOM output", () => {
    const blocks: TranscriptBlock[] = [
      {
        type: "user-message",
        text: "Please inspect this.",
        attachments: [
          {
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1024,
          },
        ],
      },
      {
        type: "assistant-text",
        text: "Working through the transcript.",
        streaming: false,
      },
      {
        type: "reasoning-summary",
        text: "Checking prior work",
      },
    ];

    const html = renderToStaticMarkup(<TranscriptHistoryBlocks blocks={blocks} />);

    expect(html).toContain("Please inspect this.");
    expect(html).toContain("Working through the transcript.");
    expect(html).toContain("Checking prior work");
    expect(html).toContain("1 attachment");
    expect(html).toContain("screenshot.png");
  });

  it("renders work-group items with collapsed commands and expandable file diffs", () => {
    const block: TranscriptBlock = {
      type: "work-group",
      title: "Command run",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:04.400Z",
      items: [
        {
          kind: "command",
          label: "Command run",
          status: "done",
          startedAt: "2026-03-13T12:00:00.000Z",
          endedAt: "2026-03-13T12:00:04.400Z",
          command: "git status --short",
          output: "M src/App.tsx",
        },
        {
          kind: "file-change",
          label: "File change",
          status: "done",
          changedFiles: ["src/example.ts"],
          additions: 2,
          deletions: 1,
          inlineUnifiedDiff:
            "diff --git a/src/example.ts b/src/example.ts\n"
            + "--- a/src/example.ts\n"
            + "+++ b/src/example.ts\n"
            + "@@ -1 +1 @@\n"
            + "-old line\n"
            + "+new line\n",
        },
      ],
    };
    const blocks = [block];
    const lines = blockToLines(block);
    const commandSignature = lines[0]?.commandWidgetSignature;

    const collapsedHtml = renderToStaticMarkup(<TranscriptHistoryBlocks blocks={blocks} />);
    const expandedHtml = renderToStaticMarkup(
      <TranscriptHistoryBlocks
        blocks={blocks}
        expandedCommandSignatures={new Set(commandSignature ? [commandSignature] : [])}
      />,
    );

    expect(collapsedHtml).toContain("transcript-blockHistory__commandWidgetSurface");
    expect(collapsedHtml).toContain("transcript-blockHistory__commandWidgetRail");
    expect(collapsedHtml).toContain("cm-line-workItemDone");
    expect(collapsedHtml).toContain("git status --short");
    expect(collapsedHtml).not.toContain("M src/App.tsx");
    expect(collapsedHtml).toContain("src/example.ts");
    expect(collapsedHtml).toContain("diff --git a/src/example.ts b/src/example.ts");
    expect(expandedHtml).toContain("M src/App.tsx");
  });

  it("renders animated state lines and answered approval options", () => {
    const blocks: TranscriptBlock[] = [
      {
        type: "waiting-state",
        startedAt: "1970-01-01T00:00:00.000Z",
        now: "1970-01-01T00:00:01.250Z",
      },
      {
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
              { label: "Staging", description: "Connect to the staging service." },
              { label: "Demo", description: "Keep using local orchestration fixtures." },
            ],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(<TranscriptHistoryBlocks blocks={blocks} />);

    expect(html).toContain("transcript-blockHistory__animatedText");
    expect(html).toContain("Waiting for agent for");
    expect(html).toContain("cm-line-userInputResolved");
    expect(html).toContain("cm-line-userInputAnsweredOption");
    expect(html).toContain("Source: Which mode should this console stay in?");
    expect(html).toContain("Staging: Connect to the staging service.");
  });

  it("treats multiline command summaries as expandable", () => {
    const block: TranscriptBlock = {
      type: "work-group",
      title: "Command run",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:04.400Z",
      items: [
        {
          kind: "command",
          label: "Command run",
          status: "done",
          command: "$ErrorActionPreference='Stop';\nSet-Location 'C:\\Projects\\example';\npython script.py",
        },
      ],
    };

    const html = renderToStaticMarkup(<TranscriptHistoryBlocks blocks={[block]} />);

    expect(html).toContain("transcript-blockHistory__commandWidgetSurfaceToggleable");
    expect(html).toContain("aria-expanded=\"false\"");
  });

  it("renders block-history search highlights with an active match", () => {
    const blocks: TranscriptBlock[] = [
      {
        type: "assistant-text",
        text: "Search this transcript.\nSearch it again.",
        streaming: false,
      },
    ];

    const searchMatches = findTranscriptHistoryBlockSearchMatches(blocks, "search");
    const html = renderToStaticMarkup(
      <TranscriptHistoryBlocks
        blocks={blocks}
        searchMatches={searchMatches}
        activeSearchMatchIndex={1}
      />,
    );

    expect(searchMatches).toHaveLength(2);
    expect(html).toContain("transcript-blockHistory__searchMatch");
    expect(html).toContain("transcript-blockHistory__searchMatch--active");
    expect(html).toContain("data-transcript-search-match-index=\"1\"");
  });

  it("renders interactive link spans with link semantics in block history", () => {
    const blocks: TranscriptBlock[] = [
      {
        type: "assistant-text",
        text: "See https://example.com and C:\\Projects\\webdev\\t3code-copilot\\README.md",
        streaming: false,
      },
    ];

    const html = renderToStaticMarkup(<TranscriptHistoryBlocks blocks={blocks} />);

    expect(html).toContain("data-link-kind=\"url\"");
    expect(html).toContain("data-link-kind=\"file\"");
    expect(html).toContain("role=\"link\"");
    expect(html).toContain("tabindex=\"0\"");
  });

  it("renders markdown tables as block-history table widgets", () => {
    const blocks: TranscriptBlock[] = [
      {
        type: "assistant-text",
        text: [
          "| File | Status |",
          "| --- | ---: |",
          "| very-long-component-name.tsx | done |",
        ].join("\n"),
        streaming: false,
      },
    ];

    const html = renderToStaticMarkup(<TranscriptHistoryBlocks blocks={blocks} />);

    expect(html).toContain("transcript-blockHistory__markdownTableSurface");
    expect(html).toContain("transcript-blockHistory__markdownTableLine--header");
    expect(html).toContain("transcript-blockHistory__markdownTableCell--body");
    expect(html).toContain("very-long-component-name.ts");
    expect(html).toContain("transcript-blockHistory__markdownTableLine--body");
    expect(html).toContain("done");
  });

  it("estimates taller blocks for narrower wrapped text widths", () => {
    const block: TranscriptBlock = {
      type: "assistant-text",
      text: "This transcript line is intentionally long so the virtual height estimate has to account for wrapping before the block is actually measured.".repeat(3),
      streaming: false,
    };

    const narrowHeight = estimateTranscriptHistoryBlockHeight(block, { availableWidthPx: 220 });
    const wideHeight = estimateTranscriptHistoryBlockHeight(block, { availableWidthPx: 900 });

    expect(narrowHeight).toBeGreaterThan(wideHeight);
  });

  it("accounts for expanded command bodies in width-aware height estimates", () => {
    const block: TranscriptBlock = {
      type: "work-group",
      title: "Command run",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:04.400Z",
      items: [
        {
          kind: "command",
          label: "Command run",
          status: "done",
          startedAt: "2026-03-13T12:00:00.000Z",
          endedAt: "2026-03-13T12:00:04.400Z",
          command: "git status --short",
          output: "A very-long-output-line-that-keeps-going ".repeat(10),
        },
      ],
    };
    const signature = blockToLines(block)[0]?.commandWidgetSignature;

    const narrowHeight = estimateTranscriptHistoryBlockHeight(block, {
      availableWidthPx: 260,
      expandedCommandSignatures: new Set(signature ? [signature] : []),
    });
    const wideHeight = estimateTranscriptHistoryBlockHeight(block, {
      availableWidthPx: 900,
      expandedCommandSignatures: new Set(signature ? [signature] : []),
    });

    expect(narrowHeight).toBeGreaterThan(wideHeight);
  });

  it("keeps collapsed multiline command summaries on a stable estimated height", () => {
    const block: TranscriptBlock = {
      type: "work-group",
      title: "Command run",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:04.400Z",
      items: [
        {
          kind: "command",
          label: "Command run",
          status: "done",
          command: "$ErrorActionPreference='Stop';\nSet-Location 'C:\\Projects\\example';\npython script.py",
        },
      ],
    };
    const signature = blockToLines(block)[0]?.commandWidgetSignature;

    const collapsedNarrowHeight = estimateTranscriptHistoryBlockHeight(block, { availableWidthPx: 260 });
    const collapsedWideHeight = estimateTranscriptHistoryBlockHeight(block, { availableWidthPx: 900 });
    const expandedNarrowHeight = estimateTranscriptHistoryBlockHeight(block, {
      availableWidthPx: 260,
      expandedCommandSignatures: new Set(signature ? [signature] : []),
    });

    expect(collapsedNarrowHeight).toBe(collapsedWideHeight);
    expect(expandedNarrowHeight).toBeGreaterThan(collapsedNarrowHeight);
  });

  it("changes the measurement key when a command widget expands", () => {
    const block: TranscriptBlock = {
      type: "work-group",
      title: "Command run",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:04.400Z",
      items: [
        {
          kind: "command",
          label: "Command run",
          status: "done",
          startedAt: "2026-03-13T12:00:00.000Z",
          endedAt: "2026-03-13T12:00:04.400Z",
          command: "git status --short",
          output: "M src/App.tsx\nM src/feature.tsx",
        },
      ],
    };
    const signature = blockToLines(block)[0]?.commandWidgetSignature;

    const collapsedKey = getTranscriptHistoryBlockMeasurementKey(block);
    const expandedKey = getTranscriptHistoryBlockMeasurementKey(block, {
      expandedCommandSignatures: new Set(signature ? [signature] : []),
    });

    expect(expandedKey).not.toBe(collapsedKey);
  });

  it("changes the measurement key when an expanded file diff resolves", () => {
    const block: TranscriptBlock = {
      type: "work-group",
      title: "File change",
      status: "done",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-13T12:00:04.400Z",
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
            fromTurnCount: 1,
            toTurnCount: 2,
          },
        },
      ],
    };
    const signature = blockToLines(block)[0]?.commandWidgetSignature;
    const expandedCollapsedState = {
      collapsedFileChangeSignatures: new Set<string>(),
    };

    const loadingKey = getTranscriptHistoryBlockMeasurementKey(block, {
      ...expandedCollapsedState,
      resolvedInlineDiffBySignature: new Map(signature ? [[signature, { status: "loading" }]] : []),
    });
    const readyKey = getTranscriptHistoryBlockMeasurementKey(block, {
      ...expandedCollapsedState,
      resolvedInlineDiffBySignature: new Map(
        signature
          ? [[signature, { status: "ready", diff: "diff --git a/src/example.ts b/src/example.ts\n+line" }]]
          : [],
      ),
    });

    expect(readyKey).not.toBe(loadingKey);
  });
});
