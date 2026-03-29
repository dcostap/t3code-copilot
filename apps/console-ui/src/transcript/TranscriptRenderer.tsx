import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent as ReactSyntheticEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { AnimatedLoadingText } from "../AnimatedLoadingText";
import type { ComposerImageAttachment } from "../composerAttachments";
import { recordSlowTranscriptSwitchDiagnostic } from "../transcriptSwitchDiagnostics";
import {
  blockToLines,
  type AnnotatedLine,
  type InlineDiffLookup,
  type TranscriptBlock,
} from "./TranscriptBlock";
import type { TranscriptBlockRowDefinition } from "./transcriptRows";
import { normalizeInlineDiffRowText, parseInlineDiffFiles } from "./inlineDiff";
import { layoutMarkdownTable } from "./markdownTable";
import { findTranscriptHistoryBlockSearchMatches, TranscriptHistoryBlocks } from "./TranscriptHistoryBlocks";

export { layoutMarkdownTable, normalizeInlineDiffRowText, parseInlineDiffFiles };

interface StoredPromptSelection {
  readonly anchorOffset: number;
  readonly headOffset: number;
}

interface PromptCaretBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

interface AttachmentViewerImage {
  readonly name: string;
  readonly src: string;
}

interface AttachmentViewerNaturalSize {
  readonly width: number;
  readonly height: number;
}

interface AttachmentViewerPan {
  readonly x: number;
  readonly y: number;
}

interface AttachmentViewerDragState {
  readonly pointerId: number;
  readonly startPan: AttachmentViewerPan;
  readonly startX: number;
  readonly startY: number;
}

interface PromptCaretMeasureElements {
  readonly mirror: HTMLDivElement;
  readonly textNode: globalThis.Text;
  readonly marker: HTMLSpanElement;
  layoutSignature?: string;
}

interface PromptTextareaLayoutMetrics {
  readonly width: number;
  readonly padding: string;
  readonly border: string;
  readonly font: string;
  readonly fontKerning: string;
  readonly fontStretch: string;
  readonly fontVariant: string;
  readonly letterSpacing: string;
  readonly lineHeight: string;
  readonly resolvedLineHeight: number;
  readonly tabSize: string;
  readonly textIndent: string;
  readonly textTransform: string;
  readonly textRendering: string;
  readonly fontSize: string;
  readonly signature: string;
}

interface TranscriptRendererProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly precomputedBlockLines?: ReadonlyArray<ReadonlyArray<AnnotatedLine>>;
  readonly precomputedBlockRows?: ReadonlyArray<ReadonlyArray<TranscriptBlockRowDefinition>>;
  readonly historyCacheKey?: string | null;
  readonly historyState?: "ready" | "loading" | "error";
  readonly historyStateMessage?: string;
  readonly composerAttachments?: ReadonlyArray<ComposerImageAttachment>;
  readonly cwd?: string | null;
  readonly projectRoot?: string | null;
  readonly paneActive?: boolean;
  readonly interactionMode?: "default" | "plan";
  readonly initialScrollOffsetFromBottom?: number | null;
  readonly promptFocusDisabled?: boolean;
  readonly promptInputDisabled?: boolean;
  readonly pendingUserInputHighlight?: {
    readonly requestId: string;
    readonly questionIndex: number;
    readonly optionIndex?: number;
  };
  readonly submitDisabled?: boolean;
  onAddImageFiles?(files: ReadonlyArray<File>): void;
  onDraftChange?(value: string): void;
  onRemoveImage?(attachmentId: string): void;
  onScrollOffsetFromBottomChange?(offsetFromBottom: number): void;
  resolveInlineDiff?(lookup: InlineDiffLookup): Promise<string | null>;
  onSubmit?(value: string): Promise<void> | void;
}

interface InlineDiffResolutionState {
  readonly status: "loading" | "ready" | "error";
  readonly diff?: string;
}

export type TranscriptRegion = "prompt" | "history";

interface FocusPromptOptions {
  readonly reveal?: boolean;
}

export interface TranscriptRendererHandle {
  focus(): void;
  focusPrompt(options?: FocusPromptOptions): void;
  focusHistory(): void;
  hasFocusWithinPane(): boolean;
  openSearch(): void;
  isHistoryActive(): boolean;
  hasHistorySelection(): boolean;
  selectAllHistory(): boolean;
  insertPromptText(text: string): void;
  deletePromptBackward(): void;
  deletePromptForward(): void;
  submitPrompt(): void;
  scrollToBottom(): void;
}

type NativeSelectionLike =
  | {
      readonly isCollapsed: boolean;
      readonly rangeCount: number;
      readonly anchorNode?: unknown;
      readonly focusNode?: unknown;
      getRangeAt(index: number): {
        readonly startContainer: unknown;
        readonly endContainer: unknown;
      };
    }
  | null;

interface TranscriptSearchMatch {
  readonly from: number;
  readonly to: number;
}

interface ScrollPositionSnapshot {
  readonly element: HTMLElement;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

function resolveSelectionContainerNode(node: unknown): Node | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  if ("nodeType" in node && typeof node.nodeType === "number") {
    return node as Node;
  }
  if ("parentElement" in node && node.parentElement && typeof node.parentElement === "object") {
    return node.parentElement as Node;
  }
  return null;
}

export function hasNonCollapsedSelectionInsideElement(
  selection: NativeSelectionLike,
  element: Pick<HTMLElement, "contains"> | null | undefined,
) {
  if (!selection || !element || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  if (
    element.contains(resolveSelectionContainerNode(selection.anchorNode))
    || element.contains(resolveSelectionContainerNode(selection.focusNode))
  ) {
    return true;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (
      element.contains(resolveSelectionContainerNode(range.startContainer))
      || element.contains(resolveSelectionContainerNode(range.endContainer))
    ) {
      return true;
    }
  }

  return false;
}

function formatAttachmentSize(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }
  return `${sizeBytes} B`;
}

function normalizeProjectPathForComparison(path: string) {
  return path.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
}

export function relativizeProjectPath(path: string, projectRoot?: string | null) {
  const leadingWhitespace = path.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = path.match(/\s*$/)?.[0] ?? "";
  const trimmed = path.trim();
  const wrappingQuote = (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    ? trimmed[0]
    : null;
  const unquoted = wrappingQuote ? trimmed.slice(1, -1) : trimmed;
  const normalizedPath = unquoted.replace(/\//g, "\\");
  if (!/^[A-Za-z]:\\/.test(normalizedPath) && !normalizedPath.startsWith("\\\\")) {
    return path;
  }
  if (!projectRoot) {
    return path;
  }

  const normalizedRoot = projectRoot.replace(/\//g, "\\").replace(/[\\]+$/, "");
  const pathKey = normalizeProjectPathForComparison(normalizedPath);
  const rootKey = normalizeProjectPathForComparison(normalizedRoot);
  if (pathKey === rootKey) {
    const quotedRootPath = wrappingQuote ? `${wrappingQuote}.${wrappingQuote}` : ".";
    return `${leadingWhitespace}${quotedRootPath}${trailingWhitespace}`;
  }
  if (!pathKey.startsWith(`${rootKey}\\`)) {
    return path;
  }

  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  const quotedRelativePath = wrappingQuote ? `${wrappingQuote}${relativePath}${wrappingQuote}` : relativePath;
  return `${leadingWhitespace}${quotedRelativePath}${trailingWhitespace}`;
}

export function formatCommandWidgetOutputLine(line: string, projectRoot?: string | null) {
  const changedPrefix = "changed: ";
  if (line.startsWith(changedPrefix)) {
    return `${changedPrefix}${relativizeProjectPath(line.slice(changedPrefix.length), projectRoot)}`;
  }
  return relativizeProjectPath(line, projectRoot);
}

function windowsPathToFileUrl(path: string) {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return encodeURI(`file:///${normalized}`);
  }
  if (normalized.startsWith("//")) {
    return encodeURI(`file:${normalized}`);
  }
  return encodeURI(`file://${normalized}`);
}

export function resolveTranscriptLinkUrl(
  link: {
    kind: "url" | "file";
    target: string;
  },
  cwd?: string | null,
) {
  if (link.kind === "url") {
    return link.target;
  }

  const normalizedTarget = link.target.replace(/\//g, "\\");
  if (/^[A-Za-z]:\\/.test(normalizedTarget) || normalizedTarget.startsWith("\\\\")) {
    return windowsPathToFileUrl(normalizedTarget);
  }
  if (!cwd) {
    return null;
  }

  try {
    const baseUrl = new URL(windowsPathToFileUrl(cwd.endsWith("\\") ? cwd : `${cwd}\\`));
    return new URL(link.target.replace(/\\/g, "/"), baseUrl).toString();
  } catch {
    return null;
  }
}

function resolveBlockHistoryLinkFromEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }
  const interactiveElement = target.closest<HTMLElement>("[data-link-kind][data-link-target]");
  if (!interactiveElement) {
    return null;
  }
  const kind = interactiveElement.dataset.linkKind;
  const linkTarget = interactiveElement.dataset.linkTarget;
  if ((kind !== "url" && kind !== "file") || !linkTarget) {
    return null;
  }
  return {
    kind,
    target: linkTarget,
  } as const;
}

export function resolveCommandWidgetToggleSignatureFromEventTarget(target: unknown) {
  if (!target || typeof target !== "object") {
    return null;
  }

  const targetElement =
    "closest" in target && typeof target.closest === "function"
      ? target
      : "parentElement" in target && target.parentElement && typeof target.parentElement === "object"
        ? target.parentElement
        : null;
  if (!targetElement || !("closest" in targetElement) || typeof targetElement.closest !== "function") {
    return null;
  }

  const blockHistoryRail = targetElement.closest(".transcript-blockHistory__commandWidgetRail");
  if (blockHistoryRail && typeof blockHistoryRail === "object" && "dataset" in blockHistoryRail) {
    const signature = blockHistoryRail.dataset?.commandWidgetSignature;
    if (typeof signature === "string" && signature.length > 0) {
      return signature;
    }
  }

  const commandRail = targetElement.closest(".cm-commandWidgetRail");
  if (!commandRail || typeof commandRail !== "object") {
    return null;
  }

  const commandSurface =
    "closest" in commandRail && typeof commandRail.closest === "function"
      ? commandRail.closest(".cm-commandWidgetSurface")
      : null;
  if (!commandSurface || typeof commandSurface !== "object" || !("dataset" in commandSurface)) {
    return null;
  }

  if (commandSurface.dataset?.commandWidgetExpandable !== "true") {
    return null;
  }

  const signature = commandSurface.dataset?.commandWidgetSignature;
  if (typeof signature === "string" && signature.length > 0) {
    return signature;
  }

  return null;
}

async function openTranscriptLink(
  link: {
    kind: "url" | "file";
    target: string;
  },
  cwd?: string | null,
) {
  const resolved = resolveTranscriptLinkUrl(link, cwd);
  if (!resolved) {
    return false;
  }

  if (typeof window !== "undefined" && window.desktopBridge) {
    return window.desktopBridge.openExternal(resolved);
  }

  if (typeof window !== "undefined") {
    window.open(resolved, "_blank", "noopener,noreferrer");
    return true;
  }

  return false;
}

function isBlockBoundarySpacerLine(line: AnnotatedLine) {
  if (line.kind === "divider") {
    return true;
  }
  if (line.text.length > 0) {
    return false;
  }
  return (
    line.kind === "meta"
    || line.kind === "userPromptSeparator"
    || line.kind === "reasoningSeparator"
    || line.kind === "workGroupSeparator"
    || line.kind === "planSeparator"
    || line.kind === "checkpointSeparator"
  );
}

function trimBlockBoundarySpacerLines(lines: ReadonlyArray<AnnotatedLine>) {
  let start = 0;
  let end = lines.length;

  while (start < end && isBlockBoundarySpacerLine(lines[start]!)) {
    start += 1;
  }
  while (end > start && isBlockBoundarySpacerLine(lines[end - 1]!)) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function shouldInsertBlockGap(
  previousBlock: TranscriptBlock | null,
  nextBlock: TranscriptBlock,
) {
  if (!previousBlock) {
    return false;
  }

  if (previousBlock.type === "reasoning-summary" && nextBlock.type === "reasoning-text") {
    return false;
  }

  return true;
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

function applyPendingHighlightToLines(
  lines: ReadonlyArray<AnnotatedLine>,
  pendingUserInputHighlight?: {
    readonly requestId: string;
    readonly questionIndex: number;
    readonly optionIndex?: number;
  },
) {
  return lines.map((line) => {
    const userInputRef = line.userInputRef;
    const extraClasses = [...(line.extraClasses ?? [])];

    if (
      pendingUserInputHighlight
      && userInputRef
      && userInputRef.requestId === pendingUserInputHighlight.requestId
      && userInputRef.questionIndex === pendingUserInputHighlight.questionIndex
    ) {
      extraClasses.push("cm-line-userInputActiveQuestion");
      if (
        userInputRef.optionIndex !== undefined
        && pendingUserInputHighlight.optionIndex !== undefined
        && userInputRef.optionIndex === pendingUserInputHighlight.optionIndex
      ) {
        extraClasses.push("cm-line-userInputActiveOption");
      }
    }

    return extraClasses.length === 0 ? line : Object.assign({}, line, { extraClasses });
  });
}

export function flattenBlocks(
  blocks: ReadonlyArray<TranscriptBlock>,
  precomputedBlockLines?: ReadonlyArray<ReadonlyArray<AnnotatedLine>>,
  pendingUserInputHighlight?: {
    readonly requestId: string;
    readonly questionIndex: number;
    readonly optionIndex?: number;
  },
) {
  const lines: AnnotatedLine[] = [];
  let previousVisibleBlock: TranscriptBlock | null = null;

  blocks.forEach((block, blockIndex) => {
    const rawBlockLines = trimBlockBoundarySpacerLines(precomputedBlockLines?.[blockIndex] ?? blockToLines(block));
    const blockLines = applyPendingHighlightToLines(rawBlockLines, pendingUserInputHighlight);
    if (blockLines.length === 0) {
      return;
    }

    if (shouldInsertBlockGap(previousVisibleBlock, block)) {
      lines.push({
        text: "",
        kind: "blockGap",
        ...(shouldShowMessageTurnSeparator(previousVisibleBlock, block)
          ? { extraClasses: ["cm-line-messageTurnSeparator"] }
          : {}),
      });
    }

    lines.push(...blockLines);
    previousVisibleBlock = block;
  });

  return {
    lines,
    widgetsByLineIndex: new Map<number, never>(),
  };
}

function collectScrollableAncestors(start: HTMLElement | null) {
  const ancestors: HTMLElement[] = [];
  let current = start;
  while (current) {
    const { overflowX, overflowY } = window.getComputedStyle(current);
    const canScrollY = (overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight;
    const canScrollX = (overflowX === "auto" || overflowX === "scroll") && current.scrollWidth > current.clientWidth;
    if (canScrollX || canScrollY) {
      ancestors.push(current);
    }
    current = current.parentElement;
  }
  return ancestors;
}

function captureScrollPositionSnapshots(...starts: Array<HTMLElement | null>) {
  const snapshots: ScrollPositionSnapshot[] = [];
  const seen = new Set<HTMLElement>();
  for (const start of starts) {
    for (const element of collectScrollableAncestors(start)) {
      if (seen.has(element)) {
        continue;
      }
      seen.add(element);
      snapshots.push({
        element,
        scrollTop: element.scrollTop,
        scrollLeft: element.scrollLeft,
      });
    }
  }
  return snapshots;
}

function restoreScrollPositionSnapshots(snapshots: ReadonlyArray<ScrollPositionSnapshot>) {
  for (const snapshot of snapshots) {
    snapshot.element.scrollTop = snapshot.scrollTop;
    snapshot.element.scrollLeft = snapshot.scrollLeft;
  }
}

export function readConversationScrollOffsetFromBottom(scrollContainer: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}) {
  return Math.max(0, scrollContainer.scrollHeight - (scrollContainer.scrollTop + scrollContainer.clientHeight));
}

export function resolveConversationScrollTopForOffsetFromBottom(scrollContainer: {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}, offsetFromBottom: number) {
  return Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight - Math.max(0, offsetFromBottom));
}

export function resolveInitialConversationScrollTop(scrollContainer: {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}, offsetFromBottom: number | null) {
  if (offsetFromBottom === null) {
    return Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  }

  return resolveConversationScrollTopForOffsetFromBottom(scrollContainer, offsetFromBottom);
}

export function shouldRenderPromptSeparator(historyLineCount: number) {
  return historyLineCount > 0;
}

export function resolvePromptTextareaLayout(lineHeight: number, scrollHeight: number) {
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
  const minHeight = Math.ceil(safeLineHeight * 2);
  const maxHeight = Math.ceil(safeLineHeight * 10);
  return {
    height: Math.min(maxHeight, Math.max(scrollHeight, minHeight)),
    overflowY: scrollHeight > maxHeight ? "auto" as const : "hidden" as const,
  };
}

function readPromptTextareaLayoutMetrics(
  textarea: HTMLTextAreaElement,
  computedStyle = window.getComputedStyle(textarea),
): PromptTextareaLayoutMetrics {
  const width = textarea.clientWidth;
  const padding = computedStyle.padding;
  const border = computedStyle.border;
  const font = computedStyle.font;
  const fontKerning = computedStyle.fontKerning;
  const fontStretch = computedStyle.fontStretch;
  const fontVariant = computedStyle.fontVariant;
  const letterSpacing = computedStyle.letterSpacing;
  const lineHeight = computedStyle.lineHeight;
  const tabSize = computedStyle.tabSize;
  const textIndent = computedStyle.textIndent;
  const textTransform = computedStyle.textTransform;
  const textRendering = computedStyle.textRendering;
  const fontSize = computedStyle.fontSize;
  return {
    width,
    padding,
    border,
    font,
    fontKerning,
    fontStretch,
    fontVariant,
    letterSpacing,
    lineHeight,
    resolvedLineHeight: Number.parseFloat(lineHeight || "20") || 20,
    tabSize,
    textIndent,
    textTransform,
    textRendering,
    fontSize,
    signature: [
      width,
      padding,
      border,
      font,
      fontKerning,
      fontStretch,
      fontVariant,
      letterSpacing,
      lineHeight,
      tabSize,
      textIndent,
      textTransform,
      textRendering,
    ].join("\u0000"),
  };
}

let promptCaretMeasureElements: PromptCaretMeasureElements | null = null;

function getPromptCaretMeasureElements(doc: Document): PromptCaretMeasureElements {
  if (promptCaretMeasureElements) {
    return promptCaretMeasureElements;
  }

  const mirror = doc.createElement("div");
  mirror.style.position = "fixed";
  mirror.style.left = "-100000px";
  mirror.style.top = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.wordBreak = "break-word";
  mirror.style.boxSizing = "border-box";

  const textNode: globalThis.Text = doc.createTextNode("");
  const marker = doc.createElement("span");
  marker.style.display = "inline-block";
  mirror.append(textNode, marker);
  doc.body.append(mirror);

  const elements: PromptCaretMeasureElements = {
    mirror,
    textNode,
    marker,
  };
  promptCaretMeasureElements = elements;
  return elements;
}

function measurePromptCaretBox(
  textarea: HTMLTextAreaElement,
  selection: StoredPromptSelection,
  layoutMetrics = readPromptTextareaLayoutMetrics(textarea),
): PromptCaretBox | null {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }

  const caretOffset = Math.max(0, Math.min(selection.headOffset, textarea.value.length));
  const measureElements = getPromptCaretMeasureElements(document);
  const { mirror, textNode, marker } = measureElements;
  if (measureElements.layoutSignature !== layoutMetrics.signature) {
    mirror.style.width = `${layoutMetrics.width}px`;
    mirror.style.padding = layoutMetrics.padding;
    mirror.style.border = layoutMetrics.border;
    mirror.style.font = layoutMetrics.font;
    mirror.style.fontKerning = layoutMetrics.fontKerning;
    mirror.style.fontStretch = layoutMetrics.fontStretch;
    mirror.style.fontVariant = layoutMetrics.fontVariant;
    mirror.style.letterSpacing = layoutMetrics.letterSpacing;
    mirror.style.lineHeight = layoutMetrics.lineHeight;
    mirror.style.tabSize = layoutMetrics.tabSize;
    mirror.style.textIndent = layoutMetrics.textIndent;
    mirror.style.textTransform = layoutMetrics.textTransform;
    mirror.style.textRendering = layoutMetrics.textRendering;
    measureElements.layoutSignature = layoutMetrics.signature;
  }

  const beforeCaret = textarea.value.slice(0, caretOffset);
  textNode.nodeValue = beforeCaret;
  const nextCharacter = textarea.value.slice(caretOffset, caretOffset + 1);
  const displayCharacter = nextCharacter === "\t"
    ? " "
    : nextCharacter && nextCharacter !== "\n"
      ? nextCharacter
      : "\u00a0";
  marker.textContent = displayCharacter;

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();

  const lineHeight = layoutMetrics.resolvedLineHeight || markerRect.height || 20;
  const top = Math.floor(markerRect.top - mirrorRect.top - textarea.scrollTop);
  const left = Math.floor(markerRect.left - mirrorRect.left - textarea.scrollLeft);
  const width = Math.ceil(Math.max(8, markerRect.width || Number.parseFloat(layoutMetrics.fontSize || "0") * 0.6 || 8));
  const height = Math.max(1, Math.round(lineHeight));

  if (!Number.isFinite(top) || !Number.isFinite(left) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  return { top, left, width, height, text: displayCharacter };
}

export function shouldRedirectHistoryTypingToPrompt(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  options?: {
    readonly promptFocusDisabled?: boolean;
    readonly promptInputDisabled?: boolean;
  },
) {
  if (options?.promptFocusDisabled || options?.promptInputDisabled) {
    return false;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }

  return event.key.length === 1;
}

export function shouldSelectAllHistoryFromHistoryKeydown(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  activeRegion: TranscriptRegion,
) {
  return activeRegion === "history"
    && (event.ctrlKey || event.metaKey)
    && !event.altKey
    && event.key.toLowerCase() === "a";
}

export function shouldSelectAllPromptFromPromptKeydown(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
) {
  return (event.ctrlKey || event.metaKey)
    && !event.altKey
    && event.key.toLowerCase() === "a";
}

export function findTranscriptSearchMatches(
  text: string,
  query: string,
  searchTo: number,
): ReadonlyArray<TranscriptSearchMatch> {
  if (query.length === 0 || searchTo <= 0) {
    return [];
  }

  const haystack = text.slice(0, searchTo).toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  return findTranscriptSearchMatchesInHaystack(haystack, needle);
}

function findTranscriptSearchMatchesInHaystack(
  haystack: string,
  needle: string,
): ReadonlyArray<TranscriptSearchMatch> {
  if (needle.length === 0) {
    return [];
  }

  const matches: TranscriptSearchMatch[] = [];
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

export function getNextTranscriptSearchMatchIndex(input: {
  readonly currentIndex: number;
  readonly matchCount: number;
  readonly direction: 1 | -1;
}) {
  if (input.matchCount <= 0) {
    return -1;
  }
  const currentIndex =
    input.currentIndex >= 0 && input.currentIndex < input.matchCount
      ? input.currentIndex
      : input.direction === 1
        ? -1
        : 0;
  return (currentIndex + input.direction + input.matchCount) % input.matchCount;
}

export function shouldUseNativePromptCaret(
  cssSupports:
    | ((property: string, value: string) => boolean)
    | null
    | undefined,
) {
  void cssSupports;
  return false;
}

export function shouldShowCustomPromptCaret(input: {
  readonly paneHasFocus: boolean;
  readonly paneActive: boolean;
  readonly activeRegion: TranscriptRegion;
  readonly promptHasFocus: boolean;
  readonly promptInputDisabled: boolean;
  readonly useNativePromptCaret: boolean;
  readonly focusedEditableOwnsTyping: boolean;
}) {
  const promptCaretOwnedByPane =
    input.paneActive
    && (input.paneHasFocus || input.activeRegion === "history");
  if (!promptCaretOwnedByPane || input.promptInputDisabled || input.focusedEditableOwnsTyping) {
    return false;
  }

  if (input.promptHasFocus && input.useNativePromptCaret) {
    return false;
  }

  return true;
}

export function shouldSuppressCustomPromptCaretForFocusedElement(input: {
  readonly isEditable: boolean;
  readonly isPromptElement: boolean;
  readonly isHistoryElement: boolean;
}) {
  if (input.isPromptElement || input.isHistoryElement) {
    return false;
  }

  return input.isEditable;
}

export function shouldRedirectPlainTextPasteToPrompt(input: {
  readonly targetIsPrompt: boolean;
  readonly hasFiles: boolean;
  readonly promptInputDisabled: boolean;
  readonly text: string;
}) {
  return !input.targetIsPrompt && !input.hasFiles && !input.promptInputDisabled && input.text.length > 0;
}

function isFileChangeWidgetLine(line: AnnotatedLine) {
  return (
    line.inlineUnifiedDiff !== undefined
    || line.inlineDiffLookup !== undefined
    || line.inlineDiffChangedFiles !== undefined
  );
}

function collectExpandedInlineDiffLookups(
  blocks: ReadonlyArray<TranscriptBlock>,
  precomputedBlockLines: ReadonlyArray<ReadonlyArray<AnnotatedLine>> | undefined,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionState>,
) {
  const lookups = new Map<string, InlineDiffLookup>();
  blocks.forEach((block, blockIndex) => {
    for (const line of precomputedBlockLines?.[blockIndex] ?? blockToLines(block)) {
      const signature = line.commandWidgetSignature;
      const lookup = line.inlineDiffLookup;
      if (!signature || !lookup || line.inlineUnifiedDiff) {
        continue;
      }
      const resolvedStatus = resolvedInlineDiffBySignature.get(signature)?.status;
      if (resolvedStatus === "loading" || resolvedStatus === "ready") {
        continue;
      }
      const isExpanded = isFileChangeWidgetLine(line)
        ? !collapsedFileChangeSignatures.has(signature)
        : expandedCommandSignatures.has(signature);
      if (isExpanded) {
        lookups.set(signature, lookup);
      }
    }
  });
  return lookups;
}

function resolveAttachmentViewerFitScale(
  naturalSize: AttachmentViewerNaturalSize,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (naturalSize.width <= 0 || naturalSize.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return 1;
  }
  const availableWidth = Math.max(1, viewportWidth - 96);
  const availableHeight = Math.max(1, viewportHeight - 96);
  return Math.min(1, availableWidth / naturalSize.width, availableHeight / naturalSize.height);
}

function resolveAttachmentViewerPanLimits(
  scale: number,
  naturalSize: AttachmentViewerNaturalSize,
  viewportWidth: number,
  viewportHeight: number,
) {
  const availableWidth = Math.max(1, viewportWidth - 96);
  const availableHeight = Math.max(1, viewportHeight - 96);
  const scaledWidth = naturalSize.width * scale;
  const scaledHeight = naturalSize.height * scale;
  return {
    maxX: Math.max(0, (scaledWidth - availableWidth) / 2),
    maxY: Math.max(0, (scaledHeight - availableHeight) / 2),
  };
}

function canPanAttachmentViewer(
  scale: number,
  naturalSize: AttachmentViewerNaturalSize,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (naturalSize.width <= 0 || naturalSize.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return false;
  }
  const { maxX, maxY } = resolveAttachmentViewerPanLimits(scale, naturalSize, viewportWidth, viewportHeight);
  return maxX > 0 || maxY > 0;
}

function clampAttachmentViewerPan(
  pan: AttachmentViewerPan,
  scale: number,
  naturalSize: AttachmentViewerNaturalSize,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (naturalSize.width <= 0 || naturalSize.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return pan;
  }

  const { maxX, maxY } = resolveAttachmentViewerPanLimits(
    scale,
    naturalSize,
    viewportWidth,
    viewportHeight,
  );

  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

export const TranscriptRenderer = forwardRef<TranscriptRendererHandle, TranscriptRendererProps>(
  function TranscriptRenderer(
    {
      blocks,
      precomputedBlockLines,
      precomputedBlockRows,
      historyCacheKey = null,
      historyState = "ready",
      historyStateMessage,
      composerAttachments = [],
      cwd,
      projectRoot: _projectRoot,
      paneActive = false,
      interactionMode: _interactionMode = "default",
      initialScrollOffsetFromBottom = null,
      promptFocusDisabled = false,
      promptInputDisabled = false,
      pendingUserInputHighlight,
      onAddImageFiles,
      onDraftChange,
      onRemoveImage,
      onScrollOffsetFromBottomChange,
      resolveInlineDiff,
      onSubmit,
      submitDisabled = false,
    },
    ref,
  ) {
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const blockHistoryRef = useRef<HTMLDivElement | null>(null);
    const historyScrollContainerRef = useRef<HTMLDivElement | null>(null);
    const historySelectAllTextRef = useRef<HTMLPreElement | null>(null);
    const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const promptCaretRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const promptLayoutSyncFrameRef = useRef<number | null>(null);
    const blockHistoryScrollIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dragDepthRef = useRef(0);
    const draftRef = useRef("");
    const submittingRef = useRef(false);
    const promptSelectionRef = useRef<StoredPromptSelection>({ anchorOffset: 0, headOffset: 0 });
    const activeRegionRef = useRef<TranscriptRegion>("prompt");
    const searchReturnRegionRef = useRef<TranscriptRegion>("prompt");
    const paneActiveRef = useRef(paneActive);
    const onSubmitRef = useRef(onSubmit);
    const onDraftChangeRef = useRef(onDraftChange);
    const onScrollOffsetFromBottomChangeRef = useRef(onScrollOffsetFromBottomChange);
    const initialScrollOffsetFromBottomRef = useRef(initialScrollOffsetFromBottom);
    const resolveInlineDiffRef = useRef(resolveInlineDiff);
    const submitDisabledRef = useRef(submitDisabled);
    const promptFocusDisabledRef = useRef(promptFocusDisabled);
    const promptInputDisabledRef = useRef(promptInputDisabled);
    const composerAttachmentsRef = useRef(composerAttachments);
    const lastHistoryCacheKeyRef = useRef<string | null>(historyCacheKey);
    const scrollOffsetFromBottomRef = useRef(initialScrollOffsetFromBottom ?? 0);
    const pendingHistoryRestoreOffsetRef = useRef<number | null>(initialScrollOffsetFromBottom);
    const historyInitialScrollAppliedRef = useRef(false);
    const [expandedCommandSignatures, setExpandedCommandSignatures] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [collapsedFileChangeSignatures, setCollapsedFileChangeSignatures] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [resolvedInlineDiffBySignature, setResolvedInlineDiffBySignature] = useState<
      ReadonlyMap<string, InlineDiffResolutionState>
    >(() => new Map());
    const [searchVisible, setSearchVisible] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(-1);
    const [historySelectAllEnabled, setHistorySelectAllEnabled] = useState(false);
    const [blockHistoryScrollTop, setBlockHistoryScrollTop] = useState(0);
    const [blockHistoryViewportHeight, setBlockHistoryViewportHeight] = useState(0);
    const [blockHistoryScrolling, setBlockHistoryScrolling] = useState(false);
    const [isDraggingImages, setIsDraggingImages] = useState(false);
    const [attachmentViewerImage, setAttachmentViewerImage] = useState<AttachmentViewerImage | null>(null);
    const [attachmentViewerNaturalSize, setAttachmentViewerNaturalSize] = useState<AttachmentViewerNaturalSize>({
      width: 0,
      height: 0,
    });
    const [attachmentViewerScale, setAttachmentViewerScale] = useState<number | null>(null);
    const [attachmentViewerPan, setAttachmentViewerPan] = useState<AttachmentViewerPan>({ x: 0, y: 0 });
    const [attachmentViewerDragging, setAttachmentViewerDragging] = useState(false);
    const attachmentViewerScaleRef = useRef<number | null>(null);
    const attachmentViewerPanRef = useRef<AttachmentViewerPan>({ x: 0, y: 0 });
    const attachmentViewerNaturalSizeRef = useRef<AttachmentViewerNaturalSize>({ width: 0, height: 0 });
    const attachmentViewerFitScaleRef = useRef(1);
    const attachmentViewerDragStateRef = useRef<AttachmentViewerDragState | null>(null);
    const useNativePromptCaret = useMemo(
      () =>
        shouldUseNativePromptCaret(
          typeof CSS !== "undefined" && typeof CSS.supports === "function"
            ? CSS.supports.bind(CSS) as (property: string, value: string) => boolean
            : null,
        ),
      [],
    );

    const historyPlainText = useMemo(
      () =>
        historySelectAllEnabled
          ? flattenBlocks(blocks, precomputedBlockLines, pendingUserInputHighlight).lines.map((line) => line.text).join("\n")
          : "",
      [blocks, historySelectAllEnabled, pendingUserInputHighlight, precomputedBlockLines],
    );
    const compactPendingUserInputPrompt =
      pendingUserInputHighlight !== undefined && !shouldRenderPromptSeparator(blocks.length);

    const blockSearchMatches = useMemo(
      () => (searchVisible ? findTranscriptHistoryBlockSearchMatches(blocks, searchQuery, precomputedBlockLines) : []),
      [blocks, searchQuery, searchVisible, precomputedBlockLines],
    );
    const searchMatchCount = blockSearchMatches.length;
    const resolvedActiveSearchMatchIndex =
      searchMatchCount === 0
        ? -1
        : activeSearchMatchIndex >= 0 && activeSearchMatchIndex < searchMatchCount
          ? activeSearchMatchIndex
          : 0;
    const activeBlockSearchMatch =
      resolvedActiveSearchMatchIndex >= 0
        ? blockSearchMatches[resolvedActiveSearchMatchIndex] ?? null
        : null;
    const expandedInlineDiffLookups = useMemo(
      () => {
        const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const lookups = collectExpandedInlineDiffLookups(
          blocks,
          precomputedBlockLines,
          expandedCommandSignatures,
          collapsedFileChangeSignatures,
          resolvedInlineDiffBySignature,
        );
        recordSlowTranscriptSwitchDiagnostic({
          label: "expanded-inline-diff-lookups",
          historyCacheKey,
          blockCount: blocks.length,
        }, startedAt, 12);
        return lookups;
      },
      [
        blocks,
        historyCacheKey,
        precomputedBlockLines,
        collapsedFileChangeSignatures,
        expandedCommandSignatures,
        resolvedInlineDiffBySignature,
      ],
    );

    useLayoutEffect(() => {
      onSubmitRef.current = onSubmit;
      onDraftChangeRef.current = onDraftChange;
      onScrollOffsetFromBottomChangeRef.current = onScrollOffsetFromBottomChange;
      initialScrollOffsetFromBottomRef.current = initialScrollOffsetFromBottom;
      resolveInlineDiffRef.current = resolveInlineDiff;
      submitDisabledRef.current = submitDisabled;
      promptFocusDisabledRef.current = promptFocusDisabled;
      promptInputDisabledRef.current = promptInputDisabled;
      composerAttachmentsRef.current = composerAttachments;
      paneActiveRef.current = paneActive;
    }, [
      composerAttachments,
      initialScrollOffsetFromBottom,
      onDraftChange,
      onScrollOffsetFromBottomChange,
      onSubmit,
      paneActive,
      promptFocusDisabled,
      promptInputDisabled,
      resolveInlineDiff,
      submitDisabled,
    ]);

    useEffect(() => {
      attachmentViewerScaleRef.current = attachmentViewerScale;
      attachmentViewerPanRef.current = attachmentViewerPan;
      attachmentViewerNaturalSizeRef.current = attachmentViewerNaturalSize;
    }, [attachmentViewerNaturalSize, attachmentViewerPan, attachmentViewerScale]);

    useEffect(() => {
      if (historyCacheKey !== lastHistoryCacheKeyRef.current) {
        lastHistoryCacheKeyRef.current = historyCacheKey;
        historyInitialScrollAppliedRef.current = false;
        pendingHistoryRestoreOffsetRef.current = initialScrollOffsetFromBottomRef.current;
      }
    }, [historyCacheKey]);

    useEffect(() => {
      if (initialScrollOffsetFromBottom !== null) {
        scrollOffsetFromBottomRef.current = initialScrollOffsetFromBottom;
      }
    }, [initialScrollOffsetFromBottom]);

    const syncBlockHistoryActiveState = useCallback(() => {
      blockHistoryRef.current?.classList.toggle(
        "transcript-history__blockRoot--active",
        activeRegionRef.current === "history",
      );
    }, []);

    const setPromptSelectionValue = useCallback((anchorOffset: number, headOffset: number) => {
      promptSelectionRef.current = { anchorOffset, headOffset };
    }, []);

    const applyPromptCaretBox = useCallback((box: PromptCaretBox | null) => {
      const caret = promptCaretRef.current;
      if (!caret) {
        return;
      }
      if (!box) {
        caret.hidden = true;
        caret.style.top = "";
        caret.style.left = "";
        caret.style.width = "";
        caret.style.height = "";
        caret.textContent = "";
        return;
      }
      caret.hidden = false;
      caret.style.top = `${box.top}px`;
      caret.style.left = `${box.left}px`;
      caret.style.width = `${box.width}px`;
      caret.style.height = `${box.height}px`;
      caret.textContent = box.text;
    }, []);

    const isFocusedEditableWithinPane = useCallback((
      activeElement: Element | null,
      textarea: HTMLTextAreaElement,
    ) => {
      if (!(activeElement instanceof HTMLElement)) {
        return false;
      }

      return shouldSuppressCustomPromptCaretForFocusedElement({
        isEditable:
          activeElement instanceof HTMLInputElement
          || activeElement instanceof HTMLTextAreaElement
          || activeElement.isContentEditable,
        isPromptElement: activeElement === textarea,
        isHistoryElement: blockHistoryRef.current?.contains(activeElement) === true,
      });
    }, []);

    const syncPromptCaretBox = useCallback((
      textarea = promptTextareaRef.current,
      layoutMetrics?: PromptTextareaLayoutMetrics,
    ) => {
      if (!textarea) {
        applyPromptCaretBox(null);
        return;
      }

      const activeElement = typeof document === "undefined" ? null : document.activeElement;
      const paneHasFocus = activeElement instanceof Node && surfaceRef.current?.contains(activeElement) === true;
      const promptHasFocus = activeElement === textarea;
      const focusedEditableOwnsTyping = isFocusedEditableWithinPane(activeElement, textarea);

      if (!shouldShowCustomPromptCaret({
        paneHasFocus,
        paneActive: paneActiveRef.current,
        activeRegion: activeRegionRef.current,
        promptHasFocus,
        promptInputDisabled: promptInputDisabledRef.current,
        useNativePromptCaret,
        focusedEditableOwnsTyping,
      })) {
        applyPromptCaretBox(null);
        return;
      }

      applyPromptCaretBox(measurePromptCaretBox(textarea, promptSelectionRef.current, layoutMetrics));
    }, [applyPromptCaretBox, isFocusedEditableWithinPane, useNativePromptCaret]);

    const syncPromptSelection = useCallback((
      textarea = promptTextareaRef.current,
      layoutMetrics?: PromptTextareaLayoutMetrics,
    ) => {
      const fallbackOffset = draftRef.current.length;
      const anchorOffset = textarea?.selectionStart ?? fallbackOffset;
      const headOffset = textarea?.selectionEnd ?? fallbackOffset;
      setPromptSelectionValue(anchorOffset, headOffset);
      syncPromptCaretBox(textarea, layoutMetrics);
    }, [setPromptSelectionValue, syncPromptCaretBox]);

    const clearHistorySelection = useCallback(() => {
      if (typeof window === "undefined") {
        return;
      }
      const selection = window.getSelection();
      if (!hasNonCollapsedSelectionInsideElement(selection, blockHistoryRef.current)) {
        return;
      }
      selection?.removeAllRanges();
    }, []);

    const preparePromptInteraction = useCallback(() => {
      clearHistorySelection();
    }, [clearHistorySelection]);

    const collapsePromptSelectionToCaret = useCallback(() => {
      const caretOffset = promptSelectionRef.current.headOffset;
      setPromptSelectionValue(caretOffset, caretOffset);
      const textarea = promptTextareaRef.current;
      if (!textarea) {
        applyPromptCaretBox(null);
        return;
      }
      textarea.setSelectionRange(caretOffset, caretOffset);
      syncPromptCaretBox(textarea);
    }, [applyPromptCaretBox, setPromptSelectionValue, syncPromptCaretBox]);

    const prepareHistoryInteraction = useCallback(() => {
      collapsePromptSelectionToCaret();
    }, [collapsePromptSelectionToCaret]);

    const syncHistoryMetrics = useCallback(() => {
      const scrollContainer = historyScrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }
      setBlockHistoryScrollTop((current) => current === scrollContainer.scrollTop ? current : scrollContainer.scrollTop);
      setBlockHistoryViewportHeight((current) =>
        current === scrollContainer.clientHeight ? current : scrollContainer.clientHeight);
      const offset = readConversationScrollOffsetFromBottom(scrollContainer);
      scrollOffsetFromBottomRef.current = offset;
      onScrollOffsetFromBottomChangeRef.current?.(offset);
    }, []);

    const scheduleHistoryScrollRestore = useCallback((offsetFromBottom?: number | null) => {
      if (offsetFromBottom === null) {
        pendingHistoryRestoreOffsetRef.current = null;
        return;
      }
      if (typeof offsetFromBottom === "number") {
        pendingHistoryRestoreOffsetRef.current = Math.max(0, offsetFromBottom);
        return;
      }
      const scrollContainer = historyScrollContainerRef.current;
      pendingHistoryRestoreOffsetRef.current = scrollContainer
        ? readConversationScrollOffsetFromBottom(scrollContainer)
        : scrollOffsetFromBottomRef.current;
    }, []);

    useEffect(() => {
      const scrollContainer = historyScrollContainerRef.current;
      if (!scrollContainer) {
        return undefined;
      }

      const handleScroll = () => {
        setBlockHistoryScrolling((current) => current ? current : true);
        if (blockHistoryScrollIdleTimeoutRef.current !== null) {
          clearTimeout(blockHistoryScrollIdleTimeoutRef.current);
        }
        blockHistoryScrollIdleTimeoutRef.current = setTimeout(() => {
          blockHistoryScrollIdleTimeoutRef.current = null;
          setBlockHistoryScrolling(false);
        }, 120);
        syncHistoryMetrics();
      };

      syncHistoryMetrics();
      scrollContainer.addEventListener("scroll", handleScroll, { passive: true });

      let resizeObserver: ResizeObserver | null = null;
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          syncHistoryMetrics();
        });
        resizeObserver.observe(scrollContainer);
        if (blockHistoryRef.current) {
          resizeObserver.observe(blockHistoryRef.current);
        }
      }

      return () => {
        scrollContainer.removeEventListener("scroll", handleScroll);
        resizeObserver?.disconnect();
        if (blockHistoryScrollIdleTimeoutRef.current !== null) {
          clearTimeout(blockHistoryScrollIdleTimeoutRef.current);
          blockHistoryScrollIdleTimeoutRef.current = null;
        }
      };
    }, [syncHistoryMetrics]);

    useLayoutEffect(() => {
      const scrollContainer = historyScrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }

      const targetOffset = historyInitialScrollAppliedRef.current
        ? pendingHistoryRestoreOffsetRef.current ?? scrollOffsetFromBottomRef.current
        : initialScrollOffsetFromBottomRef.current;
      scrollContainer.scrollTop = resolveInitialConversationScrollTop(scrollContainer, targetOffset ?? null);
      historyInitialScrollAppliedRef.current = true;
      pendingHistoryRestoreOffsetRef.current = null;
      syncHistoryMetrics();
    }, [
      blocks,
      collapsedFileChangeSignatures,
      expandedCommandSignatures,
      historyCacheKey,
      historyState,
      resolvedInlineDiffBySignature,
      syncHistoryMetrics,
    ]);

    const autosizePromptInput = useCallback((
      textarea = promptTextareaRef.current,
      layoutMetrics?: PromptTextareaLayoutMetrics,
    ) => {
      if (!textarea) {
        return;
      }

      const scrollSnapshots = captureScrollPositionSnapshots(textarea, historyScrollContainerRef.current);
      textarea.style.height = "auto";
      const resolvedLayoutMetrics = layoutMetrics ?? readPromptTextareaLayoutMetrics(textarea);
      const { height, overflowY } = resolvePromptTextareaLayout(
        resolvedLayoutMetrics.resolvedLineHeight,
        textarea.scrollHeight,
      );
      textarea.style.height = `${height}px`;
      textarea.style.overflowY = overflowY;
      restoreScrollPositionSnapshots(scrollSnapshots);
    }, []);

    const schedulePromptLayoutSync = useCallback((textarea = promptTextareaRef.current) => {
      if (!textarea) {
        return;
      }
      if (promptLayoutSyncFrameRef.current !== null) {
        cancelAnimationFrame(promptLayoutSyncFrameRef.current);
      }
      promptLayoutSyncFrameRef.current = requestAnimationFrame(() => {
        promptLayoutSyncFrameRef.current = null;
        const layoutMetrics = readPromptTextareaLayoutMetrics(textarea);
        autosizePromptInput(textarea, layoutMetrics);
        syncPromptSelection(textarea, layoutMetrics);
      });
    }, [autosizePromptInput, syncPromptSelection]);

    const setDraftValue = useCallback((nextDraft: string, textarea = promptTextareaRef.current) => {
      draftRef.current = nextDraft;
      if (textarea && textarea.value !== nextDraft) {
        textarea.value = nextDraft;
      }
      onDraftChangeRef.current?.(nextDraft);
    }, []);

    useLayoutEffect(() => {
      const textarea = promptTextareaRef.current;
      const layoutMetrics = textarea ? readPromptTextareaLayoutMetrics(textarea) : undefined;
      autosizePromptInput(textarea, layoutMetrics);
      syncPromptCaretBox(textarea, layoutMetrics);
    }, [autosizePromptInput, syncPromptCaretBox]);

    useEffect(() => () => {
      if (promptLayoutSyncFrameRef.current !== null) {
        cancelAnimationFrame(promptLayoutSyncFrameRef.current);
        promptLayoutSyncFrameRef.current = null;
      }
    }, []);

    const focusPromptInput = useCallback((_options?: FocusPromptOptions) => {
      if (promptFocusDisabledRef.current) {
        return;
      }
      activeRegionRef.current = "prompt";
      syncBlockHistoryActiveState();
      const textarea = promptTextareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus({ preventScroll: true });
      const maxOffset = textarea.value.length;
      const { anchorOffset: storedAnchorOffset, headOffset: storedHeadOffset } = promptSelectionRef.current;
      const anchorOffset = Math.min(storedAnchorOffset, maxOffset);
      const headOffset = Math.min(storedHeadOffset, maxOffset);
      textarea.setSelectionRange(anchorOffset, headOffset);
      setPromptSelectionValue(anchorOffset, headOffset);
      syncPromptCaretBox(textarea);
    }, [setPromptSelectionValue, syncBlockHistoryActiveState, syncPromptCaretBox]);

    const focusPromptRegion = useCallback((options?: FocusPromptOptions) => {
      activeRegionRef.current = "prompt";
      syncBlockHistoryActiveState();
      preparePromptInteraction();
      requestAnimationFrame(() => {
        focusPromptInput(options);
      });
    }, [focusPromptInput, preparePromptInteraction, syncBlockHistoryActiveState]);

    const focusHistoryRegion = useCallback(() => {
      prepareHistoryInteraction();
      activeRegionRef.current = "history";
      syncPromptCaretBox();
      syncBlockHistoryActiveState();
      blockHistoryRef.current?.focus({ preventScroll: true });
    }, [prepareHistoryInteraction, syncBlockHistoryActiveState, syncPromptCaretBox]);

    const insertTextIntoDraft = useCallback((text: string) => {
      preparePromptInteraction();
      const { anchorOffset, headOffset } = promptSelectionRef.current;
      const selectionStart = Math.min(anchorOffset, headOffset);
      const selectionEnd = Math.max(anchorOffset, headOffset);
      const nextDraft =
        draftRef.current.slice(0, selectionStart)
        + text
        + draftRef.current.slice(selectionEnd);
      setDraftValue(nextDraft);
      const nextCursor = selectionStart + text.length;
      setPromptSelectionValue(nextCursor, nextCursor);
      requestAnimationFrame(() => {
        const nextTextarea = promptTextareaRef.current;
        if (!nextTextarea) {
          return;
        }
        nextTextarea.focus({ preventScroll: true });
        nextTextarea.setSelectionRange(nextCursor, nextCursor);
        const layoutMetrics = readPromptTextareaLayoutMetrics(nextTextarea);
        autosizePromptInput(nextTextarea, layoutMetrics);
        syncPromptSelection(nextTextarea, layoutMetrics);
      });
    }, [autosizePromptInput, preparePromptInteraction, setDraftValue, setPromptSelectionValue, syncPromptSelection]);

    const deletePromptText = useCallback((direction: "backward" | "forward") => {
      preparePromptInteraction();
      const { anchorOffset, headOffset } = promptSelectionRef.current;
      const selectionStart = Math.min(anchorOffset, headOffset);
      const selectionEnd = Math.max(anchorOffset, headOffset);
      if (selectionStart === selectionEnd) {
        if (direction === "backward" && selectionStart === 0) {
          return;
        }
        if (direction === "forward" && selectionEnd >= draftRef.current.length) {
          return;
        }
      }
      const deleteFrom = selectionStart === selectionEnd
        ? direction === "backward"
          ? selectionStart - 1
          : selectionStart
        : selectionStart;
      const deleteTo = selectionStart === selectionEnd
        ? direction === "backward"
          ? selectionEnd
          : selectionEnd + 1
        : selectionEnd;
      const nextDraft = draftRef.current.slice(0, deleteFrom) + draftRef.current.slice(deleteTo);
      setDraftValue(nextDraft);
      setPromptSelectionValue(deleteFrom, deleteFrom);
      requestAnimationFrame(() => {
        const textarea = promptTextareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(deleteFrom, deleteFrom);
        const layoutMetrics = readPromptTextareaLayoutMetrics(textarea);
        autosizePromptInput(textarea, layoutMetrics);
        syncPromptSelection(textarea, layoutMetrics);
      });
    }, [autosizePromptInput, preparePromptInteraction, setDraftValue, setPromptSelectionValue, syncPromptSelection]);

    const submitDraft = useCallback(async () => {
      const value = draftRef.current.trim();
      if (
        (value.length === 0 && composerAttachmentsRef.current.length === 0)
        || submittingRef.current
        || submitDisabledRef.current
      ) {
        return true;
      }

      submittingRef.current = true;
      try {
        await onSubmitRef.current?.(value);
        setDraftValue("");
      } finally {
        submittingRef.current = false;
      }

      requestAnimationFrame(() => {
        const textarea = promptTextareaRef.current;
        if (textarea) {
          const layoutMetrics = readPromptTextareaLayoutMetrics(textarea);
          autosizePromptInput(textarea, layoutMetrics);
        }
        focusPromptInput();
      });
      return true;
    }, [autosizePromptInput, focusPromptInput, setDraftValue]);

    const applyHistoryTextSelection = useCallback(() => {
      if (typeof window === "undefined" || typeof document === "undefined") {
        return false;
      }
      const container = historySelectAllTextRef.current ?? blockHistoryRef.current;
      const selection = window.getSelection();
      if (!container || !selection) {
        return false;
      }
      const range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);
      prepareHistoryInteraction();
      activeRegionRef.current = "history";
      syncBlockHistoryActiveState();
      return true;
    }, [prepareHistoryInteraction, syncBlockHistoryActiveState]);
    const selectAllHistoryText = useCallback(() => {
      if (!historySelectAllEnabled) {
        setHistorySelectAllEnabled(true);
        if (typeof window !== "undefined") {
          window.requestAnimationFrame(() => {
            applyHistoryTextSelection();
          });
        }
        return true;
      }
      return applyHistoryTextSelection();
    }, [applyHistoryTextSelection, historySelectAllEnabled]);

    const requestInlineDiff = useCallback((signature: string, lookup: InlineDiffLookup) => {
      const resolver = resolveInlineDiffRef.current;
      if (!resolver) {
        return;
      }

      let shouldFetch = false;
      scheduleHistoryScrollRestore();
      setResolvedInlineDiffBySignature((current) => {
        const existing = current.get(signature);
        if (existing?.status === "loading" || existing?.status === "ready") {
          return current;
        }
        const next = new Map(current);
        next.set(signature, { status: "loading" });
        shouldFetch = true;
        return next;
      });

      if (!shouldFetch) {
        return;
      }

      void resolver(lookup)
        .then((diff) => {
          const normalizedDiff = diff?.trim();
          scheduleHistoryScrollRestore();
          setResolvedInlineDiffBySignature((current) => {
            const next = new Map(current);
            if (normalizedDiff && normalizedDiff.length > 0) {
              next.set(signature, { status: "ready", diff: normalizedDiff });
            } else {
              next.set(signature, { status: "error" });
            }
            return next;
          });
        })
        .catch(() => {
          scheduleHistoryScrollRestore();
          setResolvedInlineDiffBySignature((current) => {
            const next = new Map(current);
            next.set(signature, { status: "error" });
            return next;
          });
        });
    }, [scheduleHistoryScrollRestore]);

    useEffect(() => {
      for (const [signature, lookup] of expandedInlineDiffLookups) {
        requestInlineDiff(signature, lookup);
      }
    }, [expandedInlineDiffLookups, requestInlineDiff]);

    const handleBlockHistoryCommandWidgetToggle = useCallback((
      input: {
        readonly signature: string;
        readonly isFileChange: boolean;
        readonly inlineDiffLookup?: InlineDiffLookup;
      },
    ) => {
      scheduleHistoryScrollRestore();
      if (input.isFileChange) {
        const shouldExpand = collapsedFileChangeSignatures.has(input.signature);
        if (shouldExpand && input.inlineDiffLookup) {
          requestInlineDiff(input.signature, input.inlineDiffLookup);
        }
        setCollapsedFileChangeSignatures((current) => {
          const next = new Set(current);
          if (next.has(input.signature)) {
            next.delete(input.signature);
          } else {
            next.add(input.signature);
          }
          return next;
        });
        return;
      }

      const shouldExpand = !expandedCommandSignatures.has(input.signature);
      if (shouldExpand && input.inlineDiffLookup) {
        requestInlineDiff(input.signature, input.inlineDiffLookup);
      }
      setExpandedCommandSignatures((current) => {
        const next = new Set(current);
        if (next.has(input.signature)) {
          next.delete(input.signature);
        } else {
          next.add(input.signature);
        }
        return next;
      });
    }, [collapsedFileChangeSignatures, expandedCommandSignatures, requestInlineDiff, scheduleHistoryScrollRestore]);

    const focusSearchInput = useCallback(() => {
      requestAnimationFrame(() => {
        const input = searchInputRef.current;
        if (!input) {
          return;
        }
        input.focus({ preventScroll: true });
        input.select();
      });
    }, []);

    const closeSearch = useCallback((options?: { readonly restoreFocus?: boolean }) => {
      setSearchVisible(false);
      if (options?.restoreFocus === false) {
        return;
      }
      requestAnimationFrame(() => {
        if (searchReturnRegionRef.current === "history") {
          focusHistoryRegion();
          return;
        }
        focusPromptRegion({ reveal: false });
      });
    }, [focusHistoryRegion, focusPromptRegion]);

    const openSearch = useCallback(() => {
      if (!searchVisible) {
        searchReturnRegionRef.current = activeRegionRef.current;
      }
      setHistorySelectAllEnabled(true);
      setSearchVisible(true);
      focusSearchInput();
    }, [focusSearchInput, searchVisible]);

    const moveSearchMatch = useCallback((direction: 1 | -1) => {
      setActiveSearchMatchIndex((currentIndex) =>
        getNextTranscriptSearchMatchIndex({
          currentIndex,
          matchCount: searchMatchCount,
          direction,
        }));
    }, [searchMatchCount]);

    useEffect(() => {
      if (!searchVisible) {
        return;
      }
      focusSearchInput();
    }, [focusSearchInput, searchVisible]);

    useEffect(() => {
      if (!searchVisible) {
        return;
      }
      if (searchMatchCount === 0) {
        if (activeSearchMatchIndex !== -1) {
          setActiveSearchMatchIndex(-1);
        }
        return;
      }
      if (activeSearchMatchIndex < 0 || activeSearchMatchIndex >= searchMatchCount) {
        setActiveSearchMatchIndex(0);
      }
    }, [activeSearchMatchIndex, searchMatchCount, searchVisible]);

    useEffect(() => {
      if (!searchVisible || !activeBlockSearchMatch) {
        return;
      }
      requestAnimationFrame(() => {
        const activeMatchElement = blockHistoryRef.current?.querySelector<HTMLElement>(
          ".transcript-blockHistory__searchMatch--active",
        );
        activeMatchElement?.scrollIntoView({ block: "center" });
      });
    }, [activeBlockSearchMatch, searchVisible]);

    const handleSearchInputChange = useCallback((event: ReactChangeEvent<HTMLInputElement>) => {
      setSearchQuery(event.target.value);
      setActiveSearchMatchIndex(event.target.value.length > 0 ? 0 : -1);
    }, []);

    const handleSearchInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        moveSearchMatch(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    }, [closeSearch, moveSearchMatch]);

    const handleSearchControlMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
    }, []);

    const handlePromptInputChange = useCallback((event: ReactChangeEvent<HTMLTextAreaElement>) => {
      preparePromptInteraction();
      setDraftValue(event.target.value, event.target);
      schedulePromptLayoutSync(event.target);
    }, [preparePromptInteraction, schedulePromptLayoutSync, setDraftValue]);

    const handlePromptInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (shouldSelectAllPromptFromPromptKeydown(event)) {
        event.preventDefault();
        preparePromptInteraction();
        const selectionEnd = event.currentTarget.value.length;
        event.currentTarget.setSelectionRange(0, selectionEnd, "forward");
        setPromptSelectionValue(0, selectionEnd);
        syncPromptCaretBox(event.currentTarget);
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      void submitDraft();
    }, [preparePromptInteraction, setPromptSelectionValue, submitDraft, syncPromptCaretBox]);

    const handlePromptInputSelectionChange = useCallback((event: { currentTarget: HTMLTextAreaElement }) => {
      preparePromptInteraction();
      syncPromptSelection(event.currentTarget);
    }, [preparePromptInteraction, syncPromptSelection]);

    const handlePromptInputFocus = useCallback((event: { currentTarget: HTMLTextAreaElement }) => {
      syncPromptSelection(event.currentTarget);
    }, [syncPromptSelection]);

    const handlePromptInputBlur = useCallback((event: { currentTarget: HTMLTextAreaElement }) => {
      setPromptSelectionValue(
        event.currentTarget.selectionStart ?? draftRef.current.length,
        event.currentTarget.selectionEnd ?? draftRef.current.length,
      );
      if (promptLayoutSyncFrameRef.current !== null) {
        cancelAnimationFrame(promptLayoutSyncFrameRef.current);
        promptLayoutSyncFrameRef.current = null;
      }
      applyPromptCaretBox(null);
    }, [applyPromptCaretBox, setPromptSelectionValue]);

    const handlePromptInputScroll = useCallback((event: { currentTarget: HTMLTextAreaElement }) => {
      syncPromptCaretBox(event.currentTarget);
    }, [syncPromptCaretBox]);

    const handlePromptBodyMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, textarea, .attachment-panel")) {
        return;
      }
      event.preventDefault();
      preparePromptInteraction();
      focusPromptInput();
    }, [focusPromptInput, preparePromptInteraction]);

    const handleSurfaceFocusChange = useCallback(() => {
      requestAnimationFrame(() => {
        syncPromptCaretBox();
      });
    }, [syncPromptCaretBox]);

    const handleBlockHistoryFocus = useCallback(() => {
      prepareHistoryInteraction();
      activeRegionRef.current = "history";
      syncBlockHistoryActiveState();
      syncPromptCaretBox();
    }, [prepareHistoryInteraction, syncBlockHistoryActiveState, syncPromptCaretBox]);

    const handleBlockHistoryMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
      if (resolveBlockHistoryLinkFromEventTarget(event.target)) {
        event.preventDefault();
      }
      prepareHistoryInteraction();
      activeRegionRef.current = "history";
      syncBlockHistoryActiveState();
      syncPromptCaretBox();
    }, [prepareHistoryInteraction, syncBlockHistoryActiveState, syncPromptCaretBox]);

    const handleBlockHistoryClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
      const link = resolveBlockHistoryLinkFromEventTarget(event.target);
      if (!link) {
        return;
      }
      event.preventDefault();
      void openTranscriptLink(link, cwd);
    }, [cwd]);

    const handleBlockHistoryKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, textarea, input")) {
        return;
      }
      const link = resolveBlockHistoryLinkFromEventTarget(event.target);
      if (link && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        void openTranscriptLink(link, cwd);
        return;
      }
      if (shouldSelectAllHistoryFromHistoryKeydown(event, activeRegionRef.current)) {
        event.preventDefault();
        selectAllHistoryText();
        return;
      }
      if (!shouldRedirectHistoryTypingToPrompt(event, {
        promptFocusDisabled: promptFocusDisabledRef.current,
        promptInputDisabled: promptInputDisabledRef.current,
      })) {
        return;
      }

      event.preventDefault();
      activeRegionRef.current = "prompt";
      syncBlockHistoryActiveState();
      focusPromptInput();
      insertTextIntoDraft(event.key);
    }, [cwd, focusPromptInput, insertTextIntoDraft, selectAllHistoryText, syncBlockHistoryActiveState]);

    const handleIncomingFiles = useCallback((files: ReadonlyArray<File>) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        return false;
      }

      onAddImageFiles?.(imageFiles);
      focusPromptRegion();
      return true;
    }, [focusPromptRegion, onAddImageFiles]);

    const handlePasteCapture = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length > 0) {
        if (handleIncomingFiles(files)) {
          event.preventDefault();
        }
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      const targetIsPrompt = event.target === promptTextareaRef.current;
      if (!shouldRedirectPlainTextPasteToPrompt({
        targetIsPrompt,
        hasFiles: false,
        promptInputDisabled,
        text,
      })) {
        return;
      }
      event.preventDefault();
      insertTextIntoDraft(text);
    }, [handleIncomingFiles, insertTextIntoDraft, promptInputDisabled]);

    const handleDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDraggingImages(true);
    }, []);

    const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingImages(true);
    }, []);

    const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) {
        return;
      }
      event.preventDefault();
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDraggingImages(false);
      }
    }, []);

    const handleDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingImages(false);
      handleIncomingFiles(Array.from(event.dataTransfer.files));
    }, [handleIncomingFiles]);

    const closeAttachmentViewer = useCallback(() => {
      attachmentViewerDragStateRef.current = null;
      setAttachmentViewerDragging(false);
      setAttachmentViewerImage(null);
      setAttachmentViewerNaturalSize({ width: 0, height: 0 });
      setAttachmentViewerScale(null);
      setAttachmentViewerPan({ x: 0, y: 0 });
      attachmentViewerScaleRef.current = null;
      attachmentViewerPanRef.current = { x: 0, y: 0 };
      attachmentViewerNaturalSizeRef.current = { width: 0, height: 0 };
      attachmentViewerFitScaleRef.current = 1;
    }, []);

    const openAttachmentViewer = useCallback((src: string, name: string) => {
      attachmentViewerDragStateRef.current = null;
      setAttachmentViewerDragging(false);
      setAttachmentViewerImage({ src, name });
      setAttachmentViewerNaturalSize({ width: 0, height: 0 });
      setAttachmentViewerScale(null);
      setAttachmentViewerPan({ x: 0, y: 0 });
      attachmentViewerScaleRef.current = null;
      attachmentViewerPanRef.current = { x: 0, y: 0 };
      attachmentViewerNaturalSizeRef.current = { width: 0, height: 0 };
      attachmentViewerFitScaleRef.current = 1;
    }, []);

    const updateAttachmentViewerScaleAndPan = useCallback((
      nextScale: number,
      nextPan: AttachmentViewerPan,
    ) => {
      const clampedPan = clampAttachmentViewerPan(
        nextPan,
        nextScale,
        attachmentViewerNaturalSizeRef.current,
        window.innerWidth,
        window.innerHeight,
      );
      attachmentViewerScaleRef.current = nextScale;
      attachmentViewerPanRef.current = clampedPan;
      setAttachmentViewerScale(nextScale);
      setAttachmentViewerPan(clampedPan);
    }, []);

    useEffect(() => {
      if (!promptInputDisabled) {
        return;
      }
      const textarea = promptTextareaRef.current;
      if (textarea && document.activeElement === textarea) {
        textarea.blur();
      }
    }, [promptInputDisabled]);

    useEffect(() => {
      paneActiveRef.current = paneActive;
      const textarea = promptTextareaRef.current;
      if (!paneActive && textarea && document.activeElement === textarea) {
        setPromptSelectionValue(
          textarea.selectionStart ?? draftRef.current.length,
          textarea.selectionEnd ?? draftRef.current.length,
        );
        textarea.blur();
      }
      syncPromptCaretBox(textarea);
    }, [paneActive, setPromptSelectionValue, syncPromptCaretBox]);

    useEffect(() => {
      if (!attachmentViewerImage) {
        return;
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        closeAttachmentViewer();
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
      };
    }, [attachmentViewerImage, closeAttachmentViewer]);

    useEffect(() => {
      if (!attachmentViewerImage || attachmentViewerScaleRef.current === null) {
        return;
      }

      const handleResize = () => {
        const currentScale = attachmentViewerScaleRef.current;
        if (currentScale === null) {
          return;
        }
        const nextFitScale = resolveAttachmentViewerFitScale(
          attachmentViewerNaturalSizeRef.current,
          window.innerWidth,
          window.innerHeight,
        );
        const shouldSnapToFit = Math.abs(currentScale - attachmentViewerFitScaleRef.current) < 0.001;
        attachmentViewerFitScaleRef.current = nextFitScale;
        if (shouldSnapToFit) {
          attachmentViewerScaleRef.current = nextFitScale;
          attachmentViewerPanRef.current = { x: 0, y: 0 };
          setAttachmentViewerScale(nextFitScale);
          setAttachmentViewerPan({ x: 0, y: 0 });
          return;
        }
        const clampedPan = clampAttachmentViewerPan(
          attachmentViewerPanRef.current,
          currentScale,
          attachmentViewerNaturalSizeRef.current,
          window.innerWidth,
          window.innerHeight,
        );
        attachmentViewerPanRef.current = clampedPan;
        setAttachmentViewerPan(clampedPan);
      };

      window.addEventListener("resize", handleResize);
      return () => {
        window.removeEventListener("resize", handleResize);
      };
    }, [attachmentViewerImage]);

    const handleAttachmentViewerImageLoad = useCallback((event: ReactSyntheticEvent<HTMLImageElement>) => {
      const image = event.currentTarget;
      const naturalSize = {
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
      const fitScale = resolveAttachmentViewerFitScale(
        naturalSize,
        window.innerWidth,
        window.innerHeight,
      );
      attachmentViewerNaturalSizeRef.current = naturalSize;
      attachmentViewerFitScaleRef.current = fitScale;
      attachmentViewerScaleRef.current = fitScale;
      attachmentViewerPanRef.current = { x: 0, y: 0 };
      setAttachmentViewerNaturalSize(naturalSize);
      setAttachmentViewerScale(fitScale);
      setAttachmentViewerPan({ x: 0, y: 0 });
    }, []);

    const handleAttachmentViewerWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
      if (attachmentViewerScaleRef.current === null || attachmentViewerNaturalSizeRef.current.width <= 0) {
        return;
      }
      event.preventDefault();
      const currentScale = attachmentViewerScaleRef.current;
      const minScale = attachmentViewerFitScaleRef.current;
      const maxScale = 8;
      const nextScale = Math.min(
        maxScale,
        Math.max(minScale, currentScale * Math.exp(-event.deltaY * 0.0015)),
      );
      if (Math.abs(nextScale - currentScale) < 0.0001) {
        return;
      }
      const canvasRect = event.currentTarget.getBoundingClientRect();
      const relativeX = event.clientX - (canvasRect.left + canvasRect.width / 2);
      const relativeY = event.clientY - (canvasRect.top + canvasRect.height / 2);
      const currentPan = attachmentViewerPanRef.current;
      const worldX = (relativeX - currentPan.x) / currentScale;
      const worldY = (relativeY - currentPan.y) / currentScale;
      updateAttachmentViewerScaleAndPan(nextScale, {
        x: relativeX - worldX * nextScale,
        y: relativeY - worldY * nextScale,
      });
    }, [updateAttachmentViewerScaleAndPan]);

    const handleAttachmentViewerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || attachmentViewerScaleRef.current === null) {
        return;
      }
      if (!canPanAttachmentViewer(
        attachmentViewerScaleRef.current,
        attachmentViewerNaturalSizeRef.current,
        window.innerWidth,
        window.innerHeight,
      )) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      attachmentViewerDragStateRef.current = {
        pointerId: event.pointerId,
        startPan: attachmentViewerPanRef.current,
        startX: event.clientX,
        startY: event.clientY,
      };
      setAttachmentViewerDragging(true);
    }, []);

    const handleAttachmentViewerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = attachmentViewerDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId || attachmentViewerScaleRef.current === null) {
        return;
      }
      event.preventDefault();
      const nextPan = {
        x: dragState.startPan.x + (event.clientX - dragState.startX),
        y: dragState.startPan.y + (event.clientY - dragState.startY),
      };
      const clampedPan = clampAttachmentViewerPan(
        nextPan,
        attachmentViewerScaleRef.current,
        attachmentViewerNaturalSizeRef.current,
        window.innerWidth,
        window.innerHeight,
      );
      attachmentViewerPanRef.current = clampedPan;
      setAttachmentViewerPan(clampedPan);
    }, []);

    const handleAttachmentViewerPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = attachmentViewerDragStateRef.current;
      if (dragState?.pointerId !== event.pointerId) {
        return;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      attachmentViewerDragStateRef.current = null;
      setAttachmentViewerDragging(false);
    }, []);

    const handleAttachmentViewerDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      updateAttachmentViewerScaleAndPan(1, { x: 0, y: 0 });
    }, [updateAttachmentViewerScaleAndPan]);

    const attachmentViewerCanPan =
      attachmentViewerScale !== null
      && typeof window !== "undefined"
      && canPanAttachmentViewer(
        attachmentViewerScale,
        attachmentViewerNaturalSize,
        window.innerWidth,
        window.innerHeight,
      );

    useImperativeHandle(ref, () => ({
      focus() {
        focusPromptRegion();
      },
      focusPrompt(options) {
        focusPromptRegion(options);
      },
      focusHistory() {
        focusHistoryRegion();
      },
      hasFocusWithinPane() {
        if (typeof document === "undefined") {
          return false;
        }
        const activeElement = document.activeElement;
        return activeElement instanceof Node && surfaceRef.current?.contains(activeElement) === true;
      },
      openSearch() {
        openSearch();
      },
      isHistoryActive() {
        return activeRegionRef.current === "history";
      },
      hasHistorySelection() {
        if (typeof window === "undefined") {
          return false;
        }
        return hasNonCollapsedSelectionInsideElement(window.getSelection(), blockHistoryRef.current);
      },
      selectAllHistory() {
        return selectAllHistoryText();
      },
      insertPromptText(text) {
        insertTextIntoDraft(text);
      },
      deletePromptBackward() {
        deletePromptText("backward");
      },
      deletePromptForward() {
        deletePromptText("forward");
      },
      submitPrompt() {
        void submitDraft();
      },
      scrollToBottom() {
        const scrollContainer = historyScrollContainerRef.current;
        if (!scrollContainer) {
          return;
        }
        scrollContainer.scrollTop = resolveInitialConversationScrollTop(scrollContainer, null);
        syncHistoryMetrics();
      },
    }), [deletePromptText, focusHistoryRegion, focusPromptRegion, insertTextIntoDraft, openSearch, selectAllHistoryText, submitDraft, syncHistoryMetrics]);

    return (
      <div
        ref={surfaceRef}
        className={`transcript-surface${isDraggingImages ? " transcript-surface--drag-over" : ""}`}
        onBlurCapture={handleSurfaceFocusChange}
        onFocusCapture={handleSurfaceFocusChange}
        onPasteCapture={handlePasteCapture}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {searchVisible ? (
          <div
            className="transcript-search"
            role="search"
            aria-label="Find in transcript"
          >
            <input
              ref={searchInputRef}
              type="text"
              className="transcript-search__input"
              value={searchQuery}
              onChange={handleSearchInputChange}
              onKeyDown={handleSearchInputKeyDown}
              placeholder="Find in pane"
              spellCheck={false}
            />
            <span className="transcript-search__status" aria-live="polite">
              {searchQuery.length === 0
                ? "Find"
                : searchMatchCount === 0
                  ? "0 results"
                  : `${resolvedActiveSearchMatchIndex + 1}/${searchMatchCount}`}
            </span>
            <div className="transcript-search__actions">
              <button
                type="button"
                className="transcript-search__button"
                onMouseDown={handleSearchControlMouseDown}
                onClick={() => moveSearchMatch(-1)}
                aria-label="Previous match"
                disabled={searchMatchCount === 0}
              >
                ↑
              </button>
              <button
                type="button"
                className="transcript-search__button"
                onMouseDown={handleSearchControlMouseDown}
                onClick={() => moveSearchMatch(1)}
                aria-label="Next match"
                disabled={searchMatchCount === 0}
              >
                ↓
              </button>
              <button
                type="button"
                className="transcript-search__button"
                onMouseDown={handleSearchControlMouseDown}
                onClick={() => closeSearch()}
                aria-label="Close find"
              >
                ×
              </button>
            </div>
          </div>
        ) : null}
        <div className="transcript-history" ref={historyScrollContainerRef}>
          <div
            className="transcript-history__blockRoot"
            ref={blockHistoryRef}
            tabIndex={0}
            onFocus={handleBlockHistoryFocus}
            onMouseDown={handleBlockHistoryMouseDown}
            onClick={handleBlockHistoryClick}
            onKeyDown={handleBlockHistoryKeyDown}
          >
            <pre
              ref={historySelectAllTextRef}
              aria-hidden="true"
              style={{
                position: "absolute",
                left: "-100000px",
                top: 0,
                margin: 0,
                whiteSpace: "pre-wrap",
                pointerEvents: "none",
                userSelect: "text",
              }}
            >
              {historyPlainText}
            </pre>
            <TranscriptHistoryBlocks
              blocks={blocks}
              {...(precomputedBlockLines ? { precomputedBlockLines } : {})}
              {...(precomputedBlockRows ? { precomputedBlockRows } : {})}
              cacheKey={historyCacheKey}
              searchMatches={blockSearchMatches}
              activeSearchMatchIndex={resolvedActiveSearchMatchIndex}
              expandedCommandSignatures={expandedCommandSignatures}
              collapsedFileChangeSignatures={collapsedFileChangeSignatures}
              resolvedInlineDiffBySignature={resolvedInlineDiffBySignature}
              onToggleCommandWidget={handleBlockHistoryCommandWidgetToggle}
              scrollTop={blockHistoryScrollTop}
              viewportHeight={blockHistoryViewportHeight}
              scrollContainerRef={historyScrollContainerRef}
              isScrolling={blockHistoryScrolling}
            />
          </div>
          {historyState !== "ready" && blocks.length === 0 ? (
            <div
              className={`transcript-history__state transcript-history__state--${historyState}`}
              aria-live={historyState === "loading" ? "polite" : "assertive"}
            >
              {historyState === "loading" ? (
                <AnimatedLoadingText
                  text={historyStateMessage ?? "loading thread history"}
                  className="transcript-history__stateText"
                />
              ) : (
                <span className="transcript-history__stateText">
                  {historyStateMessage ?? "Failed to load thread history."}
                </span>
              )}
            </div>
          ) : null}
        </div>
        <div
          className={compactPendingUserInputPrompt ? "transcript-prompt transcript-prompt--compact" : "transcript-prompt"}
          onMouseDown={handlePromptBodyMouseDown}
        >
          {composerAttachments.length > 0 ? (
            <div className="attachment-panel attachment-panel--composer">
              {composerAttachments.map((attachment) => (
                <div className="attachment-tile" key={attachment.id}>
                  {attachment.previewUrl ? (
                    <button
                      type="button"
                      className="attachment-tile__media"
                      aria-label={`Open ${attachment.name}`}
                      onClick={() => {
                        openAttachmentViewer(attachment.previewUrl!, attachment.name);
                      }}
                    >
                      <img
                        className="attachment-tile__image"
                        alt={attachment.name}
                        draggable={false}
                        src={attachment.previewUrl}
                      />
                    </button>
                  ) : (
                    <div className="attachment-tile__media attachment-tile__media--empty" />
                  )}
                  <div className="attachment-tile__meta">
                    <div className="attachment-tile__name">{attachment.name}</div>
                    <div className="attachment-tile__detail">
                      {formatAttachmentSize(attachment.sizeBytes)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="attachment-tile__remove"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => {
                      onRemoveImage?.(attachment.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="transcript-prompt__body">
            <div className="transcript-prompt__row">
              <span className="transcript-prompt__marker" aria-hidden="true">›</span>
              <div className="transcript-prompt__inputShell">
                <textarea
                  ref={promptTextareaRef}
                  className={`transcript-prompt__input ${
                    useNativePromptCaret
                      ? "transcript-prompt__input--nativeCaret"
                      : "transcript-prompt__input--customCaret"
                  }`}
                  defaultValue=""
                  rows={2}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  aria-label="Prompt input"
                  aria-disabled={promptInputDisabled}
                  readOnly={promptInputDisabled}
                  onChange={handlePromptInputChange}
                  onBlur={handlePromptInputBlur}
                  onClick={handlePromptInputSelectionChange}
                  onFocus={handlePromptInputFocus}
                  onKeyDown={handlePromptInputKeyDown}
                  onScroll={handlePromptInputScroll}
                  onSelect={handlePromptInputSelectionChange}
                />
                <div
                  ref={promptCaretRef}
                  aria-hidden="true"
                  className="transcript-prompt__customCaret"
                  hidden
                />
              </div>
            </div>
          </div>
        </div>
        {attachmentViewerImage ? (
          <div
            className="image-viewer"
            role="dialog"
            aria-modal="true"
            aria-label={`Image viewer: ${attachmentViewerImage.name}`}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                closeAttachmentViewer();
              }
            }}
          >
            <div className="image-viewer__header">
              <div className="image-viewer__label">{attachmentViewerImage.name}</div>
            </div>
            <div
              className="image-viewer__canvas"
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  closeAttachmentViewer();
                }
              }}
            >
              <div
                className={`image-viewer__surface${
                  attachmentViewerCanPan ? " image-viewer__surface--pannable" : ""
                }${attachmentViewerDragging ? " image-viewer__surface--dragging" : ""}`}
                onDoubleClick={handleAttachmentViewerDoubleClick}
                onPointerCancel={handleAttachmentViewerPointerEnd}
                onPointerDown={handleAttachmentViewerPointerDown}
                onPointerMove={handleAttachmentViewerPointerMove}
                onPointerUp={handleAttachmentViewerPointerEnd}
                onWheel={handleAttachmentViewerWheel}
              >
                <img
                  className={`image-viewer__image${attachmentViewerScale === null ? " image-viewer__image--hidden" : ""}`}
                  alt={attachmentViewerImage.name}
                  draggable={false}
                  onDragStart={(event) => {
                    event.preventDefault();
                  }}
                  onLoad={handleAttachmentViewerImageLoad}
                  src={attachmentViewerImage.src}
                  style={{
                    width:
                      attachmentViewerNaturalSize.width > 0
                        ? `${attachmentViewerNaturalSize.width}px`
                        : undefined,
                    height:
                      attachmentViewerNaturalSize.height > 0
                        ? `${attachmentViewerNaturalSize.height}px`
                        : undefined,
                    transform:
                      attachmentViewerScale === null
                        ? undefined
                        : `translate(${attachmentViewerPan.x}px, ${attachmentViewerPan.y}px) scale(${attachmentViewerScale})`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  },
);
