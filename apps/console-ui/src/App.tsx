import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommandPalette } from "./CommandPalette";
import {
  filterCommandPaletteCommands,
  type CommandPaletteCommand,
} from "./commandPaletteCommands";
import {
  IMAGE_ATTACHMENT_SIZE_LIMIT_LABEL,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  composerImageDedupKey,
  createComposerImageAttachment,
  revokeComposerImageAttachmentPreview,
  toUploadImageAttachment,
  type ComposerImageAttachment,
} from "./composerAttachments";
import { TranscriptRenderer, type TranscriptRendererHandle, threadToTranscriptBlocks } from "./transcript";
import { useConsoleData } from "./consoleData/useConsoleData";
import { resolveWsHttpOrigin } from "./wsTransport";

interface AppPaletteCommand extends CommandPaletteCommand {
  run(): Promise<void> | void;
}

export function App() {
  const consoleData = useConsoleData();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [composerAttachments, setComposerAttachments] = useState<ComposerImageAttachment[]>([]);
  const transcriptRef = useRef<TranscriptRendererHandle | null>(null);
  const composerAttachmentsRef = useRef(composerAttachments);
  composerAttachmentsRef.current = composerAttachments;
  const handleSubmit = useCallback(
    async (value: string) => {
      const attachmentSnapshot = [...composerAttachments];
      try {
        await consoleData.submitPrompt({
          prompt: value,
          attachments: await Promise.all(attachmentSnapshot.map(toUploadImageAttachment)),
        });
        for (const attachment of attachmentSnapshot) {
          revokeComposerImageAttachmentPreview(attachment);
        }
        setComposerAttachments((existing) =>
          existing.filter(
            (attachment) => !attachmentSnapshot.some((candidate) => candidate.id === attachment.id),
          ),
        );
        setSubmitError(null);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Failed to submit prompt.");
      }
    },
    [composerAttachments, consoleData],
  );
  const attachmentPreviewBaseUrl = useMemo(resolveWsHttpOrigin, []);
  const blocks = useMemo(() => {
    if (consoleData.thread) {
      return threadToTranscriptBlocks(consoleData.thread, {
        resolveAttachmentPreviewUrl: (attachmentId) =>
          `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
      });
    }
    if (consoleData.error) {
      return [{ type: "status" as const, text: `Connection error: ${consoleData.error}` }];
    }
    return [{ type: "status" as const, text: "Waiting for orchestration snapshot..." }];
  }, [attachmentPreviewBaseUrl, consoleData.error, consoleData.thread]);
  const paletteCommands = useMemo<AppPaletteCommand[]>(() => {
    const commands: AppPaletteCommand[] = [];
    const activeThread = consoleData.thread;
    const canDispatchBackendCommands =
      consoleData.mode === "demo" || consoleData.connectionState === "connected";

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

    if (activeThread && canDispatchBackendCommands) {
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

      if (consoleData.isTurnRunning && !consoleData.isInterruptingTurn && !consoleData.isStoppingSession) {
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
      if (!canDispatchBackendCommands) {
        continue;
      }
      if (consoleData.respondingApprovalRequestIds.includes(approval.requestId)) {
        continue;
      }
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
      if (!canDispatchBackendCommands) {
        continue;
      }
      if (consoleData.respondingUserInputRequestIds.includes(pendingUserInput.requestId)) {
        continue;
      }
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
    () => filterCommandPaletteCommands(paletteCommands, paletteQuery),
    [paletteCommands, paletteQuery],
  );

  const handleAddImageFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) {
        return;
      }

      const accepted: ComposerImageAttachment[] = [];
      let nextCount = composerAttachments.length;
      const dedupKeys = new Set(
        composerAttachments.map((attachment) => composerImageDedupKey(attachment)),
      );
      let nextError: string | null = null;

      for (const file of files) {
        if (!file.type.startsWith("image/")) {
          nextError = `Unsupported file type for '${file.name}'. Attach image files only.`;
          continue;
        }
        if (file.size === 0 || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          nextError = `'${file.name}' exceeds the ${IMAGE_ATTACHMENT_SIZE_LIMIT_LABEL} attachment limit.`;
          continue;
        }
        if (nextCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          nextError = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
          break;
        }

        const attachment = createComposerImageAttachment(file);
        const dedupKey = composerImageDedupKey(attachment);
        if (dedupKeys.has(dedupKey)) {
          revokeComposerImageAttachmentPreview(attachment);
          continue;
        }

        accepted.push(attachment);
        dedupKeys.add(dedupKey);
        nextCount += 1;
      }

      if (accepted.length > 0) {
        setComposerAttachments((existing) => [...existing, ...accepted]);
      }
      if (nextError || accepted.length > 0) {
        setSubmitError(nextError);
      }
    },
    [composerAttachments],
  );

  const handleRemoveImage = useCallback((attachmentId: string) => {
    setComposerAttachments((existing) => {
      const removed = existing.find((attachment) => attachment.id === attachmentId);
      if (removed) {
        revokeComposerImageAttachmentPreview(removed);
      }
      return existing.filter((attachment) => attachment.id !== attachmentId);
    });
  }, []);

  useEffect(() => {
    setComposerAttachments((existing) => {
      for (const attachment of existing) {
        revokeComposerImageAttachmentPreview(attachment);
      }
      return [];
    });
  }, [consoleData.thread?.id]);

  useEffect(() => {
    return () => {
      for (const attachment of composerAttachmentsRef.current) {
        revokeComposerImageAttachmentPreview(attachment);
      }
    };
  }, []);

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

  const runPaletteCommand = useCallback(async (command: CommandPaletteCommand) => {
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
    const phase = consoleData.isTurnRunning
      ? "running"
      : consoleData.isPromptSubmitting
        ? "submitting"
        : "idle";
    const base = `${source} · ${phase} · ${provider} · ${runtime} · ${title} · ${cwd}`;
    return errorText ? `${base} · ${errorText}` : base;
  }, [
    consoleData.connectionState,
    consoleData.error,
    consoleData.isPromptSubmitting,
    consoleData.isTurnRunning,
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
            <TranscriptRenderer
              ref={transcriptRef}
              blocks={blocks}
              composerAttachments={composerAttachments}
              onAddImageFiles={handleAddImageFiles}
              onRemoveImage={handleRemoveImage}
              onSubmit={handleSubmit}
              submitDisabled={!consoleData.canSubmitPrompt}
            />
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
