import { describe, expect, it } from "vitest";

import { EventId } from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

import { buildTestSnapshot } from "../testSupport/testSnapshot";
import {
  ALWAYS_UNVIRTUALIZED_TAIL_ROWS,
  deriveTranscriptHistoryRows,
  estimateTranscriptHistoryRowHeight,
  getFirstUnvirtualizedRowIndex,
} from "./transcriptHistoryRows";
import { formatTranscriptHistoryRow } from "./TranscriptHistory";

describe("deriveTranscriptHistoryRows", () => {
  it("derives messages, grouped activities, and plans in timeline order", () => {
    const thread = buildTestSnapshot().threads[0]!;

    expect(deriveTranscriptHistoryRows(thread).map((row) => row.kind)).toEqual([
      "message",
      "activity-group",
      "tool",
      "checkpoint",
      "message",
      "message",
      "activity-group",
      "plan",
      "tool",
      "message",
      "message",
      "activity-group",
      "message",
    ]);
  });

  it("derives reasoning rows and hides report-intent utility tools", () => {
    const thread = buildReasoningAndHiddenToolFixture();
    const rows = deriveTranscriptHistoryRows(thread);

    expect(rows.some((row) => row.kind === "reasoning")).toBe(true);
    expect(rows.some((row) => row.kind === "tool" && row.tool.title === "Report intent")).toBe(false);
  });

  it("merges tool lifecycle events into one richer tool row", () => {
    const rows = deriveTranscriptHistoryRows(buildMergedToolFixture());
    const matchingRows = rows.filter((row) => row.kind === "tool" && row.tool.title === "Run checks");
    const row = matchingRows[0];

    expect(matchingRows).toHaveLength(1);
    expect(row?.kind).toBe("tool");
    if (!row || row.kind !== "tool") {
      return;
    }

    expect(row.tool.status).toBe("done");
    expect(row.tool.timingLabel).toBe("5s");
    expect(row.tool.output).toContain("packages successful");
  });

  it("appends a working row for running threads", () => {
    const thread = buildRunningThreadFixture();

    const rows = deriveTranscriptHistoryRows(thread);
    expect(rows.at(-1)?.kind).toBe("working");
  });
});

describe("getFirstUnvirtualizedRowIndex", () => {
  it("keeps the default live tail when the thread is idle", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const rows = deriveTranscriptHistoryRows(thread);

    expect(getFirstUnvirtualizedRowIndex(rows, thread)).toBe(
      Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0),
    );
  });

  it("keeps the full active turn mounted when it starts before the default live tail", () => {
    const thread = buildRunningThreadFixture();
    const rows = deriveTranscriptHistoryRows(thread);

    expect(getFirstUnvirtualizedRowIndex(rows, thread)).toBe(5);
  });
});

describe("formatTranscriptHistoryRow", () => {
  it("formats messages without user or assistant prefixes", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread)[0];

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    const display = formatTranscriptHistoryRow(row);

    expect(display).toContain(row.message.text);
    expect(display).not.toContain("user:");
    expect(display).not.toContain("assistant:");
  });

  it("formats activity groups as plain text lines", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "activity-group");

    expect(row?.kind).toBe("activity-group");
    if (!row || row.kind !== "activity-group") {
      return;
    }

    const display = formatTranscriptHistoryRow(row);

    expect(display).toContain("activity:");
    expect(display).toContain(`[${row.activities[0]!.tone}] ${row.activities[0]!.summary}`);
  });

  it("formats the working row as a simple status line", () => {
    const thread = buildRunningThreadFixture();
    const row = deriveTranscriptHistoryRows(thread).at(-1);

    expect(row?.kind).toBe("working");
    if (!row || row.kind !== "working") {
      return;
    }

    const display = formatTranscriptHistoryRow(row);

    expect(display).toBe(
      `working:\n${row.label ? `${row.label}...` : "Waiting for the next transcript update..."}`,
    );
  });
});

describe("estimateTranscriptHistoryRowHeight", () => {
  it("grows message estimates when the transcript narrows", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "message");

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    expect(
      estimateTranscriptHistoryRowHeight(row, { widthPx: 280 }),
    ).toBeGreaterThan(
      estimateTranscriptHistoryRowHeight(row, { widthPx: 900 }),
    );
  });
});

function buildRunningThreadFixture(): OrchestrationThread {
  const thread = buildTestSnapshot().threads[0]!;
  const activeTurnId = thread.messages[2]!.turnId!;

  return {
    ...thread,
    latestTurn: {
      ...thread.latestTurn!,
      turnId: activeTurnId,
      state: "running",
      startedAt: thread.messages[2]!.createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
    messages: thread.messages.map((message, index) =>
      index === thread.messages.length - 1
        ? {
            ...message,
            turnId: activeTurnId,
            streaming: true,
          }
        : message,
    ),
    session: {
      ...thread.session!,
      status: "running",
      activeTurnId,
      updatedAt: thread.updatedAt,
    },
  };
}

function buildReasoningAndHiddenToolFixture(): OrchestrationThread {
  const thread = buildTestSnapshot().threads[0]!;

  return {
    ...thread,
    activities: [
      ...thread.activities,
      {
        id: EventId.makeUnsafe("activity-console-reasoning"),
        tone: "info",
        kind: "reasoning.text",
        summary: "Reasoning",
        payload: {
          streamKind: "reasoning_text",
          text: "Think through the timeline before rendering widgets.",
        },
        turnId: thread.latestTurn?.turnId ?? null,
        sequence: 10,
        createdAt: "2026-03-10T09:01:50.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-console-report-intent"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Report intent complete",
        payload: {
          itemId: "report-intent-1",
          title: "Report intent",
          status: "completed",
          data: {
            item: {
              id: "report-intent-1",
              input: {
                intent: "Tracing widgets",
              },
            },
          },
        },
        turnId: thread.latestTurn?.turnId ?? null,
        sequence: 11,
        createdAt: "2026-03-10T09:01:51.000Z",
      },
    ],
  };
}

function buildMergedToolFixture(): OrchestrationThread {
  const thread = buildTestSnapshot().threads[0]!;
  const runningTurnId = thread.messages[2]!.turnId!;

  return {
    ...thread,
    activities: [
      ...thread.activities.filter((activity) => activity.summary !== "Run checks complete"),
      {
        id: EventId.makeUnsafe("activity-console-tool-start"),
        tone: "tool",
        kind: "tool.started",
        summary: "Run checks started",
        payload: {
          itemId: "run-checks-1",
          itemType: "command_execution",
          title: "Run checks",
          status: "inProgress",
          data: {
            item: {
              id: "run-checks-1",
              input: {
                command: ["bun", "typecheck"],
              },
            },
          },
        },
        turnId: runningTurnId,
        sequence: 12,
        createdAt: "2026-03-10T09:01:02.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-console-tool-complete"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Run checks complete",
        payload: {
          itemId: "run-checks-1",
          itemType: "command_execution",
          title: "Run checks",
          status: "completed",
          data: {
            item: {
              id: "run-checks-1",
              input: {
                command: ["bun", "typecheck"],
              },
              result: {
                exitCode: 0,
                detailedContent: "8 packages successful in 6.5s",
              },
            },
          },
        },
        turnId: runningTurnId,
        sequence: 13,
        createdAt: "2026-03-10T09:01:07.000Z",
      },
    ],
  };
}
