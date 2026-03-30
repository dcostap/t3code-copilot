import type { TranscriptMarkdownTable } from "./transcriptMessageFormatting";
import { parseTranscriptMessageBlocks } from "./transcriptMessageFormatting";
import {
  getActivityDetail,
  getToolDisplaySubject,
  TRANSCRIPT_HISTORY_ROW_GAP_PX,
  type TranscriptHistoryRow,
} from "./transcriptHistoryRows";

// Gap between segments within a single row (matches `.transcript-historyRow { gap: 6px }`)
const HISTORY_ROW_GAP_PX = 6;

// Chrome (padding/borders/structural elements beyond the text content) per row kind.
// Derived from CSS:
//   - message rows: no padding-top → 0px chrome
//   - non-message, non-widget rows (reasoning, activity-group, plan, working):
//       `.transcript-historyRow--<kind> { padding-top: 2px }` → 2px chrome
//   - widget rows (tool, checkpoint):
//       2px row padding-top
//       + 5px+5px `.transcript-blockHistory__commandWidgetSurface { padding: 5px 0 }`
//       + 1px+1px `.transcript-blockHistory__commandWidgetContent { padding: 1px 0 }`
//       = 14px chrome
const HISTORY_MESSAGE_CHROME_PX = 0;
const HISTORY_BASIC_CHROME_PX = 2;
const HISTORY_WIDGET_CHROME_PX = 14;
const HISTORY_TEXT_LINE_HEIGHT_PX = 20;
const HISTORY_REASONING_LINE_HEIGHT_PX = 24;
const HISTORY_WIDGET_LINE_HEIGHT_PX = 18;
const HISTORY_TABLE_ROW_HEIGHT_PX = 26;
const HISTORY_TABLE_CELL_HORIZONTAL_PADDING_PX = 20;
const HISTORY_TABLE_CELL_MIN_WIDTH_PX = 96;
const HISTORY_TABLE_MAX_WIDTH_PX = 448;
const HISTORY_TABLE_AVG_CHAR_WIDTH_PX = 6.9;
const HISTORY_MIN_CHARS_PER_LINE = 24;
const HISTORY_MAX_CHARS_PER_LINE = 120;
const HISTORY_AVG_CHAR_WIDTH_PX = 8.6;

export interface TranscriptHistoryLayoutRowOptions {
  readonly widthPx?: number | null;
  readonly expandedToolRowIds?: ReadonlySet<string>;
  readonly collapsedCheckpointRowIds?: ReadonlySet<string>;
  readonly checkpointDiffByRowId?: ReadonlyMap<string, {
    readonly status: "loading" | "ready" | "error";
    readonly diff?: string;
    readonly errorMessage?: string;
  }>;
}

export type TranscriptHistoryLayoutSegment =
  | {
      readonly kind: "lines";
      readonly lines: ReadonlyArray<string>;
      readonly lineHeightPx: number;
      readonly gapPx: number;
    }
  | {
      readonly kind: "table";
      readonly table: TranscriptMarkdownTable;
      readonly rowHeightsPx: ReadonlyArray<number>;
    };

export interface TranscriptHistoryLayoutRow {
  readonly id: string;
  readonly kind: TranscriptHistoryRow["kind"];
  readonly heightPx: number;
  readonly segments: ReadonlyArray<TranscriptHistoryLayoutSegment>;
}

export function deriveTranscriptHistoryLayoutRow(
  row: TranscriptHistoryRow,
  options: TranscriptHistoryLayoutRowOptions = {},
): TranscriptHistoryLayoutRow {
  const segments = (() => {
    switch (row.kind) {
      case "message":
        return deriveMessageSegments(row, options.widthPx);
      case "reasoning":
        return [
          {
            kind: "lines" as const,
            lines: wrapTextToVisualLines(row.reasoning.text, options.widthPx),
            lineHeightPx:
              row.reasoning.variant === "summary"
                ? HISTORY_REASONING_LINE_HEIGHT_PX
                : HISTORY_REASONING_LINE_HEIGHT_PX,
            gapPx: 2,
          },
        ];
      case "activity-group":
        return [
          {
            kind: "lines" as const,
            lines: row.activities.flatMap((activity) => {
              const detail = getActivityDetail(activity);
              return [
                `[${activity.tone}] ${activity.summary}`,
                ...(detail ? wrapTextToVisualLines(detail, options.widthPx) : []),
              ];
            }),
            lineHeightPx: HISTORY_TEXT_LINE_HEIGHT_PX,
            gapPx: 2,
          },
        ];
      case "plan":
        return [
          {
            kind: "lines" as const,
            lines: wrapTextToVisualLines(row.plan.planMarkdown, options.widthPx),
            lineHeightPx: HISTORY_TEXT_LINE_HEIGHT_PX,
            gapPx: 2,
          },
        ];
      case "tool":
        return deriveToolSegments(row, options);
      case "checkpoint":
        return deriveCheckpointSegments(row, options);
      case "working":
        return [
          {
            kind: "lines" as const,
            lines: [row.label ? `${row.label}...` : "Waiting for the next transcript update..."],
            lineHeightPx: HISTORY_TEXT_LINE_HEIGHT_PX,
            gapPx: 2,
          },
        ];
    }
  })();

  const heightPx = segments.reduce((total, segment, index) => {
    const segmentHeight =
      segment.kind === "table"
        ? segment.rowHeightsPx.reduce((sum, rowHeight) => sum + rowHeight, 0)
        : getLinesHeight(segment.lines, segment.lineHeightPx, segment.gapPx);
    return total + segmentHeight + (index > 0 ? HISTORY_ROW_GAP_PX : 0);
  }, 0);

  return {
    id: row.id,
    kind: row.kind,
    heightPx,
    segments,
  };
}

function deriveMessageSegments(
  row: Extract<TranscriptHistoryRow, { readonly kind: "message" }>,
  widthPx?: number | null,
): ReadonlyArray<TranscriptHistoryLayoutSegment> {
  const segments: Array<TranscriptHistoryLayoutSegment> = [];

  for (const attachment of row.message.attachments ?? []) {
    segments.push({
      kind: "lines",
      lines: [`attachment: ${attachment.type}: ${attachment.name}`],
      lineHeightPx: HISTORY_TEXT_LINE_HEIGHT_PX,
      gapPx: 0,
    });
  }

  for (const block of parseTranscriptMessageBlocks(row.message.text)) {
    if (block.kind === "table") {
      segments.push({
        kind: "table",
        table: block.table,
        rowHeightsPx: deriveTableRowHeights(block.table, widthPx),
      });
      continue;
    }
    segments.push({
      kind: "lines",
      lines: wrapTextToVisualLines(block.text, widthPx),
      lineHeightPx: HISTORY_TEXT_LINE_HEIGHT_PX,
      gapPx: 2,
    });
  }

  return segments;
}

function deriveToolSegments(
  row: Extract<TranscriptHistoryRow, { readonly kind: "tool" }>,
  options: TranscriptHistoryLayoutRowOptions,
): ReadonlyArray<TranscriptHistoryLayoutSegment> {
  const segments: Array<TranscriptHistoryLayoutSegment> = [
    {
      kind: "lines",
      lines: wrapTextToVisualLines(
        [row.tool.title, getToolDisplaySubject(row.tool), row.tool.timingLabel ?? ""]
          .filter(Boolean)
          .join("  "),
        options.widthPx,
      ),
      lineHeightPx: HISTORY_WIDGET_LINE_HEIGHT_PX,
      gapPx: 0,
    },
  ];

  if (!options.expandedToolRowIds?.has(row.id)) {
    return segments;
  }

  for (const text of [
    row.tool.detail,
    row.tool.command,
    row.tool.changedFiles.length > 0 ? row.tool.changedFiles.join("\n") : null,
    row.tool.output,
    row.tool.inlineUnifiedDiff,
  ]) {
    if (!text) {
      continue;
    }
    segments.push({
      kind: "lines",
      lines: wrapTextToVisualLines(text, options.widthPx),
      lineHeightPx: HISTORY_WIDGET_LINE_HEIGHT_PX,
      gapPx: 2,
    });
  }

  return segments;
}

function deriveCheckpointSegments(
  row: Extract<TranscriptHistoryRow, { readonly kind: "checkpoint" }>,
  options: TranscriptHistoryLayoutRowOptions,
): ReadonlyArray<TranscriptHistoryLayoutSegment> {
  const segments: Array<TranscriptHistoryLayoutSegment> = [
    {
      kind: "lines",
      lines: [formatCheckpointSummary(row.checkpoint.files.length)],
      lineHeightPx: HISTORY_WIDGET_LINE_HEIGHT_PX,
      gapPx: 0,
    },
  ];

  if (options.collapsedCheckpointRowIds?.has(row.id)) {
    return segments;
  }

  if (row.checkpoint.files.length > 0) {
    segments.push({
      kind: "lines",
      lines: row.checkpoint.files.map((file) =>
        formatCheckpointFileSummary(file.path, file.additions, file.deletions),
      ),
      lineHeightPx: HISTORY_WIDGET_LINE_HEIGHT_PX,
      gapPx: 2,
    });
  }

  const diffState = options.checkpointDiffByRowId?.get(row.id);
  if (diffState?.status === "ready" && diffState.diff) {
    segments.push({
      kind: "lines",
      lines: wrapTextToVisualLines(diffState.diff, options.widthPx),
      lineHeightPx: HISTORY_WIDGET_LINE_HEIGHT_PX,
      gapPx: 0,
    });
  } else {
    segments.push({
      kind: "lines",
      lines: [diffState?.status === "error" ? diffState.errorMessage ?? "Failed to load diff." : "Loading diff…"],
      lineHeightPx: HISTORY_WIDGET_LINE_HEIGHT_PX,
      gapPx: 0,
    });
  }

  return segments;
}

function deriveTableRowHeights(
  table: TranscriptMarkdownTable,
  widthPx?: number | null,
): ReadonlyArray<number> {
  const columnCount = Math.max(table.headers.length, 1);
  const availableWidthPx = Math.max(
    Math.min(widthPx ?? HISTORY_TABLE_MAX_WIDTH_PX, HISTORY_TABLE_MAX_WIDTH_PX),
    160,
  );
  const estimatedColumnWidthPx = Math.max(
    Math.floor(availableWidthPx / columnCount) - HISTORY_TABLE_CELL_HORIZONTAL_PADDING_PX,
    HISTORY_TABLE_CELL_MIN_WIDTH_PX,
  );
  const charsPerLine = Math.max(
    12,
    Math.floor(estimatedColumnWidthPx / HISTORY_TABLE_AVG_CHAR_WIDTH_PX),
  );

  return [
    getTableRowHeight(table.headers, charsPerLine),
    ...table.rows.map((row) => getTableRowHeight(row, charsPerLine)),
  ];
}

function getTableRowHeight(cells: ReadonlyArray<string>, charsPerLine: number) {
  const lineCount = cells.reduce((maxLines, cell) => {
    const wrappedLines = wrapTextToVisualLines(cell, undefined, charsPerLine);
    return Math.max(maxLines, wrappedLines.length);
  }, 1);
  return lineCount * HISTORY_TABLE_ROW_HEIGHT_PX;
}

function wrapTextToVisualLines(
  text: string,
  widthPx?: number | null,
  overrideCharsPerLine?: number,
): ReadonlyArray<string> {
  const charsPerLine = overrideCharsPerLine ?? estimateCharactersPerLine(widthPx);
  const wrappedLines: Array<string> = [];

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) {
      wrappedLines.push("");
      continue;
    }

    let cursor = 0;
    while (cursor < rawLine.length) {
      wrappedLines.push(rawLine.slice(cursor, cursor + charsPerLine));
      cursor += charsPerLine;
    }
  }

  return wrappedLines;
}

function getLinesHeight(
  lines: ReadonlyArray<string>,
  lineHeightPx: number,
  gapPx: number,
) {
  if (lines.length === 0) {
    return lineHeightPx;
  }
  return (lines.length * lineHeightPx) + (Math.max(lines.length - 1, 0) * gapPx);
}

function estimateCharactersPerLine(widthPx?: number | null) {
  if (!widthPx || !Number.isFinite(widthPx)) {
    return 72;
  }

  const usableWidthPx = Math.max(widthPx - 44, 160);
  return Math.min(
    Math.max(Math.floor(usableWidthPx / HISTORY_AVG_CHAR_WIDTH_PX), HISTORY_MIN_CHARS_PER_LINE),
    HISTORY_MAX_CHARS_PER_LINE,
  );
}

function formatCheckpointSummary(fileCount: number) {
  return fileCount === 1 ? "1 file changed" : `${fileCount} files changed`;
}

function formatCheckpointFileSummary(path: string, additions: number, deletions: number) {
  return `${path} (+${additions} -${deletions})`;
}

/**
 * Returns a deterministic height estimate for a transcript history row that is
 * accurate enough to minimize virtualizer corrections during scroll. Uses the
 * layout model for content height and adds per-kind CSS chrome constants.
 *
 * Priority in TranscriptHistory.tsx estimateSize:
 *   1. premeasuredRowHeightById (actual DOM measurement via measurement lane) — most accurate
 *   2. this function — deterministic, accurate for content; replaces rough heuristic estimates
 *
 * Note: The role-separator line in message rows (+7px, conditional on adjacent roles) is not
 * modeled here. The measurement lane will correct for those rows.
 */
export function deriveTranscriptHistoryRowEstimatedHeight(
  row: TranscriptHistoryRow,
  options?: TranscriptHistoryLayoutRowOptions,
  rowIndex = 0,
): number {
  const layout = deriveTranscriptHistoryLayoutRow(row, options);
  const chrome =
    row.kind === "message"
      ? HISTORY_MESSAGE_CHROME_PX
      : row.kind === "tool" || row.kind === "checkpoint"
        ? HISTORY_WIDGET_CHROME_PX
        : HISTORY_BASIC_CHROME_PX;
  return layout.heightPx + chrome + (rowIndex > 0 ? TRANSCRIPT_HISTORY_ROW_GAP_PX : 0);
}
