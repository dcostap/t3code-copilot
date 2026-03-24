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
} from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { defaultKeymap } from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";

import { createAnimatedLoadingTextElement } from "../AnimatedLoadingText";
import type { ComposerImageAttachment } from "../composerAttachments";
import {
  blockToLines,
  type AnnotatedLine,
  type InlineDiffLookup,
  type LineKind,
  type TranscriptBlock,
  type TranscriptImageAttachment,
} from "./TranscriptBlock";

interface PositionedLine {
  readonly from: number;
  readonly to: number;
  readonly kind: LineKind;
  readonly extraClasses?: ReadonlyArray<string>;
  readonly commandWidgetSignature?: string;
}

interface PositionedMark {
  readonly from: number;
  readonly to: number;
  readonly className: string;
  readonly link?: {
    readonly kind: "url" | "file";
    readonly target: string;
  };
}

interface TranscriptDocumentModel {
  readonly text: string;
  readonly historyLineCount: number;
  readonly lines: ReadonlyArray<PositionedLine>;
  readonly marks: ReadonlyArray<PositionedMark>;
  readonly widgets: ReadonlyArray<PositionedWidget>;
  readonly replacements: ReadonlyArray<PositionedReplacement>;
  readonly fileChangeWidgetSignatures: ReadonlySet<string>;
  readonly inlineDiffLookupsBySignature: ReadonlyMap<string, InlineDiffLookup>;
  readonly inlineDiffContentBySignature: ReadonlyMap<string, string>;
  readonly defaultExpandedInlineDiffSignatures: ReadonlyMap<string, InlineDiffLookup>;
  readonly separatorStart: number;
  readonly promptStart: number;
}

interface PositionedWidget {
  readonly position: number;
  readonly side: -1 | 1;
  readonly widget: WidgetType;
  readonly signature: string;
}

interface PositionedReplacement {
  readonly from: number;
  readonly to: number;
  readonly widget: WidgetType;
  readonly signature: string;
}

type UserMessageCopyLine = Pick<PositionedLine, "from" | "extraClasses">;

interface CodeBlockWidgetLineData {
  readonly text: string;
  readonly highlightSpans?: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
    readonly className: string;
  }>;
}

interface InlineDiffRowData {
  readonly kind: "metadata" | "context" | "addition" | "deletion" | "gap";
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
  readonly text: string;
}

interface InlineTextHighlightSpan {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

interface InlineDiffHunkData {
  readonly header: string;
  readonly rows: ReadonlyArray<InlineDiffRowData>;
}

interface InlineDiffFileData {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: ReadonlyArray<InlineDiffHunkData>;
}

interface StoredSelection {
  readonly anchor: number;
  readonly head: number;
}

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

interface PromptCaretMeasureElements {
  readonly mirror: HTMLDivElement;
  readonly textNode: globalThis.Text;
  readonly marker: HTMLSpanElement;
}

interface TranscriptRendererProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly composerAttachments?: ReadonlyArray<ComposerImageAttachment>;
  readonly cwd?: string | null;
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

interface CommandWidgetLineContent {
  readonly signature: string;
  readonly glyph: string;
  readonly prefix: string;
  readonly command: string;
  readonly timingLabel?: string;
  readonly counts?: {
    additions: string;
    deletions: string;
  };
  readonly inlineDiffFiles?: ReadonlyArray<InlineDiffFileData>;
  readonly rawInlineDiff?: string;
  readonly inlineDiffStateMessage?: string;
  readonly inlineDiffStateClass?: string;
  readonly outputLines?: ReadonlyArray<string>;
  readonly expanded: boolean;
  readonly hasHiddenExpansionContent: boolean;
  readonly isFileChange: boolean;
  readonly isRunning: boolean;
  readonly statusClass?: string;
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

const CURSOR_VIEWPORT_PADDING_LINES = 7;

const syncAnnotation = Annotation.define<boolean>();
const setPromptStartEffect = StateEffect.define<number>();
const decorationsCompartment = new Compartment();
const setSearchDecorationsEffect = StateEffect.define<DecorationSet>();
const commandWidgetResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();
const SEARCH_MATCH_VIEWPORT_PADDING_PX = 36;

const promptStartField = StateField.define<number>({
  create: () => 0,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPromptStartEffect)) {
        return effect.value;
      }
    }

    return transaction.changes.mapPos(value, -1);
  },
});

const searchDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSearchDecorationsEffect)) {
        return effect.value;
      }
    }
    return transaction.docChanged ? value.map(transaction.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function formatAttachmentSize(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }
  return `${sizeBytes} B`;
}

function attachmentBadgeLabel(mimeType: string) {
  const subtype = mimeType.split("/")[1]?.trim().toUpperCase();
  return subtype && subtype.length <= 5 ? subtype : "IMG";
}

function createAttachmentTileDom(
  attachment: TranscriptImageAttachment,
  variant: "history" | "composer",
  options: {
    onRemoveImage?(attachmentId: string): void;
  } = {},
) {
  const tile = document.createElement("div");
  tile.className = "attachment-tile";
  tile.title = `${attachment.name} (${attachment.mimeType}, ${formatAttachmentSize(attachment.sizeBytes)})`;

  const media =
    attachment.previewUrl && variant === "history"
      ? document.createElement("a")
      : document.createElement("div");
  media.className = "attachment-tile__media";
  if (media instanceof HTMLAnchorElement && attachment.previewUrl) {
    media.href = attachment.previewUrl;
    media.target = "_blank";
    media.rel = "noreferrer";
  }

  const fallback = document.createElement("div");
  fallback.className = "attachment-tile__fallback";
  fallback.textContent = attachmentBadgeLabel(attachment.mimeType);
  media.append(fallback);

  if (attachment.previewUrl) {
    const image = document.createElement("img");
    image.className = "attachment-tile__image";
    image.alt = attachment.name;
    image.loading = "lazy";
    image.src = attachment.previewUrl;
    image.addEventListener("load", () => {
      fallback.hidden = true;
    });
    image.addEventListener("error", () => {
      image.hidden = true;
      fallback.hidden = false;
    });
    media.append(image);
  }

  const meta = document.createElement("div");
  meta.className = "attachment-tile__meta";

  const name = document.createElement("div");
  name.className = "attachment-tile__name";
  name.textContent = attachment.name;

  const detail = document.createElement("div");
  detail.className = "attachment-tile__detail";
  detail.textContent = `${attachment.mimeType} · ${formatAttachmentSize(attachment.sizeBytes)}`;

  meta.append(name, detail);
  tile.append(media, meta);

  if (variant === "composer" && options.onRemoveImage) {
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "attachment-tile__remove";
    removeButton.textContent = "×";
    removeButton.setAttribute("aria-label", `Remove ${attachment.name}`);
    removeButton.addEventListener("click", () => {
      options.onRemoveImage?.(attachment.id);
    });
    tile.append(removeButton);
  }

  return tile;
}

class ImageAttachmentTileWidget extends WidgetType {
  constructor(private readonly attachment: TranscriptImageAttachment) {
    super();
  }

  override eq(other: ImageAttachmentTileWidget) {
    return JSON.stringify(this.attachment) === JSON.stringify(other.attachment);
  }

  override toDOM() {
    return createAttachmentTileDom(this.attachment, "history");
  }
}

async function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard copy failed");
  }
}

function renderCodeBlockLine(
  line: CodeBlockWidgetLineData,
) {
  const lineElement = document.createElement("span");
  lineElement.className = "cm-codeBlockLine";

  if (!line.highlightSpans || line.highlightSpans.length === 0) {
    if (line.text.length > 0) {
      lineElement.textContent = line.text;
    }
    return lineElement;
  }

  const orderedSpans = line.highlightSpans.toSorted((left, right) => left.from - right.from);
  let cursor = 0;

  for (const span of orderedSpans) {
    const from = Math.max(0, Math.min(line.text.length, span.from));
    const to = Math.max(from, Math.min(line.text.length, span.to));
    if (from > cursor) {
      lineElement.append(document.createTextNode(line.text.slice(cursor, from)));
    }
    if (to > from) {
      const highlighted = document.createElement("span");
      highlighted.className = `cm-codeToken ${span.className}`;
      highlighted.textContent = line.text.slice(from, to);
      lineElement.append(highlighted);
    }
    cursor = Math.max(cursor, to);
  }

  if (cursor < line.text.length) {
    lineElement.append(document.createTextNode(line.text.slice(cursor)));
  }

  return lineElement;
}

function renderHighlightedInlineText(
  text: string,
  highlightSpans?: ReadonlyArray<InlineTextHighlightSpan>,
) {
  const root = document.createElement("span");

  if (!highlightSpans || highlightSpans.length === 0) {
    root.textContent = text;
    return root;
  }

  const orderedSpans = highlightSpans.toSorted((left, right) => left.from - right.from);
  let cursor = 0;

  for (const span of orderedSpans) {
    const from = Math.max(0, Math.min(text.length, span.from));
    const to = Math.max(from, Math.min(text.length, span.to));
    if (from > cursor) {
      root.append(document.createTextNode(text.slice(cursor, from)));
    }
    if (to > from) {
      const highlighted = document.createElement("span");
      highlighted.className = `cm-codeToken ${span.className}`;
      highlighted.textContent = text.slice(from, to);
      root.append(highlighted);
    }
    cursor = Math.max(cursor, to);
  }

  if (cursor < text.length) {
    root.append(document.createTextNode(text.slice(cursor)));
  }

  return root;
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

function resolveInteractiveMarkAtPosition(
  marks: ReadonlyArray<PositionedMark>,
  position: number | null,
) {
  if (position === null) {
    return null;
  }
  return marks.find((mark) => mark.link && position >= mark.from && position < mark.to) ?? null;
}

function resolveInteractiveMarkFromMouseEvent(
  view: EditorView,
  event: MouseEvent,
  marks: ReadonlyArray<PositionedMark>,
) {
  return resolveInteractiveMarkAtPosition(
    marks,
    view.posAtCoords({
      x: event.clientX,
      y: event.clientY,
    }),
  );
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

  const signature = commandSurface.dataset?.commandWidgetSignature;
  if (typeof signature === "string" && signature.length > 0) {
    return signature;
  }

  return null;
}

export function shouldIgnoreCommandWidgetEvent(
  event: Pick<Event, "type"> & { target: unknown },
) {
  if (event.type === "copy") {
    return false;
  }
  return resolveCommandWidgetToggleSignatureFromEventTarget(event.target) === null;
}

export function isCommandWidgetSummaryOverflowing(
  element:
    | Pick<HTMLElement, "clientWidth" | "scrollWidth">
    | null
    | undefined,
) {
  if (!element) {
    return false;
  }
  return element.scrollWidth > element.clientWidth + 1;
}

export function shouldRenderCommandWidgetToggleRail(options: {
  readonly expanded: boolean;
  readonly hasHiddenExpansionContent: boolean;
  readonly summaryOverflowing: boolean;
}) {
  return options.expanded || options.hasHiddenExpansionContent || options.summaryOverflowing;
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

function renderAnimatedCommandText(text: string) {
  return createAnimatedLoadingTextElement(text, { className: "cm-commandWidgetAnimatedText" });
}

class AnimatedLoadingTextLine extends WidgetType {
  constructor(
    private readonly animatedText: string,
    private readonly suffixText: string,
    private readonly className: string,
    private readonly characterDelaySeconds?: number,
  ) {
    super();
  }

  override eq(other: AnimatedLoadingTextLine) {
    return this.animatedText === other.animatedText
      && this.suffixText === other.suffixText
      && this.className === other.className
      && this.characterDelaySeconds === other.characterDelaySeconds;
  }

  override updateDOM(dom: HTMLElement) {
    if (dom.dataset.animatedText !== this.animatedText || dom.dataset.className !== this.className) {
      return false;
    }

    const suffix = dom.querySelector<HTMLElement>(".cm-workingLineAnimatedSuffix");
    if (!suffix) {
      return false;
    }

    suffix.textContent = this.suffixText;
    return true;
  }

  override toDOM(view: EditorView) {
    const root = view.dom.ownerDocument.createElement("span");
    root.className = this.className;
    root.dataset.animatedText = this.animatedText;
    root.dataset.className = this.className;
    root.append(createAnimatedLoadingTextElement(this.animatedText, {
      document: view.dom.ownerDocument,
      className: "cm-workingLineAnimatedPrefix",
      ...(this.characterDelaySeconds !== undefined ? { characterDelaySeconds: this.characterDelaySeconds } : {}),
    }));
    const suffix = view.dom.ownerDocument.createElement("span");
    suffix.className = "cm-workingLineAnimatedSuffix";
    suffix.textContent = this.suffixText;
    root.append(suffix);
    return root;
  }
}

class CodeBlockWidget extends WidgetType {
  constructor(
    private readonly content: {
      signature: string;
      code: string;
      lines: ReadonlyArray<CodeBlockWidgetLineData>;
    },
  ) {
    super();
  }

  override eq(other: CodeBlockWidget) {
    return JSON.stringify(this.content) === JSON.stringify(other.content);
  }

  override toDOM() {
    const root = document.createElement("div");
    root.className = "cm-codeBlockSurface";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "cm-codeBlockCopyButton";
    copyButton.setAttribute("title", "Copy code block");
    copyButton.setAttribute("aria-label", "Copy code block");

    const copyButtonLabel = document.createElement("span");
    copyButtonLabel.className = "cm-codeBlockCopyButtonLabel";
    copyButtonLabel.textContent = "Copy";

    const copyButtonStatus = document.createElement("span");
    copyButtonStatus.className = "cm-codeBlockCopyButtonStatus";
    copyButtonStatus.setAttribute("aria-hidden", "true");

    copyButton.append(copyButtonLabel, copyButtonStatus);

    const copiedFeedbackDurationMs = 520;
    const copyButtonExitDurationMs = 160;
    let feedbackTimer: number | undefined;
    let contentResetTimer: number | undefined;
    const clearContentResetTimer = () => {
      if (contentResetTimer !== undefined) {
        window.clearTimeout(contentResetTimer);
        contentResetTimer = undefined;
      }
    };
    const clearFeedbackTimer = () => {
      if (feedbackTimer !== undefined) {
        window.clearTimeout(feedbackTimer);
        feedbackTimer = undefined;
      }
    };
    const resetCopyButtonContent = () => {
      clearContentResetTimer();
      copyButton.classList.remove("cm-codeBlockCopyButtonCopied", "cm-codeBlockCopyButtonFailed");
      copyButtonStatus.textContent = "";
    };
    const shouldDelayContentReset = () =>
      !root.matches(":hover") && !root.matches(":focus-within");
    const releaseCopyFeedback = () => {
      clearFeedbackTimer();
      root.classList.remove("cm-codeBlockSurfaceCopyFeedbackActive");
      if (!shouldDelayContentReset()) {
        resetCopyButtonContent();
        return;
      }
      clearContentResetTimer();
      contentResetTimer = window.setTimeout(() => {
        resetCopyButtonContent();
      }, copyButtonExitDurationMs);
    };

    const applyCopyFeedback = (variant: "copied" | "failed") => {
      clearFeedbackTimer();
      clearContentResetTimer();
      root.classList.add("cm-codeBlockSurfaceCopyFeedbackActive");
      copyButton.classList.remove("cm-codeBlockCopyButtonCopied", "cm-codeBlockCopyButtonFailed");
      void copyButton.offsetWidth;
      copyButton.classList.add(
        variant === "copied" ? "cm-codeBlockCopyButtonCopied" : "cm-codeBlockCopyButtonFailed",
      );
      copyButtonStatus.textContent = variant === "copied" ? "\u2713" : "!";
      feedbackTimer = window.setTimeout(() => {
        releaseCopyFeedback();
      }, variant === "copied" ? copiedFeedbackDurationMs : 1400);
    };

    copyButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    copyButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await copyTextToClipboard(this.content.code);
        applyCopyFeedback("copied");
      } catch {
        applyCopyFeedback("failed");
      }
    });

    const content = document.createElement("pre");
    content.className = "cm-codeBlockContent";
    this.content.lines.forEach((line, index) => {
      content.append(renderCodeBlockLine(line));
      if (index < this.content.lines.length - 1) {
        content.append(document.createTextNode("\n"));
      }
    });

    root.append(copyButton, content);
    return root;
  }
}

function normalizeDiffPath(path: string) {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function resolveInlineDiffPath(file: FileDiffMetadata) {
  return normalizeDiffPath(file.name ?? file.prevName ?? "");
}

export function normalizeInlineDiffRowText(text: string) {
  return text.replace(/\r?\n$/, "");
}

function buildInlineDiffRows(file: FileDiffMetadata): InlineDiffFileData {
  const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
  const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
  let previousOldLineNumber: number | null = null;
  let previousNewLineNumber: number | null = null;
  const hunks: InlineDiffHunkData[] = file.hunks.map((hunk) => {
    const rows: InlineDiffRowData[] = [];
    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            kind: "context",
            oldLineNumber,
            newLineNumber,
            text: normalizeInlineDiffRowText(file.additionLines[content.additionLineIndex + index] ?? ""),
          });
          oldLineNumber += 1;
          newLineNumber += 1;
        }
        continue;
      }

      for (let index = 0; index < content.deletions; index += 1) {
        rows.push({
          kind: "deletion",
          oldLineNumber,
          text: normalizeInlineDiffRowText(file.deletionLines[content.deletionLineIndex + index] ?? ""),
        });
        oldLineNumber += 1;
      }

      for (let index = 0; index < content.additions; index += 1) {
        rows.push({
          kind: "addition",
          newLineNumber,
          text: normalizeInlineDiffRowText(file.additionLines[content.additionLineIndex + index] ?? ""),
        });
        newLineNumber += 1;
      }
    }

    const firstVisibleRow = rows[0];
    if (
      firstVisibleRow
      && (
        (
          previousOldLineNumber !== null
          && firstVisibleRow.oldLineNumber !== undefined
          && firstVisibleRow.oldLineNumber > previousOldLineNumber + 1
        )
        || (
          previousNewLineNumber !== null
          && firstVisibleRow.newLineNumber !== undefined
          && firstVisibleRow.newLineNumber > previousNewLineNumber + 1
        )
      )
    ) {
      rows.unshift({
        kind: "gap",
        text: "",
      });
    }

    if (rows.length > 0) {
      previousOldLineNumber = oldLineNumber - 1;
      previousNewLineNumber = newLineNumber - 1;
    }

    return {
      header: hunk.hunkContext ? `${hunk.hunkSpecs ?? "@@"} ${hunk.hunkContext}` : (hunk.hunkSpecs ?? "@@"),
      rows,
    };
  });

  return {
    path: resolveInlineDiffPath(file),
    ...(file.prevName ? { previousPath: normalizeDiffPath(file.prevName) } : {}),
    additions,
    deletions,
    hunks,
  };
}

const inlineDiffCache = new Map<string, ReadonlyArray<InlineDiffFileData>>();

export function parseInlineDiffFiles(
  unifiedDiff: string,
  changedFiles?: ReadonlyArray<string>,
): ReadonlyArray<InlineDiffFileData> {
  const normalizedPatch = unifiedDiff.replace(/\r\n/g, "\n").trim();
  if (normalizedPatch.length === 0) {
    return [];
  }

  const normalizedPaths = changedFiles?.map((path) => normalizeDiffPath(path)) ?? [];
  const cacheKey = `${normalizedPaths.join("|")}::${normalizedPatch}`;
  const cached = inlineDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const parsed = parsePatchFiles(normalizedPatch);
    const files = parsed.flatMap((patch) => patch.files);
    const allowedPaths = new Set(normalizedPaths);
    const filteredFiles = allowedPaths.size > 0
      ? files.filter((file) => {
          const nextPath = resolveInlineDiffPath(file);
          const previousPath = file.prevName ? normalizeDiffPath(file.prevName) : null;
          return allowedPaths.has(nextPath) || (previousPath !== null && allowedPaths.has(previousPath));
        })
      : files;
    const inlineFiles = filteredFiles.map((file) => buildInlineDiffRows(file));
    inlineDiffCache.set(cacheKey, inlineFiles);
    return inlineFiles;
  } catch {
    inlineDiffCache.set(cacheKey, []);
    return [];
  }
}

function extractCommandWidgetCounts(value: string):
  | {
      base: string;
      counts: {
        additions: string;
        deletions: string;
      };
    }
  | null {
  const match = /^(?<base>[\s\S]*?) \((?<add>\+\d+), (?<remove>-\d+)\)$/.exec(value);
  const groups = match?.groups;
  const additions = groups?.add;
  const deletions = groups?.remove;
  if (!groups || !additions || !deletions) {
    return null;
  }
  return {
    base: groups.base ?? value,
    counts: {
      additions,
      deletions,
    },
  };
}

function buildCommandWidgetSummaryCopyText(content: {
  glyph: string;
  prefix: string;
  command: string;
  timingLabel?: string;
  counts?: {
    additions: string;
    deletions: string;
  };
}) {
  return [
    `${content.glyph} ${content.prefix}${content.counts ? ` (${content.counts.additions}, ${content.counts.deletions})` : ""}`,
    content.command,
    content.timingLabel,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

function parseCommandWidgetText(text: string): {
  glyph: string;
  prefix: string;
  command: string;
  commandRange?: {
    from: number;
    to: number;
  };
  timingLabel?: string;
  counts?: {
    additions: string;
    deletions: string;
  };
} | null {
  const firstSpace = text.indexOf(" ");
  if (firstSpace <= 0) {
    return null;
  }

  const glyph = text.slice(0, firstSpace);
  const prefixAndCommand = text.slice(firstSpace + 1);
  const firstDivider = prefixAndCommand.indexOf("  ");
  if (firstDivider <= 0) {
    return null;
  }

  let prefix = prefixAndCommand.slice(0, firstDivider);
  let command = prefixAndCommand.slice(firstDivider + 2);
  let rawCommandStart = firstSpace + 1 + firstDivider + 2;
  let rawCommandEnd = text.length;
  let timingLabel: string | undefined;
  let counts:
    | {
        additions: string;
        deletions: string;
      }
    | undefined;

  const prefixCounts = extractCommandWidgetCounts(prefix);
  if (prefixCounts) {
    prefix = prefixCounts.base;
    counts = prefixCounts.counts;
  }

  for (const marker of ["  Finished in ", "  Completed in ", "  Running for ", "  Failed after ", "  Declined after "]) {
    const timingIndex = command.lastIndexOf(marker);
    if (timingIndex === -1) {
      continue;
    }
    timingLabel = command.slice(timingIndex + 2);
    command = command.slice(0, timingIndex);
    rawCommandEnd = rawCommandStart + timingIndex;
    break;
  }

  if (!counts) {
    const countsPrefixMatch = /^\((?<add>\+\d+), (?<remove>-\d+)\)\s+(?<base>[\s\S]*)$/.exec(command);
    const countsPrefixGroups = countsPrefixMatch?.groups;
    const prefixAdditions = countsPrefixGroups?.add;
    const prefixDeletions = countsPrefixGroups?.remove;
    if (countsPrefixGroups && prefixAdditions && prefixDeletions) {
      const consumedPrefixLength = countsPrefixMatch?.[0].length - (countsPrefixGroups.base?.length ?? command.length);
      command = countsPrefixGroups.base ?? command;
      rawCommandStart += consumedPrefixLength;
      counts = {
        additions: prefixAdditions,
        deletions: prefixDeletions,
      };
    }
  }

  if (!counts) {
    const commandCounts = extractCommandWidgetCounts(command);
    if (commandCounts) {
      const removedSuffixLength = command.length - commandCounts.base.length;
      command = commandCounts.base;
      rawCommandEnd -= removedSuffixLength;
      counts = commandCounts.counts;
    }
  }

  const commandSearchWindow = text.slice(rawCommandStart, rawCommandEnd);
  const commandRelativeIndex = commandSearchWindow.indexOf(command);
  const commandRange =
    command.length > 0 && commandRelativeIndex >= 0
      ? {
          from: rawCommandStart + commandRelativeIndex,
          to: rawCommandStart + commandRelativeIndex + command.length,
        }
      : undefined;

  return {
    glyph,
    prefix,
    command,
    ...(commandRange ? { commandRange } : {}),
    ...(timingLabel ? { timingLabel } : {}),
    ...(counts ? { counts } : {}),
  };
}

class CommandWidgetLine extends WidgetType {
  constructor(
    private readonly content: CommandWidgetLineContent,
  ) {
    super();
  }

  override eq(other: CommandWidgetLine) {
    return JSON.stringify(this.content) === JSON.stringify(other.content);
  }

  override ignoreEvent(event: Event) {
    return shouldIgnoreCommandWidgetEvent(event);
  }

  override destroy(dom: HTMLElement) {
    const observer = commandWidgetResizeObservers.get(dom);
    observer?.disconnect();
    commandWidgetResizeObservers.delete(dom);
  }

  override toDOM() {
    const root = document.createElement("div");
    root.className = [
      "cm-commandWidgetSurface",
      this.content.isFileChange ? "cm-commandWidgetSurfaceFileChange" : "",
      this.content.expanded && this.content.outputLines?.length ? "cm-commandWidgetSurfaceWithBody" : "",
      this.content.expanded ? "cm-commandWidgetSurfaceExpanded" : "",
      this.content.statusClass ?? "",
    ].filter(Boolean).join(" ");
    root.dataset.commandWidgetSignature = this.content.signature;
    const shouldRenderRailInitially = shouldRenderCommandWidgetToggleRail({
      expanded: this.content.expanded,
      hasHiddenExpansionContent: this.content.hasHiddenExpansionContent,
      summaryOverflowing: false,
    });
    root.classList.toggle("cm-commandWidgetSurfaceToggleable", shouldRenderRailInitially);
    root.dataset.commandWidgetExpandable = shouldRenderRailInitially ? "true" : "false";

    const gutter = document.createElement("div");
    gutter.className = shouldRenderRailInitially ? "cm-commandWidgetRail" : "cm-commandWidgetRailSpacer";
    const railVisual = document.createElement("div");
    railVisual.className = "cm-commandWidgetRailVisual";
    if (shouldRenderRailInitially) {
      gutter.append(railVisual);
    }

    const contentRoot = document.createElement("div");
    contentRoot.className = "cm-commandWidgetContent";

    const summary = document.createElement("div");
    summary.className = "cm-commandWidgetSummary cm-commandWidgetCopyRow";
    summary.dataset.copyText = buildCommandWidgetSummaryCopyText(this.content);

    const lead = document.createElement("span");
    lead.className = "cm-commandWidgetLead";

    const glyph = document.createElement("span");
    glyph.className = "cm-commandWidgetGlyph";
    glyph.textContent = this.content.glyph;

    const prefix = document.createElement("span");
    prefix.className = "cm-commandWidgetPrefix";
    prefix.textContent = this.content.prefix;

    lead.append(glyph, document.createTextNode(" "), prefix);

    summary.append(lead);

    if (this.content.counts) {
      const counts = document.createElement("span");
      counts.className = "cm-commandWidgetCounts";

      const open = document.createTextNode(" (");
      const additions = document.createElement("span");
      additions.className = "cm-commandWidgetCountAdded";
      additions.textContent = this.content.counts.additions;
      const comma = document.createTextNode(", ");
      const deletions = document.createElement("span");
      deletions.className = "cm-commandWidgetCountRemoved";
      deletions.textContent = this.content.counts.deletions;
      const close = document.createTextNode(")");

      counts.append(open, additions, comma, deletions, close);
      summary.append(counts);
    }

    const command = document.createElement("span");
    command.className = "cm-commandWidgetCommand";
    command.append(
      this.content.isRunning
        ? renderAnimatedCommandText(this.content.command)
        : renderHighlightedInlineText(this.content.command),
    );

    summary.append(command);

    if (this.content.timingLabel) {
      const meta = document.createElement("span");
      meta.className = "cm-commandWidgetMeta";
      meta.textContent = this.content.timingLabel;
      summary.append(meta);
    }

    contentRoot.append(summary);

    if (this.content.expanded && this.content.outputLines && this.content.outputLines.length > 0) {
      const body = document.createElement("pre");
      body.className = "cm-commandWidgetBody cm-commandWidgetCopyRow";
      body.dataset.copyText = this.content.outputLines.join("\n");
      body.textContent = this.content.outputLines.join("\n");
      contentRoot.append(body);
    }

    if (
      this.content.expanded
      && (
        this.content.inlineDiffFiles?.length
        || this.content.rawInlineDiff
        || this.content.inlineDiffStateMessage
      )
    ) {
      const inlineDiff = document.createElement("div");
      inlineDiff.className = [
        "cm-commandWidgetInlineDiff",
        this.content.inlineDiffStateClass ?? "",
      ].filter(Boolean).join(" ");

      if (this.content.inlineDiffFiles && this.content.inlineDiffFiles.length > 0) {
        for (const file of this.content.inlineDiffFiles) {
          const fileRoot = document.createElement("section");
          fileRoot.className = "cm-inlineDiffFile";

          for (const hunk of file.hunks) {
            for (const row of hunk.rows) {
              const rowElement = document.createElement("div");
              rowElement.className = `cm-inlineDiffRow cm-inlineDiffRow${row.kind[0]!.toUpperCase()}${row.kind.slice(1)}`;
              if (row.kind !== "gap") {
                rowElement.classList.add("cm-commandWidgetCopyRow");
                rowElement.dataset.copyText = `${row.kind === "addition" ? "+" : row.kind === "deletion" ? "-" : " "}${row.text}`;
              }

              const lineNumber = document.createElement("span");
              lineNumber.className = "cm-inlineDiffLineNumber";
              lineNumber.textContent = row.newLineNumber?.toString() ?? row.oldLineNumber?.toString() ?? "";

              const body = document.createElement("span");
              body.className = "cm-inlineDiffBody";

              const marker = document.createElement("span");
              marker.className = "cm-inlineDiffMarker";
              marker.textContent =
                row.kind === "addition"
                  ? "+"
                  : row.kind === "deletion"
                  ? "-"
                  : row.kind === "gap"
                  ? "⋮"
                  : row.kind === "context"
                  ? " "
                  : "@";

              const content = document.createElement("span");
              content.className = "cm-inlineDiffContent";
              const contentText = document.createElement("span");
              contentText.className = "cm-inlineDiffContentText";
              contentText.textContent = row.text.length > 0 ? row.text : " ";
              content.append(contentText);

              body.append(marker, content);
              rowElement.append(lineNumber, body);
              fileRoot.append(rowElement);
            }
          }

          inlineDiff.append(fileRoot);
        }
      } else if (this.content.rawInlineDiff) {
        const rawFallback = document.createElement("pre");
        rawFallback.className = "cm-inlineDiffFallback cm-commandWidgetCopyRow";
        rawFallback.dataset.copyText = this.content.rawInlineDiff;
        rawFallback.textContent = this.content.rawInlineDiff;
        inlineDiff.append(rawFallback);
      } else if (this.content.inlineDiffStateMessage) {
        const stateMessage = document.createElement("div");
        stateMessage.className = "cm-inlineDiffStateMessage";
        stateMessage.textContent = this.content.inlineDiffStateMessage;
        inlineDiff.append(stateMessage);
      }

      contentRoot.append(inlineDiff);
    }

    root.append(gutter, contentRoot);

    const syncRail = () => {
      const shouldRenderRail = shouldRenderCommandWidgetToggleRail({
        expanded: this.content.expanded,
        hasHiddenExpansionContent: this.content.hasHiddenExpansionContent,
        summaryOverflowing:
          !this.content.expanded
          && !this.content.hasHiddenExpansionContent
          && isCommandWidgetSummaryOverflowing(command),
      });
      root.classList.toggle("cm-commandWidgetSurfaceToggleable", shouldRenderRail);
      root.dataset.commandWidgetExpandable = shouldRenderRail ? "true" : "false";
      gutter.className = shouldRenderRail ? "cm-commandWidgetRail" : "cm-commandWidgetRailSpacer";
      if (shouldRenderRail) {
        if (!railVisual.isConnected) {
          gutter.append(railVisual);
        }
        return;
      }
      if (railVisual.isConnected) {
        railVisual.remove();
      }
    };

    const scheduleRailSync = () => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          if (!root.isConnected) {
            return;
          }
          syncRail();
        });
        return;
      }
      queueMicrotask(syncRail);
    };

    scheduleRailSync();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        syncRail();
      });
      observer.observe(root);
      commandWidgetResizeObservers.set(root, observer);
    }

    return root;
  }
}

function buildCodeBlockReplacements(
  allLines: ReadonlyArray<AnnotatedLine>,
  positioned: ReadonlyArray<PositionedLine>,
) {
  const replacements: PositionedReplacement[] = [];

  for (let index = 0; index < allLines.length; index += 1) {
    if (allLines[index]?.kind !== "codeFenceSeparator" || allLines[index + 1]?.kind !== "codeFenceHeader") {
      continue;
    }

    let closingIndex = index + 2;
    while (closingIndex < allLines.length && allLines[closingIndex]?.kind === "codeFenceBody") {
      closingIndex += 1;
    }

    if (allLines[closingIndex]?.kind !== "codeFenceSeparator") {
      continue;
    }

    const startLine = positioned[index];
    const endLine = positioned[closingIndex];
    if (!startLine || !endLine) {
      continue;
    }

    const languageLabel = allLines[index + 1]?.text ?? "code";
    const language = languageLabel.startsWith("code · ") ? languageLabel.slice("code · ".length) : "";
    const codeLines = allLines.slice(index + 2, closingIndex).map((line) =>
      line.highlightSpans ? { text: line.text, highlightSpans: line.highlightSpans } : { text: line.text });
    const code = codeLines.map((line) => line.text).join("\n");

    replacements.push({
      from: startLine.from,
      to: endLine.to,
      widget: new CodeBlockWidget({
        signature: `${startLine.from}:${endLine.to}:${language}:${code}`,
        code,
        lines: codeLines,
      }),
      signature: `${startLine.from}:${endLine.to}:${language}:${code}`,
    });

    index = closingIndex;
  }

  return replacements;
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

export function flattenBlocks(
  blocks: ReadonlyArray<TranscriptBlock>,
  pendingUserInputHighlight?: {
    readonly requestId: string;
    readonly questionIndex: number;
    readonly optionIndex?: number;
  },
) {
  const allLines: AnnotatedLine[] = [];
  const widgetsByLineIndex = new Map<
    number,
    { widget: WidgetType; side: -1 | 1; signature: string }
  >();
  let seenVisibleBlock = false;

  for (const block of blocks) {
    const rawBlockLines = trimBlockBoundarySpacerLines(blockToLines(block));
    if (seenVisibleBlock && rawBlockLines.length > 0) {
      allLines.push({ text: "", kind: "blockGap" });
    }
    const blockLines = rawBlockLines.map((line) => {
      let nextLine = line;

      const userInputRef = nextLine.userInputRef;

      const extraClasses = [...(nextLine.extraClasses ?? [])];
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

      return extraClasses.length === 0 ? nextLine : Object.assign({}, nextLine, { extraClasses });
    });
    const startLineIndex = allLines.length;
    allLines.push(...blockLines);
    if (blockLines.length > 0) {
      seenVisibleBlock = true;
    }

    if (block.type === "user-message" && block.attachments && block.attachments.length > 0) {
      const attachmentLineOffsets = [...blockLines]
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.kind === "attachmentPanel")
        .map(({ index }) => index)
        .slice(0, block.attachments.length);

      attachmentLineOffsets.forEach((lineOffset, index) => {
        const attachment = block.attachments?.[index];
        if (!attachment) {
          return;
        }
        widgetsByLineIndex.set(startLineIndex + lineOffset, {
          widget: new ImageAttachmentTileWidget(attachment),
          side: 1,
          signature: `${attachment.id}:${attachment.name}:${attachment.mimeType}:${attachment.sizeBytes}:${attachment.previewUrl ?? ""}`,
        });
      });
    }
  }

  return {
    lines: allLines,
    widgetsByLineIndex,
  };
}

function buildTranscriptDocument(
  blocks: ReadonlyArray<TranscriptBlock>,
  expandedCommandSignatures: ReadonlySet<string>,
  collapsedFileChangeSignatures: ReadonlySet<string>,
  resolvedInlineDiffBySignature: ReadonlyMap<string, InlineDiffResolutionState>,
  pendingUserInputHighlight?: {
    readonly requestId: string;
    readonly questionIndex: number;
    readonly optionIndex?: number;
  },
): TranscriptDocumentModel {
  const { lines: historyLines, widgetsByLineIndex } = flattenBlocks(blocks, pendingUserInputHighlight);
  const allLines: AnnotatedLine[] = [...historyLines];

  let text = "";
  let offset = 0;
  const positioned: PositionedLine[] = [];
  const marks: PositionedMark[] = [];
  const widgets: PositionedWidget[] = [];
  const replacements: PositionedReplacement[] = [];
  const fileChangeWidgetSignatures = new Set<string>();
  const inlineDiffLookupsBySignature = new Map<string, InlineDiffLookup>();
  const inlineDiffContentBySignature = new Map<string, string>();
  const defaultExpandedInlineDiffSignatures = new Map<string, InlineDiffLookup>();

  allLines.forEach((line, index) => {
    const from = offset;
    const lineEnd = from + line.text.length;
    const isFileChangeWidget =
      line.commandWidgetSignature !== undefined
      && (
        line.inlineUnifiedDiff !== undefined
        || line.inlineDiffLookup !== undefined
        || line.inlineDiffChangedFiles !== undefined
      );
    if (isFileChangeWidget && line.commandWidgetSignature) {
      fileChangeWidgetSignatures.add(line.commandWidgetSignature);
    }
    const hasHiddenExpansionContent = Boolean(
      (line.commandWidgetOutputLines && line.commandWidgetOutputLines.length > 0)
      || line.inlineUnifiedDiff
      || line.inlineDiffLookup,
    );
    const isExpandedCommand =
      line.commandWidgetSignature !== undefined
      && (
        isFileChangeWidget
          ? !collapsedFileChangeSignatures.has(line.commandWidgetSignature)
          : expandedCommandSignatures.has(line.commandWidgetSignature)
      );
    positioned.push({
      from,
      to: lineEnd,
      kind: line.kind,
      ...(line.extraClasses || line.commandWidgetSignature
        ? {
            extraClasses: [
              ...(line.extraClasses ?? []),
              ...(isExpandedCommand ? ["cm-line-commandExecExpanded"] : []),
            ],
          }
        : {}),
      ...(line.commandWidgetSignature ? { commandWidgetSignature: line.commandWidgetSignature } : {}),
    });
    if (line.highlightSpans) {
      for (const span of line.highlightSpans) {
        if (span.from >= span.to) {
          continue;
        }
        marks.push({
          from: from + span.from,
          to: from + span.to,
          className: span.className,
          ...(span.link ? { link: span.link } : {}),
        });
      }
    }
    text += line.text;

    offset += line.text.length;
    const widget = widgetsByLineIndex.get(index);
    if (widget) {
      widgets.push({
        position: widget.side > 0 ? lineEnd : from,
        side: widget.side,
        widget: widget.widget,
        signature: widget.signature,
      });
    }
    if (line.commandWidgetSignature) {
      if (line.inlineDiffLookup) {
        inlineDiffLookupsBySignature.set(line.commandWidgetSignature, line.inlineDiffLookup);
        if (isFileChangeWidget && isExpandedCommand) {
          defaultExpandedInlineDiffSignatures.set(line.commandWidgetSignature, line.inlineDiffLookup);
        }
      }
      const parsed = parseCommandWidgetText(line.text);
      if (parsed) {
        const statusClass = (line.extraClasses ?? []).find((entry) => entry.startsWith("cm-line-workItem"));
        const isRunning = statusClass === "cm-line-workItemRunning";
        const resolvedInlineDiffState = resolvedInlineDiffBySignature.get(line.commandWidgetSignature);
        const effectiveInlineDiff =
          line.inlineUnifiedDiff
          ?? (resolvedInlineDiffState?.status === "ready" ? resolvedInlineDiffState.diff : undefined);
        if (effectiveInlineDiff) {
          inlineDiffContentBySignature.set(line.commandWidgetSignature, effectiveInlineDiff);
        }
        const inlineDiffFiles =
          effectiveInlineDiff && isExpandedCommand
            ? parseInlineDiffFiles(effectiveInlineDiff, line.inlineDiffChangedFiles)
            : undefined;
        const inlineDiffStateMessage =
          isExpandedCommand && !effectiveInlineDiff
            ? resolvedInlineDiffState?.status === "loading"
              ? "Loading diff..."
              : resolvedInlineDiffState?.status === "error"
                ? "Diff unavailable."
                : undefined
            : undefined;
        replacements.push({
          from,
          to: lineEnd,
          widget: new CommandWidgetLine({
            signature: line.commandWidgetSignature,
            ...parsed,
            ...(line.commandWidgetOutputLines && line.commandWidgetOutputLines.length > 0
              ? { outputLines: line.commandWidgetOutputLines }
              : {}),
            ...(inlineDiffFiles && inlineDiffFiles.length > 0 ? { inlineDiffFiles } : {}),
            ...(effectiveInlineDiff && isExpandedCommand && (!inlineDiffFiles || inlineDiffFiles.length === 0)
              ? { rawInlineDiff: effectiveInlineDiff }
              : {}),
            ...(inlineDiffStateMessage
              ? {
                  inlineDiffStateMessage,
                  inlineDiffStateClass:
                    resolvedInlineDiffState?.status === "loading"
                      ? "cm-commandWidgetInlineDiffLoading"
                      : "cm-commandWidgetInlineDiffError",
                }
              : {}),
            expanded: isExpandedCommand,
            hasHiddenExpansionContent,
            isFileChange: isFileChangeWidget,
            isRunning,
            ...(statusClass ? { statusClass } : {}),
          }),
          signature:
            `${line.commandWidgetSignature}:${line.text}:${isExpandedCommand}:${statusClass ?? ""}:`
            + `${effectiveInlineDiff ?? ""}:${resolvedInlineDiffState?.status ?? ""}:`
            + `${line.commandWidgetOutputLines?.join("\n") ?? ""}:${hasHiddenExpansionContent ? "1" : "0"}`,
        });
      }
    }
    if (line.animatedText?.kind === "loading" && line.text.length > 0) {
      const animatedFrom = Math.max(0, Math.min(line.text.length, line.animatedText.from));
      const animatedTo = Math.max(animatedFrom, Math.min(line.text.length, line.animatedText.to));
      replacements.push({
        from,
        to: lineEnd,
        widget: new AnimatedLoadingTextLine(
          line.text.slice(animatedFrom, animatedTo),
          line.text.slice(animatedTo),
          "cm-workingLineAnimatedText",
        ),
        signature: `loading:${line.kind}:${line.text.slice(animatedFrom, animatedTo)}:${line.text.slice(animatedTo)}`,
      });
    }
    if (index < allLines.length - 1) {
      text += "\n";
      offset += 1;
    }
  });

  replacements.push(...buildCodeBlockReplacements(allLines, positioned));

  return {
    text,
    historyLineCount: historyLines.length,
    lines: positioned,
    marks,
    widgets,
    replacements,
    fileChangeWidgetSignatures,
    inlineDiffLookupsBySignature,
    inlineDiffContentBySignature,
    defaultExpandedInlineDiffSignatures,
    separatorStart: text.length,
    promptStart: text.length,
  };
}

function buildDecorations(
  lines: ReadonlyArray<PositionedLine>,
  marks: ReadonlyArray<PositionedMark>,
  widgets: ReadonlyArray<PositionedWidget>,
  replacements: ReadonlyArray<PositionedReplacement>,
) {
  const ranges = lines.map((line) =>
    Decoration.line({
      class: [`cm-line-${line.kind}`, ...(line.extraClasses ?? [])].join(" "),
    }).range(line.from),
  );
  ranges.push(
    ...marks.map((mark) =>
      Decoration.mark({
        class: `cm-codeToken ${mark.className}${mark.link ? " cm-inlineLink" : ""}`,
      }).range(mark.from, mark.to),
    ),
  );
  ranges.push(
    ...widgets.map(({ position, side, widget }) =>
      Decoration.widget({ widget, side }).range(position),
    ),
  );
  ranges.push(
    ...replacements.map(({ from, to, widget }) =>
      Decoration.replace({ widget, block: true }).range(from, to),
    ),
  );
  const promptLine = lines.find((line) => line.kind === "promptInput");
  if (promptLine) {
    ranges.push(Decoration.line({ class: "cm-line-promptStart" }).range(promptLine.from));
  }
  return Decoration.set(ranges, true);
}

function buildSearchDecorations(
  searchMatches: ReadonlyArray<TranscriptSearchMatch>,
  activeSearchMatchIndex: number,
) {
  return Decoration.set(
    searchMatches.map((match, index) =>
      Decoration.mark({
        class: index === activeSearchMatchIndex
          ? "cm-transcriptSearchMatch cm-transcriptSearchMatch--active"
          : "cm-transcriptSearchMatch",
      }).range(match.from, match.to),
    ),
    true,
  );
}

function buildDecorationSignature(docModel: TranscriptDocumentModel) {
  const lineSignature = docModel.lines
    .map((line) => `${line.from}:${line.kind}:${(line.extraClasses ?? []).join(",")}`)
    .join("|");
  const markSignature = docModel.marks
    .map((mark) => `${mark.from}:${mark.to}:${mark.className}`)
    .join("|");
  const widgetSignature = docModel.widgets
    .map((widget) => `${widget.position}:${widget.side}:${widget.signature}`)
    .join("|");
  const replacementSignature = docModel.replacements
    .map((replacement) => `${replacement.from}:${replacement.to}:${replacement.signature}`)
    .join("|");
  return `${docModel.promptStart}::${lineSignature}::${markSignature}::${widgetSignature}::${replacementSignature}`;
}

function buildSearchDecorationSignature(
  searchMatches: ReadonlyArray<TranscriptSearchMatch>,
  activeSearchMatchIndex: number,
) {
  return `${searchMatches.map((match) => `${match.from}:${match.to}`).join("|")}::${activeSearchMatchIndex}`;
}

function computeMinimalDocChange(currentText: string, nextText: string) {
  if (currentText === nextText) {
    return null;
  }

  let prefix = 0;
  const maxPrefix = Math.min(currentText.length, nextText.length);
  while (prefix < maxPrefix && currentText[prefix] === nextText[prefix]) {
    prefix += 1;
  }

  let currentSuffix = currentText.length;
  let nextSuffix = nextText.length;
  while (
    currentSuffix > prefix
    && nextSuffix > prefix
    && currentText[currentSuffix - 1] === nextText[nextSuffix - 1]
  ) {
    currentSuffix -= 1;
    nextSuffix -= 1;
  }

  return {
    from: prefix,
    to: currentSuffix,
    insert: nextText.slice(prefix, nextSuffix),
  };
}

function buildEditorTheme() {
  return EditorView.theme(
    {
      "&": {
        height: "auto",
        minHeight: "100%",
        flex: "1 1 auto",
        width: "100%",
        minWidth: "0",
        display: "flex",
        flexDirection: "column",
        color: "#c5ccd3",
        backgroundColor: "transparent",
        fontFamily:
          '"Cascadia Code", "Cascadia Mono", "Iosevka Term", "JetBrains Mono", Consolas, monospace',
        fontSize: "16px",
      },
      ".cm-scroller": {
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        overflowX: "hidden",
        overflowY: "visible",
        width: "100%",
        minWidth: "0",
        minHeight: "100%",
        padding: "18px 0 18px",
        lineHeight: "1.3",
      },
      ".cm-content": {
        boxSizing: "border-box",
        display: "flex",
        flex: "1 0 auto",
        flexDirection: "column",
        width: "100%",
        minWidth: "0",
        maxWidth: "100%",
        minHeight: "100%",
        padding: "0 22px 6px",
        caretColor: "#cfd6dd",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "#cfd6dd",
      },
      "&.cm-editor-historyActive .cm-cursor": {
        display: "none",
      },
      ".cm-selectionBackground": {
        backgroundColor: "#e6e6e6 !important",
      },
      ".cm-content ::selection": {
        backgroundColor: "#e6e6e6",
        color: "#000000",
      },
      ".cm-line::selection": {
        backgroundColor: "#e6e6e6",
        color: "#000000",
      },
      ".cm-line > span::selection": {
        backgroundColor: "#e6e6e6",
        color: "#000000",
      },
      ".cm-content .cm-selectionBackground": {
        color: "#000000",
      },
      ".cm-focused": {
        outline: "none",
      },
      ".cm-line": {
        boxSizing: "border-box",
        width: "100%",
        minWidth: "0",
        maxWidth: "100%",
        padding: "0",
        whiteSpace: "pre-wrap",
      },
      ".cm-line-blockGap": {
        height: "0",
        minHeight: "0",
        lineHeight: "0",
        fontSize: "0",
        paddingTop: "1.8rem",
      },
      ".cm-line-meta": { color: "#5f676f" },
      ".cm-line-body": { color: "#cfd4d9" },
      ".cm-line-reasoningSeparator": {
        position: "relative",
        minHeight: "8px",
      },
      ".cm-line-reasoningSeparator::before": {
        display: "none",
      },
      ".cm-line-reasoningSummary": {
        color: "#69737d",
        fontSize: "14px",
        fontStyle: "italic",
        paddingTop: "2px",
        paddingBottom: "4px",
      },
      ".cm-line-reasoning": {
        color: "#69737d",
        fontSize: "14px",
        fontStyle: "italic",
      },
      ".cm-line-table": {
        color: "#d8dde2",
      },
      ".cm-line-codeFenceSeparator": {
        color: "transparent",
      },
      ".cm-line-codeFenceHeader": {
        color: "transparent",
      },
      ".cm-line-codeFenceBody": {
        color: "transparent",
      },
      ".cm-line-blockquote": {
        color: "#aeb6bf",
      },
      ".cm-codeToken.tok-keyword": { color: "#d39bff" },
      ".cm-codeToken.tok-comment": { color: "#6e7d8b", fontStyle: "italic" },
      ".cm-codeToken.tok-string": { color: "#a8d38f" },
      ".cm-codeToken.tok-number": { color: "#f0c57a" },
      ".cm-codeToken.tok-bool": { color: "#f0c57a" },
      ".cm-codeToken.tok-null": { color: "#f0c57a" },
      ".cm-codeToken.tok-variableName": { color: "#d7dde4" },
      ".cm-codeToken.tok-definition": { color: "#7dc4ff" },
      ".cm-codeToken.tok-propertyName": { color: "#8fd6ff" },
      ".cm-codeToken.tok-typeName": { color: "#79c8b6" },
      ".cm-codeToken.tok-className": { color: "#79c8b6" },
      ".cm-codeToken.tok-function": { color: "#7dc4ff" },
      ".cm-codeToken.tok-operator": { color: "#d0d7df" },
      ".cm-codeToken.tok-punctuation": { color: "#8b96a1" },
      ".cm-codeToken.tok-meta": { color: "#8aa5c2" },
      ".cm-codeToken.tok-tagName": { color: "#f0957a" },
      ".cm-codeToken.tok-attributeName": { color: "#e7c26f" },
      ".cm-codeToken.tok-attributeValue": { color: "#a8d38f" },
      ".cm-codeToken.tok-special.tok-string": { color: "#9adf8f" },
      ".cm-codeToken.tok-added": { color: "#63f28a" },
      ".cm-codeToken.tok-removed": { color: "#ff7575" },
      ".cm-codeToken.tok-inlineCode": {
        color: "#c7cdd3",
        backgroundColor: "rgba(214, 220, 226, 0.08)",
        borderRadius: "4px",
        padding: "0 0.24em",
      },
      ".cm-codeToken.tok-inlineCode.tok-markdownLink": {
        color: "#d8e0e8",
      },
      ".cm-codeToken.tok-inlineCode.tok-linkUrl": {
        color: "#d8e0e8",
      },
      ".cm-codeToken.tok-inlineCode.tok-linkFile": {
        color: "#d8e0e8",
      },
      ".cm-inlineLink": {
        cursor: "pointer",
        borderRadius: "2px",
        transition:
          "color 180ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 220ms cubic-bezier(0.22, 1, 0.36, 1), background-color 220ms cubic-bezier(0.22, 1, 0.36, 1), filter 220ms cubic-bezier(0.22, 1, 0.36, 1)",
      },
      ".cm-codeToken.tok-markdownLink": {
        textDecoration: "none",
        boxShadow:
          "0 10px 0 0 rgba(182, 233, 248, 0), inset 0 -0.125em 0 rgba(129, 184, 244, 0.18)",
      },
      ".cm-codeToken.tok-linkUrl": {
        color: "#9bd2ff",
      },
      ".cm-codeToken.tok-linkFile": {
        color: "#9ae2f3",
      },
      ".cm-codeToken.cm-inlineLink:hover": {
        boxShadow:
          "0 1px 0 4px rgba(146, 208, 255, 0.12), inset 0 -1.6em 0 rgba(146, 208, 255, 0.16)",
        filter: "brightness(1.08) saturate(1.08)",
      },
      ".cm-codeToken.tok-linkUrl.cm-inlineLink:hover": {
        color: "#edf7ff",
      },
      ".cm-codeToken.tok-linkFile.cm-inlineLink:hover": {
        color: "#edfdfa",
      },
      ".cm-codeToken.tok-inlineCode.cm-inlineLink:hover": {
        backgroundColor: "rgba(214, 220, 226, 0.12)",
      },
      ".cm-codeToken.tok-markdownStrong": {
        color: "#eef3f8",
        fontWeight: "600",
      },
      ".cm-codeToken.tok-markdownEmphasis": {
        color: "#d8dee5",
        fontStyle: "italic",
      },
      ".cm-line-markdownHeading": {
        color: "#eef3f8",
        fontWeight: "600",
      },
      ".cm-line-markdownHeading1": {
        fontSize: "1.16em",
      },
      ".cm-line-markdownHeading2": {
        fontSize: "1.08em",
      },
      ".cm-line-markdownHeading3": {
        fontSize: "1.03em",
      },
      ".cm-line-list": { color: "#c7ccd1" },
      ".cm-line-userPromptSeparator": {
        position: "relative",
        height: "0",
        minHeight: "0",
        lineHeight: "0",
        fontSize: "16px",
        paddingTop: "1.8em",
        paddingBottom: "1.8em",
        overflow: "visible",
      },
      ".cm-line-userPromptSeparator::before": {
        content: '""',
        position: "absolute",
           left: "-17px",
        right: "-17px",
        top: "50%",
        borderTop: "1px solid rgba(236, 241, 246, 0.285)",
        transform: "translateY(-50%)",
      },
      ".cm-line-userPromptSeparator.cm-line-userPromptSeparatorHidden": {
        height: "0",
        minHeight: "0",
        lineHeight: "0",
        fontSize: "0",
        paddingTop: "0",
        paddingBottom: "0",
      },
      ".cm-line-userPromptSeparator.cm-line-userPromptSeparatorHidden::before": {
        display: "none",
      },
      ".cm-line-workGroupSeparator": {
        position: "relative",
        minHeight: "10px",
      },
      ".cm-line-workGroupSeparator::before": {
        display: "none",
      },
      ".cm-line-workGroupHeader": {
        color: "#9fa7af",
        fontSize: "12px",
        paddingTop: "2px",
      },
      ".cm-line-workGroupFooter": {
        color: "#9fa7af",
        fontSize: "12px",
        paddingTop: "2px",
      },
      ".cm-line-fileChangeSummary": {
        color: "#d7dde3",
      },
      ".cm-line-planSeparator": {
        position: "relative",
        height: "0",
        minHeight: "0",
        lineHeight: "0",
        fontSize: "16px",
        paddingTop: "2.4em",
        paddingBottom: "2.4em",
        overflow: "visible",
      },
      ".cm-line-planSeparator::before": {
        content: '""',
        position: "absolute",
        left: "-17px",
        right: "-17px",
        top: "50%",
        borderTop: "1px solid rgba(210, 225, 216, 0.21)",
        transform: "translateY(-50%)",
      },
      ".cm-line-planHeader": {
        color: "#9dc5a3",
        fontSize: "12px",
        textTransform: "uppercase",
        paddingTop: "2px",
      },
      ".cm-line-planHeader.cm-line-proposedPlanHeader": {
        color: "#b4d7b8",
      },
      ".cm-line-planExplanation": {
        color: "#c4cbc5",
      },
      ".cm-line-planStepPending": {
        color: "#8d949b",
      },
      ".cm-line-planStepInProgress": {
        color: "#d7c17a",
      },
      ".cm-line-planStepCompleted": {
        color: "#9fc6a5",
      },
      ".cm-line-proposedPlanBody": {
        color: "#bcc4cb",
      },
      ".cm-line-checkpointSeparator": {
        position: "relative",
        height: "0",
        minHeight: "0",
        lineHeight: "0",
        fontSize: "16px",
        paddingTop: "2.4em",
        paddingBottom: "2.4em",
        overflow: "visible",
      },
      ".cm-line-checkpointSeparator::before": {
        content: '""',
        position: "absolute",
        left: "-17px",
        right: "-17px",
        top: "50%",
        borderTop: "1px solid rgba(224, 230, 236, 0.21)",
        transform: "translateY(-50%)",
      },
      ".cm-line-checkpointHeader": {
        color: "#a9b2bb",
        fontSize: "12px",
        textTransform: "uppercase",
        paddingTop: "2px",
      },
      ".cm-line-checkpointSummary": {
        color: "#c2c9cf",
      },
      ".cm-line-checkpointFile": {
        color: "#9098a1",
      },
      ".cm-line-workingLine": {
        color: "#7f8790",
        fontSize: "13px",
      },
      ".cm-workingLineAnimatedText": {
        display: "inline-flex",
        alignItems: "baseline",
        gap: "0",
        fontSize: "13px",
        color: "#7f8790",
      },
      ".cm-workingLineAnimatedPrefix, .cm-workingLineAnimatedSuffix": {
        fontSize: "inherit",
        color: "inherit",
      },
      ".cm-line-promptInput": {
        color: "#d6dbe0",
      },
      ".cm-line-attachmentPanel": {
        paddingLeft: "2ch",
      },
      ".cm-line-promptStart": {
        position: "relative",
        overflow: "visible",
      },
      ".cm-line-userMessageStart": {
        position: "relative",
        overflow: "visible",
      },
      ".cm-line-promptStart::before, .cm-line-userMessageStart::before": {
        content: '"›"',
        position: "absolute",
        left: "-2ch",
        top: "0",
        userSelect: "none",
        pointerEvents: "none",
        fontSize: "18px",
        lineHeight: "1",
      },
      ".cm-line-promptStart::before": {
        color: "#ffffff",
      },
      ".cm-line-userMessageStart::before": {
        color: "#8e959d",
      },
      ".cm-line-promptSeparator": {
        position: "relative",
        height: "0",
        minHeight: "0",
        lineHeight: "0",
        fontSize: "16px",
        paddingTop: "2.4em",
        paddingBottom: "2.4em",
        overflow: "visible",
      },
      ".cm-line-promptSeparator::before": {
        content: '""',
        position: "absolute",
        left: "-17px",
        right: "-17px",
        top: "50%",
        borderTop: "1px solid rgba(230, 236, 242, 0.255)",
        transform: "translateY(-50%)",
      },
      ".cm-line-promptSeparator.cm-line-promptSeparatorPlan::before": {
        content: '"──── Plan mode "',
        position: "absolute",
        left: "0",
        top: "50%",
        color: "#7fc96d",
        backgroundColor: "#0e1419",
        paddingRight: "1ch",
        transform: "translateY(-50%)",
      },
      ".cm-line-promptSeparator.cm-line-promptSeparatorPlan::after": {
        content: '""',
        position: "absolute",
        left: "18ch",
        right: "-17px",
        top: "50%",
        borderTop: "1px solid rgba(127, 201, 109, 0.465)",
        transform: "translateY(-50%)",
      },
      ".cm-line-userMessage": { color: "#e0e4e8" },
      ".cm-line-toolCall": { color: "#5aa8f3" },
      ".cm-line-toolResult": { color: "#7a828b" },
      ".cm-line-diffRemoved": {
        color: "#8f7b7d",
        backgroundColor: "rgba(84, 30, 27, 0.86)",
      },
      ".cm-line-diffAdded": {
        color: "#b8c9b8",
        backgroundColor: "rgba(28, 66, 41, 0.84)",
      },
      ".cm-line-diffContext": { color: "#717981" },
      ".cm-line-diffHeader": { color: "#8b929a", fontWeight: "500" },
      ".cm-line-divider": { color: "#40464d" },
      ".cm-line-status": { color: "#6c737b", fontStyle: "italic" },
      ".cm-line-approvalPrompt": {
        color: "#aab2bb",
        overflowWrap: "anywhere",
      },
      ".cm-line-userInputQuestion": {
        color: "#c5ccd4",
        overflowWrap: "anywhere",
      },
      ".cm-line-userInputOption": {
        color: "#aab2bb",
        overflowWrap: "anywhere",
      },
      ".cm-line-userInputResolved": { opacity: "0.54" },
      ".cm-line-userInputResolvedOption": {
        color: "#737a82",
        opacity: "0.72",
      },
      ".cm-line-userInputAnsweredOption": {
        color: "#dde4eb",
        backgroundColor: "rgba(77, 96, 119, 0.26)",
        fontWeight: "600",
        opacity: "1",
      },
      ".cm-line-userInputActiveQuestion": {},
      ".cm-line-userInputActiveOption": {
        color: "#e3e8ee",
        backgroundColor: "rgba(77, 96, 119, 0.22)",
      },
      ".cm-line-commandExec": {
        minWidth: "0",
      },
      ".cm-commandWidgetSurface": {
        color: "#ced5dc",
        display: "flex",
        alignItems: "stretch",
        gap: "0",
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "100%",
        minWidth: "0",
        fontSize: "12px",
        lineHeight: "1.45",
        padding: "2px 0",
        margin: "1px 0",
        backgroundColor: "transparent",
      },
      ".cm-commandWidgetRail, .cm-commandWidgetRailSpacer": {
        flex: "0 0 16px",
        width: "16px",
        alignSelf: "stretch",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        paddingLeft: "4px",
      },
      ".cm-commandWidgetRail": {
        cursor: "pointer",
      },
      ".cm-commandWidgetRailVisual": {
        width: "2px",
        alignSelf: "stretch",
        borderRadius: "0",
        backgroundColor: "rgba(244, 247, 250, 0.28)",
        opacity: "0",
        transition:
          "background-color 140ms ease, opacity 140ms ease, width 180ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
      },
      ".cm-commandWidgetSurfaceExpanded .cm-commandWidgetRailVisual": {
        opacity: "1",
      },
      ".cm-commandWidgetSurface:not(.cm-commandWidgetSurfaceExpanded):hover .cm-commandWidgetRailVisual": {
        opacity: "1",
      },
      ".cm-commandWidgetSurface:hover .cm-commandWidgetRailVisual": {
        backgroundColor: "rgba(244, 247, 250, 0.38)",
      },
      ".cm-commandWidgetRail:hover .cm-commandWidgetRailVisual": {
        width: "5px",
        backgroundColor: "rgba(244, 247, 250, 0.52)",
      },
      ".cm-commandWidgetSurfaceExpanded": {
        alignItems: "flex-start",
      },
      ".cm-commandWidgetSurfaceWithBody": {
        alignItems: "flex-start",
      },
      ".cm-commandWidgetContent": {
        flex: "1 1 auto",
        minWidth: "0",
        userSelect: "text",
      },
      ".cm-commandWidgetSurface.cm-line-workItemRunning .cm-commandWidgetRailVisual": {
        backgroundColor: "rgba(244, 247, 250, 0.4)",
      },
      ".cm-commandWidgetSurface.cm-line-workItemError": {
        color: "#f0cbcb",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDeclined": {
        color: "#e0d1ae",
      },
      ".cm-commandWidgetLead": {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        flexShrink: "0",
        whiteSpace: "nowrap",
      },
      ".cm-commandWidgetSummary": {
        display: "flex",
        alignItems: "center",
        flexWrap: "nowrap",
        gap: "10px",
        width: "100%",
        minWidth: "0",
        userSelect: "text",
      },
      ".cm-commandWidgetGlyph": {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "20px",
        height: "20px",
        color: "#d8e0e8",
        fontWeight: "700",
        flexShrink: "0",
      },
      ".cm-commandWidgetPrefix": {
        color: "#a7b0b8",
        fontWeight: "600",
        flexShrink: "0",
      },
      ".cm-commandWidgetCommand": {
        color: "#8a939d",
        flex: "1 1 auto",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      ".cm-commandWidgetMeta": {
        color: "#7f8891",
        marginLeft: "18px",
        flexShrink: "0",
        whiteSpace: "nowrap",
      },
      ".cm-commandWidgetCounts": {
        display: "inline-flex",
        flexShrink: "0",
        color: "#9aa4ad",
        whiteSpace: "nowrap",
      },
      ".cm-commandWidgetCountAdded": {
        color: "#63f28a",
      },
      ".cm-commandWidgetCountRemoved": {
        color: "#ff7575",
      },
      ".cm-commandWidgetSurfaceExpanded .cm-commandWidgetCommand": {
        flex: "1 1 auto",
        width: "auto",
        minWidth: "0",
        overflow: "visible",
        textOverflow: "clip",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
      ".cm-commandWidgetSurfaceExpanded .cm-commandWidgetSummary": {
        flexWrap: "nowrap",
        alignItems: "flex-start",
      },
      ".cm-commandWidgetSurfaceExpanded .cm-commandWidgetMeta": {
        marginLeft: "auto",
      },
      ".cm-commandWidgetBody": {
        width: "100%",
        minWidth: "0",
        margin: "2px 0 0",
        color: "#7a828b",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        padding: "0",
        fontFamily: "inherit",
        userSelect: "text",
      },
      ".cm-commandWidgetInlineDiff": {
        flexBasis: "100%",
        minWidth: "0",
        marginTop: "0",
        paddingTop: "0",
        borderTop: "none",
        userSelect: "text",
      },
      ".cm-inlineDiffStateMessage": {
        padding: "4px 0 0",
        color: "#a3adb7",
        fontSize: "12px",
      },
      ".cm-commandWidgetInlineDiffError .cm-inlineDiffStateMessage": {
        color: "#d8a6a6",
      },
      ".cm-inlineDiffFile": {
        minWidth: "0",
        overflow: "hidden",
      },
      ".cm-inlineDiffFile + .cm-inlineDiffFile": {
        marginTop: "6px",
      },
      ".cm-inlineDiffRow": {
        display: "grid",
        gridTemplateColumns: "52px minmax(0, 1fr)",
        columnGap: "8px",
        alignItems: "start",
        minWidth: "0",
        padding: "0 10px 0 4px",
      },
      ".cm-inlineDiffBody": {
        display: "inline-grid",
        gridTemplateColumns: "12px minmax(0, 1fr)",
        columnGap: "8px",
        alignItems: "start",
        justifySelf: "start",
        width: "fit-content",
        maxWidth: "100%",
        minWidth: "0",
      },
      ".cm-inlineDiffRowAddition .cm-inlineDiffBody": {
        backgroundColor: "rgba(20, 60, 38, 0.5)",
        borderRadius: "4px",
      },
      ".cm-inlineDiffRowDeletion .cm-inlineDiffBody": {
        backgroundColor: "rgba(66, 26, 29, 0.5)",
        borderRadius: "4px",
      },
      ".cm-inlineDiffLineNumber": {
        color: "#72808d",
        textAlign: "right",
        userSelect: "none",
      },
      ".cm-inlineDiffMarker": {
        color: "#8b97a3",
      },
      ".cm-inlineDiffContent": {
        minWidth: "0",
      },
      ".cm-inlineDiffContentText": {
        display: "inline",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        userSelect: "text",
      },
      ".cm-inlineDiffRowAddition .cm-inlineDiffMarker, .cm-inlineDiffRowAddition .cm-inlineDiffContentText": {
        color: "#9cf0b4",
      },
      ".cm-inlineDiffRowDeletion .cm-inlineDiffMarker, .cm-inlineDiffRowDeletion .cm-inlineDiffContentText": {
        color: "rgba(255, 177, 177, 0.7)",
      },
      ".cm-inlineDiffRowGap .cm-inlineDiffMarker": {
        color: "#7a8692",
      },
      ".cm-inlineDiffFallback": {
        margin: "0",
        padding: "10px 12px",
        color: "#c6d0d8",
        backgroundColor: "rgba(11, 16, 21, 0.74)",
        borderRadius: "10px",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
      ".cm-commandWidgetSurface.cm-line-workItemRunning .cm-commandWidgetGlyph": {
        color: "transparent",
      },
      ".cm-commandWidgetSurface.cm-line-workItemRunning .cm-commandWidgetPrefix": {
        color: "#82bff2",
      },
      ".cm-commandWidgetSurface.cm-line-workItemRunning .cm-commandWidgetCommand": {
        color: "#96a1ab",
      },
      ".cm-commandWidgetAnimatedText": {
        display: "inline",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDone .cm-commandWidgetPrefix": {
        color: "#c8d0d8",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDone .cm-commandWidgetGlyph": {
        color: "#63f28a",
      },
      ".cm-commandWidgetSurface.cm-line-workItemError .cm-commandWidgetPrefix": {
        color: "#ff9d9d",
      },
      ".cm-commandWidgetSurface.cm-line-workItemError .cm-commandWidgetGlyph": {
        color: "#ff9d9d",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDeclined .cm-commandWidgetPrefix": {
        color: "#f0c36a",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDeclined .cm-commandWidgetGlyph": {
        color: "#f0c36a",
      },
      ".cm-codeBlockSurface": {
        position: "relative",
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "100%",
        minWidth: "0",
        margin: "6px 0",
        padding: "14px 16px",
        borderRadius: "12px",
        backgroundColor: "rgba(22, 29, 36, 0.9)",
        overflow: "hidden",
      },
      ".cm-codeBlockContent": {
        minWidth: "0",
        paddingRight: "72px",
        margin: "0",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        userSelect: "text",
      },
      ".cm-codeBlockLine": {
        display: "inline",
        color: "#c7d0d8",
        fontSize: "13px",
        lineHeight: "1.55",
      },
      ".cm-codeBlockCopyButton": {
        position: "absolute",
        top: "10px",
        right: "10px",
        display: "inline-grid",
        placeItems: "center",
        appearance: "none",
        border: "1px solid rgba(160, 172, 183, 0.22)",
        borderRadius: "999px",
        backgroundColor: "rgba(37, 47, 57, 0.95)",
        color: "#b6c0c9",
        padding: "4px 10px",
        fontSize: "11px",
        lineHeight: "1.2",
        fontFamily: "inherit",
        cursor: "pointer",
        opacity: "0",
        transform: "translateY(-2px) scale(0.96)",
        pointerEvents: "none",
        transition:
          "opacity 160ms ease, transform 90ms ease",
        transitionDelay: "0ms, 0ms",
      },
      ".cm-codeBlockCopyButtonLabel": {
        display: "block",
        gridArea: "1 / 1",
        transition: "opacity 60ms ease",
      },
      ".cm-codeBlockCopyButtonStatus": {
        display: "inline-block",
        gridArea: "1 / 1",
        textAlign: "center",
        opacity: "0",
        transform: "scale(0.85)",
        transition: "opacity 60ms ease, transform 80ms ease",
      },
      ".cm-codeBlockSurface:hover .cm-codeBlockCopyButton": {
        opacity: "1",
        transform: "translateY(0) scale(1)",
        pointerEvents: "auto",
        transitionDelay: "100ms, 100ms",
      },
      ".cm-codeBlockSurface:focus-within .cm-codeBlockCopyButton": {
        opacity: "1",
        transform: "translateY(0) scale(1)",
        pointerEvents: "auto",
        transitionDelay: "0ms, 0ms",
      },
      ".cm-codeBlockSurfaceCopyFeedbackActive .cm-codeBlockCopyButton": {
        opacity: "1",
        transform: "translateY(0) scale(1)",
        pointerEvents: "auto",
        transitionDelay: "0ms, 0ms",
      },
      ".cm-codeBlockCopyButton:hover": {
        backgroundColor: "rgba(48, 60, 71, 0.98)",
        borderColor: "rgba(190, 200, 210, 0.34)",
        color: "#e0e7ed",
      },
      ".cm-codeBlockCopyButtonCopied": {
        backgroundColor: "rgba(48, 60, 71, 0.98)",
        borderColor: "rgba(190, 200, 210, 0.34)",
        color: "#e0e7ed",
        animation: "cm-codeBlockCopyFeedback 110ms ease",
      },
      ".cm-codeBlockCopyButtonCopied .cm-codeBlockCopyButtonLabel": {
        opacity: "0",
      },
      ".cm-codeBlockCopyButtonCopied .cm-codeBlockCopyButtonStatus": {
        opacity: "1",
        transform: "scale(1)",
      },
      ".cm-codeBlockCopyButtonFailed": {
        backgroundColor: "rgba(84, 34, 40, 0.98)",
        borderColor: "rgba(224, 112, 126, 0.48)",
        color: "#ffe1e4",
        animation: "cm-codeBlockCopyFeedback 220ms ease",
      },
      ".cm-codeBlockCopyButtonFailed .cm-codeBlockCopyButtonLabel": {
        opacity: "0",
      },
      ".cm-codeBlockCopyButtonFailed .cm-codeBlockCopyButtonStatus": {
        opacity: "1",
        transform: "scale(1)",
      },
      "@keyframes cm-codeBlockCopyFeedback": {
        "0%": {
          transform: "translateY(0) scale(0.92)",
        },
        "55%": {
          transform: "translateY(0) scale(1.05)",
        },
        "100%": {
          transform: "translateY(0) scale(1)",
        },
      },
      ".cm-line-commandOutput": { color: "#7a828b" },
    },
    { dark: true },
  );
}

function findConversationScrollContainer(start: HTMLElement | null) {
  let current = start;
  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function getConversationScrollContainer(view: EditorView) {
  return findConversationScrollContainer(view.dom);
}

interface ScrollPositionSnapshot {
  readonly element: HTMLElement;
  readonly scrollTop: number;
  readonly scrollLeft: number;
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

const USER_MESSAGE_COPY_PREFIX = "> ";

function collectSelectedUserMessageStartSegments(
  state: EditorState,
  ranges: ReadonlyArray<{ from: number; to: number; empty: boolean }>,
  userMessageStartLineStarts: ReadonlySet<number>,
) {
  const segments: string[] = [];

  for (const range of ranges) {
    let position = range.from;
    while (position <= range.to) {
      const line = state.doc.lineAt(position);
      const segmentFrom = Math.max(range.from, line.from);
      const segmentTo = Math.min(range.to, line.to);

      if (
        segmentTo > segmentFrom
        && segmentFrom === line.from
        && userMessageStartLineStarts.has(line.from)
      ) {
        segments.push(state.sliceDoc(segmentFrom, segmentTo));
      }

      if (line.to >= range.to) {
        break;
      }

      const nextPosition = line.to + 1;
      if (nextPosition > state.doc.length) {
        break;
      }
      position = nextPosition;
    }
  }

  return segments;
}

function collectUserMessageStartLineStarts(lines: ReadonlyArray<UserMessageCopyLine>) {
  return new Set(
    lines
      .filter((line) => line.extraClasses?.includes("cm-line-userMessageStart"))
      .map((line) => line.from),
  );
}

export function prefixCopiedLinesInOrder(
  text: string,
  orderedExactMatches: ReadonlyArray<string>,
  prefix: string,
) {
  if (text.length === 0 || orderedExactMatches.length === 0) {
    return text;
  }

  const lines = text.split("\n");
  let matchIndex = 0;
  const prefixedLines = lines.map((line) => {
    if (matchIndex < orderedExactMatches.length && line === orderedExactMatches[matchIndex]) {
      matchIndex += 1;
      return `${prefix}${line}`;
    }
    return line;
  });

  return matchIndex > 0 ? prefixedLines.join("\n") : text;
}

export function prefixCopiedUserMessageStarts(
  text: string,
  state: EditorState,
  lines: ReadonlyArray<UserMessageCopyLine>,
) {
  if (text.length === 0) {
    return text;
  }

  const nonEmptyRanges = state.selection.ranges.filter((range) => !range.empty);
  if (nonEmptyRanges.length === 0) {
    return text;
  }

  const userMessageStartLineStarts = collectUserMessageStartLineStarts(lines);
  if (userMessageStartLineStarts.size === 0) {
    return text;
  }

  const selectedSegments = collectSelectedUserMessageStartSegments(
    state,
    nonEmptyRanges,
    userMessageStartLineStarts,
  );

  return prefixCopiedLinesInOrder(text, selectedSegments, USER_MESSAGE_COPY_PREFIX);
}

function preserveConversationScrollPosition(view: EditorView, update: () => void) {
  const scrollContainer = getConversationScrollContainer(view);
  if (!scrollContainer) {
    update();
    return;
  }

  const { scrollTop, scrollLeft } = scrollContainer;
  update();
  requestAnimationFrame(() => {
    scrollContainer.scrollTop = scrollTop;
    scrollContainer.scrollLeft = scrollLeft;
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollTop;
      scrollContainer.scrollLeft = scrollLeft;
    });
  });
}

function isConversationScrollNearBottom(view: EditorView, thresholdPx = 24) {
  const scrollContainer = getConversationScrollContainer(view);
  if (!scrollContainer) {
    return false;
  }

  return readConversationScrollOffsetFromBottom(scrollContainer) <= thresholdPx;
}

function scrollConversationToBottom(view: EditorView) {
  const scrollContainer = getConversationScrollContainer(view);
  if (!scrollContainer) {
    return;
  }

  scrollContainer.scrollTop = resolveInitialConversationScrollTop(scrollContainer, null);
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

function restoreConversationScrollOffsetFromBottom(view: EditorView, offsetFromBottom: number) {
  const scrollContainer = getConversationScrollContainer(view);
  if (!scrollContainer) {
    return;
  }

  scrollContainer.scrollTop = resolveConversationScrollTopForOffsetFromBottom(scrollContainer, offsetFromBottom);
}

function keepCursorWithinViewportPadding(view: EditorView) {
  const scrollContainer = getConversationScrollContainer(view);
  if (!scrollContainer || !view.hasFocus) {
    return;
  }

  const cursor = view.state.selection.main.head;
  const cursorRect = view.coordsAtPos(cursor, 1) ?? view.coordsAtPos(cursor, -1);
  if (!cursorRect) {
    return;
  }

  const scrollRect = scrollContainer.getBoundingClientRect();
  const padding = view.defaultLineHeight * CURSOR_VIEWPORT_PADDING_LINES;
  const minTop = scrollRect.top + padding;
  const maxBottom = scrollRect.bottom - padding;

  if (cursorRect.top < minTop) {
    scrollContainer.scrollTop += cursorRect.top - minTop;
  } else if (cursorRect.bottom > maxBottom) {
    scrollContainer.scrollTop += cursorRect.bottom - maxBottom;
  }
}

function keepSearchMatchWithinViewport(
  view: EditorView,
  activeMatchElement: HTMLElement,
  overlayHeightPx: number,
) {
  const scrollContainer = getConversationScrollContainer(view);
  if (!scrollContainer) {
    return;
  }

  const matchRect = activeMatchElement.getBoundingClientRect();
  const scrollRect = scrollContainer.getBoundingClientRect();
  const topPadding = overlayHeightPx + SEARCH_MATCH_VIEWPORT_PADDING_PX;
  const bottomPadding = SEARCH_MATCH_VIEWPORT_PADDING_PX;
  const minTop = scrollRect.top + topPadding;
  const maxBottom = scrollRect.bottom - bottomPadding;

  if (matchRect.top < minTop) {
    scrollContainer.scrollTop += matchRect.top - minTop;
  } else if (matchRect.bottom > maxBottom) {
    scrollContainer.scrollTop += matchRect.bottom - maxBottom;
  }
}

export function getHistorySelectionLimitForPromptStart(doc: Text, promptStart: number) {
  if (promptStart >= doc.length) {
    return doc.length;
  }
  const promptLine = doc.lineAt(promptStart);
  if (promptLine.number <= 1) {
    return 0;
  }

  const separatorLine = doc.line(promptLine.number - 1);
  return Math.max(0, separatorLine.from - 1);
}

export function getHistorySelectionLimit(state: EditorState) {
  return getHistorySelectionLimitForPromptStart(state.doc, state.field(promptStartField));
}

export function resolveTranscriptRegionForPosition(
  historyLimit: number,
  position: number | null,
): TranscriptRegion | null {
  if (position === null) {
    return null;
  }

  return position <= historyLimit ? "history" : "prompt";
}

export function resolveTranscriptRegionForPointer(
  historyLimit: number,
  precisePosition: number | null,
  fallbackPosition: number | null,
): TranscriptRegion | null {
  return resolveTranscriptRegionForPosition(
    historyLimit,
    precisePosition ?? fallbackPosition,
  );
}

export function promptSeparatorClassesForInteractionMode(
  interactionMode: "default" | "plan",
) {
  return interactionMode === "plan" ? ["cm-line-promptSeparatorPlan"] : [];
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

function measurePromptCaretBox(
  textarea: HTMLTextAreaElement,
  selection: StoredPromptSelection,
): PromptCaretBox | null {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }
  if (document.activeElement !== textarea) {
    return null;
  }

  const caretOffset = Math.max(0, Math.min(selection.headOffset, textarea.value.length));
  const computedStyle = window.getComputedStyle(textarea);
  const measureElements = getPromptCaretMeasureElements(document);
  const { mirror, textNode, marker } = measureElements;
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.padding = computedStyle.padding;
  mirror.style.border = computedStyle.border;
  mirror.style.font = computedStyle.font;
  mirror.style.fontKerning = computedStyle.fontKerning;
  mirror.style.fontStretch = computedStyle.fontStretch;
  mirror.style.fontVariant = computedStyle.fontVariant;
  mirror.style.letterSpacing = computedStyle.letterSpacing;
  mirror.style.lineHeight = computedStyle.lineHeight;
  mirror.style.tabSize = computedStyle.tabSize;
  mirror.style.textIndent = computedStyle.textIndent;
  mirror.style.textTransform = computedStyle.textTransform;
  mirror.style.textRendering = computedStyle.textRendering;

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

  const lineHeight = Number.parseFloat(computedStyle.lineHeight || "0") || markerRect.height || 20;
  const top = Math.floor(markerRect.top - mirrorRect.top - textarea.scrollTop);
  const left = Math.floor(markerRect.left - mirrorRect.left - textarea.scrollLeft);
  const width = Math.ceil(Math.max(8, markerRect.width || Number.parseFloat(computedStyle.fontSize || "0") * 0.6 || 8));
  const height = Math.max(1, Math.round(lineHeight));

  if (!Number.isFinite(top) || !Number.isFinite(left) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  return { top, left, width, height, text: displayCharacter };
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

  const boundedText = text.slice(0, searchTo);
  const haystack = boundedText.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
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
  return Boolean(
    cssSupports?.("caret-shape", "block")
    && cssSupports("caret-animation", "manual"),
  );
}

export function shouldRedirectPlainTextPasteToPrompt(input: {
  readonly targetIsPrompt: boolean;
  readonly hasFiles: boolean;
  readonly promptInputDisabled: boolean;
  readonly text: string;
}) {
  return !input.targetIsPrompt && !input.hasFiles && !input.promptInputDisabled && input.text.length > 0;
}

export function shouldKeepCursorPaddingForTransactions(
  transactions: ReadonlyArray<{
    isUserEvent(event: string): boolean;
  }>,
) {
  return transactions.some((transaction) => transaction.isUserEvent("select.keyboard"));
}

function clampStoredSelectionToHistory(
  state: EditorState,
  selection: StoredSelection,
): StoredSelection {
  return resolveHistorySelectionForDocument(
    state.doc,
    state.field(promptStartField),
    selection,
  );
}

export function resolvePromptSelectionForDocument(
  promptStart: number,
  docLength: number,
  stored: StoredPromptSelection | null,
): StoredSelection {
  const maxOffset = Math.max(0, docLength - promptStart);
  const anchorOffset = Math.min(stored?.anchorOffset ?? maxOffset, maxOffset);
  const headOffset = Math.min(stored?.headOffset ?? maxOffset, maxOffset);
  return {
    anchor: promptStart + anchorOffset,
    head: promptStart + headOffset,
  };
}

export function resolveHistorySelectionForDocument(
  doc: Text,
  promptStart: number,
  stored: StoredSelection | null,
): StoredSelection {
  const historyLimit = getHistorySelectionLimitForPromptStart(doc, promptStart);
  if (!stored) {
    return { anchor: historyLimit, head: historyLimit };
  }
  return {
    anchor: Math.min(stored.anchor, historyLimit),
    head: Math.min(stored.head, historyLimit),
  };
}

function resolveHistorySelection(
  state: EditorState,
  stored: StoredSelection | null,
): StoredSelection {
  return resolveHistorySelectionForDocument(
    state.doc,
    state.field(promptStartField),
    stored,
  );
}

export const TranscriptRenderer = forwardRef<TranscriptRendererHandle, TranscriptRendererProps>(
  function TranscriptRenderer(
    {
      blocks,
      composerAttachments = [],
      cwd,
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
    const editorRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const syncingViewRef = useRef(false);
    const submittingRef = useRef(false);
    const activeRegionRef = useRef<TranscriptRegion>("prompt");
    const historySelectionRef = useRef<StoredSelection | null>(null);
    const draftRef = useRef("");
    const promptSelectionRef = useRef<StoredPromptSelection>({
      anchorOffset: 0,
      headOffset: 0,
    });
    const onSubmitRef = useRef(onSubmit);
    const onDraftChangeRef = useRef(onDraftChange);
    const onScrollOffsetFromBottomChangeRef = useRef(onScrollOffsetFromBottomChange);
    const initialScrollOffsetFromBottomRef = useRef(initialScrollOffsetFromBottom);
    const resolveInlineDiffRef = useRef(resolveInlineDiff);
    const submitDisabledRef = useRef(submitDisabled);
    const promptFocusDisabledRef = useRef(promptFocusDisabled);
    const promptInputDisabledRef = useRef(promptInputDisabled);
    const composerAttachmentsRef = useRef(composerAttachments);
    const expandedCommandSignaturesRef = useRef<ReadonlySet<string>>(new Set());
    const collapsedFileChangeSignaturesRef = useRef<ReadonlySet<string>>(new Set());
    const appliedDecorationSignatureRef = useRef("");
    const appliedSearchDecorationSignatureRef = useRef("");
    const dragDepthRef = useRef(0);
    const [expandedCommandSignatures, setExpandedCommandSignatures] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [collapsedFileChangeSignatures, setCollapsedFileChangeSignatures] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [resolvedInlineDiffBySignature, setResolvedInlineDiffBySignature] = useState<
      ReadonlyMap<string, InlineDiffResolutionState>
    >(() => new Map());
    const [isDraggingImages, setIsDraggingImages] = useState(false);
    const [draft, setDraft] = useState("");
    const [searchVisible, setSearchVisible] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(-1);
    const useNativePromptCaret = useMemo(
      () =>
        shouldUseNativePromptCaret(
          typeof CSS !== "undefined" && typeof CSS.supports === "function"
            ? CSS.supports.bind(CSS) as (property: string, value: string) => boolean
            : null,
        ),
      [],
    );
    const promptCaretRef = useRef<HTMLDivElement | null>(null);
    const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const searchOverlayRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const searchReturnRegionRef = useRef<TranscriptRegion>("prompt");

    useEffect(() => {
      draftRef.current = draft;
      onSubmitRef.current = onSubmit;
      onDraftChangeRef.current = onDraftChange;
      onScrollOffsetFromBottomChangeRef.current = onScrollOffsetFromBottomChange;
      initialScrollOffsetFromBottomRef.current = initialScrollOffsetFromBottom;
      resolveInlineDiffRef.current = resolveInlineDiff;
      submitDisabledRef.current = submitDisabled;
      promptFocusDisabledRef.current = promptFocusDisabled;
      promptInputDisabledRef.current = promptInputDisabled;
      composerAttachmentsRef.current = composerAttachments;
      expandedCommandSignaturesRef.current = expandedCommandSignatures;
      collapsedFileChangeSignaturesRef.current = collapsedFileChangeSignatures;
    }, [
      collapsedFileChangeSignatures,
      composerAttachments,
      draft,
      expandedCommandSignatures,
      initialScrollOffsetFromBottom,
      onDraftChange,
      onScrollOffsetFromBottomChange,
      onSubmit,
      promptFocusDisabled,
      promptInputDisabled,
      resolveInlineDiff,
      submitDisabled,
    ]);

    useEffect(() => {
      if (!promptInputDisabled) {
        return;
      }
      const textarea = promptTextareaRef.current;
      if (textarea && document.activeElement === textarea) {
        textarea.blur();
      }
    }, [promptInputDisabled]);

    const docModel = useMemo(
      () =>
        buildTranscriptDocument(
          blocks,
          expandedCommandSignatures,
          collapsedFileChangeSignatures,
          resolvedInlineDiffBySignature,
          pendingUserInputHighlight,
        ),
      [blocks, collapsedFileChangeSignatures, expandedCommandSignatures, pendingUserInputHighlight, resolvedInlineDiffBySignature],
    );
    const compactPendingUserInputPrompt =
      pendingUserInputHighlight !== undefined && !shouldRenderPromptSeparator(docModel.historyLineCount);
    const searchMatches = useMemo(
      () =>
        searchVisible
          ? findTranscriptSearchMatches(docModel.text, searchQuery, docModel.promptStart)
          : [],
      [docModel.promptStart, docModel.text, searchQuery, searchVisible],
    );
    const resolvedActiveSearchMatchIndex =
      searchMatches.length === 0
        ? -1
        : activeSearchMatchIndex >= 0 && activeSearchMatchIndex < searchMatches.length
          ? activeSearchMatchIndex
          : 0;
    const activeSearchMatch =
      resolvedActiveSearchMatchIndex >= 0
        ? searchMatches[resolvedActiveSearchMatchIndex] ?? null
        : null;
    const initialDocModelRef = useRef(docModel);
    const docModelRef = useRef(docModel);

    useEffect(() => {
      docModelRef.current = docModel;
    }, [docModel]);

    const setDraftValue = useCallback((nextDraft: string) => {
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      onDraftChangeRef.current?.(nextDraft);
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

    const syncPromptCaretBox = useCallback((textarea = promptTextareaRef.current) => {
      if (useNativePromptCaret || !textarea || promptInputDisabledRef.current) {
        applyPromptCaretBox(null);
        return;
      }
      applyPromptCaretBox(measurePromptCaretBox(textarea, promptSelectionRef.current));
    }, [applyPromptCaretBox, useNativePromptCaret]);

    const syncPromptSelection = useCallback((textarea = promptTextareaRef.current) => {
      const fallbackOffset = draftRef.current.length;
      const anchorOffset = textarea?.selectionStart ?? fallbackOffset;
      const headOffset = textarea?.selectionEnd ?? fallbackOffset;
      setPromptSelectionValue(anchorOffset, headOffset);
      syncPromptCaretBox(textarea);
    }, [setPromptSelectionValue, syncPromptCaretBox]);

    const clearHistorySelection = useCallback(() => {
      if (typeof window === "undefined") {
        return;
      }
      const selection = window.getSelection();
      if (!hasNonCollapsedSelectionInsideElement(selection, editorRef.current)) {
        return;
      }
      selection?.removeAllRanges();
    }, []);

    const focusPromptInput = useCallback((_options?: FocusPromptOptions) => {
      if (promptFocusDisabledRef.current) {
        return;
      }
      activeRegionRef.current = "prompt";
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
    }, [setPromptSelectionValue, syncPromptCaretBox]);

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

    const autosizePromptInput = useCallback(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea) {
        return;
      }

      const view = viewRef.current;
      const scrollSnapshots = captureScrollPositionSnapshots(
        textarea,
        view ? getConversationScrollContainer(view) : null,
      );

      const applyAutosize = () => {
        textarea.style.height = "auto";
        const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight || "20") || 20;
        const { height, overflowY } = resolvePromptTextareaLayout(lineHeight, textarea.scrollHeight);
        const nextTextareaHeight = `${height}px`;
        if (textarea.style.height !== nextTextareaHeight) {
          textarea.style.height = nextTextareaHeight;
        }
        if (textarea.style.overflowY !== overflowY) {
          textarea.style.overflowY = overflowY;
        }
      };
      applyAutosize();
      restoreScrollPositionSnapshots(scrollSnapshots);
      syncPromptCaretBox(textarea);
    }, [syncPromptCaretBox]);

    useLayoutEffect(() => {
      autosizePromptInput();
    }, [autosizePromptInput, draft]);

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
        syncPromptCaretBox(nextTextarea);
      });
    }, [preparePromptInteraction, setDraftValue, setPromptSelectionValue, syncPromptCaretBox]);

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
        syncPromptCaretBox(textarea);
      });
    }, [preparePromptInteraction, setDraftValue, setPromptSelectionValue, syncPromptCaretBox]);

    const handlePromptInputChange = useCallback((event: ReactChangeEvent<HTMLTextAreaElement>) => {
      preparePromptInteraction();
      setDraftValue(event.target.value);
      syncPromptSelection(event.target);
    }, [preparePromptInteraction, setDraftValue, syncPromptSelection]);

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
        focusPromptInput();
      });
      return true;
    }, [focusPromptInput, setDraftValue]);

    const selectAllHistoryText = useCallback(() => {
      if (typeof window === "undefined" || typeof document === "undefined") {
        return false;
      }
      const container = editorRef.current;
      const selection = window.getSelection();
      if (!container || !selection) {
        return false;
      }
      const range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);
      prepareHistoryInteraction();
      return true;
    }, [prepareHistoryInteraction]);

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

    const handlePromptInputBlur = useCallback(() => {
      applyPromptCaretBox(null);
    }, [applyPromptCaretBox]);

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
    }, [preparePromptInteraction, focusPromptInput]);

    const requestInlineDiff = useCallback((signature: string, lookup: InlineDiffLookup) => {
      const resolver = resolveInlineDiffRef.current;
      if (!resolver) {
        return;
      }

      let shouldFetch = false;
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
          setResolvedInlineDiffBySignature((current) => {
            const next = new Map(current);
            next.set(signature, { status: "error" });
            return next;
          });
        });
    }, []);

    useEffect(() => {
      for (const [signature, lookup] of docModel.defaultExpandedInlineDiffSignatures) {
        requestInlineDiff(signature, lookup);
      }
    }, [docModel.defaultExpandedInlineDiffSignatures, requestInlineDiff]);

    const syncActiveRegionClass = useCallback((view: EditorView) => {
      view.dom.classList.toggle("cm-editor-historyActive", activeRegionRef.current === "history");
    }, []);

    const focusPromptRegion = useCallback((options?: FocusPromptOptions) => {
      activeRegionRef.current = "prompt";
      preparePromptInteraction();
      requestAnimationFrame(() => {
        focusPromptInput(options);
      });
    }, [focusPromptInput, preparePromptInteraction]);

    const focusHistoryRegion = useCallback((view: EditorView) => {
      prepareHistoryInteraction();
      activeRegionRef.current = "history";
      syncActiveRegionClass(view);
      const historySelection = resolveHistorySelection(view.state, historySelectionRef.current);
      historySelectionRef.current = historySelection;
      view.dispatch({
        selection: EditorSelection.range(historySelection.anchor, historySelection.head),
        annotations: syncAnnotation.of(true),
      });
      view.focus();
      view.contentDOM.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        keepCursorWithinViewportPadding(view);
      });
    }, [prepareHistoryInteraction, syncActiveRegionClass]);

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
          const view = viewRef.current;
          if (view) {
            focusHistoryRegion(view);
            return;
          }
        }
        focusPromptRegion({ reveal: false });
      });
    }, [focusHistoryRegion, focusPromptRegion]);

    const openSearch = useCallback(() => {
      if (!searchVisible) {
        searchReturnRegionRef.current = activeRegionRef.current;
      }
      setSearchVisible(true);
      focusSearchInput();
    }, [focusSearchInput, searchVisible]);

    const moveSearchMatch = useCallback((direction: 1 | -1) => {
      setActiveSearchMatchIndex((currentIndex) =>
        getNextTranscriptSearchMatchIndex({
          currentIndex,
          matchCount: searchMatches.length,
          direction,
        }),
      );
    }, [searchMatches.length]);

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
      if (searchMatches.length === 0) {
        if (activeSearchMatchIndex !== -1) {
          setActiveSearchMatchIndex(-1);
        }
        return;
      }
      if (activeSearchMatchIndex < 0 || activeSearchMatchIndex >= searchMatches.length) {
        setActiveSearchMatchIndex(0);
      }
    }, [activeSearchMatchIndex, searchMatches.length, searchVisible]);

    useEffect(() => {
      if (!searchVisible || !activeSearchMatch) {
        return;
      }
      const view = viewRef.current;
      if (!view) {
        return;
      }
      requestAnimationFrame(() => {
        view.dispatch({
          effects: EditorView.scrollIntoView(activeSearchMatch.from, { y: "start" }),
          annotations: syncAnnotation.of(true),
        });
        requestAnimationFrame(() => {
          const activeMatchElement = editorRef.current?.querySelector(".cm-transcriptSearchMatch--active");
          if (!(activeMatchElement instanceof HTMLElement)) {
            return;
          }
          keepSearchMatchWithinViewport(
            view,
            activeMatchElement,
            searchOverlayRef.current?.offsetHeight ?? 0,
          );
        });
      });
    }, [activeSearchMatch, searchVisible]);

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

    const redirectHistoryTypingToPrompt = useCallback(
      (view: EditorView, text: string) => {
        const currentSelection: StoredSelection = {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        };
        historySelectionRef.current = clampStoredSelectionToHistory(view.state, currentSelection);
        activeRegionRef.current = "prompt";
        syncActiveRegionClass(view);
        insertTextIntoDraft(text);
      },
      [insertTextIntoDraft, syncActiveRegionClass],
    );

    const storeSelectionForRegion = useCallback(
      (state: EditorState, region: TranscriptRegion, selection: StoredSelection) => {
        if (region === "history") {
          historySelectionRef.current = clampStoredSelectionToHistory(state, selection);
        }
      },
      [],
    );

    const updateActiveRegionFromPointer = useCallback(
      (view: EditorView, event: MouseEvent) => {
        if (event.button !== 0) {
          return;
        }

        const pointerCoords = { x: event.clientX, y: event.clientY };
        const clickPosition = view.posAtCoords(pointerCoords);
        const estimatedClickPosition =
          clickPosition === null ? view.posAtCoords(pointerCoords, false) : clickPosition;
        const nextRegion = resolveTranscriptRegionForPointer(
          getHistorySelectionLimit(view.state),
          clickPosition,
          estimatedClickPosition,
        );
        if (!nextRegion || nextRegion === activeRegionRef.current) {
          return;
        }

        const currentSelection: StoredSelection = {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        };
        storeSelectionForRegion(view.state, activeRegionRef.current, currentSelection);
        activeRegionRef.current = nextRegion;
        syncActiveRegionClass(view);
      },
      [storeSelectionForRegion, syncActiveRegionClass],
    );

    const resolveCommandWidgetSignatureFromMouseEvent = useCallback(
      (_view: EditorView, event: MouseEvent) => {
        return resolveCommandWidgetToggleSignatureFromEventTarget(event.target);
      },
      [],
    );

    useImperativeHandle(ref, () => ({
      focus() {
        focusPromptRegion();
      },
      focusPrompt(options) {
        focusPromptRegion(options);
      },
      focusHistory() {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        focusHistoryRegion(view);
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
        return hasNonCollapsedSelectionInsideElement(window.getSelection(), editorRef.current);
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
        const view = viewRef.current;
        if (!view) {
          return;
        }
        scrollConversationToBottom(view);
      },
    }), [deletePromptText, focusHistoryRegion, focusPromptRegion, insertTextIntoDraft, openSearch, selectAllHistoryText, submitDraft]);

    useLayoutEffect(() => {
      if (!editorRef.current) {
        return undefined;
      }

      const initialDocModel = initialDocModelRef.current;

      const initialState = EditorState.create({
        doc: initialDocModel.text,
        selection: EditorSelection.cursor(initialDocModel.text.length),
        extensions: [
          promptStartField,
          EditorState.transactionFilter.of((transaction) => {
            if (transaction.annotation(syncAnnotation)) {
              return transaction;
            }

            const promptStart = transaction.startState.field(promptStartField);
            if (transaction.docChanged) {
              let blocked = false;
              transaction.changes.iterChangedRanges((fromA) => {
                if (fromA < promptStart) {
                  blocked = true;
                }
              });

              if (blocked) {
                return [];
              }
            }

            const targetSelection = transaction.newSelection;
            if (!targetSelection) {
              return transaction;
            }

            const rawSelection: StoredSelection = {
              anchor: targetSelection.main.anchor,
              head: targetSelection.main.head,
            };
            const clampedSelection = clampStoredSelectionToHistory(transaction.startState, rawSelection);

            if (
              clampedSelection.anchor === rawSelection.anchor &&
              clampedSelection.head === rawSelection.head
            ) {
              return transaction;
            }

            return [
              transaction,
              {
                selection: EditorSelection.range(clampedSelection.anchor, clampedSelection.head),
              },
            ];
          }),
          keymap.of(defaultKeymap),
          EditorView.lineWrapping,
          EditorView.clipboardOutputFilter.of((text, state) =>
            prefixCopiedUserMessageStarts(
              text,
              state,
              docModelRef.current.lines,
            )),
          buildEditorTheme(),
          decorationsCompartment.of(
            EditorView.decorations.of(
              buildDecorations(
                initialDocModel.lines,
                initialDocModel.marks,
                initialDocModel.widgets,
                initialDocModel.replacements,
              ),
            ),
          ),
          searchDecorationsField,
          EditorView.updateListener.of((update) => {
            if (syncingViewRef.current) {
              return;
            }

            const currentSelection: StoredSelection = {
              anchor: update.state.selection.main.anchor,
              head: update.state.selection.main.head,
            };
            storeSelectionForRegion(update.state, activeRegionRef.current, currentSelection);

            if (update.selectionSet && shouldKeepCursorPaddingForTransactions(update.transactions)) {
              requestAnimationFrame(() => {
                keepCursorWithinViewportPadding(update.view);
              });
            }
          }),
          EditorView.domEventHandlers({
            focus(_event, view) {
              prepareHistoryInteraction();
              activeRegionRef.current = "history";
              syncActiveRegionClass(view);
              const nextSelection = resolveHistorySelection(view.state, historySelectionRef.current);
              view.dispatch({
                selection: EditorSelection.range(nextSelection.anchor, nextSelection.head),
                annotations: syncAnnotation.of(true),
              });
            },
            mousedown(_event, view) {
              const interactiveMark = resolveInteractiveMarkFromMouseEvent(view, _event, docModelRef.current.marks);
              if (interactiveMark?.link) {
                _event.preventDefault();
                return true;
              }
              if (resolveCommandWidgetSignatureFromMouseEvent(view, _event)) {
                _event.preventDefault();
                return true;
              }
              prepareHistoryInteraction();
              updateActiveRegionFromPointer(view, _event);
              return false;
            },
            click(event, view) {
              prepareHistoryInteraction();
              const interactiveMark = resolveInteractiveMarkFromMouseEvent(view, event, docModelRef.current.marks);
              if (interactiveMark?.link) {
                event.preventDefault();
                void openTranscriptLink(interactiveMark.link, cwd);
                return true;
              }
              const signature = resolveCommandWidgetSignatureFromMouseEvent(view, event);
              if (!signature) {
                return false;
              }
              event.preventDefault();
              preserveConversationScrollPosition(view, () => {
                if (docModelRef.current.fileChangeWidgetSignatures.has(signature)) {
                  const shouldExpand = collapsedFileChangeSignaturesRef.current.has(signature);
                  if (shouldExpand && !docModelRef.current.inlineDiffContentBySignature.has(signature)) {
                    const inlineDiffLookup = docModelRef.current.inlineDiffLookupsBySignature.get(signature);
                    if (inlineDiffLookup) {
                      requestInlineDiff(signature, inlineDiffLookup);
                    }
                  }
                  setCollapsedFileChangeSignatures((current) => {
                    const next = new Set(current);
                    if (next.has(signature)) {
                      next.delete(signature);
                    } else {
                      next.add(signature);
                    }
                    return next;
                  });
                  return;
                }

                const shouldExpand = !expandedCommandSignaturesRef.current.has(signature);
                if (shouldExpand && !docModelRef.current.inlineDiffContentBySignature.has(signature)) {
                  const inlineDiffLookup = docModelRef.current.inlineDiffLookupsBySignature.get(signature);
                  if (inlineDiffLookup) {
                    requestInlineDiff(signature, inlineDiffLookup);
                  }
                }
                setExpandedCommandSignatures((current) => {
                  const next = new Set(current);
                  if (next.has(signature)) {
                    next.delete(signature);
                  } else {
                    next.add(signature);
                  }
                    return next;
                  });
                });
              return true;
            },
            keydown(event, view) {
              if (activeRegionRef.current !== "history") {
                return false;
              }
              if (shouldSelectAllHistoryFromHistoryKeydown(event, activeRegionRef.current)) {
                event.preventDefault();
                selectAllHistoryText();
                return true;
              }
              if (!shouldRedirectHistoryTypingToPrompt(event, {
                promptFocusDisabled: promptFocusDisabledRef.current,
                promptInputDisabled: promptInputDisabledRef.current,
              })) {
                return false;
              }

              event.preventDefault();
              focusPromptInput();
              redirectHistoryTypingToPrompt(view, event.key);
              return true;
            },
          }),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
        ],
      });

      const view = new EditorView({
        state: initialState,
        parent: editorRef.current,
      });
      syncActiveRegionClass(view);

      view.dispatch({
        effects: setPromptStartEffect.of(initialDocModel.promptStart),
        annotations: syncAnnotation.of(true),
      });

      viewRef.current = view;
      const scrollContainer = getConversationScrollContainer(view);
      const reportScrollOffsetFromBottom = () => {
        if (!scrollContainer) {
          return;
        }
        onScrollOffsetFromBottomChangeRef.current?.(readConversationScrollOffsetFromBottom(scrollContainer));
      };
      if (scrollContainer) {
        scrollContainer.addEventListener("scroll", reportScrollOffsetFromBottom, { passive: true });
      }
      const applyInitialScrollPosition = () => {
        if (initialScrollOffsetFromBottomRef.current === null) {
          scrollConversationToBottom(view);
        } else {
          restoreConversationScrollOffsetFromBottom(view, initialScrollOffsetFromBottomRef.current);
        }
        reportScrollOffsetFromBottom();
      };
      applyInitialScrollPosition();
      let cancelled = false;
      requestAnimationFrame(() => {
        if (cancelled) {
          return;
        }
        applyInitialScrollPosition();
      });
      appliedDecorationSignatureRef.current = buildDecorationSignature(initialDocModel);
      appliedSearchDecorationSignatureRef.current = buildSearchDecorationSignature([], -1);

      return () => {
        cancelled = true;
        if (scrollContainer) {
          scrollContainer.removeEventListener("scroll", reportScrollOffsetFromBottom);
        }
        view.destroy();
        viewRef.current = null;
      };
    }, [
      cwd,
      focusPromptInput,
      focusPromptRegion,
      prepareHistoryInteraction,
      requestInlineDiff,
      redirectHistoryTypingToPrompt,
      resolveCommandWidgetSignatureFromMouseEvent,
      selectAllHistoryText,
      syncActiveRegionClass,
      storeSelectionForRegion,
      updateActiveRegionFromPointer,
    ]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }

      const currentText = view.state.doc.toString();
      const currentPromptStart = view.state.field(promptStartField);
      const nextDecorationSignature = buildDecorationSignature(docModel);
      const isTextStable = currentText === docModel.text && currentPromptStart === docModel.promptStart;
      if (isTextStable && appliedDecorationSignatureRef.current === nextDecorationSignature) {
        return;
      }

      const shouldPinToBottom = isConversationScrollNearBottom(view);
      const minimalDocChange = isTextStable ? null : computeMinimalDocChange(currentText, docModel.text);
      const nextDoc = Text.of(docModel.text.split("\n"));

      syncingViewRef.current = true;
      const syncedHistorySelection =
        activeRegionRef.current === "history"
          ? resolveHistorySelectionForDocument(nextDoc, docModel.promptStart, historySelectionRef.current)
          : null;
      if (syncedHistorySelection) {
        historySelectionRef.current = syncedHistorySelection;
      }
      view.dispatch({
        ...(minimalDocChange ? { changes: minimalDocChange } : {}),
        ...(syncedHistorySelection
          ? {
              selection: EditorSelection.range(
                syncedHistorySelection.anchor,
                syncedHistorySelection.head,
              ),
            }
          : {}),
        effects: [
          decorationsCompartment.reconfigure(
            EditorView.decorations.of(
              buildDecorations(
                docModel.lines,
                docModel.marks,
                docModel.widgets,
                docModel.replacements,
              ),
            ),
          ),
          setPromptStartEffect.of(docModel.promptStart),
        ],
        annotations: syncAnnotation.of(true),
      });
      syncingViewRef.current = false;
      appliedDecorationSignatureRef.current = nextDecorationSignature;

      if (shouldPinToBottom) {
        requestAnimationFrame(() => {
          scrollConversationToBottom(view);
          onScrollOffsetFromBottomChangeRef.current?.(0);
        });
      }
    }, [docModel]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }

      const nextSearchDecorationSignature = buildSearchDecorationSignature(
        searchMatches,
        resolvedActiveSearchMatchIndex,
      );
      if (appliedSearchDecorationSignatureRef.current === nextSearchDecorationSignature) {
        return;
      }

      view.dispatch({
        effects: setSearchDecorationsEffect.of(
          buildSearchDecorations(searchMatches, resolvedActiveSearchMatchIndex),
        ),
        annotations: syncAnnotation.of(true),
      });
      appliedSearchDecorationSignatureRef.current = nextSearchDecorationSignature;
    }, [resolvedActiveSearchMatchIndex, searchMatches]);

    const focusPromptForAttachments = useCallback(() => {
      focusPromptRegion();
    }, [focusPromptRegion]);

    const handleIncomingFiles = useCallback((files: ReadonlyArray<File>) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        return false;
      }

      onAddImageFiles?.(imageFiles);
      focusPromptForAttachments();
      return true;
    }, [focusPromptForAttachments, onAddImageFiles]);

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

    return (
      <div
        ref={surfaceRef}
        className={`transcript-surface${isDraggingImages ? " transcript-surface--drag-over" : ""}`}
        onPasteCapture={handlePasteCapture}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {searchVisible ? (
          <div
            ref={searchOverlayRef}
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
                : searchMatches.length === 0
                  ? "0 results"
                  : `${resolvedActiveSearchMatchIndex + 1}/${searchMatches.length}`}
            </span>
            <div className="transcript-search__actions">
              <button
                type="button"
                className="transcript-search__button"
                onMouseDown={handleSearchControlMouseDown}
                onClick={() => moveSearchMatch(-1)}
                aria-label="Previous match"
                disabled={searchMatches.length === 0}
              >
                ↑
              </button>
              <button
                type="button"
                className="transcript-search__button"
                onMouseDown={handleSearchControlMouseDown}
                onClick={() => moveSearchMatch(1)}
                aria-label="Next match"
                disabled={searchMatches.length === 0}
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
        <div className="transcript-history">
          <div className="transcript-history__editor" ref={editorRef} />
        </div>
        <div
          className={compactPendingUserInputPrompt ? "transcript-prompt transcript-prompt--compact" : "transcript-prompt"}
          onMouseDown={handlePromptBodyMouseDown}
        >
          {composerAttachments.length > 0 ? (
            <div className="attachment-panel attachment-panel--composer">
              {composerAttachments.map((attachment) => (
                <div className="attachment-tile" key={attachment.id}>
                  <div className="attachment-tile__media">
                    <div className="attachment-tile__fallback" hidden>
                      {attachmentBadgeLabel(attachment.mimeType)}
                    </div>
                    <img
                      className="attachment-tile__image"
                      alt={attachment.name}
                      src={attachment.previewUrl}
                    />
                  </div>
                  <div className="attachment-tile__meta">
                    <div className="attachment-tile__name">{attachment.name}</div>
                    <div className="attachment-tile__detail">
                      {attachment.mimeType} · {formatAttachmentSize(attachment.sizeBytes)}
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
                  value={draft}
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
                {useNativePromptCaret ? null : (
                  <div
                    ref={promptCaretRef}
                    aria-hidden="true"
                    className="transcript-prompt__customCaret"
                    hidden
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
);
