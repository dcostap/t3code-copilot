import type { TranscriptHistoryRow } from "./transcriptHistoryRows";

export const PREPARED_TRANSCRIPT_LAYOUT_VERSION = "prepared-transcript-v1";
export const PREPARED_TRANSCRIPT_TYPOGRAPHY_VERSION = "console-ui-default";
export const TRANSCRIPT_LAYOUT_WIDTH_QUANTUM_PX = 0.5;

export interface PreparedTranscriptBoundary {
  readonly firstLiveRowIndex: number;
  readonly sealedRowCount: number;
  readonly liveRowCount: number;
  readonly sealedRowIds: ReadonlyArray<string>;
  readonly liveRowIds: ReadonlyArray<string>;
}

export interface PreparedTranscriptLayoutStateInput {
  readonly expandedToolRowIds?: ReadonlySet<string>;
  readonly collapsedCheckpointRowIds?: ReadonlySet<string>;
  readonly checkpointDiffByRowId?: ReadonlyMap<string, {
    readonly status: "loading" | "ready" | "error";
    readonly diff?: string;
  }>;
}

export interface PreparedTranscriptLayoutKey {
  readonly threadId: string;
  readonly widthPx: number;
  readonly layoutVersion: string;
  readonly typographyVersion: string;
  readonly rowSignature: string;
  readonly stateSignature: string;
  readonly sealedRowCount: number;
  readonly liveRowCount: number;
  readonly key: string;
}

export interface PreparedTranscriptChunk {
  readonly chunkIndex: number;
  readonly startRowIndex: number;
  readonly rowIds: ReadonlyArray<string>;
  readonly rowHeightsPx: ReadonlyArray<number>;
  readonly totalHeightPx: number;
}

export interface PreparedTranscriptLayout {
  readonly key: PreparedTranscriptLayoutKey;
  readonly boundary: PreparedTranscriptBoundary;
  readonly chunks: ReadonlyArray<PreparedTranscriptChunk>;
  readonly totalSealedHeightPx: number;
  readonly rowHeightById: ReadonlyMap<string, number>;
  readonly rowStartById: ReadonlyMap<string, number>;
}

export interface PreparedTranscriptRowLayout {
  readonly row: TranscriptHistoryRow;
  readonly heightPx: number;
  readonly startOffsetPx: number;
}
