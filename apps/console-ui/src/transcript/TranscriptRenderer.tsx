import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { defaultKeymap } from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";

import { CommandPalette } from "../CommandPalette";
import { filterCommands, type SlashCommand } from "../slashCommands";
import { blockToLines, type AnnotatedLine, type LineKind, type TranscriptBlock } from "./TranscriptBlock";

interface PositionedLine {
  readonly from: number;
  readonly kind: LineKind;
}

interface TranscriptDocumentModel {
  readonly text: string;
  readonly lines: ReadonlyArray<PositionedLine>;
  readonly promptStart: number;
}

interface TranscriptRendererProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  onSubmit?(value: string): Promise<void> | void;
}

export interface TranscriptRendererHandle {
  focus(): void;
}

const CURSOR_VIEWPORT_PADDING_LINES = 7;
const PROMPT_SEPARATOR_TEXT =
  "────────────────────────────────────────────────────────────────────────────────";

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
    { text: PROMPT_SEPARATOR_TEXT, kind: "promptSeparator" },
    { text: draftLines[0] ?? "", kind: "promptInput" },
    ...draftLines.slice(1).map((line) => ({ text: line, kind: "promptInput" as const })),
  ];

  let text = "";
  let offset = 0;
  let promptStart = -1;
  const positioned: PositionedLine[] = [];

  allLines.forEach((line, index) => {
    const from = offset;
    positioned.push({ from, kind: line.kind });
    text += line.text;

    if (line.kind === "promptInput" && promptStart === -1) {
      promptStart = from;
    }

    offset += line.text.length;
    if (index < allLines.length - 1) {
      text += "\n";
      offset += 1;
    }
  });

  return { text, lines: positioned, promptStart: promptStart === -1 ? text.length : promptStart };
}

class PromptMarkerWidget extends WidgetType {
  override eq() {
    return true;
  }

  override toDOM() {
    const span = document.createElement("span");
    span.className = "cm-prompt-marker";
    span.textContent = "›";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  override ignoreEvent() {
    return true;
  }
}

function buildDecorations(lines: ReadonlyArray<PositionedLine>, promptStart: number) {
  const ranges = lines.map((line) =>
    Decoration.line({ class: `cm-line-${line.kind}` }).range(line.from),
  );
  ranges.push(
    Decoration.widget({
      widget: new PromptMarkerWidget(),
      side: -1,
    }).range(promptStart),
  );
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
          '"Cascadia Code", "Cascadia Mono", "Iosevka Term", "JetBrains Mono", Consolas, monospace',
        fontSize: "15px",
      },
      ".cm-scroller": {
        overflow: "visible",
        padding: "18px 0 18px",
        lineHeight: "1.55",
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
      ".cm-prompt-marker": {
        display: "inline-block",
        minWidth: "1ch",
        marginRight: "1ch",
        color: "#757b82",
        userSelect: "none",
        pointerEvents: "none",
      },
      ".cm-line-meta": { color: "#5f676f" },
      ".cm-line-body": { color: "#cfd4d9" },
      ".cm-line-list": { color: "#c7ccd1" },
      ".cm-line-promptInput": { color: "#d6dbe0" },
      ".cm-line-promptSeparator": { color: "rgba(95, 103, 111, 0.42)" },
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

function focusPrompt(view: EditorView) {
  const end = view.state.doc.length;
  view.dispatch({
    selection: EditorSelection.cursor(end),
  });
  view.focus();
  view.contentDOM.focus({ preventScroll: true });
}

function selectionInsidePrompt(view: EditorView) {
  const promptStart = view.state.field(promptStartField);
  const selection = view.state.selection.main;
  return selection.from >= promptStart && selection.to >= promptStart;
}

export const TranscriptRenderer = forwardRef<TranscriptRendererHandle, TranscriptRendererProps>(
  function TranscriptRenderer({ blocks, onSubmit }, ref) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const hasAutofocusedRef = useRef(false);
    const syncingViewRef = useRef(false);
    const submittingRef = useRef(false);
    const draftRef = useRef("");
    const onSubmitRef = useRef(onSubmit);
    const [draft, setDraft] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);

    const filteredCommands = useMemo(
      () => (draft.startsWith("/") ? filterCommands(draft.slice(1)) : []),
      [draft],
    );
    const paletteOpen = draft.startsWith("/") && filteredCommands.length > 0;

    const filteredCommandsRef = useRef<ReadonlyArray<SlashCommand>>([]);
    const selectedIndexRef = useRef(0);

    useEffect(() => {
      draftRef.current = draft;
      onSubmitRef.current = onSubmit;
      filteredCommandsRef.current = filteredCommands;
      selectedIndexRef.current = selectedIndex;
    }, [draft, filteredCommands, onSubmit, selectedIndex]);

    useEffect(() => {
      if (!paletteOpen) {
        setSelectedIndex(0);
      } else if (selectedIndex >= filteredCommands.length) {
        setSelectedIndex(0);
      }
    }, [filteredCommands.length, paletteOpen, selectedIndex]);

    const docModel = useMemo(() => buildTranscriptDocument(blocks, draft), [blocks, draft]);

    useImperativeHandle(ref, () => ({
      focus() {
        const view = viewRef.current;
        if (!view) {
          return;
        }

        focusPrompt(view);
        requestAnimationFrame(() => {
          keepCursorWithinViewportPadding(view);
        });
      },
    }), []);

    useEffect(() => {
      if (!editorRef.current) {
        return undefined;
      }

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
        if (value.length === 0 || submittingRef.current) {
          return true;
        }

        submittingRef.current = true;
        try {
          await onSubmitRef.current?.(value);
          replaceDraft("");
          setSelectedIndex(0);
        } finally {
          submittingRef.current = false;
        }

        return true;
      };

      const acceptSelectedCommand = () => {
        const commands = filteredCommandsRef.current;
        if (commands.length === 0) {
          return false;
        }

        const command = commands[selectedIndexRef.current];
        if (!command) {
          return false;
        }

        replaceDraft(`${command.label} `);
        setSelectedIndex(0);
        return true;
      };

      const initialState = EditorState.create({
        doc: docModel.text,
        selection: EditorSelection.cursor(docModel.text.length),
        extensions: [
          promptStartField,
          EditorState.transactionFilter.of((transaction) => {
            if (transaction.annotation(syncAnnotation) || !transaction.docChanged) {
              return transaction;
            }

            const promptStart = transaction.startState.field(promptStartField);
            let blocked = false;
            transaction.changes.iterChangedRanges((fromA) => {
              if (fromA < promptStart) {
                blocked = true;
              }
            });

            return blocked ? [] : transaction;
          }),
          keymap.of([
            {
              key: "ArrowDown",
              run() {
                const commands = filteredCommandsRef.current;
                if (draftRef.current.startsWith("/") && commands.length > 0) {
                  setSelectedIndex((index) => (index + 1) % commands.length);
                  return true;
                }
                return false;
              },
            },
            {
              key: "ArrowUp",
              run() {
                const commands = filteredCommandsRef.current;
                if (draftRef.current.startsWith("/") && commands.length > 0) {
                  setSelectedIndex((index) => (index - 1 + commands.length) % commands.length);
                  return true;
                }
                return false;
              },
            },
            {
              key: "Enter",
              run() {
                if (draftRef.current.startsWith("/") && filteredCommandsRef.current.length > 0) {
                  return acceptSelectedCommand();
                }

                void submitDraft();
                return true;
              },
            },
            {
              key: "Tab",
              run() {
                if (draftRef.current.startsWith("/") && filteredCommandsRef.current.length > 0) {
                  return acceptSelectedCommand();
                }
                return false;
              },
            },
          ]),
          keymap.of(defaultKeymap),
          EditorView.lineWrapping,
          buildEditorTheme(),
          decorationsCompartment.of(
            EditorView.decorations.of(buildDecorations(docModel.lines, docModel.promptStart)),
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
              setSelectedIndex(0);
            }

            if ((update.selectionSet || update.docChanged) && selectionInsidePrompt(update.view)) {
              requestAnimationFrame(() => {
                keepCursorWithinViewportPadding(update.view);
              });
            }
          }),
          EditorView.domEventHandlers({
            focus(_event, view) {
              if (!selectionInsidePrompt(view)) {
                const end = view.state.doc.length;
                view.dispatch({ selection: EditorSelection.cursor(end) });
              }

              requestAnimationFrame(() => {
                keepCursorWithinViewportPadding(view);
              });
            },
            mousedown(_event, view) {
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
        effects: setPromptStartEffect.of(docModel.promptStart),
        annotations: syncAnnotation.of(true),
      });

      viewRef.current = view;

      if (!hasAutofocusedRef.current) {
        hasAutofocusedRef.current = true;
        const autofocus = () => {
          focusPrompt(view);
          keepCursorWithinViewportPadding(view);
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
    }, []);

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

      const selection = view.state.selection.main;
      const previousPromptStart = currentPromptStart;
      const previousDraftLength = Math.max(0, view.state.doc.length - previousPromptStart);
      const nextDraftLength = Math.max(0, docModel.text.length - docModel.promptStart);

      const nextAnchor = docModel.promptStart + Math.min(
        Math.max(0, selection.anchor - previousPromptStart),
        nextDraftLength,
      );
      const nextHead = docModel.promptStart + Math.min(
        Math.max(0, selection.head - previousPromptStart),
        nextDraftLength,
      );

      syncingViewRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: docModel.text },
        selection: EditorSelection.range(
          previousDraftLength === 0 ? docModel.text.length : nextAnchor,
          previousDraftLength === 0 ? docModel.text.length : nextHead,
        ),
        effects: [
          decorationsCompartment.reconfigure(
            EditorView.decorations.of(buildDecorations(docModel.lines, docModel.promptStart)),
          ),
          setPromptStartEffect.of(docModel.promptStart),
        ],
        annotations: syncAnnotation.of(true),
      });
      syncingViewRef.current = false;

      if (view.hasFocus) {
        requestAnimationFrame(() => {
          keepCursorWithinViewportPadding(view);
        });
      }
    }, [docModel]);

    return (
      <div className="transcript-surface">
        <div className="transcript-editor" ref={editorRef} />
        {paletteOpen && (
          <div className="transcript-palette">
            <CommandPalette commands={filteredCommands} selectedIndex={selectedIndex} />
          </div>
        )}
      </div>
    );
  },
);
