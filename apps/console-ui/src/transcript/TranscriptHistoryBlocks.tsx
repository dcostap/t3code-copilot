import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  blockToLines,
  type AnnotatedLine,
  type InlineDiffLookup,
  type TranscriptBlock,
  type TranscriptImageAttachment,
} from "./TranscriptBlock";

interface TranscriptHistoryBlocksProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly searchMatches?: ReadonlyArray<TranscriptHistorySearchMatch>;
  readonly activeSearchMatchIndex?: number;
  readonly expandedCommandSignatures?: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures?: ReadonlySet<string>;
  readonly resolvedInlineDiffBySignature?: ReadonlyMap<string, InlineDiffResolutionStateLike>;
  readonly onToggleCommandWidget?: (input: ToggleCommandWidgetInput) => void;
  readonly onMeasuredHeightApplied?: (updates: ReadonlyArray<TranscriptHistoryMeasurementUpdate>) => void;
  readonly scrollTop?: number;
  readonly viewportHeight?: number;
}

export interface TranscriptHistorySearchMatch {
  readonly blockIndex: number;
  readonly lineIndex: number;
  readonly from: number;
  readonly to: number;
}

export interface TranscriptHistoryMeasurementUpdate {
  readonly blockIndex: number;
  readonly blockType: TranscriptBlock["type"];
  readonly blockKey: string;
  readonly measurementKey: string;
  readonly commandWidgetSignatures: ReadonlyArray<string>;
  readonly previousHeight: number;
  readonly nextHeight: number;
  readonly deltaHeight: number;
}

interface InlineDiffResolutionStateLike {
  readonly status: "loading" | "ready" | "error";
  readonly diff?: string;
}

interface ToggleCommandWidgetInput {
  readonly signature: string;
  readonly isFileChange: boolean;
  readonly inlineDiffLookup?: InlineDiffLookup;
}

interface IndexedSearchMatch extends TranscriptHistorySearchMatch {
  readonly matchIndex: number;
  readonly isActive: boolean;
}

interface RenderedTranscriptBlock {
  readonly block: TranscriptBlock;
  readonly lines: ReadonlyArray<AnnotatedLine>;
  readonly key: string;
  readonly measurementKey: string;
}

interface VirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly topSpacerHeight: number;
  readonly bottomSpacerHeight: number;
}

const DEFAULT_BLOCK_OVERSCAN_PX = 1400;
const DEFAULT_LINE_HEIGHT_PX = 20;
const DEFAULT_ESTIMATED_CHARACTER_WIDTH_PX = 7.8;
const DEFAULT_WIDTH_BUCKET_PX = 32;
const DEFAULT_BLOCK_GAP_PX = 4;
const DEFAULT_PREMEASURE_AHEAD_PX = 1200;
const DEFAULT_PREMEASURE_BLOCK_LIMIT = 6;

interface EstimateTranscriptHistoryBlockHeightInput {
  readonly availableWidthPx?: number;
  readonly expandedCommandSignatures?: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures?: ReadonlySet<string>;
}

function classNames(parts: ReadonlyArray<string | false | null | undefined>) {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

function summarizeText(text: string) {
  return `${text.length}:${text.slice(0, 40)}:${text.slice(-20)}`;
}

function getLineIdentity(line: AnnotatedLine) {
  if (line.commandWidgetSignature) {
    return `command:${line.commandWidgetSignature}`;
  }
  if (line.userInputRef) {
    return `input:${line.userInputRef.requestId}:${line.userInputRef.questionIndex}:${line.userInputRef.optionIndex ?? -1}`;
  }
  return [
    line.kind,
    summarizeText(line.text),
    line.timingLabel ?? "",
    line.extraClasses?.join("|") ?? "",
  ].join(":");
}

function getBlockIdentity(block: TranscriptBlock, lines: ReadonlyArray<AnnotatedLine>) {
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  return [
    block.type,
    lines.length,
    firstLine ? getLineIdentity(firstLine) : "empty",
    lastLine && lastLine !== firstLine ? getLineIdentity(lastLine) : "",
    block.type === "user-message" ? block.attachments?.map((attachment) => attachment.name).join("|") ?? "" : "",
  ].join(":");
}

function getCommandWidgetMeasurementIdentity(
  line: AnnotatedLine,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
) {
  const signature = line.commandWidgetSignature ?? "";
  const isExpanded = isExpandedCommandLine(line, expandedCommandSignatures, collapsedFileChangeSignatures);
  const resolvedInlineDiffState = resolvedInlineDiffBySignature.get(signature);
  const effectiveInlineDiff =
    line.inlineUnifiedDiff
    ?? (resolvedInlineDiffState?.status === "ready" ? resolvedInlineDiffState.diff : undefined);

  return [
    signature,
    isExpanded ? "expanded" : "collapsed",
    isExpanded && line.commandWidgetOutputLines && line.commandWidgetOutputLines.length > 0
      ? `output:${summarizeText(line.commandWidgetOutputLines.join("\n"))}`
      : "",
    isExpanded && effectiveInlineDiff
      ? `diff:${summarizeText(effectiveInlineDiff)}`
      : "",
    isExpanded && !effectiveInlineDiff && line.inlineDiffLookup
      ? `diff-state:${resolvedInlineDiffState?.status ?? "idle"}`
      : "",
    isExpanded && line.inlineDiffChangedFiles && line.inlineDiffChangedFiles.length > 0
      ? `files:${line.inlineDiffChangedFiles.join("|")}`
      : "",
  ].join(":");
}

function getBlockMeasurementIdentity(
  block: TranscriptBlock,
  lines: ReadonlyArray<AnnotatedLine>,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
) {
  const blockIdentity = getBlockIdentity(block, lines);
  const commandWidgetMeasurementIdentity = lines
    .filter(isCommandWidgetLine)
    .map((line) =>
      getCommandWidgetMeasurementIdentity(
        line,
        expandedCommandSignatures,
        collapsedFileChangeSignatures,
        resolvedInlineDiffBySignature,
      ))
    .join("|");

  return commandWidgetMeasurementIdentity.length > 0
    ? `${blockIdentity}:${commandWidgetMeasurementIdentity}`
    : blockIdentity;
}

export function getTranscriptHistoryBlockMeasurementKey(
  block: TranscriptBlock,
  {
    expandedCommandSignatures = new Set<string>(),
    collapsedFileChangeSignatures = new Set<string>(),
    resolvedInlineDiffBySignature = new Map<string, InlineDiffResolutionStateLike>(),
  }: {
    readonly expandedCommandSignatures?: ReadonlySet<string>;
    readonly collapsedFileChangeSignatures?: ReadonlySet<string>;
    readonly resolvedInlineDiffBySignature?: ReadonlyMap<string, InlineDiffResolutionStateLike>;
  } = {},
) {
  const lines = blockToLines(block);
  return getBlockMeasurementIdentity(
    block,
    lines,
    expandedCommandSignatures,
    collapsedFileChangeSignatures,
    resolvedInlineDiffBySignature,
  );
}

function isSpacerLine(line: AnnotatedLine) {
  return line.kind === "meta" || line.kind.endsWith("Separator");
}

function isCommandWidgetLine(line: AnnotatedLine) {
  return line.kind === "commandExec" && typeof line.commandWidgetSignature === "string";
}

function isFileChangeWidgetLine(line: AnnotatedLine) {
  return (
    line.inlineUnifiedDiff !== undefined
    || line.inlineDiffLookup !== undefined
    || line.inlineDiffChangedFiles !== undefined
  );
}

function isExpandedCommandLine(
  line: AnnotatedLine,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
) {
  if (!line.commandWidgetSignature) {
    return false;
  }
  return isFileChangeWidgetLine(line)
    ? !collapsedFileChangeSignatures.has(line.commandWidgetSignature)
    : expandedCommandSignatures.has(line.commandWidgetSignature);
}

function estimateWrappedTextRows(text: string, availableWidthPx: number) {
  const logicalLines = text.split(/\r?\n/);
  if (availableWidthPx <= 0) {
    return logicalLines.length;
  }

  const charactersPerRow = Math.max(8, Math.floor(availableWidthPx / DEFAULT_ESTIMATED_CHARACTER_WIDTH_PX));
  return logicalLines.reduce((sum, logicalLine) => {
    if (logicalLine.length === 0) {
      return sum + 1;
    }
    return sum + Math.max(1, Math.ceil(logicalLine.length / charactersPerRow));
  }, 0);
}

function estimateRenderedBlockHeight(
  renderedBlock: RenderedTranscriptBlock,
  availableWidthPx: number,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
) {
  const plainLineWidthPx = Math.max(120, availableWidthPx);
  const commandSurfaceWidthPx = Math.max(120, availableWidthPx - 28);
  const commandBodyWidthPx = Math.max(120, availableWidthPx - 28);
  let estimatedLineCount = 0;
  for (const line of renderedBlock.lines) {
    if (isSpacerLine(line)) {
      estimatedLineCount += 0.6;
      continue;
    }
    if (isCommandWidgetLine(line)) {
      estimatedLineCount += estimateWrappedTextRows(line.text, commandSurfaceWidthPx);
      estimatedLineCount += 1;
      if (!isExpandedCommandLine(line, expandedCommandSignatures, collapsedFileChangeSignatures)) {
        continue;
      }
      if (line.commandWidgetOutputLines && line.commandWidgetOutputLines.length > 0) {
        estimatedLineCount += estimateWrappedTextRows(line.commandWidgetOutputLines.join("\n"), commandBodyWidthPx);
      }
      if (line.inlineUnifiedDiff) {
        estimatedLineCount += 1;
        estimatedLineCount += Math.max(4, estimateWrappedTextRows(line.inlineUnifiedDiff, commandBodyWidthPx));
      }
      if (!line.inlineUnifiedDiff && line.inlineDiffLookup) {
        estimatedLineCount += 1;
      }
      if (line.inlineDiffChangedFiles && line.inlineDiffChangedFiles.length > 0) {
        estimatedLineCount += estimateWrappedTextRows(line.inlineDiffChangedFiles.join(", "), commandBodyWidthPx);
      }
      continue;
    }
    estimatedLineCount += estimateWrappedTextRows(line.text, plainLineWidthPx);
  }
  if (renderedBlock.block.type === "user-message" && renderedBlock.block.attachments?.length) {
    estimatedLineCount += estimateWrappedTextRows(
      `${renderedBlock.block.attachments.length} attachments: ${renderedBlock.block.attachments.map((attachment) => attachment.name).join(", ")}`,
      plainLineWidthPx,
    );
  }
  return Math.max(64, Math.ceil(estimatedLineCount * DEFAULT_LINE_HEIGHT_PX + 20));
}

export function estimateTranscriptHistoryBlockHeight(
  block: TranscriptBlock,
  {
    availableWidthPx = 0,
    expandedCommandSignatures = new Set<string>(),
    collapsedFileChangeSignatures = new Set<string>(),
  }: EstimateTranscriptHistoryBlockHeightInput = {},
) {
  const lines = blockToLines(block);
  return estimateRenderedBlockHeight(
    {
      block,
      lines,
      key: getBlockIdentity(block, lines),
      measurementKey: getBlockIdentity(block, lines),
    },
    availableWidthPx,
    expandedCommandSignatures,
    collapsedFileChangeSignatures,
  );
}

function readRenderedVirtualBlockHeight(wrapperElement: HTMLDivElement, blockIndex: number) {
  const contentElement = wrapperElement.firstElementChild;
  const contentHeight =
    contentElement instanceof HTMLElement
      ? Math.ceil(contentElement.getBoundingClientRect().height)
      : Math.ceil(wrapperElement.getBoundingClientRect().height);
  return contentHeight + (blockIndex > 0 ? DEFAULT_BLOCK_GAP_PX : 0);
}

function resolveVirtualWindow(
  renderedBlocks: ReadonlyArray<RenderedTranscriptBlock>,
  blockHeights: ReadonlyArray<number>,
  scrollTop: number,
  viewportHeight: number,
  activeSearchBlockIndex: number,
): VirtualWindow {
  if (renderedBlocks.length === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    };
  }

  if (viewportHeight <= 0) {
    return {
      startIndex: 0,
      endIndex: renderedBlocks.length,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    };
  }

  const overscannedTop = Math.max(0, scrollTop - DEFAULT_BLOCK_OVERSCAN_PX);
  const overscannedBottom = scrollTop + viewportHeight + DEFAULT_BLOCK_OVERSCAN_PX;

  let startIndex = 0;
  let endIndex = renderedBlocks.length;
  let topSpacerHeight = 0;
  let offset = 0;

  for (let index = 0; index < blockHeights.length; index += 1) {
    const nextOffset = offset + (blockHeights[index] ?? 0);
    if (nextOffset >= overscannedTop) {
      startIndex = index;
      topSpacerHeight = offset;
      break;
    }
    offset = nextOffset;
  }

  offset = topSpacerHeight;
  endIndex = renderedBlocks.length;
  for (let index = startIndex; index < blockHeights.length; index += 1) {
    offset += blockHeights[index] ?? 0;
    if (offset >= overscannedBottom) {
      endIndex = Math.min(renderedBlocks.length, index + 1);
      break;
    }
  }

  if (activeSearchBlockIndex >= 0) {
    if (activeSearchBlockIndex < startIndex || activeSearchBlockIndex >= endIndex) {
      startIndex = Math.max(0, activeSearchBlockIndex - 2);
      endIndex = Math.min(renderedBlocks.length, activeSearchBlockIndex + 3);
    }
    topSpacerHeight = blockHeights.slice(0, startIndex).reduce((sum, height) => sum + height, 0);
  }

  const renderedHeight = blockHeights.slice(startIndex, endIndex).reduce((sum, height) => sum + height, 0);
  const totalHeight = blockHeights.reduce((sum, height) => sum + height, 0);
  const bottomSpacerHeight = Math.max(0, totalHeight - topSpacerHeight - renderedHeight);

  return {
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
  };
}

function findTranscriptHistoryLineMatches(lineText: string, query: string) {
  if (query.length === 0 || lineText.length === 0) {
    return [];
  }

  const haystack = lineText.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const matches: Array<{ readonly from: number; readonly to: number }> = [];
  let fromIndex = 0;
  while (fromIndex < haystack.length) {
    const matchIndex = haystack.indexOf(needle, fromIndex);
    if (matchIndex === -1) {
      break;
    }
    matches.push({
      from: matchIndex,
      to: matchIndex + needle.length,
    });
    fromIndex = matchIndex + Math.max(needle.length, 1);
  }
  return matches;
}

export function findTranscriptHistoryBlockSearchMatches(
  blocks: ReadonlyArray<TranscriptBlock>,
  query: string,
): ReadonlyArray<TranscriptHistorySearchMatch> {
  if (query.length === 0) {
    return [];
  }

  const matches: TranscriptHistorySearchMatch[] = [];
  blocks.forEach((block, blockIndex) => {
    blockToLines(block).forEach((line, lineIndex) => {
      for (const match of findTranscriptHistoryLineMatches(line.text, query)) {
        matches.push({
          blockIndex,
          lineIndex,
          from: match.from,
          to: match.to,
        });
      }
    });
  });
  return matches;
}

function renderAnnotatedLineContent(
  line: AnnotatedLine,
  searchMatches: ReadonlyArray<IndexedSearchMatch> = [],
) {
  if (
    (!line.highlightSpans || line.highlightSpans.length === 0)
    && searchMatches.length === 0
    && (!line.animatedText || line.animatedText.to <= line.animatedText.from)
  ) {
    return line.text.length > 0 ? line.text : "\u00A0";
  }

  if (line.text.length === 0) {
    return "\u00A0";
  }

  const content: ReactNode[] = [];
  const sortedHighlightSpans = [...(line.highlightSpans ?? [])].toSorted((left, right) => left.from - right.from);
  const sortedSearchMatches = [...searchMatches].toSorted((left, right) => left.from - right.from);
  const animatedText = line.animatedText && line.animatedText.to > line.animatedText.from ? line.animatedText : null;
  const boundaries = new Set<number>([0, line.text.length]);

  for (const span of sortedHighlightSpans) {
    boundaries.add(Math.max(0, Math.min(line.text.length, span.from)));
    boundaries.add(Math.max(0, Math.min(line.text.length, span.to)));
  }
  for (const match of sortedSearchMatches) {
    boundaries.add(Math.max(0, Math.min(line.text.length, match.from)));
    boundaries.add(Math.max(0, Math.min(line.text.length, match.to)));
  }
  if (animatedText) {
    boundaries.add(Math.max(0, Math.min(line.text.length, animatedText.from)));
    boundaries.add(Math.max(0, Math.min(line.text.length, animatedText.to)));
  }

  const sortedBoundaries = [...boundaries].toSorted((left, right) => left - right);
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const from = sortedBoundaries[index]!;
    const to = sortedBoundaries[index + 1]!;
    if (to <= from) {
      continue;
    }

    const highlightSpan = sortedHighlightSpans.find((span) => from >= span.from && to <= span.to);
    const searchMatch = sortedSearchMatches.find((match) => from >= match.from && to <= match.to);
    const isAnimated = animatedText !== null && from >= animatedText.from && to <= animatedText.to;
    const textSegment = line.text.slice(from, to);
    const classes = classNames([
      highlightSpan ? "transcript-blockHistory__token" : "",
      highlightSpan?.className,
      highlightSpan?.link ? "transcript-blockHistory__token--link" : "",
      searchMatch ? "transcript-blockHistory__searchMatch" : "",
      searchMatch?.isActive ? "transcript-blockHistory__searchMatch--active" : "",
      isAnimated ? "transcript-blockHistory__animatedText" : "",
    ]);

    if (classes.length === 0) {
      content.push(
        <Fragment key={`text:${index}:${from}`}>
          {textSegment}
        </Fragment>,
      );
      continue;
    }

    content.push(
      <span
        key={`segment:${index}:${from}:${to}`}
        className={classes}
        data-link-kind={highlightSpan?.link?.kind}
        data-link-target={highlightSpan?.link?.target}
        data-transcript-search-match-index={searchMatch?.matchIndex}
      >
        {textSegment}
      </span>,
    );
  }

  return content.length > 0 ? content : "\u00A0";
}

function renderDividerLine(line: AnnotatedLine, key: string) {
  return (
    <div
      key={key}
      className="transcript-blockHistory__divider"
      aria-hidden="true"
    >
      {line.text}
    </div>
  );
}

function renderSpacerLine(line: AnnotatedLine, key: string) {
  return (
    <div
      key={key}
      className={classNames([
        "transcript-blockHistory__spacer",
        `transcript-blockHistory__spacer--${line.kind}`,
      ])}
      aria-hidden="true"
    />
  );
}

function renderAttachmentSummary(attachments: ReadonlyArray<TranscriptImageAttachment> | undefined) {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  return (
    <div className="transcript-blockHistory__attachmentSummary">
      {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
      {": "}
      {attachments.map((attachment) => attachment.name).join(", ")}
    </div>
  );
}

function renderCommandWidgetLine(
  line: AnnotatedLine,
  lineSearchMatches: ReadonlyArray<IndexedSearchMatch>,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
  onToggleCommandWidget: TranscriptHistoryBlocksProps["onToggleCommandWidget"],
) {
  const signature = line.commandWidgetSignature;
  if (!signature) {
    return null;
  }

  const isFileChange = isFileChangeWidgetLine(line);
  const isExpanded = isExpandedCommandLine(line, expandedCommandSignatures, collapsedFileChangeSignatures);
  const resolvedInlineDiffState = resolvedInlineDiffBySignature.get(signature);
  const effectiveInlineDiff =
    line.inlineUnifiedDiff
    ?? (resolvedInlineDiffState?.status === "ready" ? resolvedInlineDiffState.diff : undefined);
  const hasHiddenExpansionContent =
    (line.commandWidgetOutputLines?.length ?? 0) > 0
    || line.inlineUnifiedDiff !== undefined
    || line.inlineDiffLookup !== undefined;
  const inlineDiffStateMessage =
    isExpanded && !effectiveInlineDiff && line.inlineDiffLookup
      ? resolvedInlineDiffState?.status === "loading"
        ? "Loading diff..."
        : resolvedInlineDiffState?.status === "error"
          ? "Diff unavailable."
          : undefined
      : undefined;
  const summaryContent = (
    <div className="transcript-blockHistory__commandWidgetSummary">
      {hasHiddenExpansionContent ? (
        <span className="transcript-blockHistory__commandWidgetToggleGlyph" aria-hidden="true">
          {isExpanded ? "▾" : "▸"}
        </span>
      ) : null}
      {renderAnnotatedLineContent(line, lineSearchMatches)}
    </div>
  );

  return (
    <div
      className={classNames([
        "transcript-blockHistory__commandWidgetSurface",
        `transcript-blockHistory__commandWidgetSurface--${line.kind}`,
        ...(line.extraClasses ?? []),
        hasHiddenExpansionContent ? "transcript-blockHistory__commandWidgetSurface--toggleable" : "",
      ])}
    >
      {hasHiddenExpansionContent ? (
        <button
          type="button"
          className="transcript-blockHistory__commandWidgetButton"
          onClick={() => onToggleCommandWidget?.({
            signature,
            isFileChange,
            ...(line.inlineDiffLookup ? { inlineDiffLookup: line.inlineDiffLookup } : {}),
          })}
        >
          {summaryContent}
        </button>
      ) : summaryContent}
      {isExpanded && line.commandWidgetOutputLines && line.commandWidgetOutputLines.length > 0 ? (
        <pre className="transcript-blockHistory__commandWidgetBody">
          {line.commandWidgetOutputLines.join("\n")}
        </pre>
      ) : null}
      {isExpanded && effectiveInlineDiff ? (
        <div className="transcript-blockHistory__inlineDiff">
          {line.inlineDiffChangedFiles && line.inlineDiffChangedFiles.length > 0 ? (
            <div className="transcript-blockHistory__inlineDiffFiles">
              {line.inlineDiffChangedFiles.join(", ")}
            </div>
          ) : null}
          <pre className="transcript-blockHistory__inlineDiffBody">{effectiveInlineDiff}</pre>
        </div>
      ) : null}
      {inlineDiffStateMessage ? (
        <div className="transcript-blockHistory__inlineDiffFiles">
          {inlineDiffStateMessage}
        </div>
      ) : null}
    </div>
  );
}

function renderBlock(
  renderedBlock: RenderedTranscriptBlock,
  blockIndex: number,
  searchMatchesByLine: ReadonlyMap<string, ReadonlyArray<IndexedSearchMatch>>,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
  onToggleCommandWidget: TranscriptHistoryBlocksProps["onToggleCommandWidget"],
) {
  const lineOccurrences = new Map<string, number>();
  return (
    <section
      className={`transcript-blockHistory__block transcript-blockHistory__block--${renderedBlock.block.type}`}
      data-block-type={renderedBlock.block.type}
    >
      {renderedBlock.lines.map((line, lineIndex) => {
        const lineIdentity = getLineIdentity(line);
        const lineOccurrence = lineOccurrences.get(lineIdentity) ?? 0;
        lineOccurrences.set(lineIdentity, lineOccurrence + 1);
        const lineKey = `${lineIdentity}:${lineOccurrence}`;
        const lineSearchMatches = searchMatchesByLine.get(`${blockIndex}:${lineIndex}`) ?? [];
        if (line.kind === "divider") {
          return renderDividerLine(line, lineKey);
        }
        if (isSpacerLine(line)) {
          return renderSpacerLine(line, lineKey);
        }
        if (isCommandWidgetLine(line)) {
          return (
            <div
              key={lineKey}
              className="transcript-blockHistory__lineFrame"
            >
              {renderCommandWidgetLine(
                line,
                lineSearchMatches,
                expandedCommandSignatures,
                collapsedFileChangeSignatures,
                resolvedInlineDiffBySignature,
                onToggleCommandWidget,
              )}
            </div>
          );
        }
        return (
          <div
            key={lineKey}
            className="transcript-blockHistory__lineFrame"
          >
            <div
              className={classNames([
                "transcript-blockHistory__line",
                `transcript-blockHistory__line--${line.kind}`,
                ...(line.extraClasses ?? []),
              ])}
            >
              {renderAnnotatedLineContent(line, lineSearchMatches)}
            </div>
          </div>
        );
      })}
      {renderedBlock.block.type === "user-message" ? renderAttachmentSummary(renderedBlock.block.attachments) : null}
    </section>
  );
}

export function TranscriptHistoryBlocks({
  blocks,
  searchMatches = [],
  activeSearchMatchIndex = -1,
  expandedCommandSignatures = new Set<string>(),
  collapsedFileChangeSignatures = new Set<string>(),
  resolvedInlineDiffBySignature = new Map<string, InlineDiffResolutionStateLike>(),
  onToggleCommandWidget,
  onMeasuredHeightApplied,
  scrollTop = 0,
  viewportHeight = 0,
}: TranscriptHistoryBlocksProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const renderedBlocks = useMemo(() => {
    const blockOccurrences = new Map<string, number>();
    return blocks.map((block) => {
      const lines = blockToLines(block);
      const blockIdentity = getBlockIdentity(block, lines);
      const blockOccurrence = blockOccurrences.get(blockIdentity) ?? 0;
      blockOccurrences.set(blockIdentity, blockOccurrence + 1);
      return {
        block,
        lines,
        key: `${blockIdentity}:${blockOccurrence}`,
        measurementKey: `${getBlockMeasurementIdentity(
          block,
          lines,
          expandedCommandSignatures,
          collapsedFileChangeSignatures,
          resolvedInlineDiffBySignature,
        )}:${blockOccurrence}`,
      } satisfies RenderedTranscriptBlock;
    });
  }, [blocks, collapsedFileChangeSignatures, expandedCommandSignatures, resolvedInlineDiffBySignature]);

  const searchMatchesByLine = useMemo(() => {
    const byLine = new Map<string, IndexedSearchMatch[]>();
    searchMatches.forEach((match, index) => {
      const lineKey = `${match.blockIndex}:${match.lineIndex}`;
      const currentLineMatches = byLine.get(lineKey) ?? [];
      currentLineMatches.push({
        ...match,
        matchIndex: index,
        isActive: index === activeSearchMatchIndex,
      });
      byLine.set(lineKey, currentLineMatches);
    });
    return byLine;
  }, [activeSearchMatchIndex, searchMatches]);

  const [measuredHeights, setMeasuredHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [availableWidthPx, setAvailableWidthPx] = useState(0);
  const stickyWindowRef = useRef<VirtualWindow | null>(null);
  const blockRefs = useRef(new Map<string, HTMLDivElement>());
  const premeasureRefs = useRef(new Map<string, HTMLDivElement>());
  const setBlockRef = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) {
      blockRefs.current.set(key, node);
    } else {
      blockRefs.current.delete(key);
    }
  }, []);
  const setPremeasureRef = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) {
      premeasureRefs.current.set(key, node);
    } else {
      premeasureRefs.current.delete(key);
    }
  }, []);
  const widthBucket = Math.max(0, Math.floor(availableWidthPx / DEFAULT_WIDTH_BUCKET_PX));

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) {
      return undefined;
    }

    const syncWidth = () => {
      const nextWidth = Math.max(0, Math.floor(element.clientWidth));
      setAvailableWidthPx((current) => current === nextWidth ? current : nextWidth);
    };

    syncWidth();

    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      syncWidth();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    stickyWindowRef.current = null;
    setMeasuredHeights((current) => current.size === 0 ? current : new Map());
  }, [widthBucket]);

  const blockHeights = useMemo(
    () =>
      renderedBlocks.map((renderedBlock, index) =>
        measuredHeights.get(renderedBlock.measurementKey)
        ?? (
          estimateRenderedBlockHeight(
            renderedBlock,
            availableWidthPx,
            expandedCommandSignatures,
            collapsedFileChangeSignatures,
          )
          + (index > 0 ? DEFAULT_BLOCK_GAP_PX : 0)
        )),
    [availableWidthPx, collapsedFileChangeSignatures, expandedCommandSignatures, measuredHeights, renderedBlocks],
  );
  const blockOffsets = useMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const height of blockHeights) {
      offsets.push(offset);
      offset += height ?? 0;
    }
    return offsets;
  }, [blockHeights]);
  const totalHeight = useMemo(() => blockHeights.reduce((sum, height) => sum + height, 0), [blockHeights]);

  const activeSearchBlockIndex =
    activeSearchMatchIndex >= 0
      ? searchMatches[activeSearchMatchIndex]?.blockIndex ?? -1
      : -1;
  const blockIndexByKey = useMemo(
    () => new Map(renderedBlocks.map((renderedBlock, index) => [renderedBlock.measurementKey, index])),
    [renderedBlocks],
  );

  const applyMeasuredHeightUpdates = useCallback((updates: ReadonlyMap<string, number>) => {
    const measurementUpdates: TranscriptHistoryMeasurementUpdate[] = [];
    setMeasuredHeights((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, nextHeight] of updates) {
        const globalIndex = blockIndexByKey.get(key);
        if (globalIndex === undefined) {
          continue;
        }
        const previousHeight = blockHeights[globalIndex] ?? 0;
        const blockTop = blockOffsets[globalIndex] ?? 0;
        if (blockTop + previousHeight <= scrollTop + 0.5) {
          continue;
        }
        if (nextHeight <= 0 || previousHeight === nextHeight) {
          continue;
        }
        const renderedBlock = renderedBlocks[globalIndex];
        if (renderedBlock) {
          measurementUpdates.push({
            blockIndex: globalIndex,
            blockType: renderedBlock.block.type,
            blockKey: renderedBlock.key,
            measurementKey: renderedBlock.measurementKey,
            commandWidgetSignatures: renderedBlock.lines
              .filter(isCommandWidgetLine)
              .flatMap((line) => line.commandWidgetSignature ? [line.commandWidgetSignature] : []),
            previousHeight,
            nextHeight,
            deltaHeight: nextHeight - previousHeight,
          });
        }
        next.set(key, nextHeight);
        changed = true;
      }
      return changed ? next : current;
    });
    if (measurementUpdates.length > 0) {
      onMeasuredHeightApplied?.(measurementUpdates);
    }
  }, [blockHeights, blockIndexByKey, blockOffsets, onMeasuredHeightApplied, renderedBlocks, scrollTop]);

  const virtualWindow = useMemo(
    () => {
      const currentWindow = stickyWindowRef.current;
      if (!currentWindow || viewportHeight <= 0) {
        const nextWindow = resolveVirtualWindow(
          renderedBlocks,
          blockHeights,
          scrollTop,
          viewportHeight,
          activeSearchBlockIndex,
        );
        stickyWindowRef.current = nextWindow;
        return nextWindow;
      }

      const currentTop = blockHeights.slice(0, currentWindow.startIndex).reduce((sum, height) => sum + height, 0);
      const currentRenderedHeight = blockHeights
        .slice(currentWindow.startIndex, currentWindow.endIndex)
        .reduce((sum, height) => sum + height, 0);
      const currentBottom = currentTop + currentRenderedHeight;
      const activeSearchOutsideWindow =
        activeSearchBlockIndex >= 0
        && (activeSearchBlockIndex < currentWindow.startIndex || activeSearchBlockIndex >= currentWindow.endIndex);
      const nearWindowEdge =
        scrollTop < currentTop + Math.floor(DEFAULT_BLOCK_OVERSCAN_PX * 0.35)
        || scrollTop + viewportHeight > currentBottom - Math.floor(DEFAULT_BLOCK_OVERSCAN_PX * 0.35);

      if (activeSearchOutsideWindow || nearWindowEdge) {
        const nextWindow = resolveVirtualWindow(
          renderedBlocks,
          blockHeights,
          scrollTop,
          viewportHeight,
          activeSearchBlockIndex,
        );
        stickyWindowRef.current = nextWindow;
        return nextWindow;
      }

      const stableWindow = {
        startIndex: currentWindow.startIndex,
        endIndex: currentWindow.endIndex,
        topSpacerHeight: currentTop,
        bottomSpacerHeight: Math.max(0, totalHeight - currentTop - currentRenderedHeight),
      } satisfies VirtualWindow;
      stickyWindowRef.current = stableWindow;
      return stableWindow;
    },
    [activeSearchBlockIndex, blockHeights, renderedBlocks, scrollTop, totalHeight, viewportHeight],
  );

  const visibleBlocks = useMemo(
    () => renderedBlocks.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [renderedBlocks, virtualWindow.endIndex, virtualWindow.startIndex],
  );
  const premeasureBlocks = useMemo(() => {
    if (viewportHeight <= 0) {
      return [];
    }
    const nextBlocks: Array<{ readonly renderedBlock: RenderedTranscriptBlock; readonly blockIndex: number }> = [];
    const viewportBottom = scrollTop + viewportHeight;
    for (let blockIndex = virtualWindow.endIndex; blockIndex < renderedBlocks.length; blockIndex += 1) {
      const blockTop = blockOffsets[blockIndex] ?? 0;
      if (blockTop >= viewportBottom + DEFAULT_PREMEASURE_AHEAD_PX) {
        break;
      }
      const renderedBlock = renderedBlocks[blockIndex];
      if (!renderedBlock || measuredHeights.has(renderedBlock.measurementKey)) {
        continue;
      }
      nextBlocks.push({ renderedBlock, blockIndex });
      if (nextBlocks.length >= DEFAULT_PREMEASURE_BLOCK_LIMIT) {
        break;
      }
    }
    return nextBlocks;
  }, [blockOffsets, measuredHeights, renderedBlocks, scrollTop, viewportHeight, virtualWindow.endIndex]);

  useLayoutEffect(() => {
    if (viewportHeight <= 0) {
      return undefined;
    }

    const applyMeasurements = () => {
      const updates = new Map<string, number>();
      for (const [visibleIndex, renderedBlock] of visibleBlocks.entries()) {
        const element = blockRefs.current.get(renderedBlock.measurementKey);
        if (!element) {
          continue;
        }
        const globalIndex = virtualWindow.startIndex + visibleIndex;
        const previousHeight = blockHeights[globalIndex] ?? 0;
        const nextHeight = readRenderedVirtualBlockHeight(element, globalIndex);
        if (nextHeight <= 0 || previousHeight === nextHeight) {
          continue;
        }
        const blockTop = blockOffsets[globalIndex] ?? 0;
        const blockBottom = blockTop + previousHeight;
        if (blockBottom <= scrollTop + 0.5) {
          continue;
        }
        updates.set(renderedBlock.measurementKey, nextHeight);
      }
      if (updates.size === 0) {
        return;
      }
      applyMeasuredHeightUpdates(updates);
    };

    applyMeasurements();

    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      applyMeasurements();
    });
    for (const renderedBlock of visibleBlocks) {
      const wrapperElement = blockRefs.current.get(renderedBlock.measurementKey);
      const observedElement = wrapperElement?.firstElementChild;
      if (observedElement instanceof HTMLElement) {
        observer.observe(observedElement);
        continue;
      }
      if (wrapperElement) {
        observer.observe(wrapperElement);
      }
    }
    return () => {
      observer.disconnect();
    };
  }, [
    applyMeasuredHeightUpdates,
    blockHeights,
    blockOffsets,
    scrollTop,
    viewportHeight,
    virtualWindow.startIndex,
    visibleBlocks,
  ]);

  useLayoutEffect(() => {
    if (premeasureBlocks.length === 0) {
      return;
    }

    const updates = new Map<string, number>();
    for (const { renderedBlock, blockIndex } of premeasureBlocks) {
      const element = premeasureRefs.current.get(renderedBlock.measurementKey);
      if (!element) {
        continue;
      }
      const previousHeight = blockHeights[blockIndex] ?? 0;
      const nextHeight = readRenderedVirtualBlockHeight(element, blockIndex);
      if (nextHeight <= 0 || previousHeight === nextHeight) {
        continue;
      }
      updates.set(renderedBlock.measurementKey, nextHeight);
    }
    if (updates.size > 0) {
      applyMeasuredHeightUpdates(updates);
    }
  }, [applyMeasuredHeightUpdates, blockHeights, premeasureBlocks]);

  return (
    <div className="transcript-blockHistory" ref={rootRef}>
      <div
        className="transcript-blockHistory__virtualCanvas"
        style={{ height: `${totalHeight}px` }}
      >
        {visibleBlocks.map((renderedBlock, visibleIndex) => {
          const blockIndex = virtualWindow.startIndex + visibleIndex;
          const blockHeight = blockHeights[blockIndex] ?? 0;
          return (
            <div
              key={renderedBlock.key}
              ref={(node) => setBlockRef(renderedBlock.measurementKey, node)}
              className="transcript-blockHistory__virtualBlock"
              data-has-leading-gap={blockIndex > 0 ? "true" : undefined}
              style={{
                top: `${blockOffsets[blockIndex] ?? 0}px`,
                height: `${blockHeight}px`,
                overflow: "hidden",
              }}
            >
              {renderBlock(
                renderedBlock,
                blockIndex,
                searchMatchesByLine,
                expandedCommandSignatures,
                collapsedFileChangeSignatures,
                resolvedInlineDiffBySignature,
                onToggleCommandWidget,
              )}
            </div>
          );
        })}
      </div>
      {premeasureBlocks.length > 0 ? (
        <div className="transcript-blockHistory__measurementLane" aria-hidden="true">
          {premeasureBlocks.map(({ renderedBlock, blockIndex }) => (
            <div
              key={`measure:${renderedBlock.measurementKey}`}
              ref={(node) => setPremeasureRef(renderedBlock.measurementKey, node)}
              className="transcript-blockHistory__measurementProbe"
              data-has-leading-gap={blockIndex > 0 ? "true" : undefined}
            >
              {renderBlock(
                renderedBlock,
                blockIndex,
                searchMatchesByLine,
                expandedCommandSignatures,
                collapsedFileChangeSignatures,
                resolvedInlineDiffBySignature,
                onToggleCommandWidget,
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
