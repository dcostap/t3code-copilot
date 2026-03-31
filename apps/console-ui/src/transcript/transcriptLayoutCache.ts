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

export interface PreparedTranscriptLayoutStateRowIds {
  readonly expandedToolRowIds: ReadonlyArray<string>;
  readonly collapsedCheckpointRowIds: ReadonlyArray<string>;
  readonly readyCheckpointDiffRowIds: ReadonlyArray<string>;
}

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
  const stateRowIds = collectPreparedTranscriptLayoutStateRowIds(input);

  return hashTranscriptLayoutToken([
    `expanded:${stateRowIds.expandedToolRowIds.join(",")}`,
    `collapsed:${stateRowIds.collapsedCheckpointRowIds.join(",")}`,
    `checkpointDiff:${stateRowIds.readyCheckpointDiffRowIds.join(",")}`,
  ].join("|"));
}

export function collectPreparedTranscriptLayoutStateRowIds(
  input: PreparedTranscriptLayoutStateInput | undefined,
): PreparedTranscriptLayoutStateRowIds {
  return {
    expandedToolRowIds: Array.from(input?.expandedToolRowIds ?? []).toSorted(),
    collapsedCheckpointRowIds: Array.from(input?.collapsedCheckpointRowIds ?? []).toSorted(),
    readyCheckpointDiffRowIds: Array.from(input?.checkpointDiffByRowId?.entries() ?? [])
      .filter(([, state]) => state.status === "ready" && typeof state.diff === "string" && state.diff.length > 0)
      .map(([rowId]) => rowId)
      .toSorted(),
  };
}

export function getChangedPreparedTranscriptLayoutStateRowIds(
  previous: PreparedTranscriptLayoutStateRowIds | undefined,
  next: PreparedTranscriptLayoutStateRowIds,
): ReadonlySet<string> {
  const changedRowIds = new Set<string>();
  addSymmetricDifference(previous?.expandedToolRowIds, next.expandedToolRowIds, changedRowIds);
  addSymmetricDifference(previous?.collapsedCheckpointRowIds, next.collapsedCheckpointRowIds, changedRowIds);
  addSymmetricDifference(previous?.readyCheckpointDiffRowIds, next.readyCheckpointDiffRowIds, changedRowIds);
  return changedRowIds;
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

function addSymmetricDifference(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string>,
  target: Set<string>,
) {
  const previousSet = new Set(previous ?? []);
  const nextSet = new Set(next);
  for (const rowId of previousSet) {
    if (!nextSet.has(rowId)) {
      target.add(rowId);
    }
  }
  for (const rowId of nextSet) {
    if (!previousSet.has(rowId)) {
      target.add(rowId);
    }
  }
}

function roundToQuantum(value: number, quantum: number) {
  return Number((Math.round(value / quantum) * quantum).toFixed(3));
}
