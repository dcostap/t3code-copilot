import { describe, expect, it } from "vitest";

import type { OrchestrationThread } from "@t3tools/contracts";

import { buildTestSnapshot } from "../testSupport/testSnapshot";
import { deriveTranscriptHistoryRows } from "./transcriptHistoryRows";
import {
  createPreparedTranscriptLayoutKey,
  derivePreparedTranscriptBoundary,
} from "./transcriptLayoutCache";

describe("derivePreparedTranscriptBoundary", () => {
  it("splits sealed history from the live tail using the current transcript boundary", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const rows = deriveTranscriptHistoryRows(thread);

    const boundary = derivePreparedTranscriptBoundary(rows, thread);

    expect(boundary.firstLiveRowIndex).toBe(5);
    expect(boundary.sealedRowCount).toBe(5);
    expect(boundary.liveRowCount).toBe(rows.length - 5);
    expect(boundary.sealedRowIds).toEqual(rows.slice(0, 5).map((row) => row.id));
    expect(boundary.liveRowIds).toEqual(rows.slice(5).map((row) => row.id));
  });
});

describe("createPreparedTranscriptLayoutKey", () => {
  it("uses only the sealed prefix content in the prepared-layout row signature", () => {
    const baseThread = buildTestSnapshot().threads[0]!;
    const tailChangedThread = mutateMessageText(baseThread, baseThread.messages.length - 1, "Tail-only change");
    const sealedChangedThread = mutateMessageText(baseThread, 0, "Sealed change");

    const baseKey = createPreparedTranscriptLayoutKey({
      thread: baseThread,
      rows: deriveTranscriptHistoryRows(baseThread),
      widthPx: 574.5,
    });
    const tailChangedKey = createPreparedTranscriptLayoutKey({
      thread: tailChangedThread,
      rows: deriveTranscriptHistoryRows(tailChangedThread),
      widthPx: 574.5,
    });
    const sealedChangedKey = createPreparedTranscriptLayoutKey({
      thread: sealedChangedThread,
      rows: deriveTranscriptHistoryRows(sealedChangedThread),
      widthPx: 574.5,
    });

    expect(tailChangedKey.rowSignature).toBe(baseKey.rowSignature);
    expect(sealedChangedKey.rowSignature).not.toBe(baseKey.rowSignature);
  });

  it("changes the cache key when width or sealed interactive state changes", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const rows = deriveTranscriptHistoryRows(thread);
    const sealedToolRow = rows.find((row, index) => index < 5 && row.kind === "tool");
    const sealedCheckpointRow = rows.find((row, index) => index < 5 && row.kind === "checkpoint");

    expect(sealedToolRow?.kind).toBe("tool");
    expect(sealedCheckpointRow?.kind).toBe("checkpoint");
    if (!sealedToolRow || sealedToolRow.kind !== "tool" || !sealedCheckpointRow || sealedCheckpointRow.kind !== "checkpoint") {
      return;
    }

    const baseKey = createPreparedTranscriptLayoutKey({
      thread,
      rows,
      widthPx: 574.5,
    });
    const widthChangedKey = createPreparedTranscriptLayoutKey({
      thread,
      rows,
      widthPx: 575,
    });
    const stateChangedKey = createPreparedTranscriptLayoutKey({
      thread,
      rows,
      widthPx: 574.5,
      state: {
        expandedToolRowIds: new Set([sealedToolRow.id]),
        collapsedCheckpointRowIds: new Set([sealedCheckpointRow.id]),
      },
    });

    expect(widthChangedKey.key).not.toBe(baseKey.key);
    expect(stateChangedKey.key).not.toBe(baseKey.key);
  });

  it("rejects missing or invalid widths", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const rows = deriveTranscriptHistoryRows(thread);

    expect(() => createPreparedTranscriptLayoutKey({
      thread,
      rows,
      widthPx: Number.NaN,
    })).toThrow("Prepared transcript layout requires a finite positive width.");
  });
});

function mutateMessageText(
  thread: OrchestrationThread,
  messageIndex: number,
  text: string,
): OrchestrationThread {
  return {
    ...thread,
    messages: thread.messages.map((message, index) =>
      index === messageIndex
        ? {
            ...message,
            text,
          }
        : message,
    ),
  };
}
