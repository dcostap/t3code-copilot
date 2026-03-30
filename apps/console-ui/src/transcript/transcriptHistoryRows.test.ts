import { describe, expect, it } from "vitest";

import type { OrchestrationThread } from "@t3tools/contracts";

import { buildTestSnapshot } from "../testSupport/testSnapshot";
import {
  ALWAYS_UNVIRTUALIZED_TAIL_ROWS,
  deriveTranscriptHistoryRows,
  getFirstUnvirtualizedRowIndex,
} from "./transcriptHistoryRows";

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
