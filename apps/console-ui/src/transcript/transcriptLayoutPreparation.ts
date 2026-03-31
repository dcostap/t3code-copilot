import type { OrchestrationThread } from "@t3tools/contracts";

import { createPreparedTranscriptLayoutKey, derivePreparedTranscriptBoundary } from "./transcriptLayoutCache";
import type {
  PreparedTranscriptBoundary,
  PreparedTranscriptChunk,
  PreparedTranscriptLayout,
  PreparedTranscriptLayoutStateInput,
} from "./transcriptLayoutTypes";
import type { TranscriptHistoryRow } from "./transcriptHistoryRows";

export const DEFAULT_PREPARED_TRANSCRIPT_CHUNK_ROW_COUNT = 24;

interface BuildPreparedTranscriptLayoutInput {
  readonly rows: ReadonlyArray<TranscriptHistoryRow>;
  readonly thread: OrchestrationThread | null;
  readonly widthPx: number;
  readonly rowHeightById: ReadonlyMap<string, number>;
  readonly maxChunkRowCount?: number;
  readonly tailRowCount?: number;
  readonly layoutVersion?: string;
  readonly typographyVersion?: string;
  readonly state?: PreparedTranscriptLayoutStateInput;
}

export function getNextPreparedMeasurementBatch(input: {
  readonly rows: ReadonlyArray<TranscriptHistoryRow>;
  readonly boundary: PreparedTranscriptBoundary;
  readonly rowHeightById: ReadonlyMap<string, number>;
  readonly maxChunkRowCount?: number;
}): ReadonlyArray<{ readonly index: number; readonly row: TranscriptHistoryRow }> {
  const chunks = partitionPreparedTranscriptChunks(input);
  const nextChunk = chunks.find((chunk) =>
    chunk.rowIds.some((rowId) => !hasPreparedTranscriptRowHeight(input.rowHeightById, rowId)),
  );
  if (!nextChunk) {
    return [];
  }

  return input.rows
    .slice(nextChunk.startRowIndex, nextChunk.startRowIndex + nextChunk.rowIds.length)
    .map((row, rowOffset) => ({
      index: nextChunk.startRowIndex + rowOffset,
      row,
    }));
}

export function partitionPreparedTranscriptChunks(input: {
  readonly rows: ReadonlyArray<TranscriptHistoryRow>;
  readonly boundary: PreparedTranscriptBoundary;
  readonly maxChunkRowCount?: number;
}): ReadonlyArray<Pick<PreparedTranscriptChunk, "chunkIndex" | "startRowIndex" | "rowIds">> {
  const maxChunkRowCount = normalizeChunkRowCount(input.maxChunkRowCount);
  const sealedRows = input.rows.slice(0, input.boundary.firstLiveRowIndex);
  const chunks: Array<Pick<PreparedTranscriptChunk, "chunkIndex" | "startRowIndex" | "rowIds">> = [];

  for (let startIndex = 0; startIndex < sealedRows.length; startIndex += maxChunkRowCount) {
    const chunkRows = sealedRows.slice(startIndex, startIndex + maxChunkRowCount);
    chunks.push({
      chunkIndex: chunks.length,
      startRowIndex: startIndex,
      rowIds: chunkRows.map((row) => row.id),
    });
  }

  return chunks;
}

export function buildPreparedTranscriptLayout(
  input: BuildPreparedTranscriptLayoutInput,
): PreparedTranscriptLayout {
  const boundary = derivePreparedTranscriptBoundary(input.rows, input.thread, input.tailRowCount);
  const chunkDescriptors = partitionPreparedTranscriptChunks({
    rows: input.rows,
    boundary,
    ...(input.maxChunkRowCount === undefined ? {} : { maxChunkRowCount: input.maxChunkRowCount }),
  });
  const chunks = chunkDescriptors.map((chunk) => {
    const rowHeightsPx = chunk.rowIds.map((rowId) => readPreparedTranscriptRowHeight(input.rowHeightById, rowId));
    return {
      chunkIndex: chunk.chunkIndex,
      startRowIndex: chunk.startRowIndex,
      rowIds: chunk.rowIds,
      rowHeightsPx,
      totalHeightPx: rowHeightsPx.reduce((total, heightPx) => total + heightPx, 0),
    } satisfies PreparedTranscriptChunk;
  });
  const totalSealedHeightPx = chunks.reduce((total, chunk) => total + chunk.totalHeightPx, 0);
  const sealedRowHeightById = new Map<string, number>();
  const sealedRowStartById = new Map<string, number>();
  let nextRowStartPx = 0;
  for (const chunk of chunks) {
    chunk.rowIds.forEach((rowId, index) => {
      const rowHeightPx = chunk.rowHeightsPx[index]!;
      sealedRowHeightById.set(rowId, rowHeightPx);
      sealedRowStartById.set(rowId, nextRowStartPx);
      nextRowStartPx += rowHeightPx;
    });
  }

  return {
    key: createPreparedTranscriptLayoutKey({
      rows: input.rows,
      thread: input.thread,
      widthPx: input.widthPx,
      ...(input.tailRowCount === undefined ? {} : { tailRowCount: input.tailRowCount }),
      ...(input.layoutVersion === undefined ? {} : { layoutVersion: input.layoutVersion }),
      ...(input.typographyVersion === undefined ? {} : { typographyVersion: input.typographyVersion }),
      ...(input.state === undefined ? {} : { state: input.state }),
    }),
    boundary,
    chunks,
    totalSealedHeightPx,
    rowHeightById: sealedRowHeightById,
    rowStartById: sealedRowStartById,
  };
}

function normalizeChunkRowCount(value: number | undefined) {
  if (!value || !Number.isFinite(value) || value < 1) {
    return DEFAULT_PREPARED_TRANSCRIPT_CHUNK_ROW_COUNT;
  }
  return Math.max(1, Math.floor(value));
}

function readPreparedTranscriptRowHeight(
  rowHeightById: ReadonlyMap<string, number>,
  rowId: string,
) {
  const heightPx = rowHeightById.get(rowId);
  if (!hasPreparedTranscriptRowHeight(rowHeightById, rowId)) {
    throw new Error(`Prepared transcript layout is missing a measured height for row "${rowId}".`);
  }
  return heightPx!;
}

function hasPreparedTranscriptRowHeight(
  rowHeightById: ReadonlyMap<string, number>,
  rowId: string,
) {
  const heightPx = rowHeightById.get(rowId);
  return Number.isFinite(heightPx) && heightPx !== undefined && heightPx > 0;
}
