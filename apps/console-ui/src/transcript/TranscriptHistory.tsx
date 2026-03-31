import type { ChatAttachment, OrchestrationThread } from "@t3tools/contracts";
import { measureElement, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  deriveTranscriptHistoryRows,
  estimateTranscriptHistoryRowHeight,
  getActivityDetail,
  getToolDisplaySubject,
  type TranscriptHistoryRow,
} from "./transcriptHistoryRows";
import {
  collectPreparedTranscriptLayoutStateRowIds,
  createPreparedTranscriptLayoutKey,
  derivePreparedTranscriptBoundary,
  getChangedPreparedTranscriptLayoutStateRowIds,
} from "./transcriptLayoutCache";
import {
  buildPreparedTranscriptLayout,
  getNextPreparedMeasurementBatch,
} from "./transcriptLayoutPreparation";
import {
  createBottomTranscriptScrollAnchor,
  createRowTranscriptScrollAnchor,
  restoreTranscriptScrollOffset,
  type TranscriptScrollAnchor,
} from "./transcriptScrollAnchor";
import {
  installTranscriptMeasurementDiagnosticsHelpers,
  recordTranscriptMeasurementDiagnostic,
} from "./transcriptMeasurementDiagnostics";
import {
  installTranscriptPreparedHistoryDiagnosticsHelpers,
  recordTranscriptPreparedHistoryDiagnostic,
} from "./transcriptPreparedHistoryDiagnostics";
import {
  parseTranscriptMessageBlocks,
  tokenizeTranscriptLinks,
  type TranscriptMarkdownTable,
} from "./transcriptMessageFormatting";

const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 120;
const PREPARED_TRANSCRIPT_HISTORY_ENABLED = true;

interface TranscriptHistoryProps {
  readonly getTurnDiff: ((input: {
    readonly threadId: OrchestrationThread["id"];
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }) => Promise<string>) | undefined;
  readonly projectRoot: string | null | undefined;
  readonly thread: OrchestrationThread | null;
  readonly initialScrollOffsetFromBottom: number | null | undefined;
  readonly onScrollOffsetFromBottomChange: ((offsetFromBottom: number) => void) | undefined;
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
}

export const TranscriptHistory = memo(function TranscriptHistory({
  getTurnDiff,
  projectRoot,
  thread,
  initialScrollOffsetFromBottom,
  onScrollOffsetFromBottomChange,
  scrollContainerRef,
}: TranscriptHistoryProps) {
  const rows = useMemo(() => deriveTranscriptHistoryRows(thread), [thread]);
  const historyRootRef = useRef<HTMLDivElement | null>(null);
  const virtualCanvasRef = useRef<HTMLDivElement | null>(null);
  const [historyWidthPx, setHistoryWidthPx] = useState<number | null>(null);
  const [expandedToolRowIds, setExpandedToolRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedCheckpointRowIds, setCollapsedCheckpointRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const [checkpointDiffByRowId, setCheckpointDiffByRowId] = useState<ReadonlyMap<string, {
    readonly status: "loading" | "ready" | "error";
    readonly diff?: string;
    readonly errorMessage?: string;
  }>>(() => new Map());
  const firstUnvirtualizedRowIndex = useMemo(
    () => derivePreparedTranscriptBoundary(rows, thread).firstLiveRowIndex,
    [rows, thread],
  );
  const preparedBoundary = useMemo(
    () => derivePreparedTranscriptBoundary(rows, thread),
    [rows, thread],
  );
  const lastKnownOffsetFromBottomRef = useRef(0);
  const previousThreadIdRef = useRef<string | null>(null);
  const previousThreadUpdatedAtRef = useRef<string | null>(null);
  const previousPreparedLayoutKeyRef = useRef<string | null>(null);
  const preparedHistoryDiagnosticPhaseSignatureRef = useRef<string | null>(null);
  const pendingPreparedHistoryAnchorRef = useRef<TranscriptScrollAnchor | null>(null);
  const pendingPreparedHistoryBottomOffsetRef = useRef<number | null>(null);
  const previousPreparedStateRowIdsRef = useRef<ReturnType<typeof collectPreparedTranscriptLayoutStateRowIds> | null>(null);
  const premeasureRefs = useRef(new Map<string, HTMLDivElement>());
  const preparedLayoutRef = useRef<ReturnType<typeof buildPreparedTranscriptLayout> | null>(null);
  const premeasuredRowHeightByIdRef = useRef<ReadonlyMap<string, number>>(new Map());
  const [premeasuredRowHeightById, setPremeasuredRowHeightById] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [preparedHistoryPhase, setPreparedHistoryPhase] = useState<"idle" | "preparing" | "recalculating" | "ready">("idle");
  const [preparedMeasurementWidthPx, setPreparedMeasurementWidthPx] = useState<number | null>(null);
  const measurementDiagnosticSignatureByKeyRef = useRef(new Map<string, string>());
  const measurementOptions = useMemo(() => ({
    widthPx: historyWidthPx,
    expandedToolRowIds,
    collapsedCheckpointRowIds,
    checkpointDiffByRowId,
  }), [checkpointDiffByRowId, collapsedCheckpointRowIds, expandedToolRowIds, historyWidthPx]);
  const getEstimatedRowHeight = useCallback((row: TranscriptHistoryRow, index: number) =>
    estimateTranscriptHistoryRowHeight(row, measurementOptions, index), [measurementOptions]);
  const preparedStateRowIds = useMemo(() => collectPreparedTranscriptLayoutStateRowIds({
    expandedToolRowIds,
    collapsedCheckpointRowIds,
    checkpointDiffByRowId,
  }), [checkpointDiffByRowId, collapsedCheckpointRowIds, expandedToolRowIds]);
  const preparedLayoutCacheKey = useMemo(() => {
    if (
      !PREPARED_TRANSCRIPT_HISTORY_ENABLED
      || preparedMeasurementWidthPx === null
      || preparedBoundary.sealedRowCount === 0
      || preparedMeasurementWidthPx !== historyWidthPx
    ) {
      return null;
    }

    return createPreparedTranscriptLayoutKey({
      rows,
      thread,
      widthPx: preparedMeasurementWidthPx,
      state: {
        expandedToolRowIds,
        collapsedCheckpointRowIds,
        checkpointDiffByRowId,
      },
    }).key;
  }, [
    checkpointDiffByRowId,
    collapsedCheckpointRowIds,
    expandedToolRowIds,
    historyWidthPx,
    preparedMeasurementWidthPx,
    preparedBoundary.sealedRowCount,
    rows,
    thread,
  ]);
  const preparedLayout = useMemo(() => {
    if (
      !PREPARED_TRANSCRIPT_HISTORY_ENABLED
      || preparedMeasurementWidthPx === null
      || preparedBoundary.sealedRowCount === 0
      || preparedMeasurementWidthPx !== historyWidthPx
    ) {
      return null;
    }

    const nextBatch = getNextPreparedMeasurementBatch({
      rows,
      boundary: preparedBoundary,
      rowHeightById: premeasuredRowHeightById,
    });
    if (nextBatch.length > 0) {
      return null;
    }

    return buildPreparedTranscriptLayout({
      rows,
      thread,
      widthPx: preparedMeasurementWidthPx,
      rowHeightById: premeasuredRowHeightById,
      state: {
        expandedToolRowIds,
        collapsedCheckpointRowIds,
        checkpointDiffByRowId,
      },
    });
  }, [
    checkpointDiffByRowId,
    collapsedCheckpointRowIds,
    expandedToolRowIds,
    historyWidthPx,
    preparedMeasurementWidthPx,
    premeasuredRowHeightById,
    preparedBoundary,
    rows,
    thread,
  ]);
  useEffect(() => {
    preparedLayoutRef.current = preparedLayout;
  }, [preparedLayout]);
  useEffect(() => {
    premeasuredRowHeightByIdRef.current = premeasuredRowHeightById;
  }, [premeasuredRowHeightById]);
  const capturePreparedHistoryAnchor = useCallback(() => {
    const historyRoot = historyRootRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!historyRoot || !scrollContainer) {
      return;
    }

    pendingPreparedHistoryBottomOffsetRef.current = lastKnownOffsetFromBottomRef.current;

    if (lastKnownOffsetFromBottomRef.current <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX) {
      pendingPreparedHistoryAnchorRef.current = createBottomTranscriptScrollAnchor(
        lastKnownOffsetFromBottomRef.current,
      );
      recordTranscriptPreparedHistoryDiagnostic({
        kind: "anchor-capture",
        threadId: thread?.id ?? null,
        widthPx: historyWidthPx,
        anchorKind: "bottom",
        offsetPx: lastKnownOffsetFromBottomRef.current,
      });
      return;
    }

    const scrollContainerRect = scrollContainer.getBoundingClientRect();
    const rowElements = Array.from(historyRoot.querySelectorAll<HTMLDivElement>("[data-transcript-row-id]"));
    const anchorElement = rowElements.find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > scrollContainerRect.top && rect.top < scrollContainerRect.bottom;
    });
    const rowId = anchorElement?.dataset.transcriptRowId;
    if (!anchorElement || !rowId) {
      return;
    }

    const anchorRect = anchorElement.getBoundingClientRect();
    pendingPreparedHistoryAnchorRef.current = createRowTranscriptScrollAnchor({
      rowId,
      offsetWithinRowPx: Math.max(scrollContainerRect.top - anchorRect.top, 0),
      rowHeightPx: anchorRect.height,
    });
    recordTranscriptPreparedHistoryDiagnostic({
      kind: "anchor-capture",
      threadId: thread?.id ?? null,
      widthPx: historyWidthPx,
      anchorKind: "row",
      rowId,
      offsetPx: Math.max(scrollContainerRect.top - anchorRect.top, 0),
    });
  }, [historyWidthPx, scrollContainerRef, thread?.id]);
  const restorePreparedHistoryAnchor = useCallback((anchor: TranscriptScrollAnchor) => {
    const historyRoot = historyRootRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!historyRoot || !scrollContainer) {
      return;
    }

    if (anchor.kind === "bottom") {
      scrollContainer.scrollTop = Math.max(
        scrollContainer.scrollHeight - scrollContainer.clientHeight - anchor.offsetFromBottomPx,
        0,
      );
      recordTranscriptPreparedHistoryDiagnostic({
        kind: "anchor-restore",
        threadId: thread?.id ?? null,
        widthPx: historyWidthPx,
        outcome: "bottom",
      });
      pendingPreparedHistoryBottomOffsetRef.current = null;
      return;
    }

    const preparedLayoutForRestore = preparedLayoutRef.current;
    const virtualCanvas = virtualCanvasRef.current;
    const virtualCanvasOffsetTop = virtualCanvas?.offsetTop ?? 0;
    const preparedScrollOffset = preparedLayoutForRestore
      ? restoreTranscriptScrollOffset({
          anchor,
          rowStartById: preparedLayoutForRestore.rowStartById,
          rowHeightById: preparedLayoutForRestore.rowHeightById,
          totalHeightPx: Math.max(scrollContainer.scrollHeight - virtualCanvasOffsetTop, 0),
          viewportHeightPx: scrollContainer.clientHeight,
        })
      : null;
    if (preparedScrollOffset !== null) {
      scrollContainer.scrollTop = Math.min(
        Math.max(virtualCanvasOffsetTop + preparedScrollOffset, 0),
        Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 0),
      );
      recordTranscriptPreparedHistoryDiagnostic({
        kind: "anchor-restore",
        threadId: thread?.id ?? null,
        widthPx: historyWidthPx,
        outcome: "row-geometry",
        rowId: anchor.rowId,
      });
      pendingPreparedHistoryBottomOffsetRef.current = null;
      return;
    }

    const rowElement = Array.from(historyRoot.querySelectorAll<HTMLDivElement>("[data-transcript-row-id]"))
      .find((element) => element.dataset.transcriptRowId === anchor.rowId);
    if (!rowElement) {
      const bottomOffset = pendingPreparedHistoryBottomOffsetRef.current;
      if (bottomOffset !== null) {
        scrollContainer.scrollTop = Math.max(
          scrollContainer.scrollHeight - scrollContainer.clientHeight - bottomOffset,
          0,
        );
        recordTranscriptPreparedHistoryDiagnostic({
          kind: "anchor-restore",
          threadId: thread?.id ?? null,
          widthPx: historyWidthPx,
          outcome: "fallback-bottom",
          rowId: anchor.rowId,
        });
      } else {
        recordTranscriptPreparedHistoryDiagnostic({
          kind: "anchor-restore",
          threadId: thread?.id ?? null,
          widthPx: historyWidthPx,
          outcome: "miss",
          rowId: anchor.rowId,
        });
      }
      pendingPreparedHistoryBottomOffsetRef.current = null;
      return;
    }

    const scrollContainerRect = scrollContainer.getBoundingClientRect();
    const rowRect = rowElement.getBoundingClientRect();
    const desiredRowTop = scrollContainerRect.top - anchor.offsetWithinRowPx;
    scrollContainer.scrollTop += rowRect.top - desiredRowTop;
    recordTranscriptPreparedHistoryDiagnostic({
      kind: "anchor-restore",
      threadId: thread?.id ?? null,
      widthPx: historyWidthPx,
      outcome: "row-dom",
      rowId: anchor.rowId,
    });
    pendingPreparedHistoryBottomOffsetRef.current = null;
  }, [historyWidthPx, scrollContainerRef, thread?.id]);
  const maybeRecordMeasurementDiagnostic = useCallback((
    input: Parameters<typeof recordTranscriptMeasurementDiagnostic>[0],
  ) => {
    const signatureKey = `${input.comparisonKind}:${input.rowId}:${input.widthPx ?? "unknown"}`;
    const signatureValue = `${input.expectedHeight}:${input.actualHeight}`;
    const previousSignature = measurementDiagnosticSignatureByKeyRef.current.get(signatureKey);
    if (previousSignature === signatureValue) {
      return;
    }
    measurementDiagnosticSignatureByKeyRef.current.set(signatureKey, signatureValue);
    recordTranscriptMeasurementDiagnostic(input);
  }, []);
  const measureTranscriptRowElement = useCallback((
    element: HTMLDivElement,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
  ) => {
    const index = Number.parseInt(element.dataset.index ?? "", 10);
    if (!Number.isFinite(index)) {
      return Math.ceil(measureElement(element, entry, instance));
    }

    const row = rows[index];
    if (!row) {
      return Math.ceil(measureElement(element, entry, instance));
    }

    const preparedHeight = index < firstUnvirtualizedRowIndex
      ? preparedLayout?.rowHeightById.get(row.id)
      : undefined;
    if (typeof preparedHeight === "number") {
      return preparedHeight;
    }

    const measuredHeight = Math.ceil(measureElement(element, entry, instance));
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) {
      return measuredHeight;
    }

    maybeRecordMeasurementDiagnostic({
      comparisonKind: "estimate-to-visible",
      threadId: thread?.id ?? null,
      rowId: row.id,
      rowKind: row.kind,
      widthPx: historyWidthPx,
      expectedHeight: getEstimatedRowHeight(row, index),
      actualHeight: measuredHeight,
    });

    const premeasuredHeight = premeasuredRowHeightById.get(row.id);
    if (typeof premeasuredHeight === "number") {
      maybeRecordMeasurementDiagnostic({
        comparisonKind: "premeasure-to-visible",
        threadId: thread?.id ?? null,
        rowId: row.id,
        rowKind: row.kind,
        widthPx: historyWidthPx,
        expectedHeight: premeasuredHeight,
        actualHeight: measuredHeight,
      });
    }

    return measuredHeight;
  }, [
    firstUnvirtualizedRowIndex,
    getEstimatedRowHeight,
    historyWidthPx,
    maybeRecordMeasurementDiagnostic,
    preparedLayout,
    premeasuredRowHeightById,
    rows,
    thread?.id,
  ]);

  const rowVirtualizer = useVirtualizer({
    count: firstUnvirtualizedRowIndex,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => rows[index]?.id ?? index,
    estimateSize: (index) => {
      const row = rows[index];
      return row
        ? (preparedLayout?.rowHeightById.get(row.id)
          ?? (PREPARED_TRANSCRIPT_HISTORY_ENABLED && preparedMeasurementWidthPx !== historyWidthPx
            ? undefined
            : premeasuredRowHeightById.get(row.id))
          ?? getEstimatedRowHeight(row, index))
        : 80;
    },
    measureElement: measureTranscriptRowElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });

  useLayoutEffect(() => {
    const historyRoot = historyRootRef.current;
    if (!historyRoot) {
      return;
    }

    const updateWidth = (nextWidth: number) => {
      setHistoryWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(historyRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateWidth(historyRoot.getBoundingClientRect().width);
    });
    observer.observe(historyRoot);
    return () => {
      observer.disconnect();
    };
  }, [thread?.id]);

  const measureNow = useCallback(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer]);

  useLayoutEffect(() => {
    if (!PREPARED_TRANSCRIPT_HISTORY_ENABLED) {
      setPreparedMeasurementWidthPx(historyWidthPx);
      return;
    }
    if (historyWidthPx === null) {
      setPreparedMeasurementWidthPx(null);
      return;
    }

    setPreparedMeasurementWidthPx(historyWidthPx);
  }, [historyWidthPx]);

  useLayoutEffect(() => {
    measureNow();
  }, [checkpointDiffByRowId, collapsedCheckpointRowIds, expandedToolRowIds, measureNow]);

  useLayoutEffect(() => {
    measureNow();
  }, [firstUnvirtualizedRowIndex, measureNow, premeasuredRowHeightById, rows]);

  useEffect(() => {
    setExpandedToolRowIds(new Set());
    setCollapsedCheckpointRowIds(new Set());
    setCheckpointDiffByRowId(new Map());
    setPremeasuredRowHeightById(new Map());
    previousPreparedStateRowIdsRef.current = null;
  }, [thread?.id]);

  useLayoutEffect(() => {
    if (historyWidthPx === null) {
      return;
    }
    if (
      PREPARED_TRANSCRIPT_HISTORY_ENABLED
      && (preparedLayoutRef.current !== null || premeasuredRowHeightByIdRef.current.size > 0)
    ) {
      capturePreparedHistoryAnchor();
    }
    setPremeasuredRowHeightById((existing) => existing.size === 0 ? existing : new Map());
    measureNow();
  }, [capturePreparedHistoryAnchor, historyWidthPx, measureNow]);

  useLayoutEffect(() => {
    if (!PREPARED_TRANSCRIPT_HISTORY_ENABLED) {
      return;
    }
    if (preparedLayoutRef.current !== null || premeasuredRowHeightByIdRef.current.size > 0) {
      capturePreparedHistoryAnchor();
    }
    setPremeasuredRowHeightById((existing) => existing.size === 0 ? existing : new Map());
    measureNow();
  }, [capturePreparedHistoryAnchor, measureNow, preparedBoundary.firstLiveRowIndex, thread?.id]);

  useLayoutEffect(() => {
    if (!PREPARED_TRANSCRIPT_HISTORY_ENABLED) {
      previousPreparedStateRowIdsRef.current = preparedStateRowIds;
      return;
    }
    const previousPreparedStateRowIds = previousPreparedStateRowIdsRef.current ?? undefined;
    previousPreparedStateRowIdsRef.current = preparedStateRowIds;
    const changedPreparedStateRowIds = getChangedPreparedTranscriptLayoutStateRowIds(
      previousPreparedStateRowIds,
      preparedStateRowIds,
    );
    if (changedPreparedStateRowIds.size === 0) {
      return;
    }
    setPremeasuredRowHeightById((existing) => {
      if (existing.size === 0) {
        return existing;
      }
      let changed = false;
      const next = new Map(existing);
      for (const rowId of changedPreparedStateRowIds) {
        changed = next.delete(rowId) || changed;
      }
      return changed ? next : existing;
    });
    measureNow();
  }, [measureNow, preparedStateRowIds]);

  useEffect(() => {
    if (
      !PREPARED_TRANSCRIPT_HISTORY_ENABLED
      || historyWidthPx === null
      || preparedBoundary.sealedRowCount === 0
    ) {
      setPreparedHistoryPhase("idle");
      previousPreparedLayoutKeyRef.current = null;
      return;
    }

    if (preparedMeasurementWidthPx !== historyWidthPx) {
      setPreparedHistoryPhase("recalculating");
      return;
    }

    if (preparedLayout !== null) {
      setPreparedHistoryPhase("ready");
      previousPreparedLayoutKeyRef.current = preparedLayout.key.key;
      return;
    }

    const previousPreparedLayoutKey = previousPreparedLayoutKeyRef.current;
    setPreparedHistoryPhase(
      previousPreparedLayoutKey !== null && preparedLayoutCacheKey !== previousPreparedLayoutKey
        ? "recalculating"
        : "preparing",
    );
  }, [historyWidthPx, preparedBoundary.sealedRowCount, preparedLayout, preparedLayoutCacheKey, preparedMeasurementWidthPx]);
  useEffect(() => {
    if (!PREPARED_TRANSCRIPT_HISTORY_ENABLED) {
      return;
    }

    const signature = [
      preparedHistoryPhase,
      historyWidthPx ?? "unknown",
      preparedLayoutCacheKey ?? "none",
      preparedBoundary.sealedRowCount,
    ].join("|");
    if (preparedHistoryDiagnosticPhaseSignatureRef.current === signature) {
      return;
    }
    preparedHistoryDiagnosticPhaseSignatureRef.current = signature;
    recordTranscriptPreparedHistoryDiagnostic({
      kind: "phase",
      threadId: thread?.id ?? null,
      widthPx: historyWidthPx,
      phase: preparedHistoryPhase,
      preparedKey: preparedLayoutCacheKey,
      sealedRowCount: preparedBoundary.sealedRowCount,
    });
  }, [historyWidthPx, preparedBoundary.sealedRowCount, preparedHistoryPhase, preparedLayoutCacheKey, thread?.id]);

  useLayoutEffect(() => {
    if (!PREPARED_TRANSCRIPT_HISTORY_ENABLED || preparedLayout === null) {
      return;
    }

    const anchor = pendingPreparedHistoryAnchorRef.current;
    if (!anchor) {
      return;
    }

    restorePreparedHistoryAnchor(anchor);
    pendingPreparedHistoryAnchorRef.current = null;
  }, [preparedLayout, restorePreparedHistoryAnchor]);

  useEffect(() => {
    measurementDiagnosticSignatureByKeyRef.current.clear();
  }, [historyWidthPx, thread?.id]);

  useEffect(() => {
    installTranscriptMeasurementDiagnosticsHelpers({
      writeTextFile: window.desktopBridge?.writeTextFile,
    });
    installTranscriptPreparedHistoryDiagnosticsHelpers({
      writeTextFile: window.desktopBridge?.writeTextFile,
    });
  }, []);

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const scrollOffset = instance.scrollOffset ?? 0;
      return item.start < scrollOffset;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const updateOffsetFromBottom = () => {
      const offsetFromBottom = Math.max(
        scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
        0,
      );
      lastKnownOffsetFromBottomRef.current = offsetFromBottom;
      onScrollOffsetFromBottomChange?.(offsetFromBottom);
    };

    updateOffsetFromBottom();
    scrollContainer.addEventListener("scroll", updateOffsetFromBottom, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", updateOffsetFromBottom);
    };
  }, [onScrollOffsetFromBottomChange, scrollContainerRef, thread?.id]);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    if (previousThreadIdRef.current === thread?.id) {
      return;
    }
    previousThreadIdRef.current = thread?.id ?? null;

    const frame = requestAnimationFrame(() => {
      const offsetFromBottom = Math.max(initialScrollOffsetFromBottom ?? 0, 0);
      scrollContainer.scrollTop = Math.max(
        scrollContainer.scrollHeight - scrollContainer.clientHeight - offsetFromBottom,
        0,
      );
      lastKnownOffsetFromBottomRef.current = offsetFromBottom;
      onScrollOffsetFromBottomChange?.(offsetFromBottom);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [initialScrollOffsetFromBottom, onScrollOffsetFromBottomChange, scrollContainerRef, thread?.id]);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || !thread) {
      return;
    }

    if (previousThreadUpdatedAtRef.current === thread.updatedAt) {
      return;
    }
    previousThreadUpdatedAtRef.current = thread.updatedAt;

    if (lastKnownOffsetFromBottomRef.current > AUTO_FOLLOW_BOTTOM_THRESHOLD_PX) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      lastKnownOffsetFromBottomRef.current = 0;
      onScrollOffsetFromBottomChange?.(0);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [onScrollOffsetFromBottomChange, rows, scrollContainerRef, thread]);

  const toggleToolRow = useCallback((rowId: string) => {
    setExpandedToolRowIds((existing) => {
      const next = new Set(existing);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);

  const toggleCheckpointRow = useCallback((rowId: string) => {
    setCollapsedCheckpointRowIds((existing) => {
      const next = new Set(existing);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);

  const ensureCheckpointDiff = useCallback(async (row: Extract<TranscriptHistoryRow, { readonly kind: "checkpoint" }>) => {
    if (!getTurnDiff || checkpointDiffByRowId.has(row.id)) {
      return;
    }

    setCheckpointDiffByRowId((existing) => new Map(existing).set(row.id, { status: "loading" }));
    try {
      const diff = await getTurnDiff({
        threadId: thread!.id,
        fromTurnCount: Math.max(row.checkpoint.checkpointTurnCount - 1, 0),
        toTurnCount: row.checkpoint.checkpointTurnCount,
      });
      setCheckpointDiffByRowId((existing) => new Map(existing).set(row.id, { status: "ready", diff }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to load diff.";
      setCheckpointDiffByRowId((existing) => new Map(existing).set(row.id, { status: "error", errorMessage }));
    }
  }, [checkpointDiffByRowId, getTurnDiff, thread?.id]);

  const virtualItems = rowVirtualizer.getVirtualItems();
  const staticRows = rows.slice(firstUnvirtualizedRowIndex);
  const fallbackPremeasureRows = useMemo(() => {
    if (firstUnvirtualizedRowIndex <= 0 || virtualItems.length === 0) {
      return [];
    }

    const visibleIndexes = new Set(virtualItems.map((virtualItem) => virtualItem.index));
    const firstVisibleIndex = virtualItems[0]?.index ?? 0;
    const lastVisibleIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
    const candidates: Array<number> = [];

    for (let delta = 1; candidates.length < 12; delta += 1) {
      const nextAfter = lastVisibleIndex + delta;
      if (nextAfter < firstUnvirtualizedRowIndex && !visibleIndexes.has(nextAfter)) {
        candidates.push(nextAfter);
      }

      if (candidates.length >= 12) {
        break;
      }

      const nextBefore = firstVisibleIndex - delta;
      if (nextBefore >= 0 && !visibleIndexes.has(nextBefore)) {
        candidates.push(nextBefore);
      }

      if (nextAfter >= firstUnvirtualizedRowIndex && nextBefore < 0) {
        break;
      }
    }

    return candidates
      .toSorted((left, right) => left - right)
      .map((index) => {
        const row = rows[index];
        return row
          ? {
              index,
              row,
            }
          : null;
      })
      .filter((entry): entry is { readonly index: number; readonly row: TranscriptHistoryRow } => entry !== null);
  }, [firstUnvirtualizedRowIndex, rows, virtualItems]);
  const premeasureRows = useMemo(() => {
    if (!PREPARED_TRANSCRIPT_HISTORY_ENABLED) {
      return fallbackPremeasureRows;
    }
    if (preparedLayout !== null) {
      return [];
    }
    if (historyWidthPx === null || preparedMeasurementWidthPx !== historyWidthPx) {
      return fallbackPremeasureRows;
    }

    return getNextPreparedMeasurementBatch({
      rows,
      boundary: preparedBoundary,
      rowHeightById: premeasuredRowHeightById,
    });
  }, [fallbackPremeasureRows, historyWidthPx, premeasuredRowHeightById, preparedBoundary, preparedLayout, preparedMeasurementWidthPx, rows]);

  useLayoutEffect(() => {
    if (premeasureRows.length === 0) {
      return;
    }

    const updates = new Map<string, number>();
    for (const { index, row } of premeasureRows) {
      const element = premeasureRefs.current.get(row.id);
      if (!element) {
        continue;
      }
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      if (nextHeight > 0) {
        maybeRecordMeasurementDiagnostic({
          comparisonKind: "estimate-to-premeasure",
          threadId: thread?.id ?? null,
          rowId: row.id,
          rowKind: row.kind,
          widthPx: historyWidthPx,
          expectedHeight: getEstimatedRowHeight(row, index),
          actualHeight: nextHeight,
        });
        updates.set(row.id, nextHeight);
      }
    }

    if (updates.size === 0) {
      return;
    }

    setPremeasuredRowHeightById((existing) => {
      let changed = false;
      const next = new Map(existing);
      for (const [rowId, height] of updates) {
        if (next.get(rowId) === height) {
          continue;
        }
        next.set(rowId, height);
        changed = true;
      }
      return changed ? next : existing;
    });
  }, [getEstimatedRowHeight, historyWidthPx, maybeRecordMeasurementDiagnostic, premeasureRows, thread?.id]);

  useLayoutEffect(() => {
    if (!preparedLayout) {
      return;
    }

    const historyRoot = historyRootRef.current;
    if (!historyRoot) {
      return;
    }

    const visiblePreparedRows = Array.from(
      historyRoot.querySelectorAll<HTMLDivElement>(".transcript-blockHistory__virtualBlockInner[data-transcript-row-id]"),
    );
    for (const element of visiblePreparedRows) {
      const rowId = element.dataset.transcriptRowId;
      if (!rowId) {
        continue;
      }

      const index = Number.parseInt(element.dataset.index ?? "", 10);
      if (!Number.isFinite(index) || index >= firstUnvirtualizedRowIndex) {
        continue;
      }

      const row = rows[index];
      const preparedHeight = preparedLayout.rowHeightById.get(rowId);
      if (!row || typeof preparedHeight !== "number") {
        continue;
      }

      maybeRecordMeasurementDiagnostic({
        comparisonKind: "prepared-to-visible",
        threadId: thread?.id ?? null,
        rowId,
        rowKind: row.kind,
        widthPx: historyWidthPx,
        expectedHeight: preparedHeight,
        actualHeight: Math.ceil(element.getBoundingClientRect().height),
      });
    }
  }, [firstUnvirtualizedRowIndex, historyWidthPx, maybeRecordMeasurementDiagnostic, preparedLayout, rows, thread?.id]);

  const setPremeasureRef = useCallback((rowId: string, node: HTMLDivElement | null) => {
    if (node) {
      premeasureRefs.current.set(rowId, node);
    } else {
      premeasureRefs.current.delete(rowId);
    }
  }, []);

  if (!thread) {
    return (
      <div className="transcript-history__state transcript-history__state--ready">
        <div className="transcript-history__stateText">Open a thread to view its history</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="transcript-history__state transcript-history__state--ready">
        <div className="transcript-history__stateText">No transcript yet</div>
      </div>
    );
  }

  return (
    <div ref={historyRootRef} className="transcript-historyList transcript-history__viewport">
      <div
        ref={virtualCanvasRef}
        className="transcript-blockHistory__virtualCanvas"
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((virtualItem) => {
          const row = rows[virtualItem.index];
          if (!row) {
            return null;
          }

          return (
            <div
              key={virtualItem.key}
              className="transcript-blockHistory__virtualBlock"
              style={{
                transform: `translateY(${virtualItem.start}px)`,
                height: `${virtualItem.size}px`,
                overflow: "hidden",
              }}
            >
                <div
                  data-index={virtualItem.index}
                  data-transcript-row-id={row.id}
                  className="transcript-blockHistory__virtualBlockInner"
                  data-has-leading-gap={virtualItem.index > 0 ? "true" : undefined}
                  ref={rowVirtualizer.measureElement}
                >
                <TranscriptHistoryRowView
                  previousRow={virtualItem.index > 0 ? rows[virtualItem.index - 1] ?? null : null}
                  row={row}
                  checkpointDiffState={checkpointDiffByRowId.get(row.id)}
                  isCheckpointCollapsed={collapsedCheckpointRowIds.has(row.id)}
                  isToolExpanded={expandedToolRowIds.has(row.id)}
                  onEnsureCheckpointDiff={ensureCheckpointDiff}
                  onToggleCheckpoint={toggleCheckpointRow}
                  onToggleTool={toggleToolRow}
                  projectRoot={projectRoot}
                />
              </div>
            </div>
          );
        })}
      </div>

      {premeasureRows.length > 0 ? (
        <div className="transcript-blockHistory__measurementLane" aria-hidden="true">
          {premeasureRows.map(({ index, row }) => (
            <div
              key={`measure:${row.id}`}
              ref={(node) => setPremeasureRef(row.id, node)}
              className="transcript-blockHistory__measurementProbe"
              data-has-leading-gap={index > 0 ? "true" : undefined}
            >
              <TranscriptHistoryRowView
                previousRow={index > 0 ? rows[index - 1] ?? null : null}
                row={row}
                checkpointDiffState={checkpointDiffByRowId.get(row.id)}
                isCheckpointCollapsed={collapsedCheckpointRowIds.has(row.id)}
                isToolExpanded={expandedToolRowIds.has(row.id)}
                onEnsureCheckpointDiff={ensureCheckpointDiff}
                onToggleCheckpoint={toggleCheckpointRow}
                onToggleTool={toggleToolRow}
                projectRoot={projectRoot}
              />
            </div>
          ))}
        </div>
      ) : null}

      {staticRows.map((row, index) => (
        <div
          key={row.id}
          className="transcript-blockHistory__staticBlock"
          data-transcript-row-id={row.id}
          data-has-leading-gap={firstUnvirtualizedRowIndex + index > 0 ? "true" : undefined}
        >
          <TranscriptHistoryRowView
            previousRow={firstUnvirtualizedRowIndex + index > 0 ? rows[firstUnvirtualizedRowIndex + index - 1] ?? null : null}
            row={row}
            checkpointDiffState={checkpointDiffByRowId.get(row.id)}
            isCheckpointCollapsed={collapsedCheckpointRowIds.has(row.id)}
            isToolExpanded={expandedToolRowIds.has(row.id)}
            onEnsureCheckpointDiff={ensureCheckpointDiff}
            onToggleCheckpoint={toggleCheckpointRow}
            onToggleTool={toggleToolRow}
            projectRoot={projectRoot}
          />
        </div>
      ))}
    </div>
  );
});

interface TranscriptHistoryRowViewProps {
  readonly previousRow: TranscriptHistoryRow | null;
  readonly row: TranscriptHistoryRow;
  readonly isToolExpanded: boolean;
  readonly isCheckpointCollapsed: boolean;
  readonly checkpointDiffState: {
    readonly status: "loading" | "ready" | "error";
    readonly diff?: string;
    readonly errorMessage?: string;
  } | undefined;
  readonly onEnsureCheckpointDiff: (row: Extract<TranscriptHistoryRow, { readonly kind: "checkpoint" }>) => Promise<void>;
  readonly onToggleCheckpoint: (rowId: string) => void;
  readonly onToggleTool: (rowId: string) => void;
  readonly projectRoot: string | null | undefined;
}

function TranscriptHistoryRowView({
  previousRow,
  row,
  isToolExpanded,
  isCheckpointCollapsed,
  checkpointDiffState,
  onEnsureCheckpointDiff,
  onToggleCheckpoint,
  onToggleTool,
  projectRoot,
}: TranscriptHistoryRowViewProps) {
  switch (row.kind) {
    case "message":
      return (
        <TranscriptMessageRow
          message={row.message}
          projectRoot={projectRoot}
          showRoleSeparator={shouldRenderRoleSeparator(previousRow, row)}
        />
      );

    case "reasoning":
      return <TranscriptReasoningRow reasoning={row.reasoning} projectRoot={projectRoot} />;

    case "tool":
      return (
        <TranscriptToolRow
          tool={row.tool}
          isExpanded={isToolExpanded}
          onToggle={() => onToggleTool(row.id)}
        />
      );

    case "checkpoint":
      return (
        <TranscriptCheckpointRow
          row={row}
          diffState={checkpointDiffState}
          isCollapsed={isCheckpointCollapsed}
          onEnsureDiff={onEnsureCheckpointDiff}
          onToggle={() => onToggleCheckpoint(row.id)}
        />
      );

    default:
      return (
        <div className={`transcript-historyRow transcript-historyRow--${row.kind}`}>
          <pre className="transcript-historyRow__text">{formatTranscriptHistoryRow(row)}</pre>
        </div>
      );
  }
}

export function formatTranscriptHistoryRow(row: TranscriptHistoryRow): string {
  switch (row.kind) {
    case "message": {
      const lines = [
        ...(row.message.attachments?.map((attachment) => `attachment: ${formatAttachmentLine(attachment)}`) ?? []),
        row.message.text,
      ];
      return lines.join("\n");
    }

    case "reasoning":
      return row.reasoning.text;

    case "activity-group":
      return [
        "activity:",
        ...row.activities.flatMap((activity) => {
          const detail = getActivityDetail(activity);
          return [
            `[${activity.tone}] ${activity.summary}`,
            ...(detail ? [detail] : []),
          ];
        }),
      ].join("\n");

    case "plan":
      return `plan:\n${row.plan.planMarkdown}`;

    case "tool": {
      return [
        `tool: ${getToolPrefix(row.tool)} ${getToolDisplaySubject(row.tool)}`.trim(),
        ...getExpandedToolBodySections(row.tool).map((section) => section.text),
        ...(row.tool.inlineUnifiedDiff ? [row.tool.inlineUnifiedDiff] : []),
      ].join("\n");
    }

    case "checkpoint":
      return [
        `changes: ${formatCheckpointSummary(row.checkpoint.files.length)}`,
        ...row.checkpoint.files.map((file) => formatCheckpointFileSummary(file.path, file.additions, file.deletions)),
      ].join("\n");

    case "working":
      return `working:\n${row.label ? `${row.label}...` : "Waiting for the next transcript update..."}`;
  }
}

function TranscriptMessageRow({
  message,
  projectRoot,
  showRoleSeparator,
}: {
  readonly message: Extract<TranscriptHistoryRow, { readonly kind: "message" }>["message"];
  readonly projectRoot: string | null | undefined;
  readonly showRoleSeparator: boolean;
}) {
  const blocks = useMemo(() => parseTranscriptMessageBlocks(message.text), [message.text]);

  return (
    <div className="transcript-historyRow transcript-historyRow--message">
      {showRoleSeparator ? <div className="transcript-historyRow__messageSeparator" aria-hidden="true" /> : null}
      {message.attachments?.map((attachment) => (
        <div key={attachment.id} className="transcript-historyRow__text transcript-historyRow__text--muted">
          attachment: {formatAttachmentLine(attachment)}
        </div>
      ))}
      {blocks.map((block) => (
        block.kind === "table"
          ? <TranscriptMarkdownTable key={`table:${block.table.headers.join("|")}:${block.table.rows.length}`} table={block.table} projectRoot={projectRoot} />
          : <TranscriptTextBlock key={`text:${block.text}`} text={block.text} projectRoot={projectRoot} />
      ))}
    </div>
  );
}

function TranscriptTextBlock({
  text,
  projectRoot,
  lineClassName,
}: {
  readonly text: string;
  readonly projectRoot: string | null | undefined;
  readonly lineClassName?: string;
}) {
  let offset = 0;
  return (
    <div className="transcript-historyRow__textBlock">
      {text.split(/\r?\n/).map((line) => {
        const key = `${offset}:${line}`;
        offset += line.length + 1;
        return (
          <div key={key} className={classNames(["transcript-historyRow__text", lineClassName])}>
            {renderLinkTokens(line, projectRoot)}
          </div>
        );
      })}
    </div>
  );
}

function TranscriptReasoningRow({
  reasoning,
  projectRoot,
}: {
  readonly reasoning: Extract<TranscriptHistoryRow, { readonly kind: "reasoning" }>["reasoning"];
  readonly projectRoot: string | null | undefined;
}) {
  return (
    <div className="transcript-historyRow transcript-historyRow--reasoning">
      <div className="transcript-historyRow__reasoningSurface">
        {reasoning.variant === "summary"
          ? <div className="transcript-historyRow__reasoningSummary">{reasoning.text}</div>
          : (
              <TranscriptTextBlock
                text={reasoning.text}
                projectRoot={projectRoot}
                lineClassName="transcript-historyRow__reasoningText"
              />
            )}
      </div>
    </div>
  );
}

function TranscriptMarkdownTable({
  table,
  projectRoot,
}: {
  readonly table: TranscriptMarkdownTable;
  readonly projectRoot: string | null | undefined;
}) {
  const columns = table.headers.map((header, index) => ({
    header,
    alignment: table.alignments[index] ?? "left",
  }));

  return (
    <div className="transcript-historyRow__markdownTable">
      <table className="transcript-historyRow__markdownTableSurface">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={`header:${column.header}:${column.alignment}`}
                className={`transcript-historyRow__markdownTableCell transcript-historyRow__markdownTableCell--header transcript-historyRow__markdownTableCell--${column.alignment}`}
              >
                {renderLinkTokens(column.header, projectRoot)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={`row:${row.join("|")}`}>
              {row.map((cell, cellIndex) => {
                const column = columns[cellIndex];
                const cellKey = `cell:${column?.header ?? cell}:${cell}`;
                return (
                  <td
                    key={cellKey}
                    className={`transcript-historyRow__markdownTableCell transcript-historyRow__markdownTableCell--${column?.alignment ?? "left"}`}
                  >
                    {renderLinkTokens(cell, projectRoot)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TranscriptToolRow({
  tool,
  isExpanded,
  onToggle,
}: {
  readonly tool: Extract<TranscriptHistoryRow, { readonly kind: "tool" }>["tool"];
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
}) {
  const bodySections = getExpandedToolBodySections(tool);
  const expandable = bodySections.length > 0 || Boolean(tool.inlineUnifiedDiff);
  const statusClassName = getWorkItemStatusClassName(tool.status);
  const summarySubject = getVisibleToolSummarySubject(tool);

  return (
    <div className="transcript-historyRow transcript-historyRow--tool">
      <div className={classNames([
        "transcript-blockHistory__commandWidgetSurface",
        expandable ? "transcript-blockHistory__commandWidgetSurfaceToggleable" : null,
        isExpanded ? "transcript-blockHistory__commandWidgetSurfaceWithBody" : null,
        isExpanded ? "transcript-blockHistory__commandWidgetSurfaceExpanded" : null,
        statusClassName,
      ])}>
        {expandable ? (
          <button type="button" className="transcript-blockHistory__commandWidgetRail" onClick={onToggle} aria-label={isExpanded ? "Collapse tool details" : "Expand tool details"}>
            <div className="transcript-blockHistory__commandWidgetRailVisual" />
          </button>
        ) : (
          <div className="transcript-blockHistory__commandWidgetRailSpacer" aria-hidden="true">
            <div className="transcript-blockHistory__commandWidgetRailVisual" />
          </div>
        )}
        <div className="transcript-blockHistory__commandWidgetContent">
          <div className="transcript-blockHistory__commandWidgetSummary">
            <span className="transcript-blockHistory__token tok-commandWidgetGlyph">{getToolGlyph(tool)}</span>
            <span className="transcript-blockHistory__token tok-commandWidgetPrefix">{getToolPrefix(tool)}</span>
            {summarySubject ? <span className="transcript-historyToolSummary__subject">{summarySubject}</span> : null}
            {tool.timingLabel ? (
              <span className="transcript-blockHistory__token tok-commandWidgetMeta">{tool.timingLabel}</span>
            ) : null}
          </div>
          {isExpanded && (
            <div className="transcript-blockHistory__commandWidgetBody">
              {bodySections.map((section) => (
                <div key={section.key} className="transcript-historyToolBody__section">
                  {section.label ? (
                    <div className="transcript-historyToolBody__label">{section.label}</div>
                  ) : null}
                  <pre className="transcript-historyToolBody__text">{section.text}</pre>
                </div>
              ))}
              {tool.inlineUnifiedDiff ? (
                <TranscriptDiffBody
                  diffState={{
                    status: "ready",
                    diff: tool.inlineUnifiedDiff,
                  }}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptCheckpointRow({
  row,
  diffState,
  isCollapsed,
  onEnsureDiff,
  onToggle,
}: {
  readonly row: Extract<TranscriptHistoryRow, { readonly kind: "checkpoint" }>;
  readonly diffState: {
    readonly status: "loading" | "ready" | "error";
    readonly diff?: string;
    readonly errorMessage?: string;
  } | undefined;
  readonly isCollapsed: boolean;
  readonly onEnsureDiff: (row: Extract<TranscriptHistoryRow, { readonly kind: "checkpoint" }>) => Promise<void>;
  readonly onToggle: () => void;
}) {
  const isExpanded = !isCollapsed;

  useEffect(() => {
    if (!isExpanded || diffState) {
      return;
    }
    void onEnsureDiff(row);
  }, [diffState, isExpanded, onEnsureDiff, row]);

  return (
    <div className="transcript-historyRow transcript-historyRow--checkpoint">
      <div className={classNames([
        "transcript-blockHistory__commandWidgetSurface",
        "transcript-blockHistory__commandWidgetSurfaceToggleable",
        "transcript-blockHistory__commandWidgetSurfaceWithBody",
        isExpanded ? "transcript-blockHistory__commandWidgetSurfaceExpanded" : null,
        "cm-line-workItemDone",
      ])}>
        <button type="button" className="transcript-blockHistory__commandWidgetRail" onClick={onToggle} aria-label={isExpanded ? "Collapse file changes" : "Expand file changes"}>
          <div className="transcript-blockHistory__commandWidgetRailVisual" />
        </button>
        <div className="transcript-blockHistory__commandWidgetContent">
          <div className="transcript-blockHistory__commandWidgetSummary">
            {formatCheckpointSummary(row.checkpoint.files.length)}
          </div>
          {isExpanded ? (
            <div className="transcript-blockHistory__commandWidgetBody">
              {row.checkpoint.files.map((file) => (
                <div key={file.path}>{formatCheckpointFileSummary(file.path, file.additions, file.deletions)}</div>
              ))}
              <TranscriptDiffBody diffState={diffState} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TranscriptDiffBody({
  diffState,
}: {
  readonly diffState: {
    readonly status: "loading" | "ready" | "error";
    readonly diff?: string;
    readonly errorMessage?: string;
  } | undefined;
}) {
  if (!diffState || diffState.status === "loading") {
    return <div className="transcript-blockHistory__inlineDiffStateMessage">Loading diffÔÇª</div>;
  }
  if (diffState.status === "error") {
    return (
      <div className="transcript-blockHistory__inlineDiffStateMessage transcript-blockHistory__inlineDiffStateMessage--error">
        {diffState.errorMessage ?? "Failed to load diff."}
      </div>
    );
  }
  if (!diffState.diff) {
    return null;
  }

  return (
    <div className="transcript-blockHistory__inlineDiff">
      {getKeyedLines(diffState.diff).map(({ key, text }) => {
        const line = text;
        const rowClassName = getDiffRowClassName(line);
        return (
          <div key={key} className={classNames(["transcript-blockHistory__inlineDiffRow", rowClassName])}>
            <div className="transcript-blockHistory__inlineDiffLineNumber" aria-hidden="true" />
            <div className="transcript-blockHistory__inlineDiffRowBody">
              <span className="transcript-blockHistory__inlineDiffMarker">{line[0] ?? " "}</span>
              <span className="transcript-blockHistory__inlineDiffContent">
                <span className="transcript-blockHistory__inlineDiffContentText">{line.length > 1 ? line.slice(1) : " "}</span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatAttachmentLine(attachment: ChatAttachment) {
  const sizeSuffix =
    typeof attachment.sizeBytes === "number"
      ? ` (${formatBytes(attachment.sizeBytes)})`
      : "";
  return `${attachment.type}: ${attachment.name}${sizeSuffix}`;
}

function formatBytes(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)} MB`;
  }
  if (value >= 1_000) {
    return `${Math.max(value / 1_000, 0.1).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function getKeyedLines(text: string) {
  let offset = 0;
  return text.split(/\r?\n/).map((line) => {
    const keyedLine = {
      key: `${offset}:${line}`,
      text: line,
    };
    offset += line.length + 1;
    return keyedLine;
  });
}

function classNames(parts: ReadonlyArray<string | null | undefined | false>) {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

function getWorkItemStatusClassName(status: "running" | "done" | "error" | "declined") {
  if (status === "running") {
    return "cm-line-workItemRunning";
  }
  if (status === "error") {
    return "cm-line-workItemError";
  }
  if (status === "declined") {
    return "cm-line-workItemDeclined";
  }
  return "cm-line-workItemDone";
}

function formatCheckpointSummary(fileCount: number) {
  return fileCount === 1 ? "1 file changed" : `${fileCount} files changed`;
}

function formatCheckpointFileSummary(path: string, additions: number, deletions: number) {
  return `${path} (+${additions} -${deletions})`;
}

function getDiffRowClassName(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "transcript-blockHistory__inlineDiffRow--addition";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "transcript-blockHistory__inlineDiffRow--deletion";
  }
  if (line.startsWith("@@")) {
    return "transcript-blockHistory__inlineDiffRow--gap";
  }
  return null;
}

function renderLinkTokens(text: string, projectRoot: string | null | undefined) {
  let offset = 0;
  return tokenizeTranscriptLinks(text).map((token) => {
    const key = `${offset}:${token.kind}:${token.text}`;
    offset += token.kind === "link" ? token.href.length : token.text.length;
    if (token.kind === "text") {
      return <Fragment key={key}>{token.text.length > 0 ? token.text : "\u00A0"}</Fragment>;
    }

    const href = resolveLinkHref(token.href, projectRoot);
    return (
      <a
        key={key}
        className={`transcript-blockHistory__token transcript-blockHistory__token--link tok-markdownLink ${token.linkKind === "url" ? "tok-linkUrl" : "tok-linkFile"}`}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          void openTranscriptLink(href);
        }}
      >
        {token.text}
      </a>
    );
  });
}

function resolveLinkHref(target: string, projectRoot?: string | null) {
  if (/^https?:\/\//i.test(target)) {
    return target;
  }
  if (!projectRoot) {
    return target;
  }
  const normalizedRoot = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedTarget = target.replace(/\\/g, "/").replace(/^\.\//, "");
  return `file:///${normalizedRoot}/${normalizedTarget}`;
}

async function openTranscriptLink(href: string) {
  if (window.desktopBridge?.openExternal) {
    await window.desktopBridge.openExternal(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function shouldRenderRoleSeparator(
  previousRow: TranscriptHistoryRow | null,
  row: Extract<TranscriptHistoryRow, { readonly kind: "message" }>,
) {
  if (!previousRow || previousRow.kind !== "message") {
    return false;
  }

  const leftRole = previousRow.message.role;
  const rightRole = row.message.role;
  if ((leftRole !== "user" && leftRole !== "assistant") || (rightRole !== "user" && rightRole !== "assistant")) {
    return false;
  }

  return leftRole !== rightRole;
}

function getToolGlyph(tool: Extract<TranscriptHistoryRow, { readonly kind: "tool" }>["tool"]) {
  if (tool.status === "running") {
    return "Ôå╗";
  }
  if (tool.status === "error") {
    return "Ô£ò";
  }
  if (tool.status === "declined") {
    return "ÔêÆ";
  }
  return "Ô£ô";
}

function humanizeExecutionLabel(label: string) {
  const normalized = label.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return "Tool";
  }
  if (!/[A-Z]/.test(normalized)) {
    return normalized.replace(/\b\w/g, (segment) => segment.toUpperCase());
  }
  return normalized;
}

function getToolPrefix(tool: Extract<TranscriptHistoryRow, { readonly kind: "tool" }>["tool"]) {
  if (tool.itemKind === "command") {
    if (tool.status === "running") {
      return "Running";
    }
    if (tool.status === "error") {
      return "Failed";
    }
    if (tool.status === "declined") {
      return "Declined";
    }
    return "Ran";
  }

  if (tool.itemKind === "file-change") {
    if (tool.status === "running") {
      return "Editing";
    }
    if (tool.status === "error") {
      return "Failed";
    }
    if (tool.status === "declined") {
      return "Declined";
    }
    return "Edited";
  }

  return humanizeExecutionLabel(tool.title);
}

function getVisibleToolSummarySubject(
  tool: Extract<TranscriptHistoryRow, { readonly kind: "tool" }>["tool"],
) {
  const subject = getToolDisplaySubject(tool);
  if (
    tool.itemKind === "tool"
    && subject.trim().localeCompare(tool.title.trim(), undefined, { sensitivity: "accent" }) === 0
  ) {
    return null;
  }
  return subject;
}

function getExpandedToolBodySections(
  tool: Extract<TranscriptHistoryRow, { readonly kind: "tool" }>["tool"],
) {
  const sections: Array<{ key: string; label: string | null; text: string }> = [];
  const seen = new Set<string>();
  const pushSection = (key: string, label: string | null, text: string | null) => {
    const normalized = text?.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    sections.push({ key, label, text: normalized });
  };

  pushSection("detail", null, tool.detail);
  pushSection("command", "command", tool.command ? `$ ${tool.command}` : null);
  pushSection(
    "files",
    "changed files",
    tool.changedFiles.length > 0 ? tool.changedFiles.join("\n") : null,
  );
  pushSection("output", "details", tool.output);

  return sections;
}
