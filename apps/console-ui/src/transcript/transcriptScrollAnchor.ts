export type TranscriptScrollAnchor =
  | {
      readonly kind: "bottom";
      readonly offsetFromBottomPx: number;
    }
  | {
      readonly kind: "row";
      readonly rowId: string;
      readonly offsetWithinRowPx: number;
      readonly rowHeightPx: number;
    };

export function createBottomTranscriptScrollAnchor(offsetFromBottomPx: number): TranscriptScrollAnchor {
  return {
    kind: "bottom",
    offsetFromBottomPx: normalizeNonNegative(offsetFromBottomPx),
  };
}

export function createRowTranscriptScrollAnchor(input: {
  readonly rowId: string;
  readonly offsetWithinRowPx: number;
  readonly rowHeightPx: number;
}): TranscriptScrollAnchor {
  const rowHeightPx = normalizeNonNegative(input.rowHeightPx);
  return {
    kind: "row",
    rowId: input.rowId,
    rowHeightPx,
    offsetWithinRowPx: clamp(input.offsetWithinRowPx, 0, rowHeightPx),
  };
}

export function restoreTranscriptScrollOffset(input: {
  readonly anchor: TranscriptScrollAnchor;
  readonly rowStartById: ReadonlyMap<string, number>;
  readonly rowHeightById: ReadonlyMap<string, number>;
  readonly totalHeightPx: number;
  readonly viewportHeightPx: number;
}) {
  const maxScrollOffset = Math.max(input.totalHeightPx - input.viewportHeightPx, 0);

  if (input.anchor.kind === "bottom") {
    return clamp(
      input.totalHeightPx - input.viewportHeightPx - input.anchor.offsetFromBottomPx,
      0,
      maxScrollOffset,
    );
  }

  const rowStartPx = input.rowStartById.get(input.anchor.rowId);
  if (rowStartPx === undefined) {
    return null;
  }

  const measuredRowHeightPx = input.rowHeightById.get(input.anchor.rowId);
  const rowHeightPx = measuredRowHeightPx === undefined
    ? input.anchor.rowHeightPx
    : normalizeNonNegative(measuredRowHeightPx);
  const offsetWithinRowPx = clamp(input.anchor.offsetWithinRowPx, 0, rowHeightPx);

  return clamp(rowStartPx + offsetWithinRowPx, 0, maxScrollOffset);
}

function normalizeNonNegative(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
