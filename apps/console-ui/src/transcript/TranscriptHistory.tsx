import type { ChatAttachment, OrchestrationMessage, OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";
import { measureElement, useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
      return row ? estimateTranscriptHistoryRowHeight(row) : 80;
    },
    measureElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [firstUnvirtualizedRowIndex, rowVirtualizer, rows]);

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
    <div className="transcript-blockHistory transcript-history__viewport">
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
  switch (row.kind) {
    case "message":
      return <TranscriptMessageRow message={row.message} />;

    case "activity-group":
      return <TranscriptActivityGroupRow activities={row.activities} />;

    case "plan":
      return <TranscriptPlanRow markdown={row.plan.planMarkdown} />;

    case "working":
      return <TranscriptWorkingRow label={row.label} />;
  }
}

function TranscriptMessageRow({ message }: { readonly message: OrchestrationMessage }) {
  return (
    <div className="transcript-blockHistory__block transcript-historyRow transcript-historyRow--message">
      <HistoryLabel tone={message.role}>{getMessageRoleLabel(message.role)}</HistoryLabel>
      {message.attachments?.map((attachment) => (
        <HistoryLine
          key={attachment.id}
          className="transcript-historyRow__attachmentLine"
          text={formatAttachmentLine(attachment)}
        />
      ))}
      {getKeyedLines(message.id, message.text).map((line) => (
        <HistoryLine
          key={line.key}
          className={`transcript-historyRow__messageLine transcript-historyRow__messageLine--${message.role}`}
          text={line.text}
        />
      ))}
    </div>
  );
}

function TranscriptActivityGroupRow({
  activities,
}: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  return (
    <div className="transcript-blockHistory__block transcript-historyRow transcript-historyRow--activityGroup">
      <HistoryLabel>activity</HistoryLabel>
      {activities.map((activity) => {
        const detail = getActivityDetail(activity);
        return (
          <div key={activity.id} className="transcript-historyRow__activityItem">
            <HistoryLine
              className={`transcript-historyRow__activitySummary transcript-historyRow__activitySummary--${activity.tone}`}
              text={activity.summary}
            />
            {detail ? (
              <HistoryLine
                className="transcript-historyRow__activityDetail"
                text={detail}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TranscriptPlanRow({ markdown }: { readonly markdown: string }) {
  return (
    <div className="transcript-blockHistory__block transcript-historyRow transcript-historyRow--plan">
      <HistoryLabel>plan</HistoryLabel>
      {getKeyedLines("plan", markdown).map((line) => (
        <HistoryLine key={line.key} className="transcript-historyRow__planLine" text={line.text} />
      ))}
    </div>
  );
}

function TranscriptWorkingRow({ label }: { readonly label: string | null }) {
  return (
    <div className="transcript-blockHistory__block transcript-historyRow transcript-historyRow--working">
      <HistoryLabel>working</HistoryLabel>
      <HistoryLine
        className="transcript-historyRow__workingLine"
        text={label ? `${label}...` : "Waiting for the next transcript update..."}
      />
    </div>
  );
}

function HistoryLabel({
  children,
  tone,
}: {
  readonly children: string;
  readonly tone?: OrchestrationMessage["role"];
}) {
  return (
    <div className="transcript-blockHistory__lineFrame">
      <div
        className={`transcript-blockHistory__line transcript-historyRow__label${tone ? ` transcript-historyRow__label--${tone}` : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

function HistoryLine({
  className,
  text,
}: {
  readonly className?: string;
  readonly text: string;
}) {
  return (
    <div className="transcript-blockHistory__lineFrame">
      <div className={`transcript-blockHistory__line ${className ?? ""}`.trim()}>
        {text.length > 0 ? text : " "}
      </div>
    </div>
  );
}

function splitMessageLines(text: string) {
  const lines = text.split(/\r?\n/);
  return lines.length > 0 ? lines : [""];
}

function getKeyedLines(prefix: string, text: string) {
  let offset = 0;
  return splitMessageLines(text).map((line) => {
    const keyedLine = {
      key: `${prefix}:${offset}:${line}`,
      text: line,
    };
    offset += line.length + 1;
    return keyedLine;
  });
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
