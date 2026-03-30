import { describe, expect, it } from "vitest";

import type { OrchestrationThread } from "@t3tools/contracts";

import { buildTestSnapshot } from "../testSupport/testSnapshot";
import {
  ALWAYS_UNVIRTUALIZED_TAIL_ROWS,
  deriveTranscriptHistoryRows,
  getFirstUnvirtualizedRowIndex,
} from "./transcriptHistoryRows";
import { formatTranscriptHistoryRow } from "./TranscriptHistory";

describe("deriveTranscriptHistoryRows", () => {
  it("derives messages, grouped activities, and plans in timeline order", () => {
    const thread = buildTestSnapshot().threads[0]!;

    expect(deriveTranscriptHistoryRows(thread).map((row) => row.kind)).toEqual([
      "message",
      "activity-group",
      "message",
      "message",
      "activity-group",
      "plan",
      "activity-group",
      "message",
      "message",
      "activity-group",
      "message",
    ]);
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

    expect(getFirstUnvirtualizedRowIndex(rows, thread)).toBe(3);
  });
});

describe("formatTranscriptHistoryRow", () => {
  it("formats activity groups as plain text lines", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "activity-group");

    expect(row?.kind).toBe("activity-group");
    if (!row || row.kind !== "activity-group") {
      return;
    }

    const display = formatTranscriptHistoryRow(row);

    expect(display.label).toBe("activity");
    expect(display.lines[0]).toMatchObject({
      text: `[${row.activities[0]!.tone}] ${row.activities[0]!.summary}`,
    });
  });

  it("formats the working row as a simple status line", () => {
    const thread = buildRunningThreadFixture();
    const row = deriveTranscriptHistoryRows(thread).at(-1);

    expect(row?.kind).toBe("working");
    if (!row || row.kind !== "working") {
      return;
    }

    const display = formatTranscriptHistoryRow(row);

    expect(display).toMatchObject({
      label: "working",
      lines: [{
        key: row.id,
        text: row.label ? `${row.label}...` : "Waiting for the next transcript update...",
        tone: "working",
      }],
    });
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
