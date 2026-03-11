import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommandPalette } from "./CommandPalette";
import { TranscriptRenderer, type TranscriptRendererHandle, threadToTranscriptBlocks } from "./transcript";
import { useConsoleData } from "./consoleData/useConsoleData";
import { filterCommands, type PaletteCommand } from "./slashCommands";

interface AppPaletteCommand extends PaletteCommand {
  run(): Promise<void> | void;
}

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
  const paletteCommands = useMemo<AppPaletteCommand[]>(() => {
    const commands: AppPaletteCommand[] = [];
    const activeThread = consoleData.thread;

    for (const thread of consoleData.threads) {
      commands.push({
        id: `thread:${thread.id}`,
        label: thread.id === activeThread?.id ? `Current Thread: ${thread.title}` : `Switch Thread: ${thread.title}`,
        description: `${thread.model} · ${thread.runtimeMode} · ${thread.interactionMode}`,
        keywords: ["thread", thread.model, thread.runtimeMode, thread.interactionMode],
        run: () => {
          consoleData.setActiveThreadId(thread.id);
        },
      });
    }

    if (activeThread) {
      commands.push(
        {
          id: `runtime:${activeThread.id}:full-access`,
          label: "Set Runtime: Full Access",
          description: "Dispatch thread.runtime-mode.set for full access execution.",
          keywords: ["runtime", "permissions", "full access"],
          run: () => consoleData.setRuntimeMode("full-access"),
        },
        {
          id: `runtime:${activeThread.id}:approval-required`,
          label: "Set Runtime: Approval Required",
          description: "Dispatch thread.runtime-mode.set for approval-required execution.",
          keywords: ["runtime", "permissions", "approval"],
          run: () => consoleData.setRuntimeMode("approval-required"),
        },
        {
          id: `interaction:${activeThread.id}:default`,
          label: "Set Interaction: Default",
          description: "Dispatch thread.interaction-mode.set to default mode.",
          keywords: ["interaction", "default"],
          run: () => consoleData.setInteractionMode("default"),
        },
        {
          id: `interaction:${activeThread.id}:plan`,
          label: "Set Interaction: Plan",
          description: "Dispatch thread.interaction-mode.set to plan mode.",
          keywords: ["interaction", "plan"],
          run: () => consoleData.setInteractionMode("plan"),
        },
        {
          id: `session:${activeThread.id}:stop`,
          label: "Stop Session",
          description: "Dispatch thread.session.stop for the active thread.",
          keywords: ["session", "stop", "disconnect"],
          run: () => consoleData.stopSession(),
        },
      );

      if (activeThread.latestTurn?.state === "running" || activeThread.session?.status === "running") {
        commands.push({
          id: `turn:${activeThread.id}:interrupt`,
          label: "Interrupt Turn",
          description: "Dispatch thread.turn.interrupt for the active thread.",
          keywords: ["interrupt", "cancel", "stop turn"],
          run: () => consoleData.interruptTurn(),
        });
      }
    }

    for (const approval of consoleData.pendingApprovals) {
      commands.push(
        {
          id: `approval:${approval.requestId}:accept`,
          label: `Approve ${approval.requestKind}`,
          description: approval.detail ?? "Dispatch thread.approval.respond with accept.",
          keywords: ["approval", "accept", approval.requestKind],
          run: () => consoleData.respondToApproval(approval.requestId, "accept"),
        },
        {
          id: `approval:${approval.requestId}:decline`,
          label: `Decline ${approval.requestKind}`,
          description: approval.detail ?? "Dispatch thread.approval.respond with decline.",
          keywords: ["approval", "decline", approval.requestKind],
          run: () => consoleData.respondToApproval(approval.requestId, "decline"),
        },
      );
    }

    for (const pendingUserInput of consoleData.pendingUserInputs) {
      if (pendingUserInput.questions.length === 1) {
        const question = pendingUserInput.questions[0];
        if (!question) continue;
        for (const option of question.options) {
          commands.push({
            id: `user-input:${pendingUserInput.requestId}:${question.id}:${option.label}`,
            label: `${question.header}: ${option.label}`,
            description: option.description,
            keywords: ["user input", question.header, question.question, option.label],
            run: () =>
              consoleData.respondToUserInput(pendingUserInput.requestId, {
                [question.id]: option.label,
              }),
          });
        }
      } else {
        commands.push({
          id: `user-input:${pendingUserInput.requestId}:prompt`,
          label: "Answer Pending User Input In Prompt",
          description: "Type one answer per line in the prompt editor, in question order, then press Enter.",
          keywords: ["user input", "prompt", "answer"],
          run: () => {
            requestAnimationFrame(() => {
              transcriptRef.current?.focus();
            });
          },
        });
      }
    }

    return commands;
  }, [consoleData]);
  const filteredCommands = useMemo(
    () => filterCommands(paletteCommands, paletteQuery),
    [paletteCommands, paletteQuery],
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

  const runPaletteCommand = useCallback(async (command: PaletteCommand) => {
    const executable = command as AppPaletteCommand;
    try {
      await executable.run();
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : `Command "${command.label}" failed.`);
    } finally {
      closePalette();
    }
  }, [closePalette]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isPaletteShortcut =
        event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "a";

      if (isPaletteShortcut) {
        event.preventDefault();
        setPaletteOpen((open) => {
          const nextOpen = !open;
          if (!nextOpen) {
            setPaletteQuery("");
            setSelectedCommandIndex(0);
          }
          return nextOpen;
        });
        return;
      }

      if (paletteOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePalette();
        }
        return;
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "1") {
        event.preventDefault();
        transcriptRef.current?.focusPrompt();
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "4") {
        event.preventDefault();
        transcriptRef.current?.focusHistory();
      } else if (event.key === "Escape") {
        event.preventDefault();
        transcriptRef.current?.focusPrompt();
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
