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
import {
  getInlineDiffRowCopyText,
  getInlineDiffRowMarker,
  parseInlineDiffFiles,
  type InlineDiffFileData,
} from "./inlineDiff";
import {
  layoutMarkdownTable,
  resolveMarkdownTableDisplayWidth,
  type MarkdownTableDisplayLine,
} from "./markdownTable";
import { measureTranscriptSwitchDiagnostic } from "../transcriptSwitchDiagnostics";

interface TranscriptHistoryBlocksProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly cacheKey?: string | null;
  readonly searchMatches?: ReadonlyArray<TranscriptHistorySearchMatch>;
  readonly activeSearchMatchIndex?: number;
  readonly expandedCommandSignatures?: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures?: ReadonlySet<string>;
  readonly resolvedInlineDiffBySignature?: ReadonlyMap<string, InlineDiffResolutionStateLike>;
  readonly onToggleCommandWidget?: (input: ToggleCommandWidgetInput) => void;
  readonly onMeasuredHeightApplied?: (updates: ReadonlyArray<TranscriptHistoryMeasurementUpdate>) => void;
  readonly scrollTop?: number;
  readonly viewportHeight?: number;
  readonly scrollContainerRef?: { readonly current: HTMLDivElement | null };
  readonly isScrolling?: boolean;
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
  readonly showMessageTurnSeparator: boolean;
}

interface CachedRenderedTranscriptBlockBase {
  readonly block: TranscriptBlock;
  readonly lines: ReadonlyArray<AnnotatedLine>;
  readonly key: string;
  readonly showMessageTurnSeparator: boolean;
}

interface CachedRenderedTranscriptBlocksState {
  readonly baseRenderedBlocks: ReadonlyArray<CachedRenderedTranscriptBlockBase>;
  readonly expandedCommandSignatures: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures: ReadonlySet<string>;
  readonly resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>;
  readonly renderedBlocks: ReadonlyArray<RenderedTranscriptBlock>;
}

interface CachedBlockGeometryState {
  readonly renderedBlocks: ReadonlyArray<RenderedTranscriptBlock>;
  readonly measuredHeights: ReadonlyMap<string, number>;
  readonly availableWidthPx: number;
  readonly expandedCommandSignatures: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures: ReadonlySet<string>;
  readonly resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>;
  readonly blockHeights: ReadonlyArray<number>;
  readonly blockOffsets: ReadonlyArray<number>;
  readonly totalHeight: number;
  readonly blockIndexByKey: ReadonlyMap<string, number>;
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
const DEFAULT_PREMEASURE_BLOCK_LIMIT = 12;

interface EstimateTranscriptHistoryBlockHeightInput {
  readonly availableWidthPx?: number;
  readonly expandedCommandSignatures?: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures?: ReadonlySet<string>;
  readonly resolvedInlineDiffBySignature?: ReadonlyMap<string, InlineDiffResolutionStateLike>;
}

function classNames(parts: ReadonlyArray<string | false | null | undefined>) {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

function summarizeText(text: string) {
  return `${text.length}:${text.slice(0, 40)}:${text.slice(-20)}`;
}

function summarizeTextLines(lines: ReadonlyArray<string>) {
  const firstLine = lines[0] ?? "";
  const lastLine = lines[lines.length - 1] ?? "";
  const totalLength = lines.reduce((sum, line) => sum + line.length, 0);
  return `${lines.length}:${totalLength}:${firstLine.slice(0, 40)}:${lastLine.slice(-20)}`;
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
      ? `output:${summarizeTextLines(line.commandWidgetOutputLines)}`
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

function hasExpandableCommandSummary(line: AnnotatedLine) {
  return line.text.includes("\n") || line.text.length > 180;
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

function shouldShowMessageTurnSeparator(
  previousBlock: TranscriptBlock | null,
  nextBlock: TranscriptBlock,
) {
  if (!previousBlock) {
    return false;
  }

  if (previousBlock.type === "user-message") {
    return true;
  }

  if (previousBlock.type === "finished-state") {
    return true;
  }

  if (previousBlock.type === "assistant-text" && nextBlock.type !== "finished-state") {
    return true;
  }

  return false;
}

function estimateWrappedTextRows(text: string, availableWidthPx: number) {
  return estimateWrappedLogicalLineRows(text.split(/\r?\n/), availableWidthPx);
}

function estimateWrappedLogicalLineRows(logicalLines: ReadonlyArray<string>, availableWidthPx: number) {
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

function estimateInlineDiffFileRows(
  files: ReadonlyArray<InlineDiffFileData>,
  contentWidthPx: number,
) {
  let estimatedRows = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        estimatedRows += estimateWrappedLogicalLineRows([row.text.length > 0 ? row.text : " "], contentWidthPx);
      }
    }
  }
  if (files.length > 1) {
    estimatedRows += (files.length - 1) * 0.3;
  }
  return estimatedRows;
}

function estimateRenderedBlockHeight(
  renderedBlock: RenderedTranscriptBlock,
  availableWidthPx: number,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
) {
  const plainLineWidthPx = Math.max(120, availableWidthPx);
  const commandSurfaceWidthPx = Math.max(120, availableWidthPx - 28);
  const commandBodyWidthPx = Math.max(120, availableWidthPx - 28);
  const inlineDiffContentWidthPx = Math.max(72, commandBodyWidthPx - 80);
  const markdownTableWidth = resolveMarkdownTableDisplayWidth(availableWidthPx);
  let estimatedLineCount = 0;
  for (let lineIndex = 0; lineIndex < renderedBlock.lines.length; lineIndex += 1) {
    const line = renderedBlock.lines[lineIndex]!;
    if (isSpacerLine(line)) {
      estimatedLineCount += 0.6;
      continue;
    }
    if (line.kind === "table" && line.tableData) {
      estimatedLineCount += layoutMarkdownTable(line.tableData, markdownTableWidth).length;
      while (lineIndex + 1 < renderedBlock.lines.length && renderedBlock.lines[lineIndex + 1]?.kind === "table") {
        lineIndex += 1;
      }
      continue;
    }
    if (isCommandWidgetLine(line)) {
      const isExpanded = isExpandedCommandLine(line, expandedCommandSignatures, collapsedFileChangeSignatures);
      const resolvedInlineDiffState = line.commandWidgetSignature
        ? resolvedInlineDiffBySignature.get(line.commandWidgetSignature)
        : undefined;
      const effectiveInlineDiff =
        line.inlineUnifiedDiff
        ?? (resolvedInlineDiffState?.status === "ready" ? resolvedInlineDiffState.diff : undefined);
      estimatedLineCount +=
        !isExpanded && hasExpandableCommandSummary(line)
          ? 1
          : estimateWrappedTextRows(line.text, commandSurfaceWidthPx);
      estimatedLineCount += 1;
      if (!isExpanded) {
        continue;
      }
      if (line.commandWidgetOutputLines && line.commandWidgetOutputLines.length > 0) {
        estimatedLineCount += estimateWrappedLogicalLineRows(line.commandWidgetOutputLines, commandBodyWidthPx);
      }
      if (effectiveInlineDiff) {
        const parsedInlineDiffFiles = parseInlineDiffFiles(effectiveInlineDiff, line.inlineDiffChangedFiles);
        if (parsedInlineDiffFiles.length > 0) {
          estimatedLineCount += estimateInlineDiffFileRows(parsedInlineDiffFiles, inlineDiffContentWidthPx);
        } else {
          estimatedLineCount += 1;
          estimatedLineCount += Math.max(4, estimateWrappedTextRows(effectiveInlineDiff, commandBodyWidthPx));
        }
      }
      if (!effectiveInlineDiff && line.inlineDiffLookup) {
        estimatedLineCount += 1;
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
    resolvedInlineDiffBySignature = new Map<string, InlineDiffResolutionStateLike>(),
  }: EstimateTranscriptHistoryBlockHeightInput = {},
) {
  const lines = blockToLines(block);
  return estimateRenderedBlockHeight(
    {
      block,
      lines,
      key: getBlockIdentity(block, lines),
      measurementKey: getBlockIdentity(block, lines),
      showMessageTurnSeparator: false,
    },
    availableWidthPx,
    expandedCommandSignatures,
    collapsedFileChangeSignatures,
    resolvedInlineDiffBySignature,
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
    const previousHighlightSpan = sortedHighlightSpans.find((span) => span.to === from);
    const nextHighlightSpan = sortedHighlightSpans.find((span) => span.from === to);
    const textSegment =
      line.kind === "commandExec"
      && line.text.slice(from, to) === " "
      && previousHighlightSpan?.className === "tok-commandWidgetGlyph"
      && nextHighlightSpan?.className === "tok-commandWidgetPrefix"
        ? "\u00A0"
        : line.text.slice(from, to);
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
        role={highlightSpan?.link ? "link" : undefined}
        tabIndex={highlightSpan?.link ? 0 : undefined}
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
  const parsedInlineDiffFiles =
    isExpanded && effectiveInlineDiff
      ? parseInlineDiffFiles(effectiveInlineDiff, line.inlineDiffChangedFiles)
      : [];
  const hasExpandableSummary = hasExpandableCommandSummary(line);
  const hasHiddenExpansionContent =
    hasExpandableSummary
    || (line.commandWidgetOutputLines?.length ?? 0) > 0
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
      {renderAnnotatedLineContent(line, lineSearchMatches)}
    </div>
  );
  const inlineDiffFileOccurrences = new Map<string, number>();

  return (
    <div
      className={classNames([
        "transcript-blockHistory__commandWidgetSurface",
        `transcript-blockHistory__commandWidgetSurface--${line.kind}`,
        ...(line.extraClasses ?? []),
        hasHiddenExpansionContent ? "transcript-blockHistory__commandWidgetSurfaceToggleable" : "",
        isExpanded ? "transcript-blockHistory__commandWidgetSurfaceExpanded" : "",
        isExpanded && line.commandWidgetOutputLines && line.commandWidgetOutputLines.length > 0
          ? "transcript-blockHistory__commandWidgetSurfaceWithBody"
          : "",
      ])}
    >
      {hasHiddenExpansionContent ? (
        <button
          type="button"
          className="transcript-blockHistory__commandWidgetRail"
          aria-label={isExpanded ? "Collapse details" : "Expand details"}
          aria-expanded={isExpanded}
          onClick={() => onToggleCommandWidget?.({
            signature,
            isFileChange,
            ...(line.inlineDiffLookup ? { inlineDiffLookup: line.inlineDiffLookup } : {}),
          })}
        >
          <span className="transcript-blockHistory__commandWidgetRailVisual" aria-hidden="true" />
        </button>
      ) : <span className="transcript-blockHistory__commandWidgetRailSpacer" aria-hidden="true" />}
      <div className="transcript-blockHistory__commandWidgetContent">
        {summaryContent}
        {isExpanded && line.commandWidgetOutputLines && line.commandWidgetOutputLines.length > 0 ? (
          <pre className="transcript-blockHistory__commandWidgetBody">
            {line.commandWidgetOutputLines.join("\n")}
          </pre>
        ) : null}
        {isExpanded && parsedInlineDiffFiles.length > 0 ? (
          <div className="transcript-blockHistory__inlineDiff">
            {parsedInlineDiffFiles.map((file) => {
              const fileIdentity = `${file.path}:${file.previousPath ?? ""}:${file.additions}:${file.deletions}`;
              const fileOccurrence = inlineDiffFileOccurrences.get(fileIdentity) ?? 0;
              inlineDiffFileOccurrences.set(fileIdentity, fileOccurrence + 1);
              const rowOccurrences = new Map<string, number>();
              return (
                <section
                  key={`${signature}:inline-diff:${fileIdentity}:${fileOccurrence}`}
                  className="transcript-blockHistory__inlineDiffFile"
                >
                  {file.hunks.flatMap((hunk) =>
                    hunk.rows.map((row) => {
                      const copyText = getInlineDiffRowCopyText(row);
                      const rowIdentity =
                        `${hunk.header}:${row.kind}:${row.oldLineNumber ?? ""}:${row.newLineNumber ?? ""}:${row.text}`;
                      const rowOccurrence = rowOccurrences.get(rowIdentity) ?? 0;
                      rowOccurrences.set(rowIdentity, rowOccurrence + 1);
                      return (
                        <div
                          key={`${signature}:inline-diff:${fileIdentity}:${rowIdentity}:${rowOccurrence}`}
                          className={classNames([
                            "transcript-blockHistory__inlineDiffRow",
                            `transcript-blockHistory__inlineDiffRow--${row.kind}`,
                            copyText ? "transcript-blockHistory__commandWidgetCopyRow" : "",
                          ])}
                          data-copy-text={copyText}
                        >
                          <span className="transcript-blockHistory__inlineDiffLineNumber">
                            {row.newLineNumber?.toString() ?? row.oldLineNumber?.toString() ?? ""}
                          </span>
                          <span className="transcript-blockHistory__inlineDiffRowBody">
                            <span className="transcript-blockHistory__inlineDiffMarker">
                              {getInlineDiffRowMarker(row)}
                            </span>
                            <span className="transcript-blockHistory__inlineDiffContent">
                              <span className="transcript-blockHistory__inlineDiffContentText">
                                {row.text.length > 0 ? row.text : " "}
                              </span>
                            </span>
                          </span>
                        </div>
                      );
                    }))}
                </section>
              );
            })}
          </div>
        ) : isExpanded && effectiveInlineDiff ? (
          <div className="transcript-blockHistory__inlineDiff">
            <pre
              className="transcript-blockHistory__inlineDiffFallback transcript-blockHistory__commandWidgetCopyRow"
              data-copy-text={effectiveInlineDiff}
            >
              {effectiveInlineDiff}
            </pre>
          </div>
        ) : null}
        {inlineDiffStateMessage ? (
          <div
            className={classNames([
              "transcript-blockHistory__inlineDiffStateMessage",
              resolvedInlineDiffState?.status === "error" ? "transcript-blockHistory__inlineDiffStateMessage--error" : "",
            ])}
          >
            {inlineDiffStateMessage}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderMarkdownTableLine(line: MarkdownTableDisplayLine, key: string) {
  if (!line.cells || line.kind === "border") {
    return (
      <div
        key={key}
        className={classNames([
          "transcript-blockHistory__markdownTableLine",
          `transcript-blockHistory__markdownTableLine--${line.kind}`,
        ])}
      >
        {line.text}
      </div>
    );
  }

  const cells = line.cells;
  const cellKind = line.kind === "header" ? "header" : "body";
  const cellOccurrences = new Map<string, number>();
  return (
    <div
      key={key}
      className={classNames([
        "transcript-blockHistory__markdownTableLine",
        `transcript-blockHistory__markdownTableLine--${line.kind}`,
      ])}
    >
      <span className="transcript-blockHistory__markdownTableBorderGlyph">│ </span>
      {cells.map((cell, index) => {
        const cellIdentity = [
          cell.text,
          cell.highlightSpans?.map((span) => `${span.from}:${span.to}:${span.className}`).join("|") ?? "",
        ].join(":");
        const cellOccurrence = cellOccurrences.get(cellIdentity) ?? 0;
        cellOccurrences.set(cellIdentity, cellOccurrence + 1);
        return (
          <Fragment key={`${key}:cell:${cellIdentity}:${cellOccurrence}`}>
          <span
            className={classNames([
              "transcript-blockHistory__markdownTableCell",
              `transcript-blockHistory__markdownTableCell--${cellKind}`,
            ])}
          >
            {renderAnnotatedLineContent({
              text: cell.text,
              kind: "table",
              ...(cell.highlightSpans ? { highlightSpans: cell.highlightSpans } : {}),
            })}
          </span>
          <span className="transcript-blockHistory__markdownTableBorderGlyph">
            {index === cells.length - 1 ? " │" : " │ "}
          </span>
          </Fragment>
        );
      })}
    </div>
  );
}

function renderMarkdownTableWidget(line: AnnotatedLine, availableWidthPx: number, key: string) {
  if (!line.tableData) {
    return null;
  }

  const displayLines = layoutMarkdownTable(line.tableData, resolveMarkdownTableDisplayWidth(availableWidthPx));
  return (
    <div key={key} className="transcript-blockHistory__lineFrame">
      <div className="transcript-blockHistory__markdownTableSurface">
        <div className="transcript-blockHistory__markdownTableLines">
          {displayLines.map((displayLine, index) =>
            renderMarkdownTableLine(displayLine, `${key}:${displayLine.kind}:${index}`))}
        </div>
      </div>
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
  availableWidthPx: number,
) {
  const lineOccurrences = new Map<string, number>();
  const renderedLines: ReactNode[] = [];
  for (let lineIndex = 0; lineIndex < renderedBlock.lines.length; lineIndex += 1) {
    const line = renderedBlock.lines[lineIndex]!;
    const lineIdentity = getLineIdentity(line);
    const lineOccurrence = lineOccurrences.get(lineIdentity) ?? 0;
    lineOccurrences.set(lineIdentity, lineOccurrence + 1);
    const lineKey = `${lineIdentity}:${lineOccurrence}`;
    const lineSearchMatches = searchMatchesByLine.get(`${blockIndex}:${lineIndex}`) ?? [];
    if (line.kind === "table" && line.tableData) {
      renderedLines.push(renderMarkdownTableWidget(line, availableWidthPx, lineKey));
      while (lineIndex + 1 < renderedBlock.lines.length && renderedBlock.lines[lineIndex + 1]?.kind === "table") {
        lineIndex += 1;
      }
      continue;
    }
    if (line.kind === "divider") {
      renderedLines.push(renderDividerLine(line, lineKey));
      continue;
    }
    if (isSpacerLine(line)) {
      renderedLines.push(renderSpacerLine(line, lineKey));
      continue;
    }
    if (isCommandWidgetLine(line)) {
      renderedLines.push(
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
        </div>,
      );
      continue;
    }
    renderedLines.push(
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
      </div>,
    );
  }
  return (
    <section
      className={`transcript-blockHistory__block transcript-blockHistory__block--${renderedBlock.block.type}`}
      data-block-type={renderedBlock.block.type}
    >
      {renderedLines}
      {renderedBlock.block.type === "user-message" ? renderAttachmentSummary(renderedBlock.block.attachments) : null}
    </section>
  );
}

export function TranscriptHistoryBlocks({
  blocks,
  cacheKey = null,
  searchMatches = [],
  activeSearchMatchIndex = -1,
  expandedCommandSignatures = new Set<string>(),
  collapsedFileChangeSignatures = new Set<string>(),
  resolvedInlineDiffBySignature = new Map<string, InlineDiffResolutionStateLike>(),
  onToggleCommandWidget,
  onMeasuredHeightApplied,
  scrollTop = 0,
  viewportHeight = 0,
  scrollContainerRef,
  isScrolling = false,
}: TranscriptHistoryBlocksProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const renderedBlockCacheRef = useRef<Map<string, {
    readonly blocks: ReadonlyArray<TranscriptBlock>;
    readonly renderedBlocks: ReadonlyArray<CachedRenderedTranscriptBlockBase>;
  }>>(new Map());
  const renderedBlocksStateCacheRef = useRef<Map<string, CachedRenderedTranscriptBlocksState>>(new Map());
  const geometryCacheRef = useRef<Map<string, CachedBlockGeometryState>>(new Map());
  const baseRenderedBlocks = useMemo(() => {
    return measureTranscriptSwitchDiagnostic({
      label: "block-history-base-render",
      historyCacheKey: cacheKey,
      blockCount: blocks.length,
      cacheHit: cacheKey !== null && (renderedBlockCacheRef.current.get(cacheKey)?.blocks === blocks),
    }, () => {
      const cached =
        cacheKey !== null
          ? (renderedBlockCacheRef.current.get(cacheKey) ?? null)
          : null;
      if (cached && cached.blocks === blocks) {
        return cached.renderedBlocks;
      }
      const blockOccurrences = new Map<string, number>();
      const nextRenderedBlocks = blocks.map((block, blockIndex) => {
        const previousBlock = blockIndex > 0 ? blocks[blockIndex - 1] ?? null : null;
        const lines = blockToLines(block);
        const blockIdentity = getBlockIdentity(block, lines);
        const blockOccurrence = blockOccurrences.get(blockIdentity) ?? 0;
        blockOccurrences.set(blockIdentity, blockOccurrence + 1);
        return {
          block,
          lines,
          key: `${blockIdentity}:${blockOccurrence}`,
          showMessageTurnSeparator: shouldShowMessageTurnSeparator(previousBlock, block),
        } satisfies CachedRenderedTranscriptBlockBase;
      });
      if (cacheKey !== null) {
        renderedBlockCacheRef.current.set(cacheKey, {
          blocks,
          renderedBlocks: nextRenderedBlocks,
        });
      }
      return nextRenderedBlocks;
    });
  }, [blocks, cacheKey]);
  const renderedBlocks = useMemo(() => {
    return measureTranscriptSwitchDiagnostic({
      label: "block-history-rendered-blocks",
      historyCacheKey: cacheKey,
      blockCount: baseRenderedBlocks.length,
      cacheHit:
        cacheKey !== null
        && (() => {
          const cachedState = renderedBlocksStateCacheRef.current.get(cacheKey);
          return Boolean(
            cachedState
            && cachedState.baseRenderedBlocks === baseRenderedBlocks
            && cachedState.expandedCommandSignatures === expandedCommandSignatures
            && cachedState.collapsedFileChangeSignatures === collapsedFileChangeSignatures
            && cachedState.resolvedInlineDiffBySignature === resolvedInlineDiffBySignature,
          );
        })(),
    }, () => {
      const cachedState =
        cacheKey !== null
          ? (renderedBlocksStateCacheRef.current.get(cacheKey) ?? null)
          : null;
      if (
        cachedState
        && cachedState.baseRenderedBlocks === baseRenderedBlocks
        && cachedState.expandedCommandSignatures === expandedCommandSignatures
        && cachedState.collapsedFileChangeSignatures === collapsedFileChangeSignatures
        && cachedState.resolvedInlineDiffBySignature === resolvedInlineDiffBySignature
      ) {
        return cachedState.renderedBlocks;
      }

      const nextRenderedBlocks = baseRenderedBlocks.map((renderedBlock) => ({
        ...renderedBlock,
        measurementKey: `${getBlockMeasurementIdentity(
          renderedBlock.block,
          renderedBlock.lines,
          expandedCommandSignatures,
          collapsedFileChangeSignatures,
          resolvedInlineDiffBySignature,
        )}:${renderedBlock.key}`,
      } satisfies RenderedTranscriptBlock));

      if (cacheKey !== null) {
        renderedBlocksStateCacheRef.current.set(cacheKey, {
          baseRenderedBlocks,
          expandedCommandSignatures,
          collapsedFileChangeSignatures,
          resolvedInlineDiffBySignature,
          renderedBlocks: nextRenderedBlocks,
        });
      }

      return nextRenderedBlocks;
    });
  }, [
    baseRenderedBlocks,
    cacheKey,
    collapsedFileChangeSignatures,
    expandedCommandSignatures,
    resolvedInlineDiffBySignature,
  ]);

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
  const pendingScrollAnchorDeltaRef = useRef(0);
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

  const geometry = useMemo(() => {
    return measureTranscriptSwitchDiagnostic({
      label: "block-history-geometry",
      historyCacheKey: cacheKey,
      blockCount: renderedBlocks.length,
      cacheHit:
        cacheKey !== null
        && (() => {
          const cachedGeometry = geometryCacheRef.current.get(cacheKey);
          return Boolean(
            cachedGeometry
            && cachedGeometry.renderedBlocks === renderedBlocks
            && cachedGeometry.measuredHeights === measuredHeights
            && cachedGeometry.availableWidthPx === availableWidthPx
            && cachedGeometry.expandedCommandSignatures === expandedCommandSignatures
            && cachedGeometry.collapsedFileChangeSignatures === collapsedFileChangeSignatures
            && cachedGeometry.resolvedInlineDiffBySignature === resolvedInlineDiffBySignature,
          );
        })(),
    }, () => {
      const cachedGeometry =
        cacheKey !== null
          ? (geometryCacheRef.current.get(cacheKey) ?? null)
          : null;
      if (
        cachedGeometry
        && cachedGeometry.renderedBlocks === renderedBlocks
        && cachedGeometry.measuredHeights === measuredHeights
        && cachedGeometry.availableWidthPx === availableWidthPx
        && cachedGeometry.expandedCommandSignatures === expandedCommandSignatures
        && cachedGeometry.collapsedFileChangeSignatures === collapsedFileChangeSignatures
        && cachedGeometry.resolvedInlineDiffBySignature === resolvedInlineDiffBySignature
      ) {
        return cachedGeometry;
      }

      const blockHeights = renderedBlocks.map((renderedBlock, index) =>
        measuredHeights.get(renderedBlock.measurementKey)
        ?? (
          estimateRenderedBlockHeight(
            renderedBlock,
            availableWidthPx,
            expandedCommandSignatures,
            collapsedFileChangeSignatures,
            resolvedInlineDiffBySignature,
          )
          + (index > 0 ? DEFAULT_BLOCK_GAP_PX : 0)
        ));
      const blockOffsets: number[] = [];
      let offset = 0;
      for (const height of blockHeights) {
        blockOffsets.push(offset);
        offset += height ?? 0;
      }
      const totalHeight = blockHeights.reduce((sum, height) => sum + height, 0);
      const blockIndexByKey = new Map(renderedBlocks.map((renderedBlock, index) => [renderedBlock.measurementKey, index]));
      const nextGeometry = {
        renderedBlocks,
        measuredHeights,
        availableWidthPx,
        expandedCommandSignatures,
        collapsedFileChangeSignatures,
        resolvedInlineDiffBySignature,
        blockHeights,
        blockOffsets,
        totalHeight,
        blockIndexByKey,
      } satisfies CachedBlockGeometryState;

      if (cacheKey !== null) {
        geometryCacheRef.current.set(cacheKey, nextGeometry);
      }

      return nextGeometry;
    });
  }, [
    availableWidthPx,
    cacheKey,
    collapsedFileChangeSignatures,
    expandedCommandSignatures,
    measuredHeights,
    renderedBlocks,
    resolvedInlineDiffBySignature,
  ]);
  const { blockHeights, blockIndexByKey, blockOffsets, totalHeight } = geometry;

  const activeSearchBlockIndex =
    activeSearchMatchIndex >= 0
      ? searchMatches[activeSearchMatchIndex]?.blockIndex ?? -1
      : -1;

  const applyMeasuredHeightUpdates = useCallback((updates: ReadonlyMap<string, number>) => {
    const measurementUpdates: TranscriptHistoryMeasurementUpdate[] = [];
    const nextMeasuredHeights = new Map<string, number>();
    let scrollAnchorDelta = 0;
    for (const [key, nextHeight] of updates) {
      const globalIndex = blockIndexByKey.get(key);
      if (globalIndex === undefined) {
        continue;
      }
      const previousHeight = blockHeights[globalIndex] ?? 0;
      if (nextHeight <= 0 || previousHeight === nextHeight) {
        continue;
      }
      const blockTop = blockOffsets[globalIndex] ?? 0;
      const blockBottom = blockTop + previousHeight;
      if (blockBottom <= scrollTop + 0.5) {
        if (isScrolling) {
          continue;
        }
        scrollAnchorDelta += nextHeight - previousHeight;
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
      nextMeasuredHeights.set(key, nextHeight);
    }
    if (nextMeasuredHeights.size === 0) {
      return;
    }
    if (Math.abs(scrollAnchorDelta) > 0.5) {
      pendingScrollAnchorDeltaRef.current += scrollAnchorDelta;
    }
    setMeasuredHeights((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, nextHeight] of nextMeasuredHeights) {
        if (next.get(key) === nextHeight) {
          continue;
        }
        next.set(key, nextHeight);
        changed = true;
      }
      return changed ? next : current;
    });
    if (measurementUpdates.length > 0) {
      onMeasuredHeightApplied?.(measurementUpdates);
    }
  }, [blockHeights, blockIndexByKey, blockOffsets, isScrolling, onMeasuredHeightApplied, renderedBlocks, scrollTop]);

  useLayoutEffect(() => {
    const scrollAnchorDelta = pendingScrollAnchorDeltaRef.current;
    if (Math.abs(scrollAnchorDelta) <= 0.5) {
      return;
    }
    pendingScrollAnchorDeltaRef.current = 0;
    const scrollContainer = scrollContainerRef?.current;
    if (!scrollContainer) {
      return;
    }
    scrollContainer.scrollTop += scrollAnchorDelta;
  }, [measuredHeights, scrollContainerRef]);

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
    const viewportTop = scrollTop;
    const viewportBottom = scrollTop + viewportHeight;
    const candidates: Array<{
      readonly renderedBlock: RenderedTranscriptBlock;
      readonly blockIndex: number;
      readonly distanceFromViewport: number;
    }> = [];
    renderedBlocks.forEach((renderedBlock, blockIndex) => {
      if (blockIndex >= virtualWindow.startIndex && blockIndex < virtualWindow.endIndex) {
        return;
      }
      if (measuredHeights.has(renderedBlock.measurementKey)) {
        return;
      }
      const blockTop = blockOffsets[blockIndex] ?? 0;
      const blockBottom = blockTop + (blockHeights[blockIndex] ?? 0);
      const distanceFromViewport =
        blockBottom <= viewportTop
          ? viewportTop - blockBottom
          : blockTop >= viewportBottom
            ? blockTop - viewportBottom
            : 0;
      candidates.push({ renderedBlock, blockIndex, distanceFromViewport });
    });
    return candidates
      .toSorted((left, right) =>
        left.distanceFromViewport === right.distanceFromViewport
          ? left.blockIndex - right.blockIndex
          : left.distanceFromViewport - right.distanceFromViewport)
      .slice(0, DEFAULT_PREMEASURE_BLOCK_LIMIT)
      .map(({ renderedBlock, blockIndex }) => ({ renderedBlock, blockIndex }));
  }, [
    blockHeights,
    blockOffsets,
    measuredHeights,
    renderedBlocks,
    scrollTop,
    viewportHeight,
    virtualWindow.endIndex,
    virtualWindow.startIndex,
  ]);

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
              className={classNames([
                "transcript-blockHistory__virtualBlock",
                renderedBlock.showMessageTurnSeparator ? "transcript-blockHistory__virtualBlock--messageTurnSeparator" : "",
              ])}
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
                availableWidthPx,
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
              className={classNames([
                "transcript-blockHistory__measurementProbe",
                renderedBlock.showMessageTurnSeparator ? "transcript-blockHistory__measurementProbe--messageTurnSeparator" : "",
              ])}
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
                availableWidthPx,
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
