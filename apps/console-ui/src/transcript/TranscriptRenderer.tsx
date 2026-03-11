import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
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
import { Decoration, EditorView, keymap } from "@codemirror/view";

import { blockToLines, type AnnotatedLine, type LineKind, type TranscriptBlock } from "./TranscriptBlock";

interface PositionedLine {
  readonly from: number;
  readonly kind: LineKind;
}

interface TranscriptDocumentModel {
  readonly text: string;
  readonly lines: ReadonlyArray<PositionedLine>;
  readonly separatorStart: number;
  readonly promptStart: number;
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
  readonly submitDisabled?: boolean;
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

function flattenBlocks(blocks: ReadonlyArray<TranscriptBlock>): AnnotatedLine[] {
  const allLines: AnnotatedLine[] = [];
  for (const block of blocks) {
    allLines.push(...blockToLines(block));
  }
  return allLines;
}

function buildTranscriptDocument(
  blocks: ReadonlyArray<TranscriptBlock>,
  draft: string,
): TranscriptDocumentModel {
  const historyLines = flattenBlocks(blocks);
  const draftLines = draft.length > 0 ? draft.split("\n") : [""];
  const allLines: AnnotatedLine[] = [
    ...historyLines,
    { text: "", kind: "promptSeparator" },
    { text: draftLines[0] ?? "", kind: "promptInput" },
    ...draftLines.slice(1).map((line) => ({ text: line, kind: "promptInput" as const })),
  ];

  let text = "";
  let offset = 0;
  let separatorStart = -1;
  let promptStart = -1;
  const positioned: PositionedLine[] = [];

  allLines.forEach((line, index) => {
    const from = offset;
    positioned.push({ from, kind: line.kind });
    text += line.text;

    if (line.kind === "promptSeparator" && separatorStart === -1) {
      separatorStart = from;
    }

    if (line.kind === "promptInput" && promptStart === -1) {
      promptStart = from;
    }

    offset += line.text.length;
    if (index < allLines.length - 1) {
      text += "\n";
      offset += 1;
    }
  });

  return {
    text,
    lines: positioned,
    separatorStart: separatorStart === -1 ? promptStart === -1 ? text.length : promptStart : separatorStart,
    promptStart: promptStart === -1 ? text.length : promptStart,
  };
}

function buildDecorations(lines: ReadonlyArray<PositionedLine>, promptStart: number) {
  const ranges = lines.map((line) =>
    Decoration.line({ class: `cm-line-${line.kind}` }).range(line.from),
  );
  ranges.push(Decoration.line({ class: "cm-line-promptStart" }).range(promptStart));
  return Decoration.set(ranges, true);
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
      ".cm-line-list": { color: "#c7ccd1" },
      ".cm-line-promptInput": { color: "#d6dbe0" },
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
      ".cm-line-commandExec": { color: "#a3d9a5" },
      ".cm-line-commandOutput": { color: "#7a828b" },
      ".cm-line-planText": { color: "#b8bfc7" },
    },
    { dark: true },
  );
}

function getConversationScrollContainer(view: EditorView) {
  const scrollContainer = view.dom.closest(".conversation-scroll");
  return scrollContainer instanceof HTMLElement ? scrollContainer : null;
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
  function TranscriptRenderer({ blocks, onSubmit, submitDisabled = false }, ref) {
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
    const submitDisabledRef = useRef(submitDisabled);
    const [draft, setDraft] = useState("");

    useEffect(() => {
      draftRef.current = draft;
      onSubmitRef.current = onSubmit;
      submitDisabledRef.current = submitDisabled;
    }, [draft, onSubmit, submitDisabled]);

    const docModel = useMemo(() => buildTranscriptDocument(blocks, draft), [blocks, draft]);
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
        if (value.length === 0 || submittingRef.current || submitDisabledRef.current) {
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
              buildDecorations(initialDocModel.lines, initialDocModel.promptStart),
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
    }, [focusPromptRegion, storeSelectionForRegion, updateActiveRegionFromPointer]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }

      const currentText = view.state.doc.toString();
      const currentPromptStart = view.state.field(promptStartField);
      if (currentText === docModel.text && currentPromptStart === docModel.promptStart) {
        return;
      }

      const nextSelection =
        activeRegionRef.current === "prompt"
          ? resolvePromptSelectionForDocModel(docModel, promptSelectionRef.current)
          : resolveHistorySelectionForDocModel(docModel, historySelectionRef.current);

      syncingViewRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: docModel.text },
        selection: EditorSelection.range(nextSelection.anchor, nextSelection.head),
        effects: [
          decorationsCompartment.reconfigure(
            EditorView.decorations.of(buildDecorations(docModel.lines, docModel.promptStart)),
          ),
          setPromptStartEffect.of(docModel.promptStart),
        ],
        annotations: syncAnnotation.of(true),
      });
      syncingViewRef.current = false;

      if (activeRegionRef.current === "prompt") {
        promptSelectionRef.current = storePromptSelection(view.state, nextSelection);
      } else {
        historySelectionRef.current = clampStoredSelectionToHistory(view.state, nextSelection);
      }

      if (view.hasFocus) {
        requestAnimationFrame(() => {
          keepCursorWithinViewportPadding(view);
        });
      }
    }, [docModel]);

    return (
      <div className="transcript-surface">
        <div className="transcript-editor" ref={editorRef} />
      </div>
    );
  },
);
