import { useMemo } from "react";

import { TranscriptRenderer, buildDemoTranscript } from "./transcript";
import { CommandPalette } from "./CommandPalette";
import { useComposerWithPalette } from "./useComposerWithPalette";

export function App() {
  const composer = useComposerWithPalette();
  const blocks = useMemo(() => buildDemoTranscript(), []);

  return (
    <>
      <div className="bg-image" />
      <div className="bg-gradient" />
      <div className="console-shell">
        <main className="transcript-shell">
          <TranscriptRenderer blocks={blocks} />
        </main>
        <div className="composer-area">
          {composer.paletteOpen && (
            <CommandPalette
              commands={composer.filteredCommands}
              selectedIndex={composer.selectedIndex}
            />
          )}
          <section className="composer-shell">
            <span className="composer-prompt" aria-hidden="true">›</span>
            <textarea
              ref={composer.textareaRef}
              aria-label="Prompt composer"
              className="composer-input"
              placeholder="Find and fix a bug in @filename"
              rows={2}
              spellCheck={false}
              value={composer.value}
              onChange={composer.onChange}
              onKeyDown={composer.onKeyDown}
            />
          </section>
        </div>
        <footer className="status-line">gpt-5.3-codex high · 17% left · C:\Projects\GLP4</footer>
      </div>
    </>
  );
}
