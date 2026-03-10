import { useEffect, useMemo, useRef } from "react";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";

import { buildPrototypeDocument, type PrototypeLine } from "./prototypeDocument";

function buildLineDecorations(lines: ReadonlyArray<PrototypeLine>) {
  const ranges = lines.map((line) => Decoration.line({ class: `cm-line-${line.kind}` }).range(line.from));
  return Decoration.set(ranges, true);
}

function buildEditorTheme() {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "#c5ccd3",
        backgroundColor: "transparent",
        fontFamily:
          "\"Cascadia Code\", \"Cascadia Mono\", \"Iosevka Term\", \"JetBrains Mono\", Consolas, monospace",
        fontSize: "15px",
      },
      ".cm-scroller": {
        overflow: "auto",
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
      ".cm-line-meta": {
        color: "#5f676f",
      },
      ".cm-line-body": {
        color: "#cfd4d9",
      },
      ".cm-line-list": {
        color: "#c7ccd1",
      },
      ".cm-line-toolCall": {
        color: "#5aa8f3",
      },
      ".cm-line-toolResult": {
        color: "#7a828b",
      },
      ".cm-line-diffRemoved": {
        color: "#8f7b7d",
        backgroundColor: "rgba(84, 30, 27, 0.86)",
      },
      ".cm-line-diffAdded": {
        color: "#b8c9b8",
        backgroundColor: "rgba(28, 66, 41, 0.84)",
      },
      ".cm-line-diffContext": {
        color: "#717981",
      },
      ".cm-line-divider": {
        color: "#40464d",
      },
    },
    { dark: true },
  );
}

function createPrototypeState() {
  const prototype = buildPrototypeDocument();
  return EditorState.create({
    doc: prototype.text,
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      keymap.of(defaultKeymap),
      buildEditorTheme(),
      EditorView.decorations.of(buildLineDecorations(prototype.lines)),
    ],
  });
}

function TranscriptSurface() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const prototypeState = useMemo(() => createPrototypeState(), []);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const view = new EditorView({
      state: prototypeState,
      parent: containerRef.current,
    });

    view.dispatch({
      selection: { anchor: prototypeState.doc.length },
      scrollIntoView: true,
    });

    return () => {
      view.destroy();
    };
  }, [prototypeState]);

  return <div className="transcript-surface" ref={containerRef} />;
}

export function App() {
  return (
    <>
      <div className="bg-image" />
      <div className="bg-gradient" />
      <div className="console-shell">
        <main className="transcript-shell">
          <TranscriptSurface />
        </main>
        <section className="composer-shell">
          <span className="composer-prompt" aria-hidden="true">›</span>
          <textarea
            aria-label="Prompt composer"
            className="composer-input"
            placeholder="Find and fix a bug in @filename"
            rows={2}
            spellCheck={false}
          />
        </section>
        <footer className="status-line">gpt-5.3-codex high · 17% left · C:\Projects\GLP4</footer>
      </div>
    </>
  );
}
