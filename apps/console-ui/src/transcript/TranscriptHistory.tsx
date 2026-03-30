import type { ChatAttachment, OrchestrationThread } from "@t3tools/contracts";
import { measureElement, useVirtualizer } from "@tanstack/react-virtual";
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
  getFirstUnvirtualizedRowIndex,
  getToolDisplaySubject,
  type TranscriptHistoryRow,
} from "./transcriptHistoryRows";
import {
  parseTranscriptMessageBlocks,
  tokenizeTranscriptLinks,
  type TranscriptMarkdownTable,
} from "./transcriptMessageFormatting";

const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 120;

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
  const [historyWidthPx, setHistoryWidthPx] = useState<number | null>(null);
  const [expandedToolRowIds, setExpandedToolRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedCheckpointRowIds, setCollapsedCheckpointRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const [checkpointDiffByRowId, setCheckpointDiffByRowId] = useState<ReadonlyMap<string, {
    readonly status: "loading" | "ready" | "error";
    readonly diff?: string;
    readonly errorMessage?: string;
  }>>(() => new Map());
  const firstUnvirtualizedRowIndex = useMemo(
    () => getFirstUnvirtualizedRowIndex(rows, thread),
    [rows, thread],
  );
  const lastKnownOffsetFromBottomRef = useRef(0);
  const previousThreadIdRef = useRef<string | null>(null);
  const previousThreadUpdatedAtRef = useRef<string | null>(null);
  const pendingMeasureFrameRef = useRef<number | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: firstUnvirtualizedRowIndex,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => rows[index]?.id ?? index,
    estimateSize: (index) => {
      const row = rows[index];
      return row
        ? estimateTranscriptHistoryRowHeight(row, {
            widthPx: historyWidthPx,
            expandedToolRowIds,
            collapsedCheckpointRowIds,
            checkpointDiffByRowId,
          })
        : 80;
    },
    measureElement,
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

  const scheduleMeasure = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) {
      return;
    }

    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);

  useEffect(() => {
    scheduleMeasure();
  }, [checkpointDiffByRowId, collapsedCheckpointRowIds, expandedToolRowIds, firstUnvirtualizedRowIndex, rows, scheduleMeasure]);

  useEffect(() => {
    setExpandedToolRowIds(new Set());
    setCollapsedCheckpointRowIds(new Set());
    setCheckpointDiffByRowId(new Map());
  }, [thread?.id]);

  useEffect(() => {
    if (historyWidthPx === null) {
      return;
    }
    scheduleMeasure();
  }, [historyWidthPx, scheduleMeasure]);

  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_FOLLOW_BOTTOM_THRESHOLD_PX;
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

  const virtualItems = rowVirtualizer.getVirtualItems();
  const staticRows = rows.slice(firstUnvirtualizedRowIndex);

  return (
    <div ref={historyRootRef} className="transcript-historyList transcript-history__viewport">
      <div
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
              data-index={virtualItem.index}
              className="transcript-blockHistory__virtualBlock"
              data-has-leading-gap={virtualItem.index > 0 ? "true" : undefined}
              ref={rowVirtualizer.measureElement}
              style={{
                transform: `translateY(${virtualItem.start}px)`,
              }}
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
          );
        })}
      </div>

      {staticRows.map((row, index) => (
        <div
          key={row.id}
          className="transcript-blockHistory__staticBlock"
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
    return <div className="transcript-blockHistory__inlineDiffStateMessage">Loading diff…</div>;
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
    return "↻";
  }
  if (tool.status === "error") {
    return "✕";
  }
  if (tool.status === "declined") {
    return "−";
  }
  return "✓";
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
