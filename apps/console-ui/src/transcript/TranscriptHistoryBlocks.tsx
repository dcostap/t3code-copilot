import {
  Fragment,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { measureElement as measureVirtualElement, useVirtualizer } from "@tanstack/react-virtual";

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
import { recordSlowTranscriptSwitchDiagnostic } from "../transcriptSwitchDiagnostics";
import { deriveTranscriptBlockRowDefinitions, type TranscriptBlockRowDefinition } from "./transcriptRows";

interface TranscriptHistoryBlocksProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly precomputedBlockLines?: ReadonlyArray<ReadonlyArray<AnnotatedLine>>;
  readonly precomputedBlockRows?: ReadonlyArray<ReadonlyArray<TranscriptBlockRowDefinition>>;
  readonly cacheKey?: string | null;
  readonly searchMatches?: ReadonlyArray<TranscriptHistorySearchMatch>;
  readonly activeSearchMatchIndex?: number;
  readonly expandedCommandSignatures?: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures?: ReadonlySet<string>;
  readonly resolvedInlineDiffBySignature?: ReadonlyMap<string, InlineDiffResolutionStateLike>;
  readonly onToggleCommandWidget?: ((input: ToggleCommandWidgetInput) => void) | undefined;
  readonly scrollTop?: number;
  readonly viewportHeight?: number;
  readonly scrollContainerRef?: { readonly current: HTMLDivElement | null } | undefined;
  readonly isScrolling?: boolean | undefined;
}

export interface TranscriptHistorySearchMatch {
  readonly blockIndex: number;
  readonly lineIndex: number;
  readonly from: number;
  readonly to: number;
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
  readonly rows: ReadonlyArray<TranscriptBlockRowDefinition>;
  readonly key: string;
  readonly showMessageTurnSeparator: boolean;
}

interface TranscriptBlockRowBase {
  readonly key: string;
  readonly lineIndexStart: number;
  readonly lineIndexEnd: number;
}

type VirtualizedTranscriptRow =
  | {
      readonly kind: "content";
      readonly key: string;
      readonly blockIndex: number;
      readonly blockType: TranscriptBlock["type"];
      readonly row: TranscriptBlockRow;
      readonly showMessageTurnSeparator: boolean;
      readonly hasLeadingGap: boolean;
    }
  | {
      readonly kind: "attachmentSummary";
      readonly key: string;
      readonly blockIndex: number;
      readonly blockType: TranscriptBlock["type"];
      readonly attachments: ReadonlyArray<TranscriptImageAttachment>;
      readonly showMessageTurnSeparator: boolean;
      readonly hasLeadingGap: boolean;
    };

const DEFAULT_ROW_OVERSCAN = 20;
const DEFAULT_LINE_HEIGHT_PX = 20;
const DEFAULT_ESTIMATED_CHARACTER_WIDTH_PX = 7.8;
const DEFAULT_WIDTH_BUCKET_PX = 32;
const DEFAULT_BLOCK_GAP_PX = 4;
const ALWAYS_UNVIRTUALIZED_TAIL_BLOCKS = 8;
const renderedBlockCache = new Map<string, {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly renderedBlocks: ReadonlyArray<RenderedTranscriptBlock>;
}>();
const flattenedRowCache = new Map<string, {
  readonly renderedBlocks: ReadonlyArray<RenderedTranscriptBlock>;
  readonly rows: ReadonlyArray<VirtualizedTranscriptRow>;
}>();
const rowEstimateCache = new Map<string, number>();

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
  const rows = resolveRenderedBlockRows(renderedBlock, 0, new Map());
  let estimatedHeight = rows.reduce(
    (sum, row) =>
      sum
      + estimateRenderedBlockRowHeight(
          row,
          availableWidthPx,
          expandedCommandSignatures,
          collapsedFileChangeSignatures,
          resolvedInlineDiffBySignature,
        ),
    0,
  );
  if (renderedBlock.block.type === "user-message" && renderedBlock.block.attachments?.length) {
    estimatedHeight += estimateAttachmentSummaryHeight(renderedBlock.block.attachments, availableWidthPx);
  }
  return Math.max(DEFAULT_LINE_HEIGHT_PX, Math.ceil(estimatedHeight));
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
      rows: deriveTranscriptBlockRowDefinitions(lines),
      key: getBlockIdentity(block, lines),
      showMessageTurnSeparator: false,
    },
    availableWidthPx,
    expandedCommandSignatures,
    collapsedFileChangeSignatures,
    resolvedInlineDiffBySignature,
  );
}

function isActiveTranscriptBlock(block: TranscriptBlock) {
  switch (block.type) {
    case "assistant-text":
      return block.streaming;
    case "work-group":
    case "tool-call":
      return block.status === "running";
    case "user-input-request":
      return !block.resolved;
    case "sending-state":
    case "waiting-state":
    case "working-state":
      return true;
    default:
      return false;
  }
}

export function findFirstUnvirtualizedTranscriptBlockIndex(blocks: ReadonlyArray<TranscriptBlock>) {
  const firstTailBlockIndex = Math.max(blocks.length - ALWAYS_UNVIRTUALIZED_TAIL_BLOCKS, 0);
  const firstActiveBlockIndex = blocks.findIndex((block) => isActiveTranscriptBlock(block));
  if (firstActiveBlockIndex < 0) {
    return blocks.length;
  }

  for (let index = firstActiveBlockIndex - 1; index >= 0; index -= 1) {
    const previousBlock = blocks[index];
    if (!previousBlock) {
      continue;
    }
    if (previousBlock.type === "user-message") {
      return Math.min(index, firstTailBlockIndex);
    }
    if (previousBlock.type === "assistant-text" && !previousBlock.streaming) {
      break;
    }
  }

  return Math.min(firstActiveBlockIndex, firstTailBlockIndex);
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
  precomputedBlockLines?: ReadonlyArray<ReadonlyArray<AnnotatedLine>>,
): ReadonlyArray<TranscriptHistorySearchMatch> {
  if (query.length === 0) {
    return [];
  }

  const matches: TranscriptHistorySearchMatch[] = [];
  blocks.forEach((block, blockIndex) => {
    (precomputedBlockLines?.[blockIndex] ?? blockToLines(block)).forEach((line, lineIndex) => {
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

function TranscriptDividerRow({ line }: { readonly line: AnnotatedLine }) {
  return (
    <div
      className="transcript-blockHistory__divider"
      aria-hidden="true"
    >
      {line.text}
    </div>
  );
}

function TranscriptSpacerRow({ line }: { readonly line: AnnotatedLine }) {
  return (
    <div
      className={classNames([
        "transcript-blockHistory__spacer",
        `transcript-blockHistory__spacer--${line.kind}`,
      ])}
      aria-hidden="true"
    />
  );
}

function TranscriptAttachmentSummary({
  attachments,
}: {
  readonly attachments: ReadonlyArray<TranscriptImageAttachment> | undefined;
}) {
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

function TranscriptCommandWidgetRow({
  line,
  searchMatches,
  expandedCommandSignatures,
  collapsedFileChangeSignatures,
  resolvedInlineDiffBySignature,
  onToggleCommandWidget,
}: {
  readonly line: AnnotatedLine;
  readonly searchMatches: ReadonlyArray<IndexedSearchMatch>;
  readonly expandedCommandSignatures: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures: ReadonlySet<string>;
  readonly resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>;
  readonly onToggleCommandWidget: TranscriptHistoryBlocksProps["onToggleCommandWidget"];
}) {
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
      {renderAnnotatedLineContent(line, searchMatches)}
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
          data-command-widget-signature={signature}
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

function TranscriptMarkdownTableDisplayLine({
  line,
  lineKey,
}: {
  readonly line: MarkdownTableDisplayLine;
  readonly lineKey: string;
}) {
  if (!line.cells || line.kind === "border") {
    return (
      <div
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
          <Fragment key={`${lineKey}:cell:${cellIdentity}:${cellOccurrence}`}>
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

function TranscriptMarkdownTableRow({
  line,
  availableWidthPx,
  rowKey,
}: {
  readonly line: AnnotatedLine;
  readonly availableWidthPx: number;
  readonly rowKey: string;
}) {
  if (!line.tableData) {
    return null;
  }

  const displayLines = layoutMarkdownTable(line.tableData, resolveMarkdownTableDisplayWidth(availableWidthPx));
  const displayLineOccurrences = new Map<string, number>();
  return (
    <div className="transcript-blockHistory__lineFrame">
      <div className="transcript-blockHistory__markdownTableSurface">
        <div className="transcript-blockHistory__markdownTableLines">
          {displayLines.map((displayLine) => {
            const displayLineIdentity = `${displayLine.kind}:${displayLine.text}`;
            const displayLineOccurrence = displayLineOccurrences.get(displayLineIdentity) ?? 0;
            displayLineOccurrences.set(displayLineIdentity, displayLineOccurrence + 1);
            const displayLineKey = `${rowKey}:${displayLineIdentity}:${displayLineOccurrence}`;
            return (
              <TranscriptMarkdownTableDisplayLine
                key={displayLineKey}
                line={displayLine}
                lineKey={displayLineKey}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

type TranscriptBlockRow =
  | (TranscriptBlockRowBase & {
      readonly kind: "table";
      readonly line: AnnotatedLine;
    })
  | (TranscriptBlockRowBase & {
      readonly kind: "divider";
      readonly line: AnnotatedLine;
    })
  | (TranscriptBlockRowBase & {
      readonly kind: "spacer";
      readonly line: AnnotatedLine;
    })
  | (TranscriptBlockRowBase & {
      readonly kind: "commandWidget";
      readonly line: AnnotatedLine;
      readonly searchMatches: ReadonlyArray<IndexedSearchMatch>;
    })
  | (TranscriptBlockRowBase & {
      readonly kind: "line";
      readonly line: AnnotatedLine;
      readonly searchMatches: ReadonlyArray<IndexedSearchMatch>;
    });

function resolveRenderedBlockRows(
  renderedBlock: RenderedTranscriptBlock,
  blockIndex: number,
  searchMatchesByLine: ReadonlyMap<string, ReadonlyArray<IndexedSearchMatch>>,
): ReadonlyArray<TranscriptBlockRow> {
  return renderedBlock.rows.flatMap((row): ReadonlyArray<TranscriptBlockRow> => {
    const line = renderedBlock.lines[row.lineIndexStart];
    if (!line) {
      return [];
    }
    const lineSearchMatches = searchMatchesByLine.get(`${blockIndex}:${row.lineIndexStart}`) ?? [];
    switch (row.kind) {
      case "table":
        return [{ kind: "table", key: row.key, lineIndexStart: row.lineIndexStart, lineIndexEnd: row.lineIndexEnd, line }];
      case "divider":
        return [{ kind: "divider", key: row.key, lineIndexStart: row.lineIndexStart, lineIndexEnd: row.lineIndexEnd, line }];
      case "spacer":
        return [{ kind: "spacer", key: row.key, lineIndexStart: row.lineIndexStart, lineIndexEnd: row.lineIndexEnd, line }];
      case "commandWidget":
        return [{
          kind: "commandWidget",
          key: row.key,
          lineIndexStart: row.lineIndexStart,
          lineIndexEnd: row.lineIndexEnd,
          line,
          searchMatches: lineSearchMatches,
        }];
      case "line":
        return [{
          kind: "line",
          key: row.key,
          lineIndexStart: row.lineIndexStart,
          lineIndexEnd: row.lineIndexEnd,
          line,
          searchMatches: lineSearchMatches,
        }];
    }
  });
}

function estimateAttachmentSummaryHeight(
  attachments: ReadonlyArray<TranscriptImageAttachment>,
  availableWidthPx: number,
) {
  return Math.max(
    DEFAULT_LINE_HEIGHT_PX,
    Math.ceil(
      estimateWrappedTextRows(
        `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}: ${attachments.map((attachment) => attachment.name).join(", ")}`,
        Math.max(120, availableWidthPx),
      ) * DEFAULT_LINE_HEIGHT_PX,
    ),
  );
}

function estimateRenderedBlockRowHeight(
  row: TranscriptBlockRow,
  availableWidthPx: number,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
) {
  const plainLineWidthPx = Math.max(120, availableWidthPx);
  const commandSurfaceWidthPx = Math.max(120, availableWidthPx - 28);
  const commandBodyWidthPx = Math.max(120, availableWidthPx - 28);
  const inlineDiffContentWidthPx = Math.max(72, commandBodyWidthPx - 80);
  switch (row.kind) {
    case "spacer":
      return Math.ceil(DEFAULT_LINE_HEIGHT_PX * 0.6);
    case "table":
      if (!row.line.tableData) {
        return DEFAULT_LINE_HEIGHT_PX;
      }
      return Math.max(
        DEFAULT_LINE_HEIGHT_PX,
        Math.ceil(
          layoutMarkdownTable(row.line.tableData, resolveMarkdownTableDisplayWidth(availableWidthPx)).length
          * DEFAULT_LINE_HEIGHT_PX
          + 8,
        ),
      );
    case "divider":
    case "line":
      return Math.max(DEFAULT_LINE_HEIGHT_PX, estimateWrappedTextRows(row.line.text, plainLineWidthPx) * DEFAULT_LINE_HEIGHT_PX);
    case "commandWidget": {
      const line = row.line;
      const isExpanded = isExpandedCommandLine(line, expandedCommandSignatures, collapsedFileChangeSignatures);
      const resolvedInlineDiffState = line.commandWidgetSignature
        ? resolvedInlineDiffBySignature.get(line.commandWidgetSignature)
        : undefined;
      const effectiveInlineDiff =
        line.inlineUnifiedDiff
        ?? (resolvedInlineDiffState?.status === "ready" ? resolvedInlineDiffState.diff : undefined);
      let estimatedLineCount =
        !isExpanded && hasExpandableCommandSummary(line)
          ? 1
          : estimateWrappedTextRows(line.text, commandSurfaceWidthPx);
      estimatedLineCount += 1;
      if (!isExpanded) {
        return Math.max(32, Math.ceil(estimatedLineCount * DEFAULT_LINE_HEIGHT_PX + 12));
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
      return Math.max(32, Math.ceil(estimatedLineCount * DEFAULT_LINE_HEIGHT_PX + 16));
    }
  }
}

function estimateVirtualizedTranscriptRowHeight(
  row: VirtualizedTranscriptRow,
  availableWidthPx: number,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
) {
  const baseHeight =
    row.kind === "attachmentSummary"
      ? estimateAttachmentSummaryHeight(row.attachments, availableWidthPx)
      : estimateRenderedBlockRowHeight(
          row.row,
          availableWidthPx,
          expandedCommandSignatures,
          collapsedFileChangeSignatures,
          resolvedInlineDiffBySignature,
        );
  return baseHeight + (row.hasLeadingGap ? DEFAULT_BLOCK_GAP_PX : 0);
}

function getVirtualizedTranscriptRowEstimateKey(
  row: VirtualizedTranscriptRow,
  availableWidthPx: number,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
) {
  if (row.kind === "attachmentSummary") {
    return `attachment:${row.key}:${availableWidthPx}`;
  }
  if (row.row.kind === "commandWidget") {
    return [
      "commandWidget",
      row.key,
      availableWidthPx,
      getCommandWidgetMeasurementIdentity(
        row.row.line,
        expandedCommandSignatures,
        collapsedFileChangeSignatures,
        resolvedInlineDiffBySignature,
      ),
    ].join(":");
  }
  if (row.row.kind === "table") {
    return `table:${row.key}:${resolveMarkdownTableDisplayWidth(availableWidthPx)}`;
  }
  return `${row.row.kind}:${row.key}:${availableWidthPx}`;
}

function flattenVirtualizedTranscriptRows(
  renderedBlocks: ReadonlyArray<RenderedTranscriptBlock>,
  searchMatchesByLine: ReadonlyMap<string, ReadonlyArray<IndexedSearchMatch>>,
  includeRowIndexByBlockLine: boolean,
) {
  const rows: VirtualizedTranscriptRow[] = [];
  const rowIndexByBlockLine = includeRowIndexByBlockLine ? new Map<string, number>() : null;
  renderedBlocks.forEach((renderedBlock, blockIndex) => {
    const derivedRows = resolveRenderedBlockRows(renderedBlock, blockIndex, searchMatchesByLine);
    derivedRows.forEach((row, rowIndexWithinBlock) => {
      const flattenedRow = {
        kind: "content",
        key: `${renderedBlock.key}:row:${row.key}`,
        blockIndex,
        blockType: renderedBlock.block.type,
        row,
        showMessageTurnSeparator: renderedBlock.showMessageTurnSeparator && rowIndexWithinBlock === 0,
        hasLeadingGap: blockIndex > 0 && rowIndexWithinBlock === 0,
      } satisfies VirtualizedTranscriptRow;
      const flattenedRowIndex = rows.length;
      rows.push(flattenedRow);
      if (rowIndexByBlockLine) {
        for (let lineIndex = row.lineIndexStart; lineIndex <= row.lineIndexEnd; lineIndex += 1) {
          rowIndexByBlockLine.set(`${blockIndex}:${lineIndex}`, flattenedRowIndex);
        }
      }
    });
    if (renderedBlock.block.type === "user-message" && renderedBlock.block.attachments && renderedBlock.block.attachments.length > 0) {
      rows.push({
        kind: "attachmentSummary",
        key: `${renderedBlock.key}:attachments`,
        blockIndex,
        blockType: renderedBlock.block.type,
        attachments: renderedBlock.block.attachments,
        showMessageTurnSeparator: false,
        hasLeadingGap: false,
      });
    }
  });
  return {
    rows,
    rowIndexByBlockLine: rowIndexByBlockLine ?? new Map<string, number>(),
  };
}

function renderVirtualizedTranscriptRow(
  row: VirtualizedTranscriptRow,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>,
  onToggleCommandWidget: TranscriptHistoryBlocksProps["onToggleCommandWidget"],
  availableWidthPx: number,
) {
  if (row.kind === "attachmentSummary") {
    return <TranscriptAttachmentSummary attachments={row.attachments} />;
  }
  return (
    <TranscriptBlockRowView
      row={row.row}
      expandedCommandSignatures={expandedCommandSignatures}
      collapsedFileChangeSignatures={collapsedFileChangeSignatures}
      resolvedInlineDiffBySignature={resolvedInlineDiffBySignature}
      onToggleCommandWidget={onToggleCommandWidget}
      availableWidthPx={availableWidthPx}
    />
  );
}

function TranscriptPlainLineRow({
  line,
  searchMatches,
}: {
  readonly line: AnnotatedLine;
  readonly searchMatches: ReadonlyArray<IndexedSearchMatch>;
}) {
  return (
    <div className="transcript-blockHistory__lineFrame">
      <div
        className={classNames([
          "transcript-blockHistory__line",
          `transcript-blockHistory__line--${line.kind}`,
          ...(line.extraClasses ?? []),
        ])}
      >
        {renderAnnotatedLineContent(line, searchMatches)}
      </div>
    </div>
  );
}

function TranscriptBlockRowView({
  row,
  expandedCommandSignatures,
  collapsedFileChangeSignatures,
  resolvedInlineDiffBySignature,
  onToggleCommandWidget,
  availableWidthPx,
}: {
  readonly row: TranscriptBlockRow;
  readonly expandedCommandSignatures: ReadonlySet<string>;
  readonly collapsedFileChangeSignatures: ReadonlySet<string>;
  readonly resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionStateLike>;
  readonly onToggleCommandWidget: TranscriptHistoryBlocksProps["onToggleCommandWidget"];
  readonly availableWidthPx: number;
}) {
  switch (row.kind) {
    case "table":
      return <TranscriptMarkdownTableRow line={row.line} availableWidthPx={availableWidthPx} rowKey={row.key} />;
    case "divider":
      return <TranscriptDividerRow line={row.line} />;
    case "spacer":
      return <TranscriptSpacerRow line={row.line} />;
    case "commandWidget":
      return (
        <div className="transcript-blockHistory__lineFrame">
          <TranscriptCommandWidgetRow
            line={row.line}
            searchMatches={row.searchMatches}
            expandedCommandSignatures={expandedCommandSignatures}
            collapsedFileChangeSignatures={collapsedFileChangeSignatures}
            resolvedInlineDiffBySignature={resolvedInlineDiffBySignature}
            onToggleCommandWidget={onToggleCommandWidget}
          />
        </div>
      );
    case "line":
      return <TranscriptPlainLineRow line={row.line} searchMatches={row.searchMatches} />;
  }
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
  const rows = resolveRenderedBlockRows(renderedBlock, blockIndex, searchMatchesByLine);
  return (
    <section
      className={`transcript-blockHistory__block transcript-blockHistory__block--${renderedBlock.block.type}`}
      data-block-type={renderedBlock.block.type}
    >
      {rows.map((row) => (
        <TranscriptBlockRowView
          key={row.key}
          row={row}
          expandedCommandSignatures={expandedCommandSignatures}
          collapsedFileChangeSignatures={collapsedFileChangeSignatures}
          resolvedInlineDiffBySignature={resolvedInlineDiffBySignature}
          onToggleCommandWidget={onToggleCommandWidget}
          availableWidthPx={availableWidthPx}
        />
      ))}
      {renderedBlock.block.type === "user-message"
        ? <TranscriptAttachmentSummary attachments={renderedBlock.block.attachments} />
        : null}
    </section>
  );
}

export function TranscriptHistoryBlocks({
  blocks,
  precomputedBlockLines,
  precomputedBlockRows,
  cacheKey = null,
  searchMatches = [],
  activeSearchMatchIndex = -1,
  expandedCommandSignatures = new Set<string>(),
  collapsedFileChangeSignatures = new Set<string>(),
  resolvedInlineDiffBySignature = new Map<string, InlineDiffResolutionStateLike>(),
  onToggleCommandWidget,
  scrollTop = 0,
  viewportHeight = 0,
  scrollContainerRef,
  isScrolling = false,
}: TranscriptHistoryBlocksProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const staticBlockRefs = useRef(new Map<string, HTMLDivElement>());
  const baseRenderedBlocks = useMemo(() => {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const cached =
      cacheKey !== null
        ? (renderedBlockCache.get(cacheKey) ?? null)
        : null;
    if (cached && cached.blocks === blocks) {
      recordSlowTranscriptSwitchDiagnostic({
        label: "base-rendered-blocks",
        historyCacheKey: cacheKey,
        blockCount: cached.renderedBlocks.length,
        cacheHit: true,
      }, startedAt, 12);
      return cached.renderedBlocks;
    }
    const blockOccurrences = new Map<string, number>();
    const nextRenderedBlocks = blocks.map((block, blockIndex) => {
      const previousBlock = blockIndex > 0 ? blocks[blockIndex - 1] ?? null : null;
      const lines = precomputedBlockLines?.[blockIndex] ?? blockToLines(block);
      const rows = precomputedBlockRows?.[blockIndex] ?? deriveTranscriptBlockRowDefinitions(lines);
      const blockIdentity = getBlockIdentity(block, lines);
      const blockOccurrence = blockOccurrences.get(blockIdentity) ?? 0;
      blockOccurrences.set(blockIdentity, blockOccurrence + 1);
      return {
        block,
        lines,
        rows,
        key: `${blockIdentity}:${blockOccurrence}`,
        showMessageTurnSeparator: shouldShowMessageTurnSeparator(previousBlock, block),
      } satisfies RenderedTranscriptBlock;
    });
    if (cacheKey !== null) {
      renderedBlockCache.set(cacheKey, {
        blocks,
        renderedBlocks: nextRenderedBlocks,
      });
    }
    recordSlowTranscriptSwitchDiagnostic({
      label: "base-rendered-blocks",
      historyCacheKey: cacheKey,
      blockCount: nextRenderedBlocks.length,
      cacheHit: false,
    }, startedAt, 12);
    return nextRenderedBlocks;
  }, [blocks, cacheKey, precomputedBlockLines, precomputedBlockRows]);

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

  const [availableWidthPx, setAvailableWidthPx] = useState(0);
  const setStaticBlockRef = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) {
      staticBlockRefs.current.set(key, node);
    } else {
      staticBlockRefs.current.delete(key);
    }
  }, []);

  useLayoutEffect(() => {
    const element = scrollContainerRef?.current ?? rootRef.current;
    if (!element || typeof window === "undefined") {
      return undefined;
    }

    let frameId: number | null = null;
    const syncWidth = (measuredWidth?: number) => {
      const widthPx = measuredWidth ?? element.clientWidth;
      const nextWidth = Math.max(0, Math.floor(widthPx / DEFAULT_WIDTH_BUCKET_PX) * DEFAULT_WIDTH_BUCKET_PX);
      setAvailableWidthPx((current) => current === nextWidth ? current : nextWidth);
    };
    const scheduleWidthSync = (measuredWidth?: number) => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncWidth(measuredWidth);
      });
    };

    syncWidth();

    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }

    const observer = new ResizeObserver((entries) => {
      scheduleWidthSync(entries[0]?.contentRect.width);
    });
    observer.observe(element);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [scrollContainerRef]);

  const scrollContainer = scrollContainerRef?.current ?? null;
  const shouldVirtualize = Boolean(scrollContainer && viewportHeight > 0);
  const firstUnvirtualizedBlockIndex = useMemo(
    () =>
      shouldVirtualize
        ? findFirstUnvirtualizedTranscriptBlockIndex(baseRenderedBlocks.map(({ block }) => block))
        : baseRenderedBlocks.length,
    [baseRenderedBlocks, shouldVirtualize],
  );
  const virtualizedBlocks = useMemo(
    () => shouldVirtualize ? baseRenderedBlocks.slice(0, firstUnvirtualizedBlockIndex) : [],
    [baseRenderedBlocks, firstUnvirtualizedBlockIndex, shouldVirtualize],
  );
  const nonVirtualizedBlocks = useMemo(
    () => shouldVirtualize ? baseRenderedBlocks.slice(firstUnvirtualizedBlockIndex) : baseRenderedBlocks,
    [baseRenderedBlocks, firstUnvirtualizedBlockIndex, shouldVirtualize],
  );
  const shouldBuildSearchRowIndex = activeSearchMatchIndex >= 0;
  const { rows: virtualizedRows, rowIndexByBlockLine } = useMemo(() => {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!shouldBuildSearchRowIndex && cacheKey !== null) {
      const cached = flattenedRowCache.get(cacheKey) ?? null;
      if (cached && cached.renderedBlocks === virtualizedBlocks) {
        recordSlowTranscriptSwitchDiagnostic({
          label: "flatten-virtualized-rows",
          historyCacheKey: cacheKey,
          rowCount: cached.rows.length,
          cacheHit: true,
        }, startedAt, 12);
        return {
          rows: cached.rows,
          rowIndexByBlockLine: new Map<string, number>(),
        };
      }
    }

    const nextFlattenedRows = flattenVirtualizedTranscriptRows(
      virtualizedBlocks,
      searchMatchesByLine,
      shouldBuildSearchRowIndex,
    );
    if (!shouldBuildSearchRowIndex && cacheKey !== null) {
      flattenedRowCache.set(cacheKey, {
        renderedBlocks: virtualizedBlocks,
        rows: nextFlattenedRows.rows,
      });
    }
    recordSlowTranscriptSwitchDiagnostic({
      label: "flatten-virtualized-rows",
      historyCacheKey: cacheKey,
      rowCount: nextFlattenedRows.rows.length,
      cacheHit: false,
    }, startedAt, 12);
    return nextFlattenedRows;
  }, [cacheKey, searchMatchesByLine, shouldBuildSearchRowIndex, virtualizedBlocks]);

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? virtualizedRows.length : 0,
    getScrollElement: () => scrollContainer,
    initialOffset: scrollTop,
    initialRect: {
      width: availableWidthPx,
      height: viewportHeight,
    },
    getItemKey: (index) => virtualizedRows[index]?.key ?? index,
    estimateSize: (index) => {
      const row = virtualizedRows[index];
      if (!row) {
        return DEFAULT_LINE_HEIGHT_PX;
      }
      const estimateKey = getVirtualizedTranscriptRowEstimateKey(
        row,
        availableWidthPx,
        expandedCommandSignatures,
        collapsedFileChangeSignatures,
        resolvedInlineDiffBySignature,
      );
      const cachedEstimate = rowEstimateCache.get(estimateKey);
      if (cachedEstimate !== undefined) {
        return cachedEstimate;
      }
      const nextEstimate = estimateVirtualizedTranscriptRowHeight(
        row,
        availableWidthPx,
        expandedCommandSignatures,
        collapsedFileChangeSignatures,
        resolvedInlineDiffBySignature,
      );
      rowEstimateCache.set(estimateKey, nextEstimate);
      return nextEstimate;
    },
    measureElement: (element, entry, instance) => {
      const measuredSize = measureVirtualElement(element, entry, instance);
      const rowIndex = Number(element.getAttribute("data-index"));
      if (Number.isFinite(rowIndex)) {
        const row = virtualizedRows[rowIndex];
        if (row) {
          rowEstimateCache.set(
            getVirtualizedTranscriptRowEstimateKey(
              row,
              availableWidthPx,
              expandedCommandSignatures,
              collapsedFileChangeSignatures,
              resolvedInlineDiffBySignature,
            ),
            measuredSize,
          );
        }
      }
      return measuredSize;
    },
    useAnimationFrameWithResizeObserver: true,
    overscan: DEFAULT_ROW_OVERSCAN,
  });

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      if (isScrolling) {
        return false;
      }
      const scrollOffset = instance.scrollOffset ?? scrollTop;
      return item.start + item.size <= scrollOffset + 0.5;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [isScrolling, rowVirtualizer, scrollTop]);

  useEffect(() => {
    rowVirtualizer.measure();
  }, [
    availableWidthPx,
    collapsedFileChangeSignatures,
    expandedCommandSignatures,
    resolvedInlineDiffBySignature,
    rowVirtualizer,
    virtualizedRows,
  ]);

  const visibleVirtualRows = useMemo(() => {
    if (!shouldVirtualize) {
      return [];
    }
    return rowVirtualizer.getVirtualItems().flatMap((virtualItem) => {
      const row = virtualizedRows[virtualItem.index];
      return row
        ? [{
            row,
            rowIndex: virtualItem.index,
            start: virtualItem.start,
          }]
        : [];
    });
  }, [rowVirtualizer, shouldVirtualize, virtualizedRows]);
  const visibleVirtualRowIndexSet = useMemo(
    () => new Set(visibleVirtualRows.map(({ rowIndex }) => rowIndex)),
    [visibleVirtualRows],
  );

  const activeSearchMatch = activeSearchMatchIndex >= 0 ? searchMatches[activeSearchMatchIndex] ?? null : null;
  const activeSearchBlockIndex = activeSearchMatch?.blockIndex ?? -1;
  const activeSearchVirtualRowIndex =
    activeSearchMatch
      ? (rowIndexByBlockLine.get(`${activeSearchMatch.blockIndex}:${activeSearchMatch.lineIndex}`) ?? -1)
      : -1;

  useEffect(() => {
    if (!shouldVirtualize || activeSearchBlockIndex < 0) {
      return;
    }
    if (activeSearchBlockIndex >= firstUnvirtualizedBlockIndex) {
      const activeTailBlock = baseRenderedBlocks[activeSearchBlockIndex];
      if (!activeTailBlock) {
        return;
      }
      staticBlockRefs.current.get(activeTailBlock.key)?.scrollIntoView({ block: "center" });
      return;
    }
    if (activeSearchVirtualRowIndex < 0 || visibleVirtualRowIndexSet.has(activeSearchVirtualRowIndex)) {
      return;
    }
    rowVirtualizer.scrollToIndex(activeSearchVirtualRowIndex, { align: "center" });
  }, [
    activeSearchBlockIndex,
    activeSearchVirtualRowIndex,
    baseRenderedBlocks,
    firstUnvirtualizedBlockIndex,
    rowVirtualizer,
    shouldVirtualize,
    visibleVirtualRowIndexSet,
  ]);

  return (
    <div className="transcript-blockHistory" ref={rootRef}>
      {shouldVirtualize ? (
        <div
          className="transcript-blockHistory__virtualCanvas"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {visibleVirtualRows.map(({ row, rowIndex, start }) => (
            <div
              key={row.key}
              ref={rowVirtualizer.measureElement}
              className={classNames([
                "transcript-blockHistory__virtualBlock",
                row.showMessageTurnSeparator ? "transcript-blockHistory__virtualBlock--messageTurnSeparator" : "",
              ])}
              data-index={rowIndex}
              data-block-index={row.blockIndex}
              data-block-type={row.blockType}
              data-has-leading-gap={row.hasLeadingGap ? "true" : undefined}
              style={{
                transform: `translateY(${start}px)`,
              }}
            >
              {renderVirtualizedTranscriptRow(
                row,
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
      {nonVirtualizedBlocks.map((renderedBlock, index) => {
        const blockIndex = shouldVirtualize ? firstUnvirtualizedBlockIndex + index : index;
        return (
          <div
            key={shouldVirtualize ? `tail:${renderedBlock.key}` : renderedBlock.key}
            ref={shouldVirtualize ? (node) => setStaticBlockRef(renderedBlock.key, node) : undefined}
            className={classNames([
              "transcript-blockHistory__staticBlock",
              renderedBlock.showMessageTurnSeparator ? "transcript-blockHistory__staticBlock--messageTurnSeparator" : "",
            ])}
            data-block-index={blockIndex}
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
        );
      })}
    </div>
  );
}
