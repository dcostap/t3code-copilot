import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";

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
import { resolvePendingUserInputAnswer } from "./pendingUserInput";
import {
  hasNonCollapsedSelectionInsideElement,
  TranscriptRenderer,
  type TranscriptRendererHandle,
  threadToTranscriptBlocks,
} from "./transcript";
import { useConsoleData, type PendingConsoleThread } from "./consoleData/useConsoleData";
import {
  resolveThreadCwd,
  useConsoleProjectLayouts,
  type ConsolePaneSetup,
  type ConsoleProjectPane,
} from "./consoleSessions";
import { resolveWsHttpOrigin } from "./wsTransport";

const DRAFT_STORAGE_KEY = "t3code:console-pane-drafts:v1";
const EMPTY_PROJECTS: ReadonlyArray<OrchestrationProject> = [];

interface AppPaletteCommand extends CommandPaletteCommand {
  run(): Promise<void> | void;
}

interface PaneView {
  readonly project: OrchestrationProject;
  readonly tabId: string;
  readonly pane: ConsoleProjectPane;
  readonly isActive: boolean;
  readonly threadId: OrchestrationThread["id"] | null;
  readonly thread: OrchestrationThread | null;
  readonly pendingThread: PendingConsoleThread | null;
  readonly setup: ConsolePaneSetup | null;
  readonly blocks: ReturnType<typeof threadToTranscriptBlocks>;
  readonly attachments: ReadonlyArray<ComposerImageAttachment>;
  readonly pendingPromptSendStartedAt: string | null;
  readonly pendingUserInput: ReturnType<ReturnType<typeof useConsoleData>["getPendingUserInputs"]>[number] | null;
  readonly pendingQuestionIndex: number;
  readonly pendingQuestion: ReturnType<ReturnType<typeof useConsoleData>["getPendingUserInputs"]>[number]["questions"][number] | null;
  readonly draftAnswers: Record<string, string>;
  readonly cwd: string | null;
  readonly interactionMode: "default" | "plan";
  readonly provider: ProviderKind;
}

interface ThreadStatusDescriptor {
  readonly tone: "working" | "waiting" | "idle" | "error";
  readonly label: string;
}

function isDesktopBridgeAvailable() {
  if (typeof window === "undefined") {
    return false;
  }
  return typeof window.desktopBridge !== "undefined";
}

function renderLoadingText(text: string) {
  const seen = new Map<string, number>();
  return Array.from(text).map((char, index) => {
    const nextCount = (seen.get(char) ?? 0) + 1;
    seen.set(char, nextCount);
    return (
      <span
        key={`${char === " " ? "space" : char}:${nextCount}`}
        className="loading-screen__char"
        style={{ animationDelay: `${index * 0.028}s` }}
      >
        {char === " " ? "\u00A0" : char}
      </span>
    );
  });
}

function truncateTitle(text: string, maxLength = 50) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function formatElapsedCompact(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0s";
  }
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function getThreadFirstPrompt(thread: OrchestrationThread) {
  return thread.messages.find((message) => message.role === "user" && message.text.trim().length > 0)?.text.trim()
    ?? thread.title;
}

function getThreadSortValue(thread: OrchestrationThread) {
  const candidates = [
    thread.updatedAt,
    thread.createdAt,
    thread.latestTurn?.completedAt ?? null,
    thread.latestTurn?.startedAt ?? null,
    thread.latestTurn?.requestedAt ?? null,
    thread.session?.updatedAt ?? null,
  ];
  return Math.max(
    ...candidates
      .map(parseTimestampMs)
      .filter((value) => Number.isFinite(value)),
    0,
  );
}

function getThreadStatus(
  thread: OrchestrationThread,
  nowIso: string,
  isThreadTurnRunning: boolean,
): ThreadStatusDescriptor {
  if (thread.session?.lastError) {
    return { tone: "error", label: "error" };
  }

  const nowMs = parseTimestampMs(nowIso);
  if (isThreadTurnRunning || thread.latestTurn?.state === "running") {
    const startedAt = parseTimestampMs(
      thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? thread.updatedAt,
    );
    return {
      tone: "working",
      label: `working ${formatElapsedCompact(nowMs - startedAt)}`,
    };
  }

  const waitingFrom = parseTimestampMs(
    thread.latestTurn?.completedAt ?? thread.latestTurn?.startedAt ?? thread.updatedAt,
  );
  if (Number.isFinite(waitingFrom)) {
    return {
      tone: "waiting",
      label: `waiting ${formatElapsedCompact(nowMs - waitingFrom)}`,
    };
  }

  return { tone: "idle", label: "idle" };
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function readPersistedPaneDrafts() {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function persistPaneDrafts(draftsByPaneId: Record<string, string>) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draftsByPaneId));
}

function DraftPaneHeader(props: {
  readonly setup: ConsolePaneSetup;
  readonly busy: boolean;
  onSelectProvider(provider: ProviderKind): void;
}) {
  const options: ReadonlyArray<{ readonly provider: ProviderKind; readonly label: string }> = [
    { provider: "codex", label: "Codex" },
    { provider: "copilot", label: "Copilot" },
  ];

  return (
    <div className="draft-pane-header">
      <div className="draft-pane-header__meta">
        <span className="draft-pane-header__eyebrow">draft</span>
        <span className="draft-pane-header__detail">
          provider {props.setup.selectedProvider} · mode {props.setup.interactionMode}
        </span>
      </div>
      <div className="draft-pane-header__providers" role="group" aria-label="Draft provider">
        {options.map((option) => (
          <button
            key={option.provider}
            type="button"
            className={`draft-pane-header__provider${option.provider === props.setup.selectedProvider ? " draft-pane-header__provider--active" : ""}`}
            disabled={props.busy}
            onClick={() => props.onSelectProvider(option.provider)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyWorkspaceSurface(props: {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly disabled?: boolean;
  onAction?(): void;
}) {
  return (
    <div className="empty-workspace" role="status" aria-live="polite">
      <div className="empty-workspace__content">
        <div className="empty-workspace__row">
          <span className="thread-setup__line">{props.title}</span>
        </div>
        <div className="empty-workspace__row">
          <span className="thread-setup__line thread-setup__line--muted">{props.detail}</span>
        </div>
        {props.onAction && props.actionLabel ? (
          <div className="empty-workspace__row">
            <button
              type="button"
              className="thread-setup__option thread-setup__option--active empty-workspace__action"
              onClick={props.onAction}
              disabled={props.disabled}
            >
              <span className="thread-setup__text">{props.actionLabel}</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function shouldRetainPendingPromptSend(input: {
  readonly thread: OrchestrationThread | null;
  readonly startedAt: string;
  readonly hasPendingThreadHistory: boolean;
  readonly isThreadTurnRunning: boolean;
}) {
  if (!input.thread) {
    return input.hasPendingThreadHistory;
  }

  if (input.isThreadTurnRunning) {
    return false;
  }

  return !input.thread.activities.some((activity) =>
    activity.kind === "provider.turn.start.failed" && activity.createdAt >= input.startedAt
  );
}

export function App() {
  const isDesktop = useMemo(isDesktopBridgeAvailable, []);
  const consoleData = useConsoleData();
  const projects = useMemo(
    () => consoleData.snapshot?.projects ?? EMPTY_PROJECTS,
    [consoleData.snapshot?.projects],
  );
  const workspace = useConsoleProjectLayouts({
    threads: consoleData.threads,
    projects,
    preferredThreadId: consoleData.activeThreadId,
  });

  const getPendingUserInputs = consoleData.getPendingUserInputs;
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

  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [pendingPromptSendStartedAtByThreadId, setPendingPromptSendStartedAtByThreadId] = useState<Record<string, string>>({});
  const [composerAttachmentsByPaneId, setComposerAttachmentsByPaneId] = useState<Record<string, ReadonlyArray<ComposerImageAttachment>>>({});
  const [composerDraftByPaneId, setComposerDraftByPaneId] = useState<Record<string, string>>(() => readPersistedPaneDrafts());
  const [pendingThreadByPaneId, setPendingThreadByPaneId] = useState<
    Record<string, { readonly threadId: OrchestrationThread["id"]; readonly pendingThread: PendingConsoleThread }>
  >({});
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<Record<string, Record<string, string>>>({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] = useState<Record<string, number>>({});
  const [pendingDraftPaneIds, setPendingDraftPaneIds] = useState<ReadonlySet<string>>(() => new Set());
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);
  const [highlightedPaneId, setHighlightedPaneId] = useState<string | null>(null);
  const paneRefs = useRef<Record<string, TranscriptRendererHandle | null>>({});
  const initializedPaneIdsRef = useRef<Record<string, true>>({});
  const hasInitiallyFocusedPromptRef = useRef(false);
  const composerAttachmentsRef = useRef(composerAttachmentsByPaneId);
  composerAttachmentsRef.current = composerAttachmentsByPaneId;

  useEffect(() => {
    const handle = window.setInterval(() => {
      setNowIso(new Date().toISOString());
    }, 1000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    persistPaneDrafts(composerDraftByPaneId);
  }, [composerDraftByPaneId]);

  const orderedThreadsByProjectId = useMemo(() => {
    const map = new Map<string, OrchestrationThread[]>();
    for (const project of projects.filter((project) => project.deletedAt === null)) {
      map.set(project.id, []);
    }
    for (const thread of consoleData.threads.filter((thread) => thread.deletedAt === null)) {
      const bucket = map.get(thread.projectId);
      if (bucket) {
        bucket.push(thread);
      }
    }
    for (const bucket of map.values()) {
      bucket.sort((left, right) => getThreadSortValue(right) - getThreadSortValue(left));
    }
    return map;
  }, [consoleData.threads, projects]);

  const livePaneIds = useMemo(() => {
    const ids: string[] = [];
    for (const projectView of workspace.projectViews) {
      for (const tab of projectView.layout.tabs) {
        ids.push(...tab.paneIds);
      }
    }
    return ids;
  }, [workspace.projectViews]);

  const liveDraftPaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const projectView of workspace.projectViews) {
      for (const pane of Object.values(projectView.layout.panesById)) {
        if (pane.kind === "draft") {
          ids.add(pane.id);
        }
      }
    }
    return ids;
  }, [workspace.projectViews]);

  useEffect(() => {
    const livePaneIdSet = new Set(livePaneIds);

    setComposerAttachmentsByPaneId((existing) => {
      const next = Object.fromEntries(Object.entries(existing).filter(([paneId]) => livePaneIdSet.has(paneId)));
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });
    setPendingThreadByPaneId((existing) => {
      const next = Object.fromEntries(Object.entries(existing).filter(([paneId]) => livePaneIdSet.has(paneId)));
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });
    setComposerDraftByPaneId((existing) => {
      const next = Object.fromEntries(
        Object.entries(existing).filter(([paneId, value]) => liveDraftPaneIds.has(paneId) && value.length > 0),
      );
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });

    for (const paneId of Object.keys(initializedPaneIdsRef.current)) {
      if (!livePaneIdSet.has(paneId)) {
        delete initializedPaneIdsRef.current[paneId];
        delete paneRefs.current[paneId];
      }
    }
  }, [liveDraftPaneIds, livePaneIds]);

  useEffect(() => {
    if (!workspace.activeThreadId || consoleData.activeThreadId === workspace.activeThreadId) {
      return;
    }
    consoleData.setActiveThreadId(workspace.activeThreadId);
  }, [consoleData, workspace.activeThreadId]);

  useEffect(() => {
    setPendingThreadByPaneId((existing) => {
      let changed = false;
      const next: Record<string, { readonly threadId: OrchestrationThread["id"]; readonly pendingThread: PendingConsoleThread }> = {};
      for (const [paneId, pendingThread] of Object.entries(existing)) {
        const paneStillPending = workspace.projectViews.some((projectView) =>
          Object.values(projectView.layout.panesById).some(
            (pane) => pane.id === paneId
              && pane.kind === "thread"
              && pane.threadId === pendingThread.threadId
              && !consoleData.threads.some((thread) => thread.id === pane.threadId),
          ),
        );
        if (paneStillPending) {
          next[paneId] = pendingThread;
        } else {
          changed = true;
        }
      }
      return changed ? next : existing;
    });
  }, [consoleData.threads, workspace.projectViews]);

  useEffect(() => {
    setPendingPromptSendStartedAtByThreadId((existing) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [threadId, startedAt] of Object.entries(existing)) {
        const thread = consoleData.threads.find((candidate) => candidate.id === threadId) ?? null;
        const keep = shouldRetainPendingPromptSend({
          thread,
          startedAt,
          hasPendingThreadHistory: Object.values(pendingThreadByPaneId).some((candidate) => candidate.threadId === threadId),
          isThreadTurnRunning: thread ? isThreadTurnRunning(thread.id) : false,
        });
        if (keep) {
          next[threadId] = startedAt;
        } else {
          changed = true;
        }
      }
      return changed ? next : existing;
    });
  }, [consoleData.threads, isThreadTurnRunning, pendingThreadByPaneId]);

  const focusPanePrompt = useCallback((paneId: string | null) => {
    if (!paneId || paletteOpen) {
      return;
    }
    requestAnimationFrame(() => {
      paneRefs.current[paneId]?.focusPrompt({ reveal: true });
    });
  }, [paletteOpen]);

  useEffect(() => {
    if (!workspace.activePaneId || paletteOpen) {
      return;
    }
    if (!hasInitiallyFocusedPromptRef.current) {
      hasInitiallyFocusedPromptRef.current = true;
    }
    focusPanePrompt(workspace.activePaneId);
  }, [focusPanePrompt, paletteOpen, workspace.activePaneId]);

  const setComposerDraftForPane = useCallback((paneId: string, value: string) => {
    setComposerDraftByPaneId((existing) => (existing[paneId] === value ? existing : { ...existing, [paneId]: value }));
  }, []);

  const handleAddImageFilesForPane = useCallback((paneId: string, files: ReadonlyArray<File>) => {
    if (files.length === 0) {
      return;
    }

    const existingAttachments = [...(composerAttachmentsRef.current[paneId] ?? [])];
    const accepted: ComposerImageAttachment[] = [];
    let nextCount = existingAttachments.length;
    const dedupKeys = new Set(existingAttachments.map((attachment) => composerImageDedupKey(attachment)));
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
  }, []);

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

  const activeLayout = workspace.activeLayout;
  const activeTab = workspace.activeTab;
  const attachmentPreviewBaseUrl = useMemo(resolveWsHttpOrigin, []);

  const paneViews = useMemo<ReadonlyArray<PaneView>>(() => {
    const activeProject = workspace.activeProject;
    if (!activeProject || !activeLayout || !activeTab) {
      return [];
    }

    return activeTab.paneIds
      .flatMap((paneId) => {
        const pane = activeLayout.panesById[paneId];
        if (!pane) {
          return [];
        }
        const thread = pane.kind === "thread"
          ? consoleData.threads.find((candidate) => candidate.id === pane.threadId) ?? null
          : null;
        const pendingThreadEntry = pendingThreadByPaneId[pane.id] ?? null;
        const pendingThread = pendingThreadEntry?.pendingThread ?? null;
        const pendingUserInput = pane.kind === "thread" ? (getPendingUserInputs(pane.threadId)[0] ?? null) : null;
        const pendingQuestionIndex = pendingUserInput
          ? pendingUserInputQuestionIndexByRequestId[pendingUserInput.requestId] ?? 0
          : 0;
        const pendingQuestion = pendingUserInput?.questions[pendingQuestionIndex] ?? null;
        const provider: ProviderKind = thread?.provider
          ?? pendingThread?.provider
          ?? (pane.kind === "draft" ? pane.setup.selectedProvider : "codex");
        const effectiveNow = thread && (isThreadTurnRunning(thread.id) || pendingPromptSendStartedAtByThreadId[thread.id])
          ? nowIso
          : undefined;
        const blocks = thread
          ? threadToTranscriptBlocks(thread, {
              resolveAttachmentPreviewUrl: (attachmentId) =>
                `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
              orchestrationEvents: getThreadEvents(thread.id),
              ...(effectiveNow ? { now: effectiveNow } : {}),
            })
          : [];
        const pendingPromptSendStartedAt = pane.kind === "thread"
          ? pendingPromptSendStartedAtByThreadId[pane.threadId] ?? null
          : null;

        return [{
          project: activeProject,
          tabId: activeTab.id,
          pane,
          isActive: activeTab.activePaneId === pane.id,
          threadId: pane.kind === "thread" ? pane.threadId : null,
          thread,
          pendingThread,
          setup: pane.kind === "draft" ? pane.setup : null,
          blocks: thread && pendingPromptSendStartedAt && effectiveNow && !isThreadTurnRunning(thread.id)
            ? [
                ...blocks,
                {
                  type: "sending-state" as const,
                  startedAt: pendingPromptSendStartedAt,
                  now: effectiveNow,
                },
              ]
            : blocks,
          attachments: composerAttachmentsByPaneId[pane.id] ?? [],
          pendingPromptSendStartedAt,
          pendingUserInput,
          pendingQuestionIndex,
          pendingQuestion,
          draftAnswers: pendingUserInput ? (pendingUserInputAnswersByRequestId[pendingUserInput.requestId] ?? {}) : {},
          cwd: thread
            ? resolveThreadCwd(thread, projects)
            : (pendingThread?.worktreePath ?? (pane.kind === "draft" ? pane.setup.worktreePath : null) ?? activeProject.workspaceRoot),
          interactionMode: thread?.interactionMode ?? pendingThread?.interactionMode ?? (pane.kind === "draft" ? pane.setup.interactionMode : "default"),
          provider,
        } satisfies PaneView];
      });
  }, [
    activeLayout,
    activeTab,
    attachmentPreviewBaseUrl,
    composerAttachmentsByPaneId,
    consoleData.threads,
    getPendingUserInputs,
    getThreadEvents,
    isThreadTurnRunning,
    nowIso,
    pendingPromptSendStartedAtByThreadId,
    pendingThreadByPaneId,
    pendingUserInputAnswersByRequestId,
    pendingUserInputQuestionIndexByRequestId,
    projects,
    workspace.activeProject,
  ]);

  const activePaneView = useMemo(
    () => paneViews.find((paneView) => paneView.isActive) ?? null,
    [paneViews],
  );

  const openPalette = useCallback(() => {
    setPaletteOpen(true);
    setPaletteQuery("");
    setSelectedCommandIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteQuery("");
    setSelectedCommandIndex(0);
    focusPanePrompt(workspace.activePaneId);
  }, [focusPanePrompt, workspace.activePaneId]);

  const highlightPane = useCallback((paneId: string) => {
    setHighlightedPaneId(paneId);
    window.setTimeout(() => {
      setHighlightedPaneId((current) => (current === paneId ? null : current));
    }, 1400);
  }, []);

  const handleCreateDraftTab = useCallback(() => {
    const projectId = workspace.activeProject?.id ?? workspace.projectViews[0]?.project.id ?? null;
    if (!projectId) {
      setSubmitError("No project is available.");
      return;
    }
    const created = workspace.createDraftTab({ projectId });
    if (!created) {
      return;
    }
    setSubmitError(null);
    focusPanePrompt(created.paneId);
  }, [focusPanePrompt, workspace]);

  const handleSplitActivePane = useCallback(() => {
    if (!workspace.activeProject || !workspace.activePaneId) {
      return;
    }
    const created = workspace.splitPane({
      projectId: workspace.activeProject.id,
      paneId: workspace.activePaneId,
    });
    if (created) {
      focusPanePrompt(created.paneId);
    }
  }, [focusPanePrompt, workspace]);

  const handleCloseTab = useCallback(() => {
    if (!workspace.activeProject || !workspace.activeTab) {
      return;
    }
    workspace.closeTab(workspace.activeProject.id, workspace.activeTab.id);
  }, [workspace]);

  const handleOpenThread = useCallback((threadId: ThreadId) => {
    const result = workspace.openThread(threadId);
    if (!result) {
      return;
    }
    focusPanePrompt(result.paneId);
    if (result.highlightPane) {
      highlightPane(result.paneId);
    }
  }, [focusPanePrompt, highlightPane, workspace]);

  const handleSubmit = useCallback(async (paneView: PaneView, value: string) => {
    const attachmentSnapshot = [...(composerAttachmentsRef.current[paneView.pane.id] ?? [])];

    try {
      if (paneView.pendingUserInput) {
        if (attachmentSnapshot.length > 0) {
          throw new Error("Image attachments are not supported while a user-input request is pending.");
        }
        if (!paneView.pendingQuestion || !paneView.threadId) {
          throw new Error("Pending user input is missing an active question.");
        }

        const answer = resolvePendingUserInputAnswer(value, paneView.pendingQuestion);
        if (!answer) {
          throw new Error("Type an answer or enter an option number for the active user-input question.");
        }

        const nextAnswers = {
          ...paneView.draftAnswers,
          [paneView.pendingQuestion.id]: answer,
        };

        if (paneView.pendingQuestionIndex < paneView.pendingUserInput.questions.length - 1) {
          setPendingUserInputAnswersByRequestId((existing) => ({
            ...existing,
            [paneView.pendingUserInput!.requestId]: nextAnswers,
          }));
          setPendingUserInputQuestionIndexByRequestId((existing) => ({
            ...existing,
            [paneView.pendingUserInput!.requestId]: paneView.pendingQuestionIndex + 1,
          }));
          setSubmitError(null);
          return;
        }

        await respondToUserInput(paneView.threadId, paneView.pendingUserInput.requestId, nextAnswers);
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [paneView.pendingUserInput!.requestId]: nextAnswers,
        }));
        setSubmitError(null);
        return;
      }

      if (paneView.pane.kind === "draft") {
        const prompt = value.trim();
        if (prompt.length === 0 && attachmentSnapshot.length === 0) {
          return;
        }

        setPendingDraftPaneIds((existing) => new Set(existing).add(paneView.pane.id));
        const created = await createThread({
          projectId: paneView.project.id,
          provider: paneView.pane.setup.selectedProvider,
          title: truncateTitle(prompt || "New thread"),
          interactionMode: paneView.pane.setup.interactionMode,
          branch: paneView.pane.setup.branch,
          worktreePath: paneView.pane.setup.worktreePath,
          createdAt: paneView.pane.setup.createdAt,
        });

        workspace.mountThreadInPane({
          projectId: paneView.project.id,
          paneId: paneView.pane.id,
          threadId: created.threadId,
        });
        setPendingThreadByPaneId((existing) => ({
          ...existing,
          [paneView.pane.id]: {
            threadId: created.threadId,
            pendingThread: created.pendingThread,
          },
        }));
        setPendingPromptSendStartedAtByThreadId((existing) => ({
          ...existing,
          [created.threadId]: new Date().toISOString(),
        }));

        try {
          await submitPrompt({
            threadId: created.threadId,
            pendingThread: created.pendingThread,
            prompt: value,
            attachments: await Promise.all(attachmentSnapshot.map(toUploadImageAttachment)),
          });
        } catch (submitError) {
          setPendingPromptSendStartedAtByThreadId((existing) => {
            const next = { ...existing };
            delete next[created.threadId];
            return next;
          });
          throw submitError;
        }

        for (const attachment of attachmentSnapshot) {
          revokeComposerImageAttachmentPreview(attachment);
        }
        setComposerAttachmentsByPaneId((existing) => ({
          ...existing,
          [paneView.pane.id]: [],
        }));
        setComposerDraftByPaneId((existing) => {
          const next = { ...existing };
          delete next[paneView.pane.id];
          return next;
        });
        setSubmitError(null);
        return;
      }

      if (!paneView.threadId) {
        throw new Error("No orchestration thread is available.");
      }

      const sendingStartedAt = new Date().toISOString();
      setPendingPromptSendStartedAtByThreadId((existing) => ({
        ...existing,
        [paneView.threadId!]: sendingStartedAt,
      }));
      try {
        await submitPrompt({
          threadId: paneView.threadId,
          pendingThread: paneView.pendingThread,
          prompt: value,
          attachments: await Promise.all(attachmentSnapshot.map(toUploadImageAttachment)),
        });
      } catch (submitError) {
        setPendingPromptSendStartedAtByThreadId((existing) => {
          const next = { ...existing };
          delete next[paneView.threadId!];
          return next;
        });
        throw submitError;
      }

      for (const attachment of attachmentSnapshot) {
        revokeComposerImageAttachmentPreview(attachment);
      }
      setComposerAttachmentsByPaneId((existing) => ({
        ...existing,
        [paneView.pane.id]: [],
      }));
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to submit prompt.");
    } finally {
      if (paneView.pane.kind === "draft") {
        setPendingDraftPaneIds((existing) => {
          const next = new Set(existing);
          next.delete(paneView.pane.id);
          return next;
        });
      }
    }
  }, [createThread, respondToUserInput, submitPrompt, workspace]);

  const paletteCommands = useMemo<AppPaletteCommand[]>(() => {
    const commands: AppPaletteCommand[] = [];
    const canDispatchBackendCommands = consoleData.connectionState === "connected";

    for (const projectView of workspace.projectViews) {
      commands.push({
        id: `project:${projectView.project.id}`,
        label:
          projectView.project.id === workspace.activeProject?.id
            ? `[Project] Current · ${projectView.project.title}`
            : `[Project] Focus · ${projectView.project.title}`,
        contextText: projectView.project.workspaceRoot,
        keywords: ["project", projectView.project.title, projectView.project.workspaceRoot],
        run: () => {
          workspace.activateProject(projectView.project.id);
          focusPanePrompt(projectView.layout.tabs.find((tab) => tab.id === projectView.layout.activeTabId)?.activePaneId ?? null);
        },
      });

      for (const thread of orderedThreadsByProjectId.get(projectView.project.id) ?? []) {
        commands.push({
          id: `thread:${thread.id}`,
          label: `[Thread] Open · ${thread.title}`,
          contextText: projectView.project.title,
          keywords: ["thread", thread.title, getThreadFirstPrompt(thread), projectView.project.title],
          run: () => handleOpenThread(thread.id),
        });
      }
    }

    if (canDispatchBackendCommands && workspace.projectViews.length > 0) {
      commands.push({
        id: "tab:new",
        label: "[Tab] New",
        keywords: ["tab", "new", "draft"],
        run: handleCreateDraftTab,
      });
    }

    if (workspace.activeProject && workspace.activePaneId) {
      commands.push({
        id: "pane:split",
        label: "[Pane] Split active",
        keywords: ["pane", "split", "draft"],
        run: handleSplitActivePane,
      });
      commands.push({
        id: "pane:close",
        label: "[Pane] Close active",
        keywords: ["pane", "close"],
        run: () => workspace.closePane(workspace.activeProject!.id, workspace.activePaneId!),
      });
    }

    if (workspace.activeProject && workspace.activeTab && workspace.activeLayout?.tabs.length && workspace.activeLayout.tabs.length > 1) {
      commands.push({
        id: "tab:close",
        label: "[Tab] Close active",
        keywords: ["tab", "close"],
        run: handleCloseTab,
      });
    }

    if (activePaneView?.setup) {
      for (const provider of ["codex", "copilot"] satisfies ProviderKind[]) {
        commands.push({
          id: `draft-provider:${provider}`,
          label:
            activePaneView.setup.selectedProvider === provider
              ? `[Draft] Provider · ${provider} · current`
              : `[Draft] Provider · ${provider}`,
          keywords: ["draft", "provider", provider],
          run: () => {
            workspace.updateDraftPane({
              paneId: activePaneView.pane.id,
              updater: (setup) => ({ ...setup, selectedProvider: provider }),
            });
          },
        });
      }
    }

    if (activePaneView?.thread && canDispatchBackendCommands) {
      const activeThread = activePaneView.thread;
      const activeProvider = activeThread.provider;
      const activeReasoningEffort = activeThread.modelOptions?.[activeProvider]?.reasoningEffort ?? null;
      const activeReasoningOptions = REASONING_EFFORT_OPTIONS_BY_PROVIDER[activeProvider];

      for (const modelOption of MODEL_OPTIONS_BY_PROVIDER[activeProvider]) {
        commands.push({
          id: `model:${activeThread.id}:${modelOption.slug}`,
          label:
            activeThread.model === modelOption.slug
              ? `[Model] Current · ${modelOption.name}`
              : `[Model] Set · ${modelOption.name}`,
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
              ? "[Reasoning] Current · default"
              : "[Reasoning] Set · default",
          keywords: ["reasoning", "default", activeProvider],
          run: () => setThreadReasoningEffort(activeThread.id, activeProvider, null),
        });
        for (const option of activeReasoningOptions) {
          commands.push({
            id: `reasoning:${activeThread.id}:${option}`,
            label:
              activeReasoningEffort === option
                ? `[Reasoning] Current · ${option}`
                : `[Reasoning] Set · ${option}`,
            keywords: ["reasoning", option, activeProvider],
            run: () => setThreadReasoningEffort(activeThread.id, activeProvider, option),
          });
        }
      }

      commands.push(
        {
          id: `mode:${activeThread.id}:default`,
          label: "[Mode] Set · default",
          keywords: ["mode", "default"],
          run: () => setInteractionMode(activeThread.id, "default"),
        },
        {
          id: `mode:${activeThread.id}:plan`,
          label: "[Mode] Set · plan",
          keywords: ["mode", "plan"],
          run: () => setInteractionMode(activeThread.id, "plan"),
        },
        {
          id: `session:${activeThread.id}:stop`,
          label: "[Session] Stop active",
          keywords: ["session", "stop"],
          run: () => stopSession(activeThread.id),
        },
      );

      if (isThreadTurnRunning(activeThread.id) && !consoleData.isInterruptingTurn && !consoleData.isStoppingSession) {
        commands.push({
          id: `turn:${activeThread.id}:interrupt`,
          label: "[Turn] Interrupt active",
          keywords: ["turn", "interrupt", "stop"],
          run: () => interruptTurn(activeThread.id),
        });
      }
    }

    return commands;
  }, [
    activePaneView,
    consoleData.connectionState,
    consoleData.isInterruptingTurn,
    consoleData.isStoppingSession,
    focusPanePrompt,
    handleCloseTab,
    handleCreateDraftTab,
    handleOpenThread,
    handleSplitActivePane,
    interruptTurn,
    isThreadTurnRunning,
    orderedThreadsByProjectId,
    setInteractionMode,
    setThreadModel,
    setThreadReasoningEffort,
    stopSession,
    workspace,
  ]);

  const filteredCommands = useMemo(
    () => filterCommandPaletteCommands(paletteCommands, paletteQuery),
    [paletteCommands, paletteQuery],
  );

  useEffect(() => {
    setSelectedCommandIndex((current) => Math.min(current, Math.max(filteredCommands.length - 1, 0)));
  }, [filteredCommands.length]);

  const runPaletteCommand = useCallback(async (command: AppPaletteCommand) => {
    closePalette();
    await command.run();
  }, [closePalette]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (paletteOpen) {
          closePalette();
        } else {
          openPalette();
        }
        return;
      }

      if (paletteOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePalette();
        }
        return;
      }

      if (!workspace.activePaneId || isEditableTarget(event.target)) {
        return;
      }

      if (
        typeof window !== "undefined"
        && typeof document !== "undefined"
        && hasNonCollapsedSelectionInsideElement(window.getSelection(), document.body)
      ) {
        return;
      }

      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
        event.preventDefault();
        paneRefs.current[workspace.activePaneId]?.insertPromptText(event.key);
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        paneRefs.current[workspace.activePaneId]?.deletePromptBackward();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closePalette, openPalette, paletteOpen, workspace.activePaneId]);

  const footerText = useMemo(() => {
    if (!workspace.activeProject) {
      return submitError ?? "No project loaded.";
    }

    const paneView = activePaneView;
    if (!paneView) {
      return submitError ?? `${workspace.activeProject.title} · ${workspace.activeProject.workspaceRoot}`;
    }

    if (paneView.setup) {
      return submitError
        ?? `Draft · ${paneView.setup.selectedProvider} · ${paneView.cwd ?? workspace.activeProject.workspaceRoot}`;
    }

    if (paneView.thread) {
      return submitError
        ?? `${paneView.thread.title} · ${paneView.thread.provider} · ${paneView.thread.model ?? DEFAULT_MODEL_BY_PROVIDER[paneView.thread.provider]} · ${paneView.cwd ?? workspace.activeProject.workspaceRoot}`;
    }

    return submitError ?? `${workspace.activeProject.title} · ${workspace.activeProject.workspaceRoot}`;
  }, [activePaneView, submitError, workspace.activeProject]);

  const shellClassName = `console-shell${isDesktop ? " console-shell--desktop" : ""}`;
  const activePaneGridClassName = activeTab
    ? `project-pane-grid project-pane-grid--${Math.min(Math.max(activeTab.paneIds.length, 1), 6)}`
    : "project-pane-grid project-pane-grid--1";

  if (!consoleData.snapshot && !consoleData.error) {
    return (
      <>
        <div className="bg-image" aria-hidden="true" />
        <div className="bg-gradient" aria-hidden="true" />
        <div className={shellClassName}>
          <div className="loading-screen loading-screen--shell">
            <span className="loading-screen__text">{renderLoadingText("connecting to orchestration")}</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bg-image" aria-hidden="true" />
      <div className="bg-gradient" aria-hidden="true" />
      <div className={shellClassName}>
        <div className="project-workspace">
          <aside className="project-sidebar" style={{ width: workspace.sidebarWidth }}>
            <div className="project-sidebar__toolbar">
              <button type="button" className="project-sidebar__toolbarButton" onClick={handleCreateDraftTab}>
                + tab
              </button>
              <span className="project-sidebar__origin">{resolveWsHttpOrigin()}</span>
            </div>
            <div className="project-tree" role="tree" aria-label="Projects">
              {workspace.projectViews.map((projectView) => {
                const threads = orderedThreadsByProjectId.get(projectView.project.id) ?? [];
                const isActiveProject = projectView.project.id === workspace.activeProject?.id;

                return (
                  <section
                    key={projectView.project.id}
                    className={`project-tree__section${isActiveProject ? " project-tree__section--active" : ""}`}
                    draggable
                    onDragStart={() => setDraggedProjectId(projectView.project.id)}
                    onDragOver={(event) => {
                      if (!draggedProjectId || draggedProjectId === projectView.project.id) {
                        return;
                      }
                      event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!draggedProjectId || draggedProjectId === projectView.project.id) {
                        return;
                      }
                      const reordered = workspace.projectViews.map((view) => view.project.id).filter((id) => id !== draggedProjectId);
                      const targetIndex = reordered.indexOf(projectView.project.id);
                      reordered.splice(targetIndex, 0, draggedProjectId as OrchestrationProject["id"]);
                      workspace.reorderProjects(reordered);
                      setDraggedProjectId(null);
                    }}
                    onDragEnd={() => setDraggedProjectId(null)}
                  >
                    <div className="project-tree__header">
                      <button
                        type="button"
                        className="project-tree__toggle"
                        onClick={() => workspace.toggleProjectCollapsed(projectView.project.id)}
                        aria-label={projectView.collapsed ? "Expand project" : "Collapse project"}
                      >
                        {projectView.collapsed ? "+" : "−"}
                      </button>
                      <button
                        type="button"
                        className="project-tree__projectButton"
                        onClick={() => {
                          workspace.activateProject(projectView.project.id);
                          focusPanePrompt(
                            projectView.layout.tabs.find((tab) => tab.id === projectView.layout.activeTabId)?.activePaneId ?? null,
                          );
                        }}
                      >
                        <span className="project-tree__projectTitle">{projectView.project.title}</span>
                        <span className="project-tree__projectMeta">{threads.length}</span>
                      </button>
                    </div>
                    {!projectView.collapsed ? (
                      <div className="project-tree__threads">
                        {threads.length === 0 ? (
                          <div className="project-tree__empty">No threads yet.</div>
                        ) : threads.map((thread) => {
                          const status = getThreadStatus(thread, nowIso, isThreadTurnRunning(thread.id));
                          const tooltip = getThreadFirstPrompt(thread);
                          const mounted = projectView.layout.tabs.some((tab) =>
                            tab.paneIds.some((paneId) => {
                              const pane = projectView.layout.panesById[paneId];
                              return pane?.kind === "thread" && pane.threadId === thread.id;
                            })
                          );

                          return (
                            <button
                              key={thread.id}
                              type="button"
                              className={`project-thread${thread.id === workspace.activeThreadId ? " project-thread--active" : ""}${mounted ? " project-thread--mounted" : ""}`}
                              title={tooltip}
                              draggable
                              onDragStart={() => setDraggedThreadId(thread.id)}
                              onDragEnd={() => setDraggedThreadId(null)}
                              onClick={() => handleOpenThread(thread.id)}
                            >
                              <span className="project-thread__title">{thread.title}</span>
                              <span className={`project-thread__status project-thread__status--${status.tone}`}>{status.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </aside>
          <div
            className="project-sidebar__resizeHandle"
            onMouseDown={(event) => {
              event.preventDefault();
              const startX = event.clientX;
              const startWidth = workspace.sidebarWidth;
              const handleMouseMove = (moveEvent: MouseEvent) => {
                workspace.setSidebarWidth(startWidth + (moveEvent.clientX - startX));
              };
              const handleMouseUp = () => {
                window.removeEventListener("mousemove", handleMouseMove);
                window.removeEventListener("mouseup", handleMouseUp);
              };
              window.addEventListener("mousemove", handleMouseMove);
              window.addEventListener("mouseup", handleMouseUp);
            }}
          />
          <main className="project-main">
            {workspace.activeProject && activeLayout && activeTab ? (
              <>
                <div className="project-tabs">
                  {activeLayout.tabs.map((tab, index) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`project-tab${tab.id === activeLayout.activeTabId ? " project-tab--active" : ""}`}
                      onClick={() => {
                        workspace.activateTab(workspace.activeProject!.id, tab.id);
                        focusPanePrompt(tab.activePaneId);
                      }}
                    >
                      <span className="project-tab__title">Tab {index + 1}</span>
                      <span className="project-tab__meta">{tab.paneIds.length}</span>
                    </button>
                  ))}
                  <button type="button" className="project-tab project-tab--create" onClick={handleCreateDraftTab}>
                    +
                  </button>
                </div>
                <div className={activePaneGridClassName}>
                  {paneViews.map((paneView) => {
                    const status = paneView.thread ? getThreadStatus(paneView.thread, nowIso, isThreadTurnRunning(paneView.thread.id)) : null;
                    const dropAllowed = draggedThreadId
                      ? (consoleData.threads.find((thread) => thread.id === draggedThreadId)?.projectId === paneView.project.id)
                      : false;

                    return (
                      <section
                        key={paneView.pane.id}
                        className={`conversation-pane${paneView.isActive ? " conversation-pane--active" : ""}${dragOverPaneId === paneView.pane.id ? " conversation-pane--drag-over" : ""}${highlightedPaneId === paneView.pane.id ? " conversation-pane--highlight" : ""}`}
                        onClick={() => workspace.activatePane(paneView.project.id, paneView.tabId, paneView.pane.id)}
                        onDragOver={(event: ReactDragEvent<HTMLElement>) => {
                          if (!dropAllowed) {
                            return;
                          }
                          event.preventDefault();
                          setDragOverPaneId(paneView.pane.id);
                        }}
                        onDragLeave={() => {
                          setDragOverPaneId((current) => (current === paneView.pane.id ? null : current));
                        }}
                        onDrop={(event: ReactDragEvent<HTMLElement>) => {
                          event.preventDefault();
                          setDragOverPaneId(null);
                          if (!draggedThreadId) {
                            return;
                          }
                          const thread = consoleData.threads.find((candidate) => candidate.id === draggedThreadId) ?? null;
                          if (!thread || thread.projectId !== paneView.project.id) {
                            return;
                          }
                          workspace.mountThreadInPane({
                            projectId: paneView.project.id,
                            paneId: paneView.pane.id,
                            threadId: draggedThreadId as ThreadId,
                          });
                          focusPanePrompt(paneView.pane.id);
                          setDraggedThreadId(null);
                        }}
                      >
                        <header className="conversation-pane__header">
                          <div className="conversation-pane__titleBlock">
                            <div className="conversation-pane__eyebrow">
                              {paneView.setup ? "Draft thread" : paneView.project.title}
                            </div>
                            <div className="conversation-pane__title">
                              {paneView.thread
                                ? paneView.thread.title
                                : paneView.setup
                                  ? "New thread"
                                  : "Loading thread"}
                            </div>
                            <div className="conversation-pane__meta">
                              {paneView.setup
                                ? `${paneView.setup.selectedProvider} · ${paneView.cwd ?? paneView.project.workspaceRoot}`
                                : paneView.thread
                                  ? `${paneView.thread.provider} · ${paneView.thread.model} · ${status?.label ?? ""}`
                                  : `${paneView.provider} · connecting`}
                            </div>
                          </div>
                          <div className="conversation-pane__actions">
                            <button type="button" className="conversation-pane__action" onClick={(event) => {
                              event.stopPropagation();
                              workspace.activatePane(paneView.project.id, paneView.tabId, paneView.pane.id);
                              handleSplitActivePane();
                            }}
                            >
                              split
                            </button>
                            <button
                              type="button"
                              className="conversation-pane__action"
                              onClick={(event) => {
                                event.stopPropagation();
                                workspace.closePane(paneView.project.id, paneView.pane.id);
                              }}
                            >
                              close
                            </button>
                          </div>
                        </header>
                        {paneView.setup ? (
                          <DraftPaneHeader
                            setup={paneView.setup}
                            busy={pendingDraftPaneIds.has(paneView.pane.id)}
                            onSelectProvider={(provider) => {
                              workspace.updateDraftPane({
                                paneId: paneView.pane.id,
                                updater: (setup) => ({ ...setup, selectedProvider: provider }),
                              });
                            }}
                          />
                        ) : null}
                        <div className="conversation-pane__body">
                          <TranscriptRenderer
                            ref={(handle) => {
                              if (!handle) {
                                delete paneRefs.current[paneView.pane.id];
                                return;
                              }
                              paneRefs.current[paneView.pane.id] = handle;
                              if (!initializedPaneIdsRef.current[paneView.pane.id]) {
                                initializedPaneIdsRef.current[paneView.pane.id] = true;
                                const persistedDraft = composerDraftByPaneId[paneView.pane.id];
                                if (persistedDraft) {
                                  handle.insertPromptText(persistedDraft);
                                }
                              }
                            }}
                            blocks={paneView.blocks}
                            composerAttachments={paneView.attachments}
                            cwd={paneView.cwd}
                            interactionMode={paneView.interactionMode}
                            promptFocusDisabled={paletteOpen}
                            {...(paneView.pendingUserInput && paneView.pendingQuestion
                                ? {
                                    pendingUserInputHighlight: {
                                      requestId: paneView.pendingUserInput.requestId,
                                      questionIndex: paneView.pendingQuestionIndex,
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
                            onSubmit={(value) => handleSubmit(paneView, value)}
                            submitDisabled={
                              pendingDraftPaneIds.has(paneView.pane.id)
                              || paneView.pendingPromptSendStartedAt !== null
                              || (paneView.threadId
                                ? !canSubmitPromptForThread(paneView.threadId, paneView.pendingThread)
                                : false)
                            }
                          />
                        </div>
                      </section>
                    );
                  })}
                </div>
              </>
            ) : projects.length === 0 ? (
              <EmptyWorkspaceSurface title="No project loaded." detail="Create or sync a project first." />
            ) : (
              <EmptyWorkspaceSurface
                title="No tab is active."
                detail="Open a draft tab to start a new thread."
                actionLabel="Open draft tab"
                onAction={handleCreateDraftTab}
              />
            )}
          </main>
        </div>
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
        onRun={(command) => void runPaletteCommand(command as AppPaletteCommand)}
      />
    </>
  );
}
