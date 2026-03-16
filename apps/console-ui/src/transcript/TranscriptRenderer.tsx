import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
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
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";

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
}

interface TranscriptDocumentModel {
  readonly text: string;
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

interface CodeBlockWidgetLineData {
  readonly text: string;
  readonly highlightSpans?: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
    readonly className: string;
  }>;
}

interface InlineDiffRowData {
  readonly kind: "metadata" | "context" | "addition" | "deletion";
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
  readonly text: string;
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

interface TranscriptRendererProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly composerAttachments?: ReadonlyArray<ComposerImageAttachment>;
  readonly interactionMode?: "default" | "plan";
  readonly pendingUserInputHighlight?: {
    readonly requestId: string;
    readonly questionIndex: number;
    readonly optionIndex?: number;
  };
  readonly submitDisabled?: boolean;
  onAddImageFiles?(files: ReadonlyArray<File>): void;
  onDraftChange?(value: string): void;
  onRemoveImage?(attachmentId: string): void;
  resolveInlineDiff?(lookup: InlineDiffLookup): Promise<string | null>;
  onSubmit?(value: string): Promise<void> | void;
}

interface InlineDiffResolutionState {
  readonly status: "loading" | "ready" | "error";
  readonly diff?: string;
}

export type TranscriptRegion = "prompt" | "history";

export interface TranscriptRendererHandle {
  focus(): void;
  focusPrompt(): void;
  focusHistory(): void;
}

const CURSOR_VIEWPORT_PADDING_LINES = 7;

const syncAnnotation = Annotation.define<boolean>();
const setPromptStartEffect = StateEffect.define<number>();
const decorationsCompartment = new Compartment();

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
  const lineElement = document.createElement("div");
  lineElement.className = "cm-codeBlockLine";

  if (!line.highlightSpans || line.highlightSpans.length === 0) {
    if (line.text.length === 0) {
      lineElement.append(document.createElement("br"));
    } else {
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

  if (lineElement.childNodes.length === 0) {
    lineElement.append(document.createElement("br"));
  }

  return lineElement;
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
    const copyButtonExitDurationMs = 320;
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

    const content = document.createElement("div");
    content.className = "cm-codeBlockContent";
    for (const line of this.content.lines) {
      content.append(renderCodeBlockLine(line));
    }

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

function buildInlineDiffRows(file: FileDiffMetadata): InlineDiffFileData {
  const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
  const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
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
            text: file.additionLines[content.additionLineIndex + index] ?? "",
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
          text: file.deletionLines[content.deletionLineIndex + index] ?? "",
        });
        oldLineNumber += 1;
      }

      for (let index = 0; index < content.additions; index += 1) {
        rows.push({
          kind: "addition",
          newLineNumber,
          text: file.additionLines[content.additionLineIndex + index] ?? "",
        });
        newLineNumber += 1;
      }
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

function parseInlineDiffFiles(
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

function parseCommandWidgetText(text: string): {
  glyph: string;
  prefix: string;
  command: string;
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

  for (const marker of ["  Completed in ", "  Running for ", "  Failed after ", "  Declined after "]) {
    const timingIndex = command.lastIndexOf(marker);
    if (timingIndex === -1) {
      continue;
    }
    timingLabel = command.slice(timingIndex + 2);
    command = command.slice(0, timingIndex);
    break;
  }

  if (!counts) {
    const countsPrefixMatch = /^\((?<add>\+\d+), (?<remove>-\d+)\)\s+(?<base>[\s\S]*)$/.exec(command);
    const countsPrefixGroups = countsPrefixMatch?.groups;
    const prefixAdditions = countsPrefixGroups?.add;
    const prefixDeletions = countsPrefixGroups?.remove;
    if (countsPrefixGroups && prefixAdditions && prefixDeletions) {
      command = countsPrefixGroups.base ?? command;
      counts = {
        additions: prefixAdditions,
        deletions: prefixDeletions,
      };
    }
  }

  if (!counts) {
  const commandCounts = extractCommandWidgetCounts(command);
    if (commandCounts) {
      command = commandCounts.base;
      counts = commandCounts.counts;
    }
  }

  return {
    glyph,
    prefix,
    command,
    ...(timingLabel ? { timingLabel } : {}),
    ...(counts ? { counts } : {}),
  };
}

class CommandWidgetLine extends WidgetType {
  constructor(
    private readonly content: {
      signature: string;
      glyph: string;
      prefix: string;
      command: string;
      timingLabel?: string;
      counts?: {
        additions: string;
        deletions: string;
      };
      inlineDiffFiles?: ReadonlyArray<InlineDiffFileData>;
      rawInlineDiff?: string;
      inlineDiffStateMessage?: string;
      inlineDiffStateClass?: string;
      expanded: boolean;
      isFileChange: boolean;
      statusClass?: string;
    },
  ) {
    super();
  }

  override eq(other: CommandWidgetLine) {
    return JSON.stringify(this.content) === JSON.stringify(other.content);
  }

  override ignoreEvent() {
    return false;
  }

  override toDOM() {
    const root = document.createElement("div");
    root.className = [
      "cm-commandWidgetSurface",
      this.content.isFileChange ? "cm-commandWidgetSurfaceFileChange" : "",
      this.content.expanded ? "cm-commandWidgetSurfaceExpanded" : "",
      this.content.statusClass ?? "",
    ].filter(Boolean).join(" ");
    root.dataset.commandWidgetSignature = this.content.signature;

    const lead = document.createElement("span");
    lead.className = "cm-commandWidgetLead";

    const glyph = document.createElement("span");
    glyph.className = "cm-commandWidgetGlyph";
    glyph.textContent = this.content.glyph;

    const prefix = document.createElement("span");
    prefix.className = "cm-commandWidgetPrefix";
    prefix.textContent = this.content.prefix;

    lead.append(glyph, document.createTextNode(" "), prefix);

    root.append(lead);

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
      root.append(counts);
    }

    const command = document.createElement("span");
    command.className = "cm-commandWidgetCommand";
    command.textContent = this.content.command;

    root.append(command);

    if (this.content.timingLabel) {
      const meta = document.createElement("span");
      meta.className = "cm-commandWidgetMeta";
      meta.textContent = this.content.timingLabel;
      root.append(meta);
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

              const newLine = document.createElement("span");
              newLine.className = "cm-inlineDiffLineNumber";
              newLine.textContent = row.newLineNumber?.toString() ?? "";

              const marker = document.createElement("span");
              marker.className = "cm-inlineDiffMarker";
              marker.textContent =
                row.kind === "addition" ? "+" : row.kind === "deletion" ? "-" : row.kind === "context" ? " " : "@";

              const content = document.createElement("span");
              content.className = "cm-inlineDiffContent";
              content.textContent = row.text.length > 0 ? row.text : " ";

              rowElement.append(newLine, marker, content);
              fileRoot.append(rowElement);
            }
          }

          inlineDiff.append(fileRoot);
        }
      } else if (this.content.rawInlineDiff) {
        const rawFallback = document.createElement("pre");
        rawFallback.className = "cm-inlineDiffFallback";
        rawFallback.textContent = this.content.rawInlineDiff;
        inlineDiff.append(rawFallback);
      } else if (this.content.inlineDiffStateMessage) {
        const stateMessage = document.createElement("div");
        stateMessage.className = "cm-inlineDiffStateMessage";
        stateMessage.textContent = this.content.inlineDiffStateMessage;
        inlineDiff.append(stateMessage);
      }

      root.append(inlineDiff);
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

function flattenBlocks(
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
    const rawBlockLines = blockToLines(block);
    const leadingUserPromptSeparatorCount =
      !seenVisibleBlock && block.type === "user-message"
        ? rawBlockLines.findIndex((line) => line.kind !== "userPromptSeparator")
        : -1;
    const hiddenUserPromptSeparatorCount =
      leadingUserPromptSeparatorCount === -1 ? rawBlockLines.length : leadingUserPromptSeparatorCount;
    const blockLines = rawBlockLines.map((line, lineIndex) => {
      let nextLine = line;

      if (
        !seenVisibleBlock
        && block.type === "user-message"
        && line.kind === "userPromptSeparator"
        && lineIndex < hiddenUserPromptSeparatorCount
      ) {
        nextLine = {
          ...line,
          extraClasses: [...(line.extraClasses ?? []), "cm-line-userPromptSeparatorHidden"],
        };
      }

      const userInputRef = nextLine.userInputRef;

      if (!pendingUserInputHighlight || !userInputRef) {
        return nextLine;
      }

      if (
        userInputRef.requestId !== pendingUserInputHighlight.requestId
        || userInputRef.questionIndex !== pendingUserInputHighlight.questionIndex
      ) {
        return nextLine;
      }

      const extraClasses = [...(nextLine.extraClasses ?? []), "cm-line-userInputActiveQuestion"];
      if (
        userInputRef.optionIndex !== undefined
        && pendingUserInputHighlight.optionIndex !== undefined
        && userInputRef.optionIndex === pendingUserInputHighlight.optionIndex
      ) {
        extraClasses.push("cm-line-userInputActiveOption");
      }

      return Object.assign({}, nextLine, { extraClasses });
    });
    const startLineIndex = allLines.length;
    allLines.push(...blockLines);
    if (blockLines.some((line) => line.text.length > 0 || line.kind !== "userPromptSeparator")) {
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
  draft: string,
  interactionMode: "default" | "plan",
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
  const draftLines = draft.length > 0 ? draft.split("\n") : [""];
  const allLines: AnnotatedLine[] = [
    ...historyLines,
    {
      text: "",
      kind: "promptSeparator",
      extraClasses: promptSeparatorClassesForInteractionMode(interactionMode),
    },
    { text: draftLines[0] ?? "", kind: "promptInput" },
    ...draftLines.slice(1).map((line) => ({ text: line, kind: "promptInput" as const })),
  ];

  let text = "";
  let offset = 0;
  let separatorStart = -1;
  let promptStart = -1;
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
        });
      }
    }
    text += line.text;

    if (line.kind === "promptSeparator" && separatorStart === -1) {
      separatorStart = from;
    }

    if (line.kind === "promptInput" && promptStart === -1) {
      promptStart = from;
    }

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
            isFileChange: isFileChangeWidget,
            ...(statusClass ? { statusClass } : {}),
          }),
          signature: `${line.commandWidgetSignature}:${line.text}:${isExpandedCommand}:${statusClass ?? ""}:${effectiveInlineDiff ?? ""}:${resolvedInlineDiffState?.status ?? ""}`,
        });
      }
    }
    if (index < allLines.length - 1) {
      text += "\n";
      offset += 1;
    }
  });

  replacements.push(...buildCodeBlockReplacements(allLines, positioned));

  return {
    text,
    lines: positioned,
    marks,
    widgets,
    replacements,
    fileChangeWidgetSignatures,
    inlineDiffLookupsBySignature,
    inlineDiffContentBySignature,
    defaultExpandedInlineDiffSignatures,
    separatorStart: separatorStart === -1 ? promptStart === -1 ? text.length : promptStart : separatorStart,
    promptStart: promptStart === -1 ? text.length : promptStart,
  };
}

function buildDecorations(
  lines: ReadonlyArray<PositionedLine>,
  marks: ReadonlyArray<PositionedMark>,
  widgets: ReadonlyArray<PositionedWidget>,
  replacements: ReadonlyArray<PositionedReplacement>,
  promptStart: number,
) {
  const ranges = lines.map((line) =>
    Decoration.line({
      class: [`cm-line-${line.kind}`, ...(line.extraClasses ?? [])].join(" "),
    }).range(line.from),
  );
  ranges.push(
    ...marks.map((mark) =>
      Decoration.mark({ class: `cm-codeToken ${mark.className}` }).range(mark.from, mark.to),
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
  ranges.push(Decoration.line({ class: "cm-line-promptStart" }).range(promptStart));
  return Decoration.set(ranges, true);
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
        width: "100%",
        minWidth: "0",
        color: "#c5ccd3",
        backgroundColor: "transparent",
        fontFamily:
          '"Cascadia Mono", "Cascadia Code", "Iosevka Term", "JetBrains Mono", Consolas, monospace',
        fontSize: "16px",
      },
      ".cm-scroller": {
        overflowX: "hidden",
        overflowY: "visible",
        width: "100%",
        minWidth: "0",
        padding: "18px 0 18px",
        lineHeight: "1.3",
      },
      ".cm-content": {
        boxSizing: "border-box",
        width: "100%",
        minWidth: "0",
        maxWidth: "100%",
        padding: "0 22px 18px",
        caretColor: "#cfd6dd",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "#cfd6dd",
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
        fontSize: "13px",
        fontStyle: "italic",
        paddingBottom: "4px",
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
      ".cm-line-list": { color: "#c7ccd1" },
      ".cm-line-userPromptSeparator": {
        position: "relative",
        height: "0",
        minHeight: "0",
        lineHeight: "0",
        fontSize: "16px",
        paddingTop: "1.3em",
        paddingBottom: "1.3em",
        overflow: "visible",
      },
      ".cm-line-userPromptSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(236, 241, 246, 0.38)",
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
        paddingTop: "1.3em",
        paddingBottom: "1.3em",
        overflow: "visible",
      },
      ".cm-line-planSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(210, 225, 216, 0.28)",
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
        paddingTop: "1.3em",
        paddingBottom: "1.3em",
        overflow: "visible",
      },
      ".cm-line-checkpointSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(224, 230, 236, 0.28)",
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
      ".cm-codeToken.tok-workingPulseEdge": {
        color: "rgba(255, 255, 255, 0.42)",
      },
      ".cm-codeToken.tok-workingPulseMid": {
        color: "rgba(255, 255, 255, 0.76)",
      },
      ".cm-codeToken.tok-workingPulseCore": {
        color: "#ffffff",
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
        paddingTop: "1.3em",
        paddingBottom: "1.3em",
        overflow: "visible",
      },
      ".cm-line-promptSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(230, 236, 242, 0.34)",
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
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(127, 201, 109, 0.62)",
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
      ".cm-line-approvalPrompt": { color: "#e8a84c" },
      ".cm-line-userInputQuestion": { color: "#cfa764" },
      ".cm-line-userInputOption": { color: "#d1a65f" },
      ".cm-line-userInputResolved": { opacity: "0.54" },
      ".cm-line-userInputResolvedOption": {
        color: "#737a82",
        opacity: "0.72",
      },
      ".cm-line-userInputAnsweredOption": {
        color: "#eed3a0",
        backgroundColor: "rgba(88, 70, 35, 0.26)",
        fontWeight: "600",
        opacity: "1",
      },
      ".cm-line-userInputActiveQuestion": { color: "#f0bc6b" },
      ".cm-line-userInputActiveOption": {
        color: "#f3c877",
        backgroundColor: "rgba(93, 72, 31, 0.22)",
      },
      ".cm-line-commandExec": {
        minWidth: "0",
      },
      ".cm-commandWidgetSurface": {
        color: "#ced5dc",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "100%",
        minWidth: "0",
        fontSize: "12px",
        lineHeight: "1.45",
        padding: "5px 10px",
        margin: "2px 0",
        border: "1px solid rgba(123, 135, 146, 0.32)",
        borderRadius: "10px",
        backgroundColor: "rgba(17, 23, 29, 0.9)",
        cursor: "pointer",
        overflow: "hidden",
        transition:
          "max-height 180ms ease, background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease",
      },
      ".cm-commandWidgetSurface:hover": {
        backgroundColor: "rgba(22, 31, 38, 0.98)",
        borderColor: "rgba(168, 180, 191, 0.48)",
        boxShadow: "inset 0 0 0 1px rgba(205, 214, 223, 0.05)",
      },
      ".cm-commandWidgetSurfaceExpanded": {
        alignItems: "flex-start",
        flexWrap: "wrap",
      },
      ".cm-commandWidgetSurface.cm-line-workItemRunning": {
        borderColor: "rgba(113, 178, 255, 0.44)",
        backgroundColor: "rgba(18, 27, 36, 0.96)",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDone": {
        borderColor: "rgba(128, 146, 160, 0.34)",
      },
      ".cm-commandWidgetSurface.cm-line-workItemError": {
        color: "#f0cbcb",
        borderColor: "rgba(214, 108, 108, 0.42)",
        backgroundColor: "rgba(41, 22, 24, 0.94)",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDeclined": {
        color: "#e0d1ae",
        borderColor: "rgba(194, 154, 79, 0.38)",
        backgroundColor: "rgba(40, 31, 17, 0.94)",
      },
      ".cm-commandWidgetLead": {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        flexShrink: "0",
        whiteSpace: "nowrap",
      },
      ".cm-commandWidgetGlyph": {
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
        flex: "1 1 auto",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      ".cm-commandWidgetMeta": {
        color: "#7f8891",
        flexShrink: "0",
        whiteSpace: "nowrap",
      },
      ".cm-commandWidgetCounts": {
        color: "#9aa4ad",
      },
      ".cm-commandWidgetCountAdded": {
        color: "#63f28a",
      },
      ".cm-commandWidgetCountRemoved": {
        color: "#ff7575",
      },
      ".cm-commandWidgetSurfaceExpanded .cm-commandWidgetCommand": {
        flex: "0 0 100%",
        width: "100%",
        overflow: "visible",
        textOverflow: "clip",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
      ".cm-commandWidgetSurfaceExpanded .cm-commandWidgetMeta": {
        marginLeft: "auto",
      },
      ".cm-commandWidgetSurfaceExpanded.cm-commandWidgetSurfaceFileChange .cm-commandWidgetCommand": {
        flex: "1 1 auto",
        width: "auto",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      ".cm-commandWidgetSurfaceExpanded.cm-commandWidgetSurfaceFileChange .cm-commandWidgetMeta": {
        marginLeft: "0",
      },
      ".cm-commandWidgetInlineDiff": {
        flexBasis: "100%",
        minWidth: "0",
        marginTop: "0",
        paddingTop: "0",
        borderTop: "none",
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
        borderRadius: "10px",
        backgroundColor: "rgba(11, 16, 21, 0.74)",
      },
      ".cm-inlineDiffFile + .cm-inlineDiffFile": {
        marginTop: "6px",
      },
      ".cm-inlineDiffRow": {
        display: "grid",
        gridTemplateColumns: "52px 12px minmax(0, 1fr)",
        columnGap: "8px",
        alignItems: "start",
        minWidth: "0",
        padding: "0 10px",
      },
      ".cm-inlineDiffRowContext": {
        backgroundColor: "rgba(20, 26, 32, 0.58)",
      },
      ".cm-inlineDiffRowAddition": {
        backgroundColor: "rgba(20, 60, 38, 0.5)",
      },
      ".cm-inlineDiffRowDeletion": {
        backgroundColor: "rgba(66, 26, 29, 0.5)",
      },
      ".cm-inlineDiffLineNumber": {
        color: "#72808d",
        textAlign: "right",
        userSelect: "none",
      },
      ".cm-inlineDiffMarker": {
        color: "#8b97a3",
        userSelect: "none",
      },
      ".cm-inlineDiffRowAddition .cm-inlineDiffMarker, .cm-inlineDiffRowAddition .cm-inlineDiffContent": {
        color: "#9cf0b4",
      },
      ".cm-inlineDiffRowDeletion .cm-inlineDiffMarker, .cm-inlineDiffRowDeletion .cm-inlineDiffContent": {
        color: "#ffb1b1",
      },
      ".cm-inlineDiffContent": {
        minWidth: "0",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
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
        color: "#8cc8ff",
      },
      ".cm-commandWidgetSurface.cm-line-workItemRunning .cm-commandWidgetPrefix": {
        color: "#82bff2",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDone .cm-commandWidgetPrefix": {
        color: "#c8d0d8",
      },
      ".cm-commandWidgetSurface.cm-line-workItemDone .cm-commandWidgetGlyph": {
        color: "#d8e6d8",
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
      },
      ".cm-codeBlockLine": {
        color: "#c7d0d8",
        fontSize: "13px",
        lineHeight: "1.55",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
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
        transform: "translateY(-4px) scale(0.96)",
        pointerEvents: "none",
        transition:
          "opacity 320ms ease, transform 180ms ease",
        transitionDelay: "0ms, 0ms",
      },
      ".cm-codeBlockCopyButtonLabel": {
        display: "block",
        gridArea: "1 / 1",
        transition: "opacity 120ms ease",
      },
      ".cm-codeBlockCopyButtonStatus": {
        display: "inline-block",
        gridArea: "1 / 1",
        textAlign: "center",
        opacity: "0",
        transform: "scale(0.85)",
        transition: "opacity 120ms ease, transform 160ms ease",
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

function getConversationScrollContainer(view: EditorView) {
  const scrollContainer = view.dom.closest(".conversation-scroll");
  return scrollContainer instanceof HTMLElement ? scrollContainer : null;
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

  return (
    scrollContainer.scrollHeight - (scrollContainer.scrollTop + scrollContainer.clientHeight)
      <= thresholdPx
  );
}

function scrollConversationToBottom(view: EditorView) {
  const scrollContainer = getConversationScrollContainer(view);
  if (!scrollContainer) {
    return;
  }

  scrollContainer.scrollTop = Math.max(
    0,
    scrollContainer.scrollHeight - scrollContainer.clientHeight,
  );
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

export function getHistorySelectionLimitForPromptStart(doc: Text, promptStart: number) {
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

export function shouldRedirectHistoryTypingToPrompt(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
) {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }

  return event.key.length === 1;
}

export function shouldKeepCursorPaddingForTransactions(
  transactions: ReadonlyArray<{
    isUserEvent(event: string): boolean;
  }>,
) {
  return transactions.some((transaction) => transaction.isUserEvent("select.keyboard"));
}

function clampStoredSelectionToPrompt(
  state: EditorState,
  selection: StoredSelection,
): StoredSelection {
  const promptStart = state.field(promptStartField);
  return {
    anchor: Math.max(promptStart, Math.min(selection.anchor, state.doc.length)),
    head: Math.max(promptStart, Math.min(selection.head, state.doc.length)),
  };
}

function clampSelectionToPromptBounds(
  promptStart: number,
  docLength: number,
  selection: StoredSelection,
): StoredSelection {
  return {
    anchor: Math.max(promptStart, Math.min(selection.anchor, docLength)),
    head: Math.max(promptStart, Math.min(selection.head, docLength)),
  };
}

function clampStoredSelectionToHistory(
  state: EditorState,
  selection: StoredSelection,
): StoredSelection {
  const historyLimit = getHistorySelectionLimit(state);
  return {
    anchor: Math.min(selection.anchor, historyLimit),
    head: Math.min(selection.head, historyLimit),
  };
}

function storePromptSelection(
  state: EditorState,
  selection: StoredSelection,
): StoredPromptSelection {
  const promptStart = state.field(promptStartField);
  const clamped = clampStoredSelectionToPrompt(state, selection);
  return {
    anchorOffset: clamped.anchor - promptStart,
    headOffset: clamped.head - promptStart,
  };
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

function resolvePromptSelection(
  state: EditorState,
  stored: StoredPromptSelection | null,
): StoredSelection {
  return resolvePromptSelectionForDocument(
    state.field(promptStartField),
    state.doc.length,
    stored,
  );
}

function resolveHistorySelection(
  state: EditorState,
  stored: StoredSelection | null,
): StoredSelection {
  const historyLimit = getHistorySelectionLimit(state);
  if (!stored) {
    return { anchor: historyLimit, head: historyLimit };
  }
  return clampStoredSelectionToHistory(state, stored);
}

export const TranscriptRenderer = forwardRef<TranscriptRendererHandle, TranscriptRendererProps>(
  function TranscriptRenderer(
    {
      blocks,
      composerAttachments = [],
      interactionMode = "default",
      pendingUserInputHighlight,
      onAddImageFiles,
      onDraftChange,
      onRemoveImage,
      resolveInlineDiff,
      onSubmit,
      submitDisabled = false,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const hasAutofocusedRef = useRef(false);
    const syncingViewRef = useRef(false);
    const submittingRef = useRef(false);
    const activeRegionRef = useRef<TranscriptRegion>("prompt");
    const promptSelectionRef = useRef<StoredPromptSelection | null>(null);
    const historySelectionRef = useRef<StoredSelection | null>(null);
    const draftRef = useRef("");
    const onSubmitRef = useRef(onSubmit);
    const onDraftChangeRef = useRef(onDraftChange);
    const resolveInlineDiffRef = useRef(resolveInlineDiff);
    const submitDisabledRef = useRef(submitDisabled);
    const composerAttachmentsRef = useRef(composerAttachments);
    const expandedCommandSignaturesRef = useRef<ReadonlySet<string>>(new Set());
    const collapsedFileChangeSignaturesRef = useRef<ReadonlySet<string>>(new Set());
    const appliedDecorationSignatureRef = useRef("");
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

    useEffect(() => {
      draftRef.current = draft;
      onSubmitRef.current = onSubmit;
      onDraftChangeRef.current = onDraftChange;
      resolveInlineDiffRef.current = resolveInlineDiff;
      submitDisabledRef.current = submitDisabled;
      composerAttachmentsRef.current = composerAttachments;
      expandedCommandSignaturesRef.current = expandedCommandSignatures;
      collapsedFileChangeSignaturesRef.current = collapsedFileChangeSignatures;
    }, [
      collapsedFileChangeSignatures,
      composerAttachments,
      draft,
      expandedCommandSignatures,
      onDraftChange,
      onSubmit,
      resolveInlineDiff,
      submitDisabled,
    ]);

    const docModel = useMemo(
      () =>
        buildTranscriptDocument(
          blocks,
          draft,
          interactionMode,
          expandedCommandSignatures,
          collapsedFileChangeSignatures,
          resolvedInlineDiffBySignature,
          pendingUserInputHighlight,
        ),
      [blocks, draft, expandedCommandSignatures, collapsedFileChangeSignatures, interactionMode, pendingUserInputHighlight, resolvedInlineDiffBySignature],
    );
    const initialDocModelRef = useRef(docModel);
    const docModelRef = useRef(docModel);

    useEffect(() => {
      docModelRef.current = docModel;
    }, [docModel]);

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

    const focusPromptRegion = useCallback((view: EditorView) => {
      activeRegionRef.current = "prompt";
      const promptSelection = resolvePromptSelection(view.state, promptSelectionRef.current);
      promptSelectionRef.current = storePromptSelection(view.state, promptSelection);
      view.dispatch({
        selection: EditorSelection.range(promptSelection.anchor, promptSelection.head),
        annotations: syncAnnotation.of(true),
      });
      view.focus();
      view.contentDOM.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        keepCursorWithinViewportPadding(view);
      });
    }, []);

    const focusHistoryRegion = useCallback((view: EditorView) => {
      const currentSelection: StoredSelection = {
        anchor: view.state.selection.main.anchor,
        head: view.state.selection.main.head,
      };
      promptSelectionRef.current = storePromptSelection(view.state, currentSelection);
      activeRegionRef.current = "history";
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
    }, []);

    const redirectHistoryTypingToPrompt = useCallback(
      (view: EditorView, text: string) => {
        const currentSelection: StoredSelection = {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        };
        historySelectionRef.current = clampStoredSelectionToHistory(view.state, currentSelection);
        activeRegionRef.current = "prompt";

        const promptSelection = resolvePromptSelection(view.state, promptSelectionRef.current);
        view.dispatch({
          changes: {
            from: promptSelection.anchor,
            to: promptSelection.head,
            insert: text,
          },
          selection: EditorSelection.cursor(promptSelection.anchor + text.length),
          annotations: syncAnnotation.of(true),
        });
        promptSelectionRef.current = storePromptSelection(view.state, {
          anchor: promptSelection.anchor + text.length,
          head: promptSelection.anchor + text.length,
        });
        view.focus();
        view.contentDOM.focus({ preventScroll: true });
        requestAnimationFrame(() => {
          keepCursorWithinViewportPadding(view);
        });
      },
      [],
    );

    const storeSelectionForRegion = useCallback(
      (state: EditorState, region: TranscriptRegion, selection: StoredSelection) => {
        if (region === "prompt") {
          promptSelectionRef.current = storePromptSelection(state, selection);
          return;
        }

        historySelectionRef.current = clampStoredSelectionToHistory(state, selection);
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
      },
      [storeSelectionForRegion],
    );

    const resolveCommandWidgetSignatureFromMouseEvent = useCallback(
      (_view: EditorView, event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Node)) {
          return null;
        }

        const commandSurface =
          target instanceof Element
            ? target.closest(".cm-commandWidgetSurface")
            : target.parentElement?.closest(".cm-commandWidgetSurface");
        if (commandSurface instanceof HTMLElement && commandSurface.dataset.commandWidgetSignature) {
          return commandSurface.dataset.commandWidgetSignature;
        }

        const commandLine =
          target instanceof Element
            ? target.closest(".cm-line-commandWidget")
            : target.parentElement?.closest(".cm-line-commandWidget");
        if (!(commandLine instanceof HTMLElement)) {
          return null;
        }

        const linePosition = _view.posAtDOM(commandLine, 0);
        const lineFrom = _view.state.doc.lineAt(linePosition).from;
        const line = docModelRef.current.lines.find((entry) => entry.from === lineFrom);
        return line?.commandWidgetSignature ?? null;
      },
      [],
    );

    useImperativeHandle(ref, () => ({
      focus() {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        focusPromptRegion(view);
      },
      focusPrompt() {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        focusPromptRegion(view);
      },
      focusHistory() {
        const view = viewRef.current;
        if (!view) {
          return;
        }
        focusHistoryRegion(view);
      },
    }), [focusHistoryRegion, focusPromptRegion]);

    useEffect(() => {
      if (!editorRef.current) {
        return undefined;
      }

      const initialDocModel = initialDocModelRef.current;

      const replaceDraft = (nextDraft: string) => {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        const promptStart = view.state.field(promptStartField);
        view.dispatch({
          changes: {
            from: promptStart,
            to: view.state.doc.length,
            insert: nextDraft,
          },
          selection: EditorSelection.cursor(promptStart + nextDraft.length),
        });
      };

      const submitDraft = async () => {
        const value = draftRef.current.trim();
        if (
          (value.length === 0 && composerAttachmentsRef.current.length === 0) ||
          submittingRef.current ||
          submitDisabledRef.current
        ) {
          return true;
        }

        submittingRef.current = true;
        try {
          await onSubmitRef.current?.(value);
          replaceDraft("");
        } finally {
          submittingRef.current = false;
        }

        return true;
      };

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
            const clampedSelection =
              activeRegionRef.current === "prompt"
                ? clampSelectionToPromptBounds(promptStart, transaction.newDoc.length, rawSelection)
                : clampStoredSelectionToHistory(transaction.startState, rawSelection);

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
          keymap.of([
            {
              key: "Shift-Enter",
              run(view) {
                if (activeRegionRef.current !== "prompt") {
                  return true;
                }
                const selection = view.state.selection.main;
                view.dispatch({
                  changes: { from: selection.from, to: selection.to, insert: "\n" },
                  selection: EditorSelection.cursor(selection.from + 1),
                });
                return true;
              },
            },
            {
              key: "Enter",
              run() {
                if (activeRegionRef.current !== "prompt") {
                  return true;
                }
                void submitDraft();
                return true;
              },
            },
          ]),
          keymap.of(defaultKeymap),
          EditorView.lineWrapping,
          buildEditorTheme(),
          decorationsCompartment.of(
            EditorView.decorations.of(
              buildDecorations(
                initialDocModel.lines,
                initialDocModel.marks,
                initialDocModel.widgets,
                initialDocModel.replacements,
                initialDocModel.promptStart,
              ),
            ),
          ),
          EditorView.updateListener.of((update) => {
            if (syncingViewRef.current) {
              return;
            }

            const promptStart = update.state.field(promptStartField);
            const nextDraft = update.state.sliceDoc(promptStart);
            if (nextDraft !== draftRef.current) {
              draftRef.current = nextDraft;
              setDraft(nextDraft);
              onDraftChangeRef.current?.(nextDraft);
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
              const nextSelection =
                activeRegionRef.current === "prompt"
                  ? resolvePromptSelection(view.state, promptSelectionRef.current)
                  : resolveHistorySelection(view.state, historySelectionRef.current);
              view.dispatch({
                selection: EditorSelection.range(nextSelection.anchor, nextSelection.head),
                annotations: syncAnnotation.of(true),
              });
            },
            mousedown(_event, view) {
              if (resolveCommandWidgetSignatureFromMouseEvent(view, _event)) {
                _event.preventDefault();
                return true;
              }
              updateActiveRegionFromPointer(view, _event);
              return false;
            },
            click(event, view) {
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
              if (!shouldRedirectHistoryTypingToPrompt(event)) {
                return false;
              }

              event.preventDefault();
              redirectHistoryTypingToPrompt(view, event.key);
              return true;
            },
          }),
          EditorView.editable.of(true),
          EditorState.readOnly.of(false),
        ],
      });

      const view = new EditorView({
        state: initialState,
        parent: editorRef.current,
      });

      view.dispatch({
        effects: setPromptStartEffect.of(initialDocModel.promptStart),
        annotations: syncAnnotation.of(true),
      });

      viewRef.current = view;
      appliedDecorationSignatureRef.current = buildDecorationSignature(initialDocModel);

      if (!hasAutofocusedRef.current) {
        hasAutofocusedRef.current = true;
        const autofocus = () => {
          focusPromptRegion(view);
        };
        autofocus();
        requestAnimationFrame(() => {
          autofocus();
          setTimeout(autofocus, 0);
          setTimeout(autofocus, 40);
        });
      }

      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, [
      focusPromptRegion,
      requestInlineDiff,
      redirectHistoryTypingToPrompt,
      resolveCommandWidgetSignatureFromMouseEvent,
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

      const shouldPinToBottom =
        view.hasFocus
        && activeRegionRef.current === "prompt"
        && isConversationScrollNearBottom(view);
      const minimalDocChange = isTextStable ? null : computeMinimalDocChange(currentText, docModel.text);

      syncingViewRef.current = true;
      const syncedPromptSelection =
        activeRegionRef.current === "prompt"
          ? resolvePromptSelectionForDocument(
              docModel.promptStart,
              docModel.text.length,
              promptSelectionRef.current,
            )
          : null;
      view.dispatch({
        ...(minimalDocChange ? { changes: minimalDocChange } : {}),
        ...(syncedPromptSelection
          ? {
              selection: EditorSelection.range(
                syncedPromptSelection.anchor,
                syncedPromptSelection.head,
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
                docModel.promptStart,
              ),
            ),
          ),
          setPromptStartEffect.of(docModel.promptStart),
        ],
        annotations: syncAnnotation.of(true),
      });
      syncingViewRef.current = false;
      appliedDecorationSignatureRef.current = nextDecorationSignature;

      if (!isTextStable) {
        if (activeRegionRef.current === "prompt") {
          promptSelectionRef.current = storePromptSelection(view.state, {
            anchor: view.state.selection.main.anchor,
            head: view.state.selection.main.head,
          });
        } else {
          historySelectionRef.current = clampStoredSelectionToHistory(view.state, {
            anchor: view.state.selection.main.anchor,
            head: view.state.selection.main.head,
          });
        }
      }

      if (view.hasFocus) {
        requestAnimationFrame(() => {
          if (shouldPinToBottom) {
            scrollConversationToBottom(view);
          }
        });
      }
    }, [docModel]);

    const focusPromptForAttachments = useCallback(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }
      focusPromptRegion(view);
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
      if (files.length === 0) {
        return;
      }
      if (handleIncomingFiles(files)) {
        event.preventDefault();
      }
    }, [handleIncomingFiles]);

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
        className={`transcript-surface${isDraggingImages ? " transcript-surface--drag-over" : ""}`}
        onPasteCapture={handlePasteCapture}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="transcript-editor" ref={editorRef} />
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
      </div>
    );
  },
);
