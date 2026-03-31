import { describe, expect, it } from "vitest";

import { buildTestSnapshot } from "../testSupport/testSnapshot";
import { deriveTranscriptHistoryRows } from "./transcriptHistoryRows";
import {
  buildPreparedTranscriptLayout,
  getNextPreparedMeasurementBatch,
  partitionPreparedTranscriptChunks,
} from "./transcriptLayoutPreparation";
import { derivePreparedTranscriptBoundary } from "./transcriptLayoutCache";

describe("partitionPreparedTranscriptChunks", () => {
  it("partitions only the sealed prefix rows into bounded chunks", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const rows = deriveTranscriptHistoryRows(thread);
    const boundary = derivePreparedTranscriptBoundary(rows, thread);

    const chunks = partitionPreparedTranscriptChunks({
      rows,
      boundary,
      maxChunkRowCount: 2,
    });

    expect(chunks).toEqual([
      {
        chunkIndex: 0,
        startRowIndex: 0,
        rowIds: rows.slice(0, 2).map((row) => row.id),
      },
      {
        chunkIndex: 1,
        startRowIndex: 2,
        rowIds: rows.slice(2, 4).map((row) => row.id),
      },
      {
        chunkIndex: 2,
        startRowIndex: 4,
        rowIds: rows.slice(4, 5).map((row) => row.id),
      },
    ]);
  });
});

describe("buildPreparedTranscriptLayout", () => {
  it("assembles chunk totals and sealed row heights from measured geometry", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const rows = deriveTranscriptHistoryRows(thread);
    const boundary = derivePreparedTranscriptBoundary(rows, thread);
    const sealedRows = rows.slice(0, boundary.firstLiveRowIndex);
    const rowHeightById = new Map(sealedRows.map((row, index) => [row.id, 100 + (index * 10)]));

    const layout = buildPreparedTranscriptLayout({
      thread,
      rows,
      widthPx: 574.5,
      rowHeightById,
      maxChunkRowCount: 2,
    });

    expect(layout.boundary).toEqual(boundary);
    expect(layout.chunks.map((chunk) => chunk.totalHeightPx)).toEqual([210, 250, 140]);
    expect(layout.totalSealedHeightPx).toBe(600);
    expect(Array.from(layout.rowHeightById.entries())).toEqual(Array.from(rowHeightById.entries()));
    expect(Array.from(layout.rowStartById.entries())).toEqual([
      [sealedRows[0]!.id, 0],
      [sealedRows[1]!.id, 100],
      [sealedRows[2]!.id, 210],
      [sealedRows[3]!.id, 330],
      [sealedRows[4]!.id, 460],
    ]);
  });

  it("fails when a sealed row height is missing", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const rows = deriveTranscriptHistoryRows(thread);
    const boundary = derivePreparedTranscriptBoundary(rows, thread);
    const sealedRows = rows.slice(0, boundary.firstLiveRowIndex);
    const rowHeightById = new Map(sealedRows.slice(1).map((row) => [row.id, 120]));

    expect(() => buildPreparedTranscriptLayout({
      thread,
      rows,
      widthPx: 574.5,
      rowHeightById,
    })).toThrow(`Prepared transcript layout is missing a measured height for row "${sealedRows[0]!.id}".`);
  });
});

describe("getNextPreparedMeasurementBatch", () => {
  it("returns the first incomplete sealed chunk as the next measurement batch", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const rows = deriveTranscriptHistoryRows(thread);
    const boundary = derivePreparedTranscriptBoundary(rows, thread);
    const sealedRows = rows.slice(0, boundary.firstLiveRowIndex);
    const rowHeightById = new Map([
      [sealedRows[0]!.id, 100],
      [sealedRows[1]!.id, 110],
    ]);

    const batch = getNextPreparedMeasurementBatch({
      rows,
      boundary,
      rowHeightById,
      maxChunkRowCount: 2,
    });

    expect(batch.map((entry) => entry.row.id)).toEqual(sealedRows.slice(2, 4).map((row) => row.id));
    expect(batch.map((entry) => entry.index)).toEqual([2, 3]);
  });
});
