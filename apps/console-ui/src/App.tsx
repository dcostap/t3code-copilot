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
import {
  resolvePendingUserInputAnswer,
  resolvePendingUserInputShortcut,
} from "./pendingUserInput";
import { TranscriptRenderer, type TranscriptRendererHandle, threadToTranscriptBlocks } from "./transcript";
import { useConsoleData } from "./consoleData/useConsoleData";
import { useConsoleWorkspaceSessions } from "./consoleSessions";
import { resolveWsHttpOrigin } from "./wsTransport";

interface AppPaletteCommand extends CommandPaletteCommand {
  run(): Promise<void> | void;
}

export function App() {
  const consoleData = useConsoleData();
  const workspace = useConsoleWorkspaceSessions({
    threads: consoleData.threads,
    projects: consoleData.snapshot?.projects ?? [],
    preferredThreadId: consoleData.activeThreadId,
  });
  const activeSession = workspace.activeSession;
  const getPendingUserInputs = consoleData.getPendingUserInputs;
  const getProjectForThread = consoleData.getProjectForThread;
  const getThreadEvents = consoleData.getThreadEvents;
  const isThreadTurnRunning = consoleData.isThreadTurnRunning;
  const canSubmitPromptForThread = consoleData.canSubmitPromptForThread;
  const createThread = consoleData.createThread;
  const submitPrompt = consoleData.submitPrompt;
  const respondToUserInput = consoleData.respondToUserInput;
  const setInteractionMode = consoleData.setInteractionMode;
  const interruptTurn = consoleData.interruptTurn;
  const stopSession = consoleData.stopSession;
  const createSessionFromHistory = workspace.createSessionFromHistory;
  const activateSession = workspace.activateSession;
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [composerAttachments, setComposerAttachments] = useState<ComposerImageAttachment[]>([]);
  const [composerDraft, setComposerDraft] = useState("");
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, string>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] = useState<
    Record<string, number>
  >({});
  const transcriptRef = useRef<TranscriptRendererHandle | null>(null);
  const composerAttachmentsRef = useRef(composerAttachments);
  composerAttachmentsRef.current = composerAttachments;
  const activeThreadId = workspace.activeThreadId ?? consoleData.activeThreadId;
  const activeThread = activeSession
    ? workspace.activeThread
    : (activeThreadId
        ? (consoleData.threads.find((thread) => thread.id === activeThreadId) ?? consoleData.thread)
        : consoleData.thread);
  const activeProject = activeSession
    ? workspace.activeProject
    : (activeThreadId ? getProjectForThread(activeThreadId) : consoleData.project);
  const activePendingUserInputs = useMemo(
    () => (activeThreadId ? getPendingUserInputs(activeThreadId) : []),
    [activeThreadId, getPendingUserInputs],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activeThreadTurnRunning = activeThreadId ? isThreadTurnRunning(activeThreadId) : false;
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingQuestion = activePendingUserInput?.questions[activePendingQuestionIndex] ?? null;
  const activePendingDraftAnswers = useMemo(
    () => (activePendingUserInput
      ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ?? {})
      : {}),
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingShortcut = activePendingQuestion
    ? resolvePendingUserInputShortcut(composerDraft, activePendingQuestion.options)
    : null;

  useEffect(() => {
    if (!activeThreadTurnRunning) {
      setNowIso(new Date().toISOString());
      return;
    }

    setNowIso(new Date().toISOString());
    const interval = window.setInterval(() => {
      setNowIso(new Date().toISOString());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeThreadTurnRunning]);

  useEffect(() => {
    const openRequestIds = new Set(activePendingUserInputs.map((entry) => entry.requestId));
    setPendingUserInputAnswersByRequestId((existing) =>
      Object.fromEntries(
        Object.entries(existing).filter(([requestId]) => openRequestIds.has(requestId)),
      ),
    );
    setPendingUserInputQuestionIndexByRequestId((existing) =>
      Object.fromEntries(
        Object.entries(existing).filter(([requestId]) => openRequestIds.has(requestId)),
      ),
    );
  }, [activePendingUserInputs]);

  useEffect(() => {
    if (!workspace.activeThreadId || consoleData.activeThreadId === workspace.activeThreadId) {
      return;
    }
    consoleData.setActiveThreadId(workspace.activeThreadId);
  }, [consoleData, workspace.activeThreadId]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const attachmentSnapshot = [...composerAttachments];
      try {
        if (activePendingUserInput) {
          if (attachmentSnapshot.length > 0) {
            throw new Error("Image attachments are not supported while a user-input request is pending.");
          }
          if (!activePendingQuestion) {
            throw new Error("Pending user input is missing an active question.");
          }

          const answer = resolvePendingUserInputAnswer(value, activePendingQuestion);
          if (!answer) {
            throw new Error("Type an answer or enter an option number for the active user-input question.");
          }

          const nextAnswers = {
            ...activePendingDraftAnswers,
            [activePendingQuestion.id]: answer,
          };

          if (activePendingQuestionIndex < activePendingUserInput.questions.length - 1) {
            setPendingUserInputAnswersByRequestId((existing) => ({
              ...existing,
              [activePendingUserInput.requestId]: nextAnswers,
            }));
            setPendingUserInputQuestionIndexByRequestId((existing) => ({
              ...existing,
              [activePendingUserInput.requestId]: activePendingQuestionIndex + 1,
            }));
            setSubmitError(null);
            return;
          }

          if (!activeThreadId) {
            throw new Error("No orchestration thread is available.");
          }
          await respondToUserInput(activeThreadId, activePendingUserInput.requestId, nextAnswers);
          setPendingUserInputAnswersByRequestId((existing) => ({
            ...existing,
            [activePendingUserInput.requestId]: nextAnswers,
          }));
          setPendingUserInputQuestionIndexByRequestId((existing) => ({
            ...existing,
            [activePendingUserInput.requestId]: activePendingQuestionIndex,
          }));
          setSubmitError(null);
          return;
        }

        if (!activeThreadId) {
          throw new Error("No orchestration thread is available.");
        }
        await submitPrompt({
          threadId: activeThreadId,
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
    [
      activePendingDraftAnswers,
      activePendingQuestion,
      activePendingQuestionIndex,
      activePendingUserInput,
      activeThreadId,
      composerAttachments,
      respondToUserInput,
      submitPrompt,
    ],
  );
  const attachmentPreviewBaseUrl = useMemo(resolveWsHttpOrigin, []);
  const blocks = useMemo(() => {
    if (activeThread) {
      return threadToTranscriptBlocks(activeThread, {
        resolveAttachmentPreviewUrl: (attachmentId) =>
          `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
        orchestrationEvents: getThreadEvents(activeThread.id),
        now: nowIso,
      });
    }
    if (activeSession) {
      return [{ type: "status" as const, text: "Loading session history..." }];
    }
    if (consoleData.error) {
      return [{ type: "status" as const, text: `Connection error: ${consoleData.error}` }];
    }
    return [{ type: "status" as const, text: "Waiting for orchestration snapshot..." }];
  }, [activeSession, activeThread, attachmentPreviewBaseUrl, consoleData.error, getThreadEvents, nowIso]);
  const handleCreateSession = useCallback(async () => {
    const sessionCwd =
      activeSession?.cwd ?? activeThread?.worktreePath ?? activeProject?.workspaceRoot ?? null;
    const projectId = activeSession?.projectId ?? activeProject?.id ?? null;
    if (!sessionCwd || !projectId) {
      setSubmitError("No workspace is available for a new session.");
      return;
    }
    const sessionWorktreePath =
      activeThread?.worktreePath ??
      (activeProject && sessionCwd !== activeProject.workspaceRoot ? sessionCwd : null);

    try {
      const createdAt = new Date().toISOString();
      const result = await createThread({
        projectId,
        title: "New thread",
        ...(activeThread?.model ? { model: activeThread.model } : {}),
        interactionMode: activeThread?.interactionMode ?? "default",
        branch: activeThread?.branch ?? null,
        worktreePath: sessionWorktreePath,
        createdAt,
      });
      createSessionFromHistory({
        threadId: result.threadId,
        cwd: sessionCwd,
        projectId,
        createdAt,
        pending: true,
      });
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to create a new session.");
    }
  }, [activeProject, activeSession, activeThread, createSessionFromHistory, createThread]);
  const paletteCommands = useMemo<AppPaletteCommand[]>(() => {
    const commands: AppPaletteCommand[] = [];
    const currentSession = activeSession;
    const canDispatchBackendCommands = consoleData.connectionState === "connected";

    for (const session of workspace.sessions) {
      commands.push({
        id: `session:${session.id}`,
        label:
          session.id === currentSession?.id
            ? `Current Session: ${session.title}`
            : `Switch Session: ${session.title}`,
        description: `${session.cwd} · ${session.histories.length} histories`,
        keywords: ["session", session.title, session.cwd],
        run: () => {
          activateSession(session.id);
        },
      });
    }

    if (canDispatchBackendCommands && (currentSession || activeProject)) {
      commands.push({
        id: "session:new",
        label: "New Session",
        description: "Create a new session tab with a fresh thread in the current workspace.",
        keywords: ["session", "new", "tab", "workspace"],
        run: () => handleCreateSession(),
      });
    }

    if (activeThread && canDispatchBackendCommands) {
      commands.push(
        {
          id: `interaction:${activeThread.id}:default`,
          label: "Set Interaction: Default",
          description: "Dispatch thread.interaction-mode.set to default mode.",
          keywords: ["interaction", "default"],
          run: () => setInteractionMode(activeThread.id, "default"),
        },
        {
          id: `interaction:${activeThread.id}:plan`,
          label: "Set Interaction: Plan",
          description: "Dispatch thread.interaction-mode.set to plan mode.",
          keywords: ["interaction", "plan"],
          run: () => setInteractionMode(activeThread.id, "plan"),
        },
        {
          id: `session:${activeThread.id}:stop`,
          label: "Stop Session",
          description: "Dispatch thread.session.stop for the active thread.",
          keywords: ["session", "stop", "disconnect"],
          run: () => stopSession(activeThread.id),
        },
      );

      if (activeThreadTurnRunning && !consoleData.isInterruptingTurn && !consoleData.isStoppingSession) {
        commands.push({
          id: `turn:${activeThread.id}:interrupt`,
          label: "Interrupt Turn",
          description: "Dispatch thread.turn.interrupt for the active thread.",
          keywords: ["interrupt", "cancel", "stop turn"],
          run: () => interruptTurn(activeThread.id),
        });
      }
    }

    for (const pendingUserInput of activePendingUserInputs) {
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
              activeThread
                ? respondToUserInput(activeThread.id, pendingUserInput.requestId, {
                    [question.id]: option.label,
                  })
                : Promise.resolve(),
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
  }, [
    activateSession,
    activePendingUserInputs,
    activeProject,
    activeSession,
    activeThread,
    activeThreadTurnRunning,
    consoleData.connectionState,
    consoleData.isInterruptingTurn,
    consoleData.isStoppingSession,
    consoleData.respondingUserInputRequestIds,
    handleCreateSession,
    interruptTurn,
    respondToUserInput,
    setInteractionMode,
    stopSession,
    workspace.sessions,
  ]);
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
  }, [workspace.activeThreadId]);

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
    const source = `live ${consoleData.connectionState}`;
    const provider = activeThread?.session?.providerName ?? activeThread?.model ?? "no-thread";
    const title = activeThread?.title ?? "No thread loaded";
    const cwd = workspace.activeSession?.cwd ?? activeProject?.workspaceRoot ?? "no project";
    const runtime = activeThread?.runtimeMode ?? "full-access";
    const errorText = submitError ?? consoleData.error;
    const phase = activeThreadTurnRunning
      ? "running"
      : consoleData.isPromptSubmitting
        ? "submitting"
        : "idle";
    const base = `${source} · ${phase} · ${provider} · ${runtime} · ${title} · ${cwd}`;
    return errorText ? `${base} · ${errorText}` : base;
  }, [
    activeProject?.workspaceRoot,
    activeThread?.model,
    activeThread?.runtimeMode,
    activeThread?.session?.providerName,
    activeThread?.title,
    consoleData.connectionState,
    consoleData.error,
    consoleData.isPromptSubmitting,
    activeThreadTurnRunning,
    submitError,
    workspace.activeSession?.cwd,
  ]);

  return (
    <>
      <div className="bg-image" />
      <div className="bg-gradient" />
      <div className="console-shell">
        <div className="session-tabs" role="tablist" aria-label="Workspace sessions">
          {workspace.sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              role="tab"
              aria-selected={session.id === activeSession?.id}
              className={
                session.id === activeSession?.id
                  ? "session-tab session-tab--active"
                  : "session-tab"
              }
              onClick={() => activateSession(session.id)}
              title={session.cwd}
            >
              <span className="session-tab__title">{session.title}</span>
              <span className="session-tab__meta">{session.histories.length}</span>
            </button>
          ))}
          <button
            type="button"
            className="session-tab session-tab--create"
            onClick={() => void handleCreateSession()}
            disabled={!activeProject}
            title={activeProject ? "New session" : "No workspace available"}
          >
            +
          </button>
        </div>
        <main className="conversation-scroll">
          <div className="transcript-shell">
            <TranscriptRenderer
              ref={transcriptRef}
              blocks={blocks}
              composerAttachments={composerAttachments}
              interactionMode={activeThread?.interactionMode ?? "default"}
              {...(activePendingUserInput && activePendingQuestion
                ? {
                    pendingUserInputHighlight: {
                      requestId: activePendingUserInput.requestId,
                      questionIndex: activePendingQuestionIndex,
                      ...(activePendingShortcut
                        ? { optionIndex: activePendingShortcut.optionIndex }
                        : {}),
                    },
                  }
                : {})}
              onAddImageFiles={handleAddImageFiles}
              onDraftChange={setComposerDraft}
              onRemoveImage={handleRemoveImage}
            onSubmit={handleSubmit}
              submitDisabled={!canSubmitPromptForThread(activeThreadId)}
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
