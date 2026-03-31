import type { OrchestrationThread } from "@t3tools/contracts";

import {
  getActivityDetail,
  getFirstUnvirtualizedRowIndex,
  type TranscriptHistoryRow,
} from "./transcriptHistoryRows";
import {
  PREPARED_TRANSCRIPT_LAYOUT_VERSION,
  PREPARED_TRANSCRIPT_TYPOGRAPHY_VERSION,
  TRANSCRIPT_LAYOUT_WIDTH_QUANTUM_PX,
  type PreparedTranscriptBoundary,
  type PreparedTranscriptLayoutKey,
  type PreparedTranscriptLayoutStateInput,
} from "./transcriptLayoutTypes";

interface CreatePreparedTranscriptLayoutKeyInput {
  readonly rows: ReadonlyArray<TranscriptHistoryRow>;
  readonly thread: OrchestrationThread | null;
  readonly widthPx: number;
  readonly tailRowCount?: number;
  readonly layoutVersion?: string;
  readonly typographyVersion?: string;
  readonly state?: PreparedTranscriptLayoutStateInput;
}

export function derivePreparedTranscriptBoundary(
  rows: ReadonlyArray<TranscriptHistoryRow>,
  thread: OrchestrationThread | null,
  tailRowCount?: number,
): PreparedTranscriptBoundary {
  const firstLiveRowIndex = getFirstUnvirtualizedRowIndex(rows, thread, tailRowCount);
  const sealedRows = rows.slice(0, firstLiveRowIndex);
  const liveRows = rows.slice(firstLiveRowIndex);

  return {
    firstLiveRowIndex,
    sealedRowCount: sealedRows.length,
    liveRowCount: liveRows.length,
    sealedRowIds: sealedRows.map((row) => row.id),
    liveRowIds: liveRows.map((row) => row.id),
  };
}

export function normalizePreparedTranscriptWidthPx(widthPx: number) {
  if (!Number.isFinite(widthPx) || widthPx <= 0) {
    throw new Error("Prepared transcript layout requires a finite positive width.");
  }

  return roundToQuantum(widthPx, TRANSCRIPT_LAYOUT_WIDTH_QUANTUM_PX);
}

export function createPreparedTranscriptLayoutStateSignature(
  input: PreparedTranscriptLayoutStateInput | undefined,
) {
  const expandedToolRowIds = Array.from(input?.expandedToolRowIds ?? []).toSorted();
  const collapsedCheckpointRowIds = Array.from(input?.collapsedCheckpointRowIds ?? []).toSorted();
  const readyCheckpointDiffRowIds = Array.from(input?.checkpointDiffByRowId?.entries() ?? [])
    .filter(([, state]) => state.status === "ready" && typeof state.diff === "string" && state.diff.length > 0)
    .map(([rowId]) => rowId)
    .toSorted();

  return hashTranscriptLayoutToken([
    `expanded:${expandedToolRowIds.join(",")}`,
    `collapsed:${collapsedCheckpointRowIds.join(",")}`,
    `checkpointDiff:${readyCheckpointDiffRowIds.join(",")}`,
  ].join("|"));
}

export function createPreparedTranscriptLayoutKey(
  input: CreatePreparedTranscriptLayoutKeyInput,
): PreparedTranscriptLayoutKey {
  const widthPx = normalizePreparedTranscriptWidthPx(input.widthPx);
  const boundary = derivePreparedTranscriptBoundary(input.rows, input.thread, input.tailRowCount);
  const sealedRows = input.rows.slice(0, boundary.firstLiveRowIndex);
  const threadId = input.thread?.id ?? "no-thread";
  const layoutVersion = input.layoutVersion ?? PREPARED_TRANSCRIPT_LAYOUT_VERSION;
  const typographyVersion = input.typographyVersion ?? PREPARED_TRANSCRIPT_TYPOGRAPHY_VERSION;
  const rowSignature = hashTranscriptLayoutToken(
    sealedRows.map((row) => getTranscriptRowLayoutToken(row)).join("\u001f"),
  );
  const stateSignature = createPreparedTranscriptLayoutStateSignature(input.state);
  const key = [
    "prepared-transcript",
    `thread:${threadId}`,
    `width:${widthPx}`,
    `layout:${layoutVersion}`,
    `type:${typographyVersion}`,
    `rows:${rowSignature}`,
    `state:${stateSignature}`,
    `sealed:${boundary.sealedRowCount}`,
    `live:${boundary.liveRowCount}`,
  ].join("|");

  return {
    threadId,
    widthPx,
    layoutVersion,
    typographyVersion,
    rowSignature,
    stateSignature,
    sealedRowCount: boundary.sealedRowCount,
    liveRowCount: boundary.liveRowCount,
    key,
  };
}

function getTranscriptRowLayoutToken(row: TranscriptHistoryRow) {
  switch (row.kind) {
    case "message":
      return [
        row.kind,
        row.id,
        row.createdAt,
        row.turnId ?? "",
        row.message.role,
        row.message.text,
        JSON.stringify(row.message.attachments ?? []),
      ].join("|");

    case "reasoning":
      return [
        row.kind,
        row.id,
        row.createdAt,
        row.turnId ?? "",
        row.reasoning.variant,
        row.reasoning.text,
      ].join("|");

    case "tool":
      return [
        row.kind,
        row.id,
        row.createdAt,
        row.turnId ?? "",
        row.tool.mergeKey,
        row.tool.title,
        row.tool.status,
        row.tool.itemKind,
        row.tool.detail ?? "",
        row.tool.command ?? "",
        row.tool.output ?? "",
        row.tool.changedFiles.join("\n"),
        row.tool.inlineUnifiedDiff ?? "",
        row.tool.timingLabel ?? "",
        row.tool.exitCode ?? "",
      ].join("|");

    case "activity-group":
      return [
        row.kind,
        row.id,
        row.createdAt,
        row.turnId ?? "",
        row.activities.map((activity) => [
          activity.id,
          activity.createdAt,
          activity.turnId ?? "",
          activity.kind,
          activity.tone,
          activity.summary,
          getActivityDetail(activity) ?? "",
        ].join("~")).join("^"),
      ].join("|");

    case "plan":
      return [
        row.kind,
        row.id,
        row.createdAt,
        row.turnId ?? "",
        JSON.stringify(row.plan),
      ].join("|");

    case "checkpoint":
      return [
        row.kind,
        row.id,
        row.createdAt,
        row.turnId,
        row.checkpoint.checkpointTurnCount,
        row.checkpoint.files.map((file) => `${file.path}:${file.additions}:${file.deletions}`).join("^"),
      ].join("|");

    case "working":
      return [
        row.kind,
        row.id,
        row.createdAt ?? "",
        row.turnId ?? "",
        row.label ?? "",
      ].join("|");
  }
}

function hashTranscriptLayoutToken(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function roundToQuantum(value: number, quantum: number) {
  return Number((Math.round(value / quantum) * quantum).toFixed(3));
}
