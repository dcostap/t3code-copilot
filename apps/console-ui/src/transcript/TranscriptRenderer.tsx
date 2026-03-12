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
  type LineKind,
  type TranscriptBlock,
  type TranscriptImageAttachment,
} from "./TranscriptBlock";

interface PositionedLine {
  readonly from: number;
  readonly kind: LineKind;
  readonly extraClasses?: ReadonlyArray<string>;
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
  readonly separatorStart: number;
  readonly promptStart: number;
}

interface PositionedWidget {
  readonly position: number;
  readonly side: -1 | 1;
  readonly widget: WidgetType;
  readonly signature: string;
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
  onSubmit?(value: string): Promise<void> | void;
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

  for (const block of blocks) {
    const blockLines = blockToLines(block).map((line) => {
      if (!pendingUserInputHighlight || !line.userInputRef) {
        return line;
      }

      if (
        line.userInputRef.requestId !== pendingUserInputHighlight.requestId
        || line.userInputRef.questionIndex !== pendingUserInputHighlight.questionIndex
      ) {
        return line;
      }

      const extraClasses = [...(line.extraClasses ?? []), "cm-line-userInputActiveQuestion"];
      if (
        line.userInputRef.optionIndex !== undefined
        && pendingUserInputHighlight.optionIndex !== undefined
        && line.userInputRef.optionIndex === pendingUserInputHighlight.optionIndex
      ) {
        extraClasses.push("cm-line-userInputActiveOption");
      }

      return Object.assign({}, line, { extraClasses });
    });
    const startLineIndex = allLines.length;
    allLines.push(...blockLines);

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

  allLines.forEach((line, index) => {
    const from = offset;
    positioned.push({
      from,
      kind: line.kind,
      ...(line.extraClasses ? { extraClasses: line.extraClasses } : {}),
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
    const lineEnd = from + line.text.length;
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
    if (index < allLines.length - 1) {
      text += "\n";
      offset += 1;
    }
  });

  return {
    text,
    lines: positioned,
    marks,
    widgets,
    separatorStart: separatorStart === -1 ? promptStart === -1 ? text.length : promptStart : separatorStart,
    promptStart: promptStart === -1 ? text.length : promptStart,
  };
}

function buildDecorations(
  lines: ReadonlyArray<PositionedLine>,
  marks: ReadonlyArray<PositionedMark>,
  widgets: ReadonlyArray<PositionedWidget>,
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
  return `${docModel.promptStart}::${lineSignature}::${markSignature}::${widgetSignature}`;
}

function buildEditorTheme() {
  return EditorView.theme(
    {
      "&": {
        height: "auto",
        color: "#c5ccd3",
        backgroundColor: "transparent",
        fontFamily:
          '"Cascadia Mono", "Cascadia Code", "Iosevka Term", "JetBrains Mono", Consolas, monospace',
        fontSize: "15px",
      },
      ".cm-scroller": {
        overflow: "visible",
        padding: "18px 0 18px",
        lineHeight: "1.3",
      },
      ".cm-content": {
        padding: "0 22px 18px",
        caretColor: "#cfd6dd",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "#cfd6dd",
      },
      ".cm-selectionBackground": {
        backgroundColor: "rgba(153, 170, 184, 0.14) !important",
      },
      ".cm-focused": {
        outline: "none",
      },
      ".cm-line": {
        padding: "0",
        whiteSpace: "pre-wrap",
      },
      ".cm-line-meta": { color: "#5f676f" },
      ".cm-line-body": { color: "#cfd4d9" },
      ".cm-line-table": {
        color: "#d8dde2",
      },
      ".cm-line-codeFenceSeparator": {
        color: "#4f5861",
      },
      ".cm-line-codeFenceHeader": {
        color: "#8aa5c2",
        fontSize: "12px",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        paddingTop: "2px",
      },
      ".cm-line-codeFenceBody": {
        color: "#c7d0d8",
        backgroundColor: "rgba(22, 29, 36, 0.82)",
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
      ".cm-line-list": { color: "#c7ccd1" },
      ".cm-line-userPromptSeparator": {
        position: "relative",
        minHeight: "12px",
      },
      ".cm-line-userPromptSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(95, 103, 111, 0.38)",
        transform: "translateY(-50%)",
      },
      ".cm-line-workGroupSeparator": {
        position: "relative",
        minHeight: "10px",
      },
      ".cm-line-workGroupSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(95, 103, 111, 0.32)",
        transform: "translateY(-50%)",
      },
      ".cm-line-workGroupHeader": {
        color: "#9fa7af",
        letterSpacing: "0.08em",
        fontSize: "12px",
        paddingTop: "2px",
      },
      ".cm-line-workGroupFooter": {
        color: "#5f676f",
        fontSize: "12px",
        paddingTop: "2px",
      },
      ".cm-line-planSeparator": {
        position: "relative",
        minHeight: "10px",
      },
      ".cm-line-planSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(88, 130, 98, 0.34)",
        transform: "translateY(-50%)",
      },
      ".cm-line-planHeader": {
        color: "#9dc5a3",
        letterSpacing: "0.08em",
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
        minHeight: "10px",
      },
      ".cm-line-checkpointSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(108, 118, 128, 0.30)",
        transform: "translateY(-50%)",
      },
      ".cm-line-checkpointHeader": {
        color: "#a9b2bb",
        letterSpacing: "0.08em",
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
      ".cm-line-workingSeparator": {
        position: "relative",
        minHeight: "10px",
      },
      ".cm-line-workingSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(95, 103, 111, 0.28)",
        transform: "translateY(-50%)",
      },
      ".cm-line-workingHeader": {
        color: "#aeb5bc",
        letterSpacing: "0.08em",
        fontSize: "12px",
        textTransform: "uppercase",
        paddingTop: "2px",
      },
      ".cm-line-workingFooter": {
        color: "#6f7780",
        fontSize: "12px",
        paddingTop: "2px",
      },
      ".cm-line-promptInput": { color: "#d6dbe0" },
      ".cm-line-attachmentPanel": {
        paddingLeft: "2ch",
      },
      ".cm-line-promptStart": {
        position: "relative",
        paddingLeft: "2ch",
      },
      ".cm-line-promptStart::before": {
        content: '"›"',
        position: "absolute",
        left: "0",
        top: "0",
        color: "#757b82",
        userSelect: "none",
        pointerEvents: "none",
      },
      ".cm-line-promptSeparator": {
        position: "relative",
        minHeight: "12px",
      },
      ".cm-line-promptSeparator::before": {
        content: '""',
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        borderTop: "1px solid rgba(95, 103, 111, 0.42)",
        transform: "translateY(-50%)",
      },
      ".cm-line-promptSeparator.cm-line-promptSeparatorPlan": {
        minHeight: "16px",
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
      ".cm-line-status": { color: "#5f676f", fontStyle: "italic" },
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
      ".cm-line-commandExec": { color: "#a3d9a5" },
      ".cm-line-commandOutput": { color: "#7a828b" },
    },
    { dark: true },
  );
}

function getConversationScrollContainer(view: EditorView) {
  const scrollContainer = view.dom.closest(".conversation-scroll");
  return scrollContainer instanceof HTMLElement ? scrollContainer : null;
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

function resolvePromptSelection(
  state: EditorState,
  stored: StoredPromptSelection | null,
): StoredSelection {
  const promptStart = state.field(promptStartField);
  const maxOffset = Math.max(0, state.doc.length - promptStart);
  const anchorOffset = Math.min(stored?.anchorOffset ?? maxOffset, maxOffset);
  const headOffset = Math.min(stored?.headOffset ?? maxOffset, maxOffset);
  return {
    anchor: promptStart + anchorOffset,
    head: promptStart + headOffset,
  };
}

function resolvePromptSelectionForDocModel(
  docModel: TranscriptDocumentModel,
  stored: StoredPromptSelection | null,
): StoredSelection {
  const maxOffset = Math.max(0, docModel.text.length - docModel.promptStart);
  const anchorOffset = Math.min(stored?.anchorOffset ?? maxOffset, maxOffset);
  const headOffset = Math.min(stored?.headOffset ?? maxOffset, maxOffset);
  return {
    anchor: docModel.promptStart + anchorOffset,
    head: docModel.promptStart + headOffset,
  };
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

function resolveHistorySelectionForDocModel(
  docModel: TranscriptDocumentModel,
  stored: StoredSelection | null,
): StoredSelection {
  const historyLimit = Math.max(0, docModel.separatorStart - 1);
  if (!stored) {
    return { anchor: historyLimit, head: historyLimit };
  }
  return {
    anchor: Math.min(stored.anchor, historyLimit),
    head: Math.min(stored.head, historyLimit),
  };
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
    const submitDisabledRef = useRef(submitDisabled);
    const composerAttachmentsRef = useRef(composerAttachments);
    const appliedDecorationSignatureRef = useRef("");
    const dragDepthRef = useRef(0);
    const [isDraggingImages, setIsDraggingImages] = useState(false);
    const [draft, setDraft] = useState("");

    useEffect(() => {
      draftRef.current = draft;
      onSubmitRef.current = onSubmit;
      onDraftChangeRef.current = onDraftChange;
      submitDisabledRef.current = submitDisabled;
      composerAttachmentsRef.current = composerAttachments;
    }, [composerAttachments, draft, onDraftChange, onSubmit, submitDisabled]);

    const docModel = useMemo(
      () => buildTranscriptDocument(blocks, draft, interactionMode, pendingUserInputHighlight),
      [blocks, draft, interactionMode, pendingUserInputHighlight],
    );
    const initialDocModelRef = useRef(docModel);

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

            if (update.selectionSet || update.docChanged) {
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

              requestAnimationFrame(() => {
                keepCursorWithinViewportPadding(view);
              });
            },
            mousedown(_event, view) {
              updateActiveRegionFromPointer(view, _event);
              requestAnimationFrame(() => {
                keepCursorWithinViewportPadding(view);
              });
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
    }, [focusPromptRegion, redirectHistoryTypingToPrompt, storeSelectionForRegion, updateActiveRegionFromPointer]);

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

      const nextSelection =
        activeRegionRef.current === "prompt"
          ? resolvePromptSelectionForDocModel(docModel, promptSelectionRef.current)
          : resolveHistorySelectionForDocModel(docModel, historySelectionRef.current);
      const shouldPinToBottom =
        view.hasFocus
        && activeRegionRef.current === "prompt"
        && isConversationScrollNearBottom(view);

      syncingViewRef.current = true;
      view.dispatch({
        ...(!isTextStable ? { changes: { from: 0, to: view.state.doc.length, insert: docModel.text } } : {}),
        selection: isTextStable
          ? view.state.selection
          : EditorSelection.range(nextSelection.anchor, nextSelection.head),
        effects: [
          decorationsCompartment.reconfigure(
            EditorView.decorations.of(
              buildDecorations(docModel.lines, docModel.marks, docModel.widgets, docModel.promptStart),
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
          promptSelectionRef.current = storePromptSelection(view.state, nextSelection);
        } else {
          historySelectionRef.current = clampStoredSelectionToHistory(view.state, nextSelection);
        }
      }

      if (view.hasFocus) {
        requestAnimationFrame(() => {
          if (shouldPinToBottom) {
            scrollConversationToBottom(view);
            return;
          }
          keepCursorWithinViewportPadding(view);
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
