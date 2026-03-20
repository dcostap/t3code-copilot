import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type OrchestrationProject,
  type ThreadId,
  type ProviderKind,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

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
import {
  hasNonCollapsedSelectionInsideElement,
  TranscriptRenderer,
  type TranscriptRendererHandle,
  threadToTranscriptBlocks,
} from "./transcript";
import { useConsoleData, type PendingConsoleThread } from "./consoleData/useConsoleData";
import { useConsoleWorkspaceSessions, type ConsolePaneSetup } from "./consoleSessions";
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

interface ThreadSetupSurfaceProps {
  readonly selectedProvider: ProviderKind;
  readonly busy: boolean;
  readonly hoverSelectionSuppressed: boolean;
  onHoverSelectionResume(): void;
  onSelect(provider: ProviderKind): void;
  onConfirm(provider: ProviderKind): void;
}

function ThreadSetupSurface({
  selectedProvider,
  busy,
  hoverSelectionSuppressed,
  onHoverSelectionResume,
  onSelect,
  onConfirm,
}: ThreadSetupSurfaceProps) {
  const options: ReadonlyArray<{
    readonly provider: ProviderKind;
    readonly label: string;
    readonly description: string;
  }> = [
    { provider: "codex", label: "Codex", description: "OpenAI Codex provider" },
    { provider: "copilot", label: "GitHub Copilot", description: "GitHub Copilot provider" },
  ];

  const selectProvider = useCallback((provider: ProviderKind) => {
    if (provider !== selectedProvider) {
      onSelect(provider);
    }
  }, [onSelect, selectedProvider]);

  return (
    <div className="thread-setup" role="group" aria-label="New thread setup">
      <div className="thread-setup__content">
        <div className="thread-setup__line">new thread</div>
        <div className="thread-setup__line thread-setup__line--muted">choose provider</div>
        <div className="thread-setup__spacer" />
        {options.map((option, index) => {
          const active = option.provider === selectedProvider;
          const className = [
            "thread-setup__option",
            active ? "thread-setup__option--active" : null,
            hoverSelectionSuppressed ? "thread-setup__option--hover-suppressed" : null,
          ].filter(Boolean).join(" ");
          return (
            <button
              key={option.provider}
              type="button"
              className={className}
              onMouseEnter={() => {
                if (busy || hoverSelectionSuppressed) {
                  return;
                }
                selectProvider(option.provider);
              }}
              onMouseMove={() => {
                if (busy || !hoverSelectionSuppressed) {
                  return;
                }
                onHoverSelectionResume();
                selectProvider(option.provider);
              }}
              onClick={() => {
                selectProvider(option.provider);
                onConfirm(option.provider);
              }}
              disabled={busy}
            >
              <span className="thread-setup__marker" aria-hidden="true">{active ? "›" : " "}</span>
              <span className="thread-setup__text">
                [{index + 1}] {option.label}{" "}
                <span className="thread-setup__description">— {option.description}</span>
              </span>
            </button>
          );
        })}
        {busy ? (
          <>
            <div className="thread-setup__spacer" />
            <div className="thread-setup__line thread-setup__line--hint">creating thread...</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface EmptyWorkspaceSurfaceProps {
  readonly canCreate: boolean;
  onCreate(): void;
}

function EmptyWorkspaceSurface({
  canCreate,
  onCreate,
}: EmptyWorkspaceSurfaceProps) {
  return (
    <div className="empty-workspace" role="status" aria-live="polite">
      <div className="empty-workspace__content">
        <div className="empty-workspace__row">
          <span className="thread-setup__line thread-setup__line--muted">There&apos;s nothing here...</span>
          <button
            type="button"
            className="thread-setup__option thread-setup__option--active empty-workspace__action"
            onClick={onCreate}
            disabled={!canCreate}
          >
            <span className="thread-setup__text">Open new tab?</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function renderLoadingText(text: string) {
  return Array.from(text).map((char, index) => (
    <span
      key={`${char}-${index}`}
      className="loading-screen__char"
      style={{ animationDelay: `${index * 0.028}s` }}
    >
      {char === " " ? "\u00A0" : char}
    </span>
  ));
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
  const getTurnDiff = consoleData.getTurnDiff;
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
  const updatePaneSetup = workspace.updatePaneSetup;
  const completePaneSetup = workspace.completePaneSetup;
  const createSessionWithSetup = workspace.createSessionWithSetup;
  const activateSession = workspace.activateSession;
  const closeSession = workspace.closeSession;
  const activatePane = workspace.activatePane;
  const closePane = workspace.closePane;
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const [frozenTranscriptNowIso, setFrozenTranscriptNowIso] = useState<string | null>(null);
  const [_submitError, setSubmitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [pendingPromptSendStartedAtByThreadId, setPendingPromptSendStartedAtByThreadId] = useState<
    Record<string, string>
  >({});
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
  const [pendingThreadSetupPaneIds, setPendingThreadSetupPaneIds] = useState<ReadonlySet<string>>(() => new Set());
  const [setupHoverSuppressedPaneIds, setSetupHoverSuppressedPaneIds] = useState<ReadonlySet<string>>(() => new Set());
  const [mountedSessionIds, setMountedSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(activeSession ? [activeSession.id] : []),
  );
  const paneRefs = useRef<Record<string, TranscriptRendererHandle | null>>({});
  const hasInitiallyFocusedPromptRef = useRef(false);
  const latestNowIsoRef = useRef(nowIso);
  const initializedPaneIdsRef = useRef<Record<string, true>>({});
  const previousActiveSetupPaneIdRef = useRef<string | null>(null);
  const composerAttachmentsRef = useRef(composerAttachmentsByPaneId);
  composerAttachmentsRef.current = composerAttachmentsByPaneId;
  const activePane = workspace.activePane;
  const activePaneId = activePane?.id ?? null;
  const activeThreadId = workspace.activeThreadId ?? consoleData.activeThreadId;
  latestNowIsoRef.current = nowIso;
  const activeThread = activeSession
    ? workspace.activeThread
    : (activeThreadId
        ? (consoleData.threads.find((thread) => thread.id === activeThreadId) ?? consoleData.thread)
        : consoleData.thread);
  const activeProject = activeSession
    ? workspace.activeProject
    : (activeThreadId ? getProjectForThread(activeThreadId) : consoleData.project);
  const availableProject = activeProject ?? consoleData.snapshot?.projects[0] ?? null;
  const activeHistory = useMemo(
    () => (activeSession && activePane?.historyId
      ? (activeSession.histories.find((history) => history.id === activePane.historyId) ?? null)
      : null),
    [activePane?.historyId, activeSession],
  );
  const activePendingThread = !activeThread ? (activeHistory?.pendingThread ?? null) : null;
  const composerDraft = activePaneId ? (composerDraftByPaneId[activePaneId] ?? "") : "";
  const composerAttachments = activePaneId ? [...(composerAttachmentsByPaneId[activePaneId] ?? [])] : [];
  const activePendingUserInputs = useMemo(
    () => (activeThreadId ? getPendingUserInputs(activeThreadId) : []),
    [activeThreadId, getPendingUserInputs],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activeThreadTurnRunning = activeThreadId ? isThreadTurnRunning(activeThreadId) : false;
  const activePendingPromptSendStartedAt = activeThreadId
    ? (pendingPromptSendStartedAtByThreadId[activeThreadId] ?? null)
    : null;
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
    activePane?.setup?.selectedProvider ??
    activeThread?.provider ??
    activePendingThread?.provider ??
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

  const anyThreadTurnRunning = useMemo(
    () => consoleData.threads.some((thread) => isThreadTurnRunning(thread.id)),
    [consoleData.threads, isThreadTurnRunning],
  );
  const hasLiveTranscriptTimer =
    anyThreadTurnRunning || Object.keys(pendingPromptSendStartedAtByThreadId).length > 0;

  useEffect(() => {
    if (!hasLiveTranscriptTimer) {
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
  }, [hasLiveTranscriptTimer]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const syncTranscriptSelectionFreeze = () => {
      const selection = window.getSelection();
      const transcriptShells = Array.from(document.querySelectorAll<HTMLElement>(".transcript-shell"));
      const shouldFreeze = transcriptShells.some((shell) =>
        hasNonCollapsedSelectionInsideElement(selection, shell));
      setFrozenTranscriptNowIso((current) => {
        if (shouldFreeze) {
          return current ?? latestNowIsoRef.current;
        }
        return current === null ? current : null;
      });
    };

    document.addEventListener("selectionchange", syncTranscriptSelectionFreeze);
    window.addEventListener("blur", syncTranscriptSelectionFreeze);

    return () => {
      document.removeEventListener("selectionchange", syncTranscriptSelectionFreeze);
      window.removeEventListener("blur", syncTranscriptSelectionFreeze);
    };
  }, []);

  useEffect(() => {
    setPendingPromptSendStartedAtByThreadId((existing) => {
      let changed = false;
      const next: Record<string, string> = {};

      for (const [threadId, startedAt] of Object.entries(existing)) {
        const thread = consoleData.threads.find((candidate) => candidate.id === threadId);
        if (!thread) {
          const hasPendingThreadHistory = workspace.sessions.some((session) =>
            session.histories.some((history) => history.threadId === threadId && history.pendingThread !== null),
          );
          if (hasPendingThreadHistory) {
            next[threadId] = startedAt;
            continue;
          }
          changed = true;
          continue;
        }
        if (isThreadTurnRunning(threadId)) {
          changed = true;
          continue;
        }
        next[threadId] = startedAt;
      }

      return changed ? next : existing;
    });
  }, [consoleData.threads, isThreadTurnRunning, workspace.sessions]);

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
        thread.provider === preferredProvider &&
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

  const focusActivePanePrompt = useCallback((options?: { readonly reveal?: boolean }) => {
    if (!activePaneId) {
      return;
    }
    paneRefs.current[activePaneId]?.focusPrompt(options);
  }, [activePaneId]);
  const handleToolbarButtonMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  }, []);

  const activatePaneAndFocus = useCallback((paneId: string) => {
    activatePane(paneId);
    requestAnimationFrame(() => {
      paneRefs.current[paneId]?.focusPrompt();
    });
  }, [activatePane]);
  const activateSessionAndFocus = useCallback((sessionId: string) => {
    const session = workspace.sessions.find((candidate) => candidate.id === sessionId);
    const paneId = session?.activePaneId ?? session?.panes[0]?.id ?? null;
    activateSession(sessionId);
    requestAnimationFrame(() => {
      if (!paneId) {
        return;
      }
      paneRefs.current[paneId]?.focusPrompt();
    });
  }, [activateSession, workspace.sessions]);

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
      pendingThread: PendingConsoleThread | null,
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
        const sendingStartedAt = new Date().toISOString();
        setPendingPromptSendStartedAtByThreadId((existing) => ({
          ...existing,
          [threadId]: sendingStartedAt,
        }));
        try {
          await submitPrompt({
            threadId,
            pendingThread,
            prompt: value,
            attachments: await Promise.all(attachmentSnapshot.map(toUploadImageAttachment)),
          });
        } catch (submitError) {
          setPendingPromptSendStartedAtByThreadId((existing) => {
            if (!(threadId in existing)) {
              return existing;
            }
            const next = { ...existing };
            delete next[threadId];
            return next;
          });
          throw submitError;
        }
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
  const effectiveTranscriptNowIso = frozenTranscriptNowIso ?? nowIso;
  const activeThreadNow =
    activeThreadId && (activeThreadTurnRunning || activePendingPromptSendStartedAt !== null)
      ? effectiveTranscriptNowIso
      : undefined;
  const blocks = useMemo(() => {
    if (activeThread) {
      const nextBlocks = threadToTranscriptBlocks(activeThread, {
        resolveAttachmentPreviewUrl: (attachmentId) =>
          `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
        orchestrationEvents: getThreadEvents(activeThread.id),
        ...(activeThreadNow ? { now: activeThreadNow } : {}),
      });
      if (
        activePendingPromptSendStartedAt !== null
        && activeThreadNow
        && !activeThreadTurnRunning
      ) {
        return [
          ...nextBlocks,
          {
            type: "sending-state" as const,
            startedAt: activePendingPromptSendStartedAt,
            now: activeThreadNow,
          },
        ];
      }
      return nextBlocks;
    }
    if (activeSession) {
      return [{ type: "status" as const, text: "Loading session history..." }];
    }
    if (consoleData.snapshot) {
      if (consoleData.snapshot.projects.length === 0) {
        return [{ type: "status" as const, text: "No workspace is loaded yet." }];
      }
      return [{ type: "status" as const, text: "No thread is available yet. Press + to open a new thread tab." }];
    }
    if (consoleData.error) {
      return [{ type: "status" as const, text: `Connection error: ${consoleData.error}` }];
    }
    return [{ type: "status" as const, text: "Waiting for orchestration snapshot..." }];
  }, [
    activePendingPromptSendStartedAt,
    activeSession,
    activeThread,
    activeThreadNow,
    activeThreadTurnRunning,
    attachmentPreviewBaseUrl,
    consoleData.snapshot,
    consoleData.error,
    getThreadEvents,
  ]);

  const handleCreateSession = useCallback(() => {
    const nextSessionCwd =
      activeSession?.cwd ?? activeThread?.worktreePath ?? availableProject?.workspaceRoot ?? null;
    const projectId = activeSession?.projectId ?? availableProject?.id ?? null;
    if (!nextSessionCwd || !projectId) {
      setSubmitError("No workspace is available for a new session.");
      return;
    }
    const sessionWorktreePath =
      activeThread?.worktreePath ??
      (availableProject && nextSessionCwd !== availableProject.workspaceRoot ? nextSessionCwd : null);
    createSessionWithSetup({
      cwd: nextSessionCwd,
      projectId,
      createdAt: new Date().toISOString(),
      selectedProvider: "codex",
      interactionMode: activeThread?.interactionMode ?? "default",
      branch: activeThread?.branch ?? null,
      worktreePath: sessionWorktreePath,
    });
    setSubmitError(null);
  }, [activeSession, activeThread, availableProject, createSessionWithSetup]);
  const handleConfirmSetupPane = useCallback(async (
    paneId: string,
    projectId: OrchestrationProject["id"],
    cwd: string,
    setup: ConsolePaneSetup,
  ) => {
    if (!setup || pendingThreadSetupPaneIds.has(paneId)) {
      return;
    }

    setPendingThreadSetupPaneIds((existing) => new Set(existing).add(paneId));
    try {
      const result = await createThread({
        projectId,
        provider: setup.selectedProvider,
        title: "New thread",
        model: resolveModelForProvider(setup.selectedProvider, projectId),
        interactionMode: setup.interactionMode,
        branch: setup.branch,
        worktreePath: setup.worktreePath,
        createdAt: setup.createdAt,
      });
      completePaneSetup({
        paneId,
        threadId: result.threadId,
        preferredProvider: setup.selectedProvider,
        cwd,
        projectId,
        createdAt: setup.createdAt,
        pending: true,
        pendingThread: result.pendingThread,
      });
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to create a new thread.");
    } finally {
      setPendingThreadSetupPaneIds((existing) => {
        const next = new Set(existing);
        next.delete(paneId);
        return next;
      });
    }
  }, [completePaneSetup, createThread, pendingThreadSetupPaneIds, resolveModelForProvider]);
  const sessionViews = useMemo(() => {
    return workspace.sessions
      .filter((session) => session.id === activeSession?.id || mountedSessionIds.has(session.id))
      .map((session) => {
        const paneViews = session.panes.map((pane, index) => {
          const history = session.histories.find((candidate) => candidate.id === pane.historyId) ?? null;
          const threadId = history?.threadId ?? null;
          const thread =
            threadId ? (consoleData.threads.find((candidate) => candidate.id === threadId) ?? null) : null;
          const pendingThread = !thread ? (history?.pendingThread ?? null) : null;
          const pendingUserInputs = threadId ? getPendingUserInputs(threadId) : [];
          const pendingUserInput = pendingUserInputs[0] ?? null;
          const pendingQuestionIndex = pendingUserInput
            ? (pendingUserInputQuestionIndexByRequestId[pendingUserInput.requestId] ?? 0)
            : 0;
          const pendingQuestion = pendingUserInput?.questions[pendingQuestionIndex] ?? null;
          const setup = pane.setup;
          const draft = composerDraftByPaneId[pane.id] ?? "";
          const pendingShortcut = pendingQuestion
            ? resolvePendingUserInputShortcut(draft, pendingQuestion.options)
            : null;
          const panePendingPromptSendStartedAt = threadId
            ? (pendingPromptSendStartedAtByThreadId[threadId] ?? null)
            : null;
          const paneNow =
            threadId && (isThreadTurnRunning(threadId) || panePendingPromptSendStartedAt !== null)
              ? effectiveTranscriptNowIso
              : undefined;
          const blocks = thread
            ? (() => {
                const nextBlocks = threadToTranscriptBlocks(thread, {
                  resolveAttachmentPreviewUrl: (attachmentId) =>
                    `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
                  orchestrationEvents: getThreadEvents(thread.id),
                  ...(paneNow ? { now: paneNow } : {}),
                });
                if (
                  panePendingPromptSendStartedAt !== null
                  && paneNow
                  && !isThreadTurnRunning(threadId)
                ) {
                  return [
                    ...nextBlocks,
                    {
                      type: "sending-state" as const,
                      startedAt: panePendingPromptSendStartedAt,
                      now: paneNow,
                    },
                  ];
                }
                return nextBlocks;
              })()
            : setup
              ? []
              : history?.pending && pendingThread
                ? (panePendingPromptSendStartedAt !== null && effectiveTranscriptNowIso
                    ? [{
                        type: "sending-state" as const,
                        startedAt: panePendingPromptSendStartedAt,
                        now: effectiveTranscriptNowIso,
                      }]
                    : [])
              : [{
                  type: "status" as const,
                  text: history?.pending ? "Loading session history..." : "History unavailable in this session.",
                }];

          return {
            pane,
            setup,
            history,
            threadId,
            thread,
            pendingThread,
            isActive: pane.id === session.activePaneId,
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
            pendingPromptSendStartedAt: panePendingPromptSendStartedAt,
          };
        });

        return {
          session,
          paneViews,
          isActive: session.id === activeSession?.id,
        };
      });
  }, [
    activeSession?.id,
    attachmentPreviewBaseUrl,
    composerAttachmentsByPaneId,
    composerDraftByPaneId,
    consoleData.threads,
    getPendingUserInputs,
    getThreadEvents,
    isThreadTurnRunning,
    mountedSessionIds,
    effectiveTranscriptNowIso,
    pendingPromptSendStartedAtByThreadId,
    pendingUserInputAnswersByRequestId,
    pendingUserInputQuestionIndexByRequestId,
    workspace.sessions,
  ]);
  const activeSessionView = useMemo(
    () => sessionViews.find((sessionView) => sessionView.session.id === activeSession?.id) ?? null,
    [activeSession?.id, sessionViews],
  );
  const activePaneViews = activeSessionView?.paneViews ?? [];
  const activeSetupPaneView = useMemo(
    () => activePaneViews.find((paneView) => paneView.isActive && paneView.setup) ?? null,
    [activePaneViews],
  );
  const activeSessionPaneLayoutKey = useMemo(
    () => (activeSessionView
      ? `${activeSessionView.session.id}:${activeSessionView.paneViews.map((paneView) => paneView.pane.id).join(",")}`
      : null),
    [activeSessionView],
  );
  const paletteCommands = useMemo<AppPaletteCommand[]>(() => {
    const commands: AppPaletteCommand[] = [];
    const currentSession = activeSession;
    const canDispatchBackendCommands = consoleData.connectionState === "connected";

    for (const session of workspace.sessions) {
      commands.push({
        id: `session:${session.id}`,
        label:
          session.id === currentSession?.id
            ? `[Session] Current · ${session.title}`
            : `[Session] Switch · ${session.title}`,
        contextText: `${session.cwd} · ${session.histories.length} histories`,
        keywords: ["session", session.title, session.cwd],
        run: () => {
          activateSessionAndFocus(session.id);
        },
      });
    }

    if (canDispatchBackendCommands && (currentSession || availableProject)) {
      commands.push({
        id: "thread:new-tab",
        label: "[Thread] New tab",
        keywords: ["thread", "new", "tab", "workspace"],
        run: () => handleCreateSession(),
      });
    }

    if (currentSession && currentSession.panes.length > 1) {
      currentSession.panes.forEach((pane, index) => {
        commands.push({
          id: `pane:${pane.id}:focus`,
          label:
            pane.id === currentSession.activePaneId
              ? `[Pane] Current · ${index + 1}`
              : `[Pane] Focus · ${index + 1}`,
          keywords: ["pane", "focus", `${index + 1}`],
          run: () => {
            activatePaneAndFocus(pane.id);
          },
        });
      });
      commands.push({
        id: `pane:${currentSession.activePaneId}:close`,
        label: "[Pane] Close active",
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
                ? `[Model] Current · ${modelOption.name} · ${activeProvider}`
                : `[Model] Set · ${modelOption.name} · ${activeProvider}`,
            contextText: modelOption.slug,
            keywords: ["model", activeProvider, modelOption.name, modelOption.slug],
            run: () => setThreadModel(activeThread.id, activeProvider, modelOption.slug),
          });
        }

        if (activeReasoningOptions.length > 0) {
          commands.push({
            id: `reasoning:${activeThread.id}:default`,
            label:
              activeReasoningEffort === null
                ? `[Reasoning] Current · Default · ${activeProvider}`
                : `[Reasoning] Set · Default · ${activeProvider}`,
            contextText: activeThread.model ?? undefined,
            keywords: ["reasoning", "default", activeProvider],
            run: () => setThreadReasoningEffort(activeThread.id, activeProvider, null),
          });

          for (const reasoningOption of activeReasoningOptions) {
            commands.push({
              id: `reasoning:${activeThread.id}:${reasoningOption}`,
              label:
                activeReasoningEffort === reasoningOption
                  ? `[Reasoning] Current · ${reasoningOption} · ${activeProvider}`
                  : `[Reasoning] Set · ${reasoningOption} · ${activeProvider}`,
              contextText: activeThread.model ?? undefined,
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
          label: "[Mode] Set · Default",
          keywords: ["interaction", "default"],
          run: () => setInteractionMode(activeThread.id, "default"),
        },
        {
          id: `interaction:${activeThread.id}:plan`,
          label: "[Mode] Set · Plan",
          keywords: ["interaction", "plan"],
          run: () => setInteractionMode(activeThread.id, "plan"),
        },
        {
          id: `session:${activeThread.id}:stop`,
          label: "[Session] Stop active",
          keywords: ["session", "stop", "disconnect"],
          run: () => stopSession(activeThread.id),
        },
      );

      if (activeThreadTurnRunning && !consoleData.isInterruptingTurn && !consoleData.isStoppingSession) {
        commands.push({
          id: `turn:${activeThread.id}:interrupt`,
          label: "[Turn] Interrupt active",
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
            label: `[Input] ${question.header} · ${option.label}`,
            contextText: option.description,
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
          label: `[Input] Answer in prompt · ${pendingUserInput.questions.length} questions`,
          keywords: ["user input", "prompt", "answer"],
            run: () => {
              requestAnimationFrame(() => {
                focusActivePanePrompt({ reveal: true });
              });
            },
        });
      }
    }

    return commands;
  }, [
      activePendingUserInputs,
      availableProject,
    activeSession,
    activeThread,
    activeThreadTurnRunning,
    consoleData.connectionState,
    consoleData.isInterruptingTurn,
    consoleData.isStoppingSession,
    consoleData.respondingUserInputRequestIds,
    handleCreateSession,
    interruptTurn,
    activatePaneAndFocus,
    activateSessionAndFocus,
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
    const liveSessionIds = new Set(workspace.sessions.map((session) => session.id));
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
    setMountedSessionIds((existing) => {
      const next = new Set([...existing].filter((sessionId) => liveSessionIds.has(sessionId)));
      if (next.size === existing.size && [...next].every((sessionId) => existing.has(sessionId))) {
        return existing;
      }
      return next;
    });
    initializedPaneIdsRef.current = Object.fromEntries(
      Object.entries(initializedPaneIdsRef.current).filter(([paneId]) => livePaneIds.has(paneId)),
    );
  }, [workspace.sessions]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    setMountedSessionIds((existing) => {
      if (existing.has(activeSession.id)) {
        return existing;
      }
      return new Set(existing).add(activeSession.id);
    });
  }, [activeSession]);

  useEffect(() => {
    return () => {
      Object.values(composerAttachmentsRef.current).flat().forEach(revokeComposerImageAttachmentPreview);
    };
  }, []);

  useEffect(() => {
    const activeSetupPaneId = activeSetupPaneView?.pane.id ?? null;
    const previousActiveSetupPaneId = previousActiveSetupPaneIdRef.current;
    previousActiveSetupPaneIdRef.current = activeSetupPaneId;
    if (!activePaneId || activeSetupPaneId === activePaneId) {
      return;
    }

    const shouldAutoFocusInitialReadyPane = !hasInitiallyFocusedPromptRef.current;
    const hasJustFinishedActivePaneSetup =
      previousActiveSetupPaneId === activePaneId && activeSetupPaneId !== activePaneId;
    if (!shouldAutoFocusInitialReadyPane && !hasJustFinishedActivePaneSetup) {
      return;
    }

    const handle = paneRefs.current[activePaneId];
    if (!handle) {
      return;
    }
    hasInitiallyFocusedPromptRef.current = true;
    requestAnimationFrame(() => {
      handle.focusPrompt();
    });
  }, [activePaneId, activeSetupPaneView]);

  useEffect(() => {
    if (!activeSessionView || !activeSessionPaneLayoutKey) {
      return;
    }

    requestAnimationFrame(() => {
      activeSessionView.paneViews.forEach((paneView) => {
        if (initializedPaneIdsRef.current[paneView.pane.id]) {
          return;
        }

        const handle = paneRefs.current[paneView.pane.id];
        if (!handle) {
          return;
        }

        initializedPaneIdsRef.current[paneView.pane.id] = true;
        handle.scrollToBottom();
      });
    });
  }, [activeSessionPaneLayoutKey, activeSessionView]);

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

  const routeTypedKeyToPrompt = useCallback((event: KeyboardEvent) => {
    if (paletteOpen || activeSetupPaneView?.setup || !activePaneId || event.isComposing) {
      return false;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return false;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".transcript-prompt__input")) {
      return false;
    }
    if (target?.closest("input, textarea, select, [contenteditable='true']")) {
      return false;
    }
    const handle = paneRefs.current[activePaneId];
    if (!handle) {
      return false;
    }

    const routeToPrompt = () => {
      handle.scrollToBottom();
      focusActivePanePrompt();
    };

    if (event.key === "Backspace") {
      event.preventDefault();
      routeToPrompt();
      handle.deletePromptBackward();
      return true;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      routeToPrompt();
      handle.deletePromptForward();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      routeToPrompt();
      if (event.shiftKey) {
        handle.insertPromptText("\n");
      } else {
        handle.submitPrompt();
      }
      return true;
    }
    if (event.key.length !== 1) {
      return false;
    }

    event.preventDefault();
    routeToPrompt();
    handle.insertPromptText(event.key);
    return true;
  }, [activePaneId, activeSetupPaneView, focusActivePanePrompt, paletteOpen]);

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

      if (
        activeSetupPaneView?.setup &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const providers: ReadonlyArray<ProviderKind> = ["codex", "copilot"];
        const currentIndex = providers.indexOf(activeSetupPaneView.setup.selectedProvider);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const nextProvider = providers[Math.max(0, Math.min(providers.length - 1, currentIndex + delta))];
          if (nextProvider) {
            setSetupHoverSuppressedPaneIds((existing) => new Set(existing).add(activeSetupPaneView.pane.id));
            updatePaneSetup({ paneId: activeSetupPaneView.pane.id, selectedProvider: nextProvider });
          }
          return;
        }
        if (event.key === "1" || event.key === "2") {
          event.preventDefault();
          const nextProvider = providers[Number.parseInt(event.key, 10) - 1];
          if (nextProvider) {
            setSetupHoverSuppressedPaneIds((existing) => new Set(existing).add(activeSetupPaneView.pane.id));
            updatePaneSetup({ paneId: activeSetupPaneView.pane.id, selectedProvider: nextProvider });
          }
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const projectId = activeSession?.projectId ?? availableProject?.id ?? null;
          const cwd = activeSession?.cwd ?? availableProject?.workspaceRoot ?? null;
          if (!projectId || !cwd) {
            return;
          }
          void handleConfirmSetupPane(
            activeSetupPaneView.pane.id,
            projectId,
            cwd,
            activeSetupPaneView.setup,
          );
          return;
        }
      }

      if (routeTypedKeyToPrompt(event)) {
        return;
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "1") {
        event.preventDefault();
        focusActivePanePrompt({ reveal: true });
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

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [
    activePaneId,
    activeSession?.cwd,
    activeSession?.projectId,
    activeSetupPaneView,
    availableProject?.id,
    availableProject?.workspaceRoot,
    closePalette,
    focusActivePanePrompt,
    handleConfirmSetupPane,
    paletteOpen,
    routeTypedKeyToPrompt,
    updatePaneSetup,
  ]);

  const footerText = useMemo(() => {
    const pathText =
      activeThread?.worktreePath
      ?? activePendingThread?.worktreePath
      ?? workspace.activeSession?.cwd
      ?? availableProject?.workspaceRoot
      ?? "no project";
    if (workspace.sessions.length === 0 || activeSetupPaneView?.setup) {
      return pathText;
    }
    const provider = activeProvider ?? "no-provider";
    const model = activeThread?.model ?? activePendingThread?.model ?? "no-model";
    const reasoning =
      activeReasoningEffort === null
        ? activeDefaultReasoningEffort
          ? `default (${activeDefaultReasoningEffort})`
          : "default"
        : activeReasoningEffort;
    return `${provider} · ${model} · ${reasoning} · ${pathText}`;
  }, [
    activeDefaultReasoningEffort,
    activePendingThread?.model,
    activePendingThread?.worktreePath,
    activeProvider,
    activeSetupPaneView,
    availableProject?.workspaceRoot,
    activeReasoningEffort,
    activeThread?.model,
    workspace.sessions.length,
    workspace.activeSession?.cwd,
  ]);

  if (!consoleData.snapshot && !consoleData.error) {
    return (
      <>
        <div className="bg-image" />
        <div className="bg-gradient" />
        <div className={isDesktop ? "console-shell console-shell--desktop" : "console-shell"}>
          <div
            className={isDesktop ? "session-tabs session-tabs--desktop" : "session-tabs"}
            aria-hidden="true"
          >
            <div className="session-tabs__list" />
            {isDesktop ? <div className="session-tabs__drag-space" aria-hidden="true" /> : null}
          </div>
          <main className="loading-screen loading-screen--shell" role="status" aria-live="polite">
            <span className="loading-screen__text">{renderLoadingText("connecting to backend...")}</span>
          </main>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bg-image" />
      <div className="bg-gradient" />
      <div className={isDesktop ? "console-shell console-shell--desktop" : "console-shell"}>
        <div
          className={isDesktop ? "session-tabs session-tabs--desktop" : "session-tabs"}
        >
          <div className="session-tabs__list" aria-label="Workspace sessions">
            {workspace.sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={
                  session.id === activeSession?.id
                    ? "session-tab session-tab--active"
                    : "session-tab"
                }
                onClick={() => activateSessionAndFocus(session.id)}
                onMouseDown={(event) => {
                  if (event.button !== 1) {
                    handleToolbarButtonMouseDown(event);
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  closeSession(session.id);
                }}
                tabIndex={-1}
                title={session.cwd}
              >
                <span className="session-tab__title">{session.title}</span>
              </button>
            ))}
          </div>
            <button
              type="button"
              className="session-tab session-tab--create"
              onClick={() => handleCreateSession()}
              onMouseDown={handleToolbarButtonMouseDown}
              disabled={!availableProject}
              tabIndex={-1}
              title={availableProject ? "New thread" : "No workspace available"}
            >
              +
            </button>
          {isDesktop ? <div className="session-tabs__drag-space" aria-hidden="true" /> : null}
        </div>
        <main className={activePaneViews.length > 1 ? "conversation-scroll conversation-scroll--split" : "conversation-scroll"}>
          {workspace.sessions.length === 0 ? (
            <div className="conversation-session">
              <div className="pane-grid">
                <section className="conversation-pane conversation-pane--active">
                  <div className="transcript-shell">
                    <EmptyWorkspaceSurface canCreate={availableProject !== null} onCreate={handleCreateSession} />
                  </div>
                </section>
              </div>
            </div>
          ) : sessionViews.length > 0 ? (
            sessionViews.map((sessionView) => (
              <div
                key={sessionView.session.id}
                className={
                  sessionView.paneViews.length > 1
                    ? "conversation-session conversation-session--split"
                    : "conversation-session"
                }
                hidden={!sessionView.isActive}
              >
                <div className={sessionView.paneViews.length > 1 ? "pane-grid pane-grid--split" : "pane-grid"}>
                  {sessionView.paneViews.map((paneView) => (
                    <section
                      key={paneView.pane.id}
                      className={
                        paneView.isActive
                          ? "conversation-pane conversation-pane--active"
                          : "conversation-pane"
                      }
                      onMouseDownCapture={() => activatePane(paneView.pane.id)}
                    >
                      <div className="transcript-shell">
                        {paneView.setup ? (
                          (() => {
                            const setup = paneView.setup;
                            return (
                          <ThreadSetupSurface
                            selectedProvider={setup.selectedProvider}
                            busy={pendingThreadSetupPaneIds.has(paneView.pane.id)}
                            hoverSelectionSuppressed={setupHoverSuppressedPaneIds.has(paneView.pane.id)}
                            onHoverSelectionResume={() =>
                              setSetupHoverSuppressedPaneIds((existing) => {
                                if (!existing.has(paneView.pane.id)) {
                                  return existing;
                                }
                                const next = new Set(existing);
                                next.delete(paneView.pane.id);
                                return next;
                              })}
                            onSelect={(provider) =>
                              updatePaneSetup({ paneId: paneView.pane.id, selectedProvider: provider })}
                            onConfirm={(provider) => {
                              updatePaneSetup({ paneId: paneView.pane.id, selectedProvider: provider });
                              void handleConfirmSetupPane(
                                paneView.pane.id,
                                sessionView.session.projectId,
                                sessionView.session.cwd,
                                {
                                  type: setup.type,
                                  selectedProvider: provider,
                                  createdAt: setup.createdAt,
                                  interactionMode: setup.interactionMode,
                                  branch: setup.branch,
                                  worktreePath: setup.worktreePath,
                                },
                              );
                            }}
                          />
                            );
                          })()
                        ) : (
                          <TranscriptRenderer
                            ref={(handle) => {
                              paneRefs.current[paneView.pane.id] = handle;
                            }}
                            blocks={paneView.blocks}
                            composerAttachments={paneView.attachments}
                            cwd={
                              sessionView.session.cwd
                              ?? paneView.thread?.worktreePath
                              ?? paneView.pendingThread?.worktreePath
                              ?? null
                            }
                            interactionMode={
                              paneView.thread?.interactionMode
                              ?? paneView.pendingThread?.interactionMode
                              ?? "default"
                            }
                            promptFocusDisabled={paletteOpen}
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
                            resolveInlineDiff={(lookup) =>
                              getTurnDiff({
                                threadId: lookup.threadId as ThreadId,
                                fromTurnCount: lookup.fromTurnCount,
                                toTurnCount: lookup.toTurnCount,
                              })}
                            onSubmit={(value) =>
                              handleSubmit(
                                paneView.pane.id,
                                paneView.threadId,
                                paneView.pendingThread,
                                paneView.pendingUserInput,
                                paneView.pendingQuestion,
                                paneView.pendingQuestionIndex,
                                paneView.draftAnswers,
                                value,
                              )}
                            submitDisabled={
                              paneView.pendingPromptSendStartedAt !== null
                              || !canSubmitPromptForThread(paneView.threadId, paneView.pendingThread)
                            }
                          />
                        )}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="transcript-shell">
              <TranscriptRenderer
                ref={(handle) => {
                  paneRefs.current.bootstrap = handle;
                }}
                blocks={blocks}
                composerAttachments={composerAttachments}
                cwd={activeSession?.cwd ?? activeThread?.worktreePath ?? availableProject?.workspaceRoot ?? null}
                interactionMode={activeThread?.interactionMode ?? "default"}
                promptFocusDisabled={paletteOpen}
                resolveInlineDiff={(lookup) =>
                  getTurnDiff({
                    threadId: lookup.threadId as ThreadId,
                    fromTurnCount: lookup.fromTurnCount,
                    toTurnCount: lookup.toTurnCount,
                  })}
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
                    activePendingThread,
                    activePendingUserInput,
                    activePendingQuestion,
                    activePendingQuestionIndex,
                    activePendingDraftAnswers,
                    value,
                  )}
                submitDisabled={!canSubmitPromptForThread(activeThreadId, activePendingThread)}
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
