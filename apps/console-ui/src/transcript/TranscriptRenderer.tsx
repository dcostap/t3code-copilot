import { useEffect, useMemo, useRef } from "react";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";

import { blockToLines, type AnnotatedLine, type LineKind, type TranscriptBlock } from "./TranscriptBlock";

// ── Flatten blocks into annotated lines ─────────────────────────────

interface PositionedLine {
  readonly from: number;
  readonly kind: LineKind;
}

function flattenBlocks(blocks: ReadonlyArray<TranscriptBlock>): {
  text: string;
  lines: PositionedLine[];
} {
  const allLines: AnnotatedLine[] = [];
  for (const block of blocks) {
    allLines.push(...blockToLines(block));
  }

  let text = "";
  let offset = 0;
  const positioned: PositionedLine[] = [];

  allLines.forEach((line, index) => {
    const from = offset;
    text += line.text;
    offset += line.text.length;
    positioned.push({ from, kind: line.kind });
    if (index < allLines.length - 1) {
      text += "\n";
      offset += 1;
    }
  });

  return { text, lines: positioned };
}

// ── Line decorations ────────────────────────────────────────────────

function buildLineDecorations(lines: ReadonlyArray<PositionedLine>) {
  const ranges = lines.map((line) =>
    Decoration.line({ class: `cm-line-${line.kind}` }).range(line.from),
  );
  return Decoration.set(ranges, true);
}

// ── Editor theme ────────────────────────────────────────────────────

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
        padding: "18px 0 0",
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

      // Line kind styles
      ".cm-line-meta": { color: "#5f676f" },
      ".cm-line-body": { color: "#cfd4d9" },
      ".cm-line-list": { color: "#c7ccd1" },
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

// ── React component ─────────────────────────────────────────────────

interface TranscriptRendererProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
}

export function TranscriptRenderer({ blocks }: TranscriptRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const { text, lines } = useMemo(() => flattenBlocks(blocks), [blocks]);

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return undefined;

    const state = EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        keymap.of(defaultKeymap),
        buildEditorTheme(),
        EditorView.decorations.of(buildLineDecorations(lines)),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    // Scroll to bottom
    view.dispatch({
      selection: { anchor: state.doc.length },
      scrollIntoView: true,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [text, lines]);

  return <div className="transcript-surface" ref={containerRef} />;
}
