import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TranscriptRenderer, threadToTranscriptBlocks } from "./transcript";
import { CommandPalette } from "./CommandPalette";
import { useComposerWithPalette } from "./useComposerWithPalette";
import { useConsoleData } from "./consoleData/useConsoleData";

export function App() {
  const consoleData = useConsoleData();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const handleSubmit = useCallback(
    async (value: string) => {
      try {
        await consoleData.submitPrompt(value);
        setSubmitError(null);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Failed to submit prompt.");
      }
    },
    [consoleData],
  );
  const composer = useComposerWithPalette({ onSubmit: handleSubmit });
  const blocks = useMemo(() => {
    if (consoleData.thread) {
      return threadToTranscriptBlocks(consoleData.thread);
    }
    if (consoleData.error) {
      return [{ type: "status" as const, text: `Connection error: ${consoleData.error}` }];
    }
    return [{ type: "status" as const, text: "Waiting for orchestration snapshot..." }];
  }, [consoleData.error, consoleData.thread]);
  const conversationRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = conversationRef.current;
    if (!node) return;

    node.scrollTop = node.scrollHeight;
  }, [composer.value, composer.paletteOpen]);

  const footerText = useMemo(() => {
    const source = consoleData.mode === "demo" ? "demo snapshot" : `live ${consoleData.connectionState}`;
    const provider = consoleData.thread?.session?.providerName ?? consoleData.thread?.model ?? "no-thread";
    const title = consoleData.thread?.title ?? "No thread loaded";
    const cwd = consoleData.project?.workspaceRoot ?? "no project";
    const runtime = consoleData.thread?.runtimeMode ?? "full-access";
    const errorText = submitError ?? consoleData.error;
    const base = `${source} · ${provider} · ${runtime} · ${title} · ${cwd}`;
    return errorText ? `${base} · ${errorText}` : base;
  }, [
    consoleData.connectionState,
    consoleData.error,
    consoleData.mode,
    consoleData.project?.workspaceRoot,
    consoleData.thread?.model,
    consoleData.thread?.runtimeMode,
    consoleData.thread?.session?.providerName,
    consoleData.thread?.title,
    submitError,
  ]);

  return (
    <>
      <div className="bg-image" />
      <div className="bg-gradient" />
      <div className="console-shell">
        <main className="conversation-scroll" ref={conversationRef}>
          <div className="transcript-shell">
            <TranscriptRenderer blocks={blocks} />
          </div>
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
                placeholder={
                  consoleData.mode === "demo"
                    ? "Demo mode: type a prompt and press Enter"
                    : "Live mode: send a turn to the orchestration backend"
                }
                rows={1}
                spellCheck={false}
                value={composer.value}
                onChange={composer.onChange}
                onKeyDown={composer.onKeyDown}
              />
            </section>
          </div>
        </main>
        <footer className="status-line">{footerText}</footer>
      </div>
    </>
  );
}
