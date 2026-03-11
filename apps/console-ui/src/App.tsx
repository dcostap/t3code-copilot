import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommandPalette } from "./CommandPalette";
import { TranscriptRenderer, type TranscriptRendererHandle, threadToTranscriptBlocks } from "./transcript";
import { useConsoleData } from "./consoleData/useConsoleData";
import { filterCommands, type PaletteCommand } from "./slashCommands";

export function App() {
  const consoleData = useConsoleData();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const transcriptRef = useRef<TranscriptRendererHandle | null>(null);
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
  const blocks = useMemo(() => {
    if (consoleData.thread) {
      return threadToTranscriptBlocks(consoleData.thread);
    }
    if (consoleData.error) {
      return [{ type: "status" as const, text: `Connection error: ${consoleData.error}` }];
    }
    return [{ type: "status" as const, text: "Waiting for orchestration snapshot..." }];
  }, [consoleData.error, consoleData.thread]);
  const filteredCommands = useMemo(
    () => filterCommands(paletteQuery),
    [paletteQuery],
  );

  useEffect(() => {
    const focusTranscript = () => {
      transcriptRef.current?.focus();
    };

    focusTranscript();
    requestAnimationFrame(() => {
      focusTranscript();
      setTimeout(focusTranscript, 0);
      setTimeout(focusTranscript, 40);
    });
  }, []);

  useEffect(() => {
    if (selectedCommandIndex < filteredCommands.length) {
      return;
    }

    setSelectedCommandIndex(0);
  }, [filteredCommands.length, selectedCommandIndex]);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteQuery("");
    setSelectedCommandIndex(0);
    requestAnimationFrame(() => {
      transcriptRef.current?.focus();
    });
  }, []);

  const runPaletteCommand = useCallback((command: PaletteCommand) => {
    setSubmitError(`Command "${command.label}" is not wired yet.`);
    closePalette();
  }, [closePalette]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setPaletteOpen((open) => {
          const nextOpen = !open;
          if (!nextOpen) {
            setPaletteQuery("");
            setSelectedCommandIndex(0);
          }
          return nextOpen;
        });
      } else if (event.key === "Escape" && paletteOpen) {
        event.preventDefault();
        closePalette();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePalette, paletteOpen]);

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
        <main className="conversation-scroll">
          <div className="transcript-shell">
            <TranscriptRenderer ref={transcriptRef} blocks={blocks} onSubmit={handleSubmit} />
          </div>
        </main>
        <footer className="status-line">{footerText}</footer>
      </div>
      <CommandPalette
        open={paletteOpen}
        query={paletteQuery}
        commands={filteredCommands}
        selectedIndex={selectedCommandIndex}
        onClose={closePalette}
        onQueryChange={setPaletteQuery}
        onSelectedIndexChange={setSelectedCommandIndex}
        onRun={runPaletteCommand}
      />
    </>
  );
}
