import type { ChatAttachment, OrchestrationMessage, OrchestrationThread } from "@t3tools/contracts";
import { measureElement, useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
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
  type TranscriptHistoryRow,
} from "./transcriptHistoryRows";

const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 120;

interface TranscriptHistoryProps {
  readonly thread: OrchestrationThread | null;
  readonly initialScrollOffsetFromBottom: number | null | undefined;
  readonly onScrollOffsetFromBottomChange: ((offsetFromBottom: number) => void) | undefined;
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
}

export const TranscriptHistory = memo(function TranscriptHistory({
  thread,
  initialScrollOffsetFromBottom,
  onScrollOffsetFromBottomChange,
  scrollContainerRef,
}: TranscriptHistoryProps) {
  const rows = useMemo(() => deriveTranscriptHistoryRows(thread), [thread]);
  const historyRootRef = useRef<HTMLDivElement | null>(null);
  const [historyWidthPx, setHistoryWidthPx] = useState<number | null>(null);
  const firstUnvirtualizedRowIndex = useMemo(
    () => getFirstUnvirtualizedRowIndex(rows, thread),
    [rows, thread],
  );
  const lastKnownOffsetFromBottomRef = useRef(0);
  const previousThreadIdRef = useRef<string | null>(null);
  const previousThreadUpdatedAtRef = useRef<string | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: firstUnvirtualizedRowIndex,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => rows[index]?.id ?? index,
    estimateSize: (index) => {
      const row = rows[index];
      return row ? estimateTranscriptHistoryRowHeight(row, { widthPx: historyWidthPx }) : 80;
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

  useEffect(() => {
    rowVirtualizer.measure();
  }, [firstUnvirtualizedRowIndex, rowVirtualizer, rows]);

  useEffect(() => {
    if (historyWidthPx === null) {
      return;
    }
    rowVirtualizer.measure();
  }, [historyWidthPx, rowVirtualizer]);

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
              className="transcript-blockHistory__virtualBlock"
              data-has-leading-gap={virtualItem.index > 0 ? "true" : undefined}
              ref={(element) => {
                if (element) {
                  rowVirtualizer.measureElement(element);
                }
              }}
              style={{
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <TranscriptHistoryRowView row={row} />
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
          <TranscriptHistoryRowView row={row} />
        </div>
      ))}
    </div>
  );
});

function TranscriptHistoryRowView({ row }: { readonly row: TranscriptHistoryRow }) {
  return (
    <div className={`transcript-historyRow transcript-historyRow--${row.kind}`}>
      <pre className="transcript-historyRow__text">{formatTranscriptHistoryRow(row)}</pre>
    </div>
  );
}

export function formatTranscriptHistoryRow(row: TranscriptHistoryRow): string {
  switch (row.kind) {
    case "message": {
      const lines = [
        `${getMessageRoleLabel(row.message.role)}:`,
        ...(row.message.attachments?.map((attachment) => `attachment: ${formatAttachmentLine(attachment)}`) ?? []),
        row.message.text,
      ];
      return lines.join("\n");
    }

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

    case "working":
      return `working:\n${row.label ? `${row.label}...` : "Waiting for the next transcript update..."}`;
  }
}

function getMessageRoleLabel(role: OrchestrationMessage["role"]) {
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
  }
  return "user";
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
