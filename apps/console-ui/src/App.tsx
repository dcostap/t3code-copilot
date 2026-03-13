import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type OrchestrationThread,
  type ProviderKind,
} from "@t3tools/contracts";
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

function isDesktopBridgeAvailable() {
  if (typeof window === "undefined") {
    return false;
  }
  return typeof window.desktopBridge !== "undefined";
}

function resolveProviderFromThread(providerName: string | null | undefined): ProviderKind | null {
  if (providerName === "codex" || providerName === "copilot") {
    return providerName;
  }
  return null;
}

function buildScrollDebugBlocks() {
  return Array.from({ length: 24 }, (_, index) => {
    const section = index + 1;
    return [
      {
        type: "user-message" as const,
        text: `Scroll debug prompt ${section}: test plain user/assistant transcript flow without structured widgets yet.`,
      },
      {
        type: "assistant-text" as const,
        streaming: false,
        text:
          `Scroll debug section ${section}\n` +
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789  ─ │ ┌ ┐ └ ┘\n" +
          "The quick brown fox jumps over the lazy dog. Smooth wheel scrolling should feel uniform here.\n" +
          `Line ${section}.1  ·  Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.\n` +
          `Line ${section}.2  ·  Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.\n` +
          `Line ${section}.3  ·  Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.\n` +
          `Line ${section}.4  ·  Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt.`,
      },
      {
        type: "assistant-text" as const,
        streaming: false,
        text: `Unicode sample ${section}: · • ◦ ○ ◉ ◎ □ ▣ ░ ▒ ▓ → ← ↑ ↓`,
      },
    ];
  }).flat();
}

export function App() {
  const isDesktop = useMemo(isDesktopBridgeAvailable, []);
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
  const setThreadModel = consoleData.setThreadModel;
  const setThreadReasoningEffort = consoleData.setThreadReasoningEffort;
  const setInteractionMode = consoleData.setInteractionMode;
  const interruptTurn = consoleData.interruptTurn;
  const stopSession = consoleData.stopSession;
  const createSessionFromHistory = workspace.createSessionFromHistory;
  const activateSession = workspace.activateSession;
  const closeSession = workspace.closeSession;
  const activatePane = workspace.activatePane;
  const closePane = workspace.closePane;
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const [_submitError, setSubmitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [composerAttachmentsByPaneId, setComposerAttachmentsByPaneId] = useState<
    Record<string, ReadonlyArray<ComposerImageAttachment>>
  >({});
  const [composerDraftByPaneId, setComposerDraftByPaneId] = useState<Record<string, string>>({});
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, string>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] = useState<
    Record<string, number>
  >({});
  const paneRefs = useRef<Record<string, TranscriptRendererHandle | null>>({});
  const composerAttachmentsRef = useRef(composerAttachmentsByPaneId);
  composerAttachmentsRef.current = composerAttachmentsByPaneId;
  const activePane = workspace.activePane;
  const activePaneId = activePane?.id ?? null;
  const activeHistory = useMemo(() => {
    if (!activeSession || !activePane?.historyId) {
      return null;
    }
    return activeSession.histories.find((history) => history.id === activePane.historyId) ?? null;
  }, [activePane?.historyId, activeSession]);
  const activeThreadId = activeSession ? workspace.activeThreadId : consoleData.activeThreadId;
  const activeThread = activeSession
    ? workspace.activeThread
    : (activeThreadId
        ? (consoleData.threads.find((thread) => thread.id === activeThreadId) ?? consoleData.thread)
        : consoleData.thread);
  const activeProject = activeSession
    ? workspace.activeProject
    : (activeThreadId ? getProjectForThread(activeThreadId) : consoleData.project);
  const composerDraft = activePaneId ? (composerDraftByPaneId[activePaneId] ?? "") : "";
  const composerAttachments = activePaneId ? [...(composerAttachmentsByPaneId[activePaneId] ?? [])] : [];
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
  const activeProvider =
    activeHistory?.debugPreset === "scroll"
      ? null
      : activeHistory?.preferredProvider ??
        resolveProviderFromThread(activeThread?.session?.providerName) ??
        null;
  const activeReasoningEffort =
    activeProvider === "codex"
      ? (activeThread?.modelOptions?.codex?.reasoningEffort ?? null)
      : activeProvider === "copilot"
        ? (activeThread?.modelOptions?.copilot?.reasoningEffort ?? null)
        : null;
  const activeReasoningOptions = useMemo(() => {
    if (!activeProvider || !activeThread) {
      return [];
    }

    const providerStatus = consoleData.serverConfig?.providers.find(
      (provider) => provider.provider === activeProvider,
    );
    const activeModelStatus = providerStatus?.models?.find((model) => model.id === activeThread.model);

    if (activeModelStatus) {
      if (!activeModelStatus.supportsReasoningEffort) {
        return [];
      }
      return activeModelStatus.supportedReasoningEfforts ??
        REASONING_EFFORT_OPTIONS_BY_PROVIDER[activeProvider];
    }

    return REASONING_EFFORT_OPTIONS_BY_PROVIDER[activeProvider];
  }, [activeProvider, activeThread, consoleData.serverConfig?.providers]);
  const activeDefaultReasoningEffort = useMemo(() => {
    if (!activeProvider || !activeThread) {
      return null;
    }

    const providerStatus = consoleData.serverConfig?.providers.find(
      (provider) => provider.provider === activeProvider,
    );
    const activeModelStatus = providerStatus?.models?.find((model) => model.id === activeThread.model);
    return activeModelStatus?.defaultReasoningEffort ?? null;
  }, [activeProvider, activeThread, consoleData.serverConfig?.providers]);

  useEffect(() => {
    if (!activeThreadTurnRunning) {
      setNowIso(new Date().toISOString());
      return;
    }

    setNowIso(new Date().toISOString());
    let animationFrameId = 0;
    let lastCommittedAt = performance.now();

    const tick = (frameAt: number) => {
      if (frameAt - lastCommittedAt >= 45) {
        lastCommittedAt = frameAt;
        setNowIso(new Date().toISOString());
      }
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [activeThreadTurnRunning]);

  useEffect(() => {
    const openRequestIds = new Set(
      (activeSession
        ? activeSession.panes.flatMap((pane) => {
            const history = activeSession.histories.find((candidate) => candidate.id === pane.historyId);
            return history ? getPendingUserInputs(history.threadId) : [];
          })
        : activePendingUserInputs).map((entry) => entry.requestId),
    );
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
  }, [activePendingUserInputs, activeSession, getPendingUserInputs]);

  const resolveModelForProvider = useCallback((preferredProvider: ProviderKind, projectId: string) => {
    const providerStatus = consoleData.serverConfig?.providers.find(
      (provider) => provider.provider === preferredProvider,
    );
    const availableModelIds = new Set((providerStatus?.models ?? []).map((model) => model.id));
    const isAvailableModel = (model: string | null | undefined) =>
      typeof model === "string" &&
      model.length > 0 &&
      (availableModelIds.size === 0 || availableModelIds.has(model));

    const matchingProviderThread = [...consoleData.threads]
      .filter((thread) =>
        thread.projectId === projectId &&
        resolveProviderFromThread(thread.session?.providerName) === preferredProvider &&
        isAvailableModel(thread.model),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

    return (
      matchingProviderThread?.model ??
      providerStatus?.models?.[0]?.id ??
      DEFAULT_MODEL_BY_PROVIDER[preferredProvider]
    );
  }, [consoleData.serverConfig?.providers, consoleData.threads]);

  useEffect(() => {
    if (!workspace.activeThreadId || consoleData.activeThreadId === workspace.activeThreadId) {
      return;
    }
    consoleData.setActiveThreadId(workspace.activeThreadId);
  }, [consoleData, workspace.activeThreadId]);

  const focusActivePanePrompt = useCallback(() => {
    if (!activePaneId) {
      return;
    }
    paneRefs.current[activePaneId]?.focusPrompt();
  }, [activePaneId]);

  const activatePaneAndFocus = useCallback((paneId: string) => {
    activatePane(paneId);
    requestAnimationFrame(() => {
      paneRefs.current[paneId]?.focusPrompt();
    });
  }, [activatePane]);

  const setComposerDraftForPane = useCallback((paneId: string, value: string) => {
    setComposerDraftByPaneId((existing) =>
      existing[paneId] === value ? existing : { ...existing, [paneId]: value },
    );
  }, []);

  const handleAddImageFilesForPane = useCallback(
    (paneId: string, files: ReadonlyArray<File>) => {
      if (files.length === 0) {
        return;
      }

      const existingAttachments = [...(composerAttachmentsByPaneId[paneId] ?? [])];
      const accepted: ComposerImageAttachment[] = [];
      let nextCount = existingAttachments.length;
      const dedupKeys = new Set(
        existingAttachments.map((attachment) => composerImageDedupKey(attachment)),
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
        setComposerAttachmentsByPaneId((existing) => ({
          ...existing,
          [paneId]: [...(existing[paneId] ?? []), ...accepted],
        }));
      }
      if (nextError || accepted.length > 0) {
        setSubmitError(nextError);
      }
    },
    [composerAttachmentsByPaneId],
  );

  const handleRemoveImageForPane = useCallback((paneId: string, attachmentId: string) => {
    setComposerAttachmentsByPaneId((existing) => {
      const current = existing[paneId] ?? [];
      const removed = current.find((attachment) => attachment.id === attachmentId);
      if (removed) {
        revokeComposerImageAttachmentPreview(removed);
      }
      return {
        ...existing,
        [paneId]: current.filter((attachment) => attachment.id !== attachmentId),
      };
    });
  }, []);

  const handleSubmit = useCallback(
    async (
      paneId: string,
      threadId: string | null,
      preferredProvider: ProviderKind | null,
      pendingUserInput: typeof activePendingUserInput,
      activeQuestion: typeof activePendingQuestion,
      activeQuestionIndex: number,
      draftAnswers: Record<string, string>,
      value: string,
    ) => {
      const attachmentSnapshot = [...(composerAttachmentsByPaneId[paneId] ?? [])];
      try {
        if (pendingUserInput) {
          if (attachmentSnapshot.length > 0) {
            throw new Error("Image attachments are not supported while a user-input request is pending.");
          }
          if (!activeQuestion) {
            throw new Error("Pending user input is missing an active question.");
          }

          const answer = resolvePendingUserInputAnswer(value, activeQuestion);
          if (!answer) {
            throw new Error("Type an answer or enter an option number for the active user-input question.");
          }

          const nextAnswers = {
            ...draftAnswers,
            [activeQuestion.id]: answer,
          };

          if (activeQuestionIndex < pendingUserInput.questions.length - 1) {
            setPendingUserInputAnswersByRequestId((existing) => ({
              ...existing,
              [pendingUserInput.requestId]: nextAnswers,
            }));
            setPendingUserInputQuestionIndexByRequestId((existing) => ({
              ...existing,
              [pendingUserInput.requestId]: activeQuestionIndex + 1,
            }));
            setSubmitError(null);
            return;
          }

          if (!threadId) {
            throw new Error("No orchestration thread is available.");
          }
          await respondToUserInput(threadId, pendingUserInput.requestId, nextAnswers);
          setPendingUserInputAnswersByRequestId((existing) => ({
            ...existing,
            [pendingUserInput.requestId]: nextAnswers,
          }));
          setPendingUserInputQuestionIndexByRequestId((existing) => ({
            ...existing,
            [pendingUserInput.requestId]: activeQuestionIndex,
          }));
          setSubmitError(null);
          return;
        }

        if (!threadId) {
          throw new Error("No orchestration thread is available.");
        }
        await submitPrompt({
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          prompt: value,
          attachments: await Promise.all(attachmentSnapshot.map(toUploadImageAttachment)),
        });
        for (const attachment of attachmentSnapshot) {
          revokeComposerImageAttachmentPreview(attachment);
        }
        setComposerAttachmentsByPaneId((existing) => ({
          ...existing,
          [paneId]: (existing[paneId] ?? []).filter(
            (attachment) => !attachmentSnapshot.some((candidate) => candidate.id === attachment.id),
          ),
        }));
        setSubmitError(null);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Failed to submit prompt.");
      }
    },
    [
      composerAttachmentsByPaneId,
      respondToUserInput,
      submitPrompt,
    ],
  );
  const attachmentPreviewBaseUrl = useMemo(resolveWsHttpOrigin, []);
  const activeThreadNow = activeThreadTurnRunning ? nowIso : undefined;
  const blocks = useMemo(() => {
    if (activeHistory?.debugPreset === "scroll") {
      return buildScrollDebugBlocks();
    }
    if (activeThread) {
      return threadToTranscriptBlocks(activeThread, {
        resolveAttachmentPreviewUrl: (attachmentId) =>
          `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
        orchestrationEvents: getThreadEvents(activeThread.id),
        ...(activeThreadNow ? { now: activeThreadNow } : {}),
      });
    }
    if (activeSession) {
      return [{ type: "status" as const, text: "Loading session history..." }];
    }
    if (consoleData.error) {
      return [{ type: "status" as const, text: `Connection error: ${consoleData.error}` }];
    }
    return [{ type: "status" as const, text: "Waiting for orchestration snapshot..." }];
  }, [activeHistory?.debugPreset, activeSession, activeThread, activeThreadNow, attachmentPreviewBaseUrl, consoleData.error, getThreadEvents]);

  const handleCreateScrollDebugSession = useCallback(() => {
    const sessionCwd =
      activeSession?.cwd ?? activeThread?.worktreePath ?? activeProject?.workspaceRoot ?? null;
    const projectId = activeSession?.projectId ?? activeProject?.id ?? null;
    if (!sessionCwd || !projectId) {
      setSubmitError("No workspace is available for a scroll debug session.");
      return;
    }

    createSessionFromHistory({
      threadId: `debug:scroll:${crypto.randomUUID()}` as OrchestrationThread["id"],
      preferredProvider: "codex",
      cwd: sessionCwd,
      projectId,
      createdAt: new Date().toISOString(),
      debugPreset: "scroll",
    });
  }, [activeProject, activeSession, activeThread?.worktreePath, createSessionFromHistory]);

  const handleCreateSession = useCallback(async (preferredProvider: ProviderKind) => {
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
        model: resolveModelForProvider(preferredProvider, projectId),
        interactionMode: activeThread?.interactionMode ?? "default",
        branch: activeThread?.branch ?? null,
        worktreePath: sessionWorktreePath,
        createdAt,
      });
      createSessionFromHistory({
        threadId: result.threadId,
        preferredProvider,
        cwd: sessionCwd,
        projectId,
        createdAt,
        pending: true,
      });
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to create a new session.");
    }
  }, [activeProject, activeSession, activeThread, createSessionFromHistory, createThread, resolveModelForProvider]);
  const handleSplitActivePane = useCallback(async (preferredProvider: ProviderKind) => {
    if (!activeSession) {
      setSubmitError("No active session is available to split.");
      return;
    }
    if (activeSession.panes.length >= 2) {
      setSubmitError("This session is already split.");
      return;
    }

    const sessionCwd = activeSession.cwd;
    const projectId = activeSession.projectId;
    const sessionWorktreePath =
      activeThread?.worktreePath ??
      (activeProject && sessionCwd !== activeProject.workspaceRoot ? sessionCwd : null);

    try {
      const createdAt = new Date().toISOString();
      const result = await createThread({
        projectId,
        title: "New thread",
        model: resolveModelForProvider(preferredProvider, projectId),
        interactionMode: activeThread?.interactionMode ?? "default",
        branch: activeThread?.branch ?? null,
        worktreePath: sessionWorktreePath,
        createdAt,
      });
      workspace.splitActivePane({
        threadId: result.threadId,
        preferredProvider,
        cwd: sessionCwd,
        projectId,
        createdAt,
        pending: true,
      });
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to split the active pane.");
    }
  }, [activeProject, activeSession, activeThread, createThread, resolveModelForProvider, workspace]);
  const paneViews = useMemo(() => {
    if (!activeSession) {
      return [];
    }

    return activeSession.panes.map((pane, index) => {
      const history = activeSession.histories.find((candidate) => candidate.id === pane.historyId) ?? null;
      const threadId = history?.debugPreset === "scroll" ? null : (history?.threadId ?? null);
      const thread =
        threadId ? (consoleData.threads.find((candidate) => candidate.id === threadId) ?? null) : null;
      const pendingUserInputs = threadId ? getPendingUserInputs(threadId) : [];
      const pendingUserInput = pendingUserInputs[0] ?? null;
      const pendingQuestionIndex = pendingUserInput
        ? (pendingUserInputQuestionIndexByRequestId[pendingUserInput.requestId] ?? 0)
        : 0;
      const pendingQuestion = pendingUserInput?.questions[pendingQuestionIndex] ?? null;
      const draft = composerDraftByPaneId[pane.id] ?? "";
      const pendingShortcut = pendingQuestion
        ? resolvePendingUserInputShortcut(draft, pendingQuestion.options)
        : null;
      const paneNow = threadId && isThreadTurnRunning(threadId) ? nowIso : undefined;
      const blocks = history?.debugPreset === "scroll"
        ? buildScrollDebugBlocks()
        : thread
          ? threadToTranscriptBlocks(thread, {
            resolveAttachmentPreviewUrl: (attachmentId) =>
              `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
            orchestrationEvents: getThreadEvents(thread.id),
            ...(paneNow ? { now: paneNow } : {}),
          })
          : [{
            type: "status" as const,
            text: history?.pending ? "Loading session history..." : "History unavailable in this session.",
          }];

      return {
        pane,
        history,
        threadId,
        thread,
        isActive: pane.id === activeSession.activePaneId,
        index,
        blocks,
        draft,
        attachments: [...(composerAttachmentsByPaneId[pane.id] ?? [])],
        pendingUserInput,
        pendingQuestionIndex,
        pendingQuestion,
        draftAnswers: pendingUserInput
          ? (pendingUserInputAnswersByRequestId[pendingUserInput.requestId] ?? {})
          : {},
        pendingShortcut,
      };
    });
  }, [
    activeSession,
    attachmentPreviewBaseUrl,
    composerAttachmentsByPaneId,
    composerDraftByPaneId,
    consoleData.threads,
    getPendingUserInputs,
    getThreadEvents,
    isThreadTurnRunning,
    nowIso,
    pendingUserInputAnswersByRequestId,
    pendingUserInputQuestionIndexByRequestId,
  ]);
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
      commands.push(
        {
          id: "session:new:codex",
          label: "New Session: Codex",
          description: "Create a new session tab with a fresh Codex thread in the current workspace.",
          keywords: ["session", "new", "tab", "workspace", "codex"],
          run: () => handleCreateSession("codex"),
        },
        {
          id: "session:new:copilot",
          label: "New Session: Copilot",
          description: "Create a new session tab with a fresh Copilot thread in the current workspace.",
          keywords: ["session", "new", "tab", "workspace", "copilot"],
          run: () => handleCreateSession("copilot"),
        },
      );
    }

    if (currentSession || activeProject) {
      commands.push({
        id: "session:new:scroll-debug",
        label: "New Session: Scroll Debug",
        description: "Open a local-only debug tab with plain transcript text for scroll testing.",
        keywords: ["session", "new", "debug", "scroll", "plain", "transcript"],
        run: handleCreateScrollDebugSession,
      });
    }

    if (canDispatchBackendCommands && currentSession && currentSession.panes.length < 2) {
      commands.push(
        {
          id: `session:${currentSession.id}:split:codex`,
          label: "Split Active Pane: Codex",
          description: "Create a second pane in the current session with a fresh Codex thread.",
          keywords: ["split", "pane", "parallel", "session", "codex"],
          run: () => handleSplitActivePane("codex"),
        },
        {
          id: `session:${currentSession.id}:split:copilot`,
          label: "Split Active Pane: Copilot",
          description: "Create a second pane in the current session with a fresh Copilot thread.",
          keywords: ["split", "pane", "parallel", "session", "copilot"],
          run: () => handleSplitActivePane("copilot"),
        },
      );
    }

    if (currentSession && currentSession.panes.length > 1) {
      currentSession.panes.forEach((pane, index) => {
        commands.push({
          id: `pane:${pane.id}:focus`,
          label:
            pane.id === currentSession.activePaneId
              ? `Current Pane: ${index + 1}`
              : `Focus Pane: ${index + 1}`,
          description: "Focus this pane and route transcript actions to it.",
          keywords: ["pane", "focus", `${index + 1}`],
          run: () => {
            activatePaneAndFocus(pane.id);
          },
        });
      });
      commands.push({
        id: `pane:${currentSession.activePaneId}:close`,
        label: "Close Active Pane",
        description: "Remove the current split without deleting its history.",
        keywords: ["pane", "close", "split"],
        run: () => {
              if (currentSession.activePaneId) {
                closePane(currentSession.activePaneId);
              }
            },
          });
        }

    if (activeThread && canDispatchBackendCommands) {
      if (activeProvider) {
        for (const modelOption of MODEL_OPTIONS_BY_PROVIDER[activeProvider]) {
          commands.push({
            id: `model:${activeThread.id}:${modelOption.slug}`,
            label:
              activeThread.model === modelOption.slug
                ? `Current Model: ${modelOption.name}`
                : `Set Model: ${modelOption.name}`,
            description: `${activeProvider} · ${modelOption.slug}`,
            keywords: ["model", activeProvider, modelOption.name, modelOption.slug],
            run: () => setThreadModel(activeThread.id, activeProvider, modelOption.slug),
          });
        }

        if (activeReasoningOptions.length > 0) {
          commands.push({
            id: `reasoning:${activeThread.id}:default`,
            label:
              activeReasoningEffort === null
                ? "Current Reasoning: Default"
                : "Set Reasoning: Default",
            description: `${activeProvider} · use the model default reasoning effort`,
            keywords: ["reasoning", "default", activeProvider],
            run: () => setThreadReasoningEffort(activeThread.id, activeProvider, null),
          });

          for (const reasoningOption of activeReasoningOptions) {
            commands.push({
              id: `reasoning:${activeThread.id}:${reasoningOption}`,
              label:
                activeReasoningEffort === reasoningOption
                  ? `Current Reasoning: ${reasoningOption}`
                  : `Set Reasoning: ${reasoningOption}`,
              description: `${activeProvider} · ${activeThread.model}`,
              keywords: ["reasoning", activeProvider, reasoningOption, activeThread.model],
              run: () =>
                setThreadReasoningEffort(activeThread.id, activeProvider, reasoningOption),
            });
          }
        }
      }

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
              focusActivePanePrompt();
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
    handleCreateScrollDebugSession,
    handleCreateSession,
    handleSplitActivePane,
    interruptTurn,
    activatePaneAndFocus,
    activeProvider,
    activeReasoningEffort,
    activeReasoningOptions,
    focusActivePanePrompt,
    respondToUserInput,
    setThreadModel,
    setThreadReasoningEffort,
    setInteractionMode,
    stopSession,
    closePane,
    workspace.sessions,
  ]);
  const filteredCommands = useMemo(
    () => filterCommandPaletteCommands(paletteCommands, paletteQuery),
    [paletteCommands, paletteQuery],
  );

  useEffect(() => {
    const livePaneIds = new Set(
      workspace.sessions.flatMap((session) => session.panes.map((pane) => pane.id)),
    );
    setComposerAttachmentsByPaneId((existing) => {
      let changed = false;
      const nextEntries = Object.entries(existing)
        .filter(([paneId]) => livePaneIds.has(paneId))
        .map(([paneId, attachments]) => {
          if (livePaneIds.has(paneId)) {
            return [paneId, attachments] as const;
          }
          changed = true;
          attachments.forEach(revokeComposerImageAttachmentPreview);
          return null;
        })
        .filter((entry): entry is readonly [string, ReadonlyArray<ComposerImageAttachment>] => entry !== null);
      if (!changed && nextEntries.length === Object.keys(existing).length) {
        return existing;
      }
      Object.entries(existing).forEach(([paneId, attachments]) => {
        if (!livePaneIds.has(paneId)) {
          changed = true;
          attachments.forEach(revokeComposerImageAttachmentPreview);
        }
      });
      return Object.fromEntries(nextEntries);
    });
    setComposerDraftByPaneId((existing) =>
      Object.fromEntries(
        Object.entries(existing).filter(([paneId]) => livePaneIds.has(paneId)),
      ),
    );
  }, [workspace.sessions]);

  useEffect(() => {
    return () => {
      Object.values(composerAttachmentsRef.current).flat().forEach(revokeComposerImageAttachmentPreview);
    };
  }, []);

  useEffect(() => {
    const focusTranscript = () => {
      focusActivePanePrompt();
    };

    focusTranscript();
    requestAnimationFrame(() => {
      focusTranscript();
      setTimeout(focusTranscript, 0);
      setTimeout(focusTranscript, 40);
    });
  }, [focusActivePanePrompt]);

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
      focusActivePanePrompt();
    });
  }, [focusActivePanePrompt]);

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
        focusActivePanePrompt();
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "4") {
        event.preventDefault();
        if (activePaneId) {
          paneRefs.current[activePaneId]?.focusHistory();
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        focusActivePanePrompt();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePaneId, closePalette, focusActivePanePrompt, paletteOpen]);

  const footerText = useMemo(() => {
    if (activeHistory?.debugPreset === "scroll") {
      const cwd = workspace.activeSession?.cwd ?? activeProject?.workspaceRoot ?? "no project";
      return `debug · scroll-debug · ${cwd}`;
    }
    const provider = activeProvider ?? "no-provider";
    const model = activeThread?.model ?? "no-model";
    const reasoning =
      activeReasoningEffort === null
        ? activeDefaultReasoningEffort
          ? `default (${activeDefaultReasoningEffort})`
          : "default"
        : activeReasoningEffort;
    const cwd = workspace.activeSession?.cwd ?? activeProject?.workspaceRoot ?? "no project";
    return `${provider} · ${model} · ${reasoning} · ${cwd}`;
  }, [
    activeHistory?.debugPreset,
    activeDefaultReasoningEffort,
    activeProvider,
    activeProject?.workspaceRoot,
    activeReasoningEffort,
    activeThread?.model,
    workspace.activeSession?.cwd,
  ]);

  return (
    <>
      <div className="bg-image" />
      <div className="bg-gradient" />
      <div className={isDesktop ? "console-shell console-shell--desktop" : "console-shell"}>
        <div
          className={isDesktop ? "session-tabs session-tabs--desktop" : "session-tabs"}
          role="tablist"
          aria-label="Workspace sessions"
        >
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
              onMouseDown={(event) => {
                if (event.button !== 1) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                closeSession(session.id);
              }}
              title={session.cwd}
            >
              <span className="session-tab__title">{session.title}</span>
              <span className="session-tab__meta">{session.histories.length}</span>
            </button>
          ))}
          <button
            type="button"
            className="session-tab session-tab--create"
            onClick={() => void handleCreateSession("codex")}
            disabled={!activeProject}
            title={activeProject ? "New session" : "No workspace available"}
          >
            +
          </button>
          {isDesktop ? <div className="session-tabs__drag-space" aria-hidden="true" /> : null}
        </div>
        <main className={paneViews.length > 1 ? "conversation-scroll conversation-scroll--split" : "conversation-scroll"}>
          {paneViews.length > 0 ? (
            <div className={paneViews.length > 1 ? "pane-grid pane-grid--split" : "pane-grid"}>
              {paneViews.map((paneView) => (
                <section
                  key={paneView.pane.id}
                  className={
                    paneView.isActive
                      ? "conversation-pane conversation-pane--active"
                      : "conversation-pane"
                  }
                  onMouseDownCapture={() => activatePane(paneView.pane.id)}
                >
                  <div className="conversation-pane__header">
                    <span className="conversation-pane__label">Pane {paneView.index + 1}</span>
                    <span className="conversation-pane__meta">
                      {paneView.thread?.title ??
                        (paneView.history?.debugPreset === "scroll"
                          ? "Debug · Scroll transcript"
                          : `${paneView.history?.preferredProvider === "copilot" ? "Copilot" : "Codex"} · ${
                            paneView.history?.pending ? "Loading thread..." : "History unavailable"
                          }`)}
                    </span>
                  </div>
                  <div className="transcript-shell">
                    <TranscriptRenderer
                      ref={(handle) => {
                        paneRefs.current[paneView.pane.id] = handle;
                      }}
                      blocks={paneView.blocks}
                      composerAttachments={paneView.attachments}
                      interactionMode={paneView.thread?.interactionMode ?? "default"}
                      {...(paneView.pendingUserInput && paneView.pendingQuestion
                        ? {
                            pendingUserInputHighlight: {
                              requestId: paneView.pendingUserInput.requestId,
                              questionIndex: paneView.pendingQuestionIndex,
                              ...(paneView.pendingShortcut
                                ? { optionIndex: paneView.pendingShortcut.optionIndex }
                                : {}),
                            },
                          }
                        : {})}
                      onAddImageFiles={(files) => handleAddImageFilesForPane(paneView.pane.id, files)}
                      onDraftChange={(value) => setComposerDraftForPane(paneView.pane.id, value)}
                      onRemoveImage={(attachmentId) => handleRemoveImageForPane(paneView.pane.id, attachmentId)}
                      onSubmit={(value) =>
                        handleSubmit(
                          paneView.pane.id,
                          paneView.threadId,
                          paneView.history?.preferredProvider ?? null,
                          paneView.pendingUserInput,
                          paneView.pendingQuestion,
                          paneView.pendingQuestionIndex,
                          paneView.draftAnswers,
                          value,
                        )}
                      submitDisabled={paneView.history?.debugPreset === "scroll" || !canSubmitPromptForThread(paneView.threadId)}
                    />
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="transcript-shell">
              <TranscriptRenderer
                ref={(handle) => {
                  paneRefs.current.bootstrap = handle;
                }}
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
                onAddImageFiles={(files) => activePaneId && handleAddImageFilesForPane(activePaneId, files)}
                onDraftChange={(value) => activePaneId && setComposerDraftForPane(activePaneId, value)}
                onRemoveImage={(attachmentId) => activePaneId && handleRemoveImageForPane(activePaneId, attachmentId)}
                onSubmit={(value) =>
                  handleSubmit(
                    activePaneId ?? "bootstrap",
                    activeThreadId,
                    activeHistory?.preferredProvider ?? null,
                    activePendingUserInput,
                    activePendingQuestion,
                    activePendingQuestionIndex,
                    activePendingDraftAnswers,
                    value,
                  )}
                submitDisabled={!canSubmitPromptForThread(activeThreadId)}
              />
            </div>
          )}
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
