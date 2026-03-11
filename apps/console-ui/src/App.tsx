import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TranscriptRenderer, type TranscriptRendererHandle, threadToTranscriptBlocks } from "./transcript";
import { useConsoleData } from "./consoleData/useConsoleData";

export function App() {
  const consoleData = useConsoleData();
  const [submitError, setSubmitError] = useState<string | null>(null);
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
    </>
  );
}
