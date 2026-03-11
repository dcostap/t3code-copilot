import {
  type ApprovalRequestId,
  type CommandId,
  type MessageId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type ServerConfig,
  type UserInputQuestion,
  type WsWelcomePayload,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DemoConsoleBackend,
  LiveConsoleBackend,
  type ConsoleBackend,
  type ConsoleBackendConnectionState,
} from "../consoleBackend";

export type ConsoleSourceMode = "demo" | "live";
export type ConsoleConnectionState =
  | "demo"
  | ConsoleBackendConnectionState;

interface ConsoleSearchConfig {
  readonly mode: ConsoleSourceMode;
  readonly threadId: string | null;
}

export interface ConsolePendingApproval {
  readonly requestId: string;
  readonly requestKind: "command" | "file-read" | "file-change";
  readonly createdAt: string;
  readonly detail?: string;
}

export interface ConsolePendingUserInput {
  readonly requestId: string;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

export interface ConsoleDataState {
  readonly mode: ConsoleSourceMode;
  readonly connectionState: ConsoleConnectionState;
  readonly snapshot: OrchestrationReadModel | null;
  readonly serverConfig: ServerConfig | null;
  readonly welcome: WsWelcomePayload | null;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly activeThreadId: string | null;
  readonly thread: OrchestrationThread | null;
  readonly project: OrchestrationProject | null;
  readonly pendingApprovals: ReadonlyArray<ConsolePendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<ConsolePendingUserInput>;
  readonly isTurnRunning: boolean;
  readonly isPromptSubmitting: boolean;
  readonly canSubmitPrompt: boolean;
  readonly respondingApprovalRequestIds: ReadonlyArray<string>;
  readonly respondingUserInputRequestIds: ReadonlyArray<string>;
  readonly isInterruptingTurn: boolean;
  readonly isStoppingSession: boolean;
  readonly error: string | null;
  setActiveThreadId(threadId: string): void;
  submitPrompt(prompt: string): Promise<void>;
  respondToApproval(requestId: string, decision: ProviderApprovalDecision): Promise<void>;
  respondToUserInput(requestId: string, answers: Record<string, unknown>): Promise<void>;
  setRuntimeMode(runtimeMode: RuntimeMode): Promise<void>;
  setInteractionMode(interactionMode: ProviderInteractionMode): Promise<void>;
  interruptTurn(): Promise<void>;
  stopSession(): Promise<void>;
}

function readSearchConfig(): ConsoleSearchConfig {
  const search = new URLSearchParams(window.location.search);
  const modeQuery = search.get("source");
  const envMode = import.meta.env.VITE_CONSOLE_UI_SOURCE as string | undefined;
  const mode = modeQuery === "live" || envMode === "live" ? "live" : "demo";

  return {
    mode,
    threadId: search.get("threadId"),
  };
}

function makeId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function makeCommandId() {
  return makeId("command") as CommandId;
}

function providerFromThread(thread: OrchestrationThread | null): ProviderKind | undefined {
  if (thread?.session?.providerName === "codex" || thread?.session?.providerName === "copilot") {
    return thread.session.providerName;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compareActivitiesByOrder(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
) {
  if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  if (left.sequence !== undefined && right.sequence === undefined) {
    return 1;
  }
  if (left.sequence === undefined && right.sequence !== undefined) {
    return -1;
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function requestKindFromPayload(payload: Record<string, unknown> | null): ConsolePendingApproval["requestKind"] | null {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  switch (payload?.requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }

  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      const record = asRecord(entry);
      const id = asString(record?.id);
      const header = asString(record?.header);
      const question = asString(record?.question);
      const options = Array.isArray(record?.options) ? record.options : [];
      if (!id || !header || !question) {
        return null;
      }

      const normalizedOptions = options
        .map((option) => {
          const optionRecord = asRecord(option);
          const label = asString(optionRecord?.label);
          const description = asString(optionRecord?.description);
          if (!label || !description) {
            return null;
          }
          return { label, description };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);

      if (normalizedOptions.length === 0) {
        return null;
      }

      return {
        id,
        header,
        question,
        options: normalizedOptions,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);

  return parsed.length > 0 ? parsed : null;
}

function derivePendingApprovals(thread: OrchestrationThread | null): ConsolePendingApproval[] {
  if (!thread) return [];
  const openByRequestId = new Map<string, ConsolePendingApproval>();
  const ordered = [...thread.activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    const requestId = asString(payload?.requestId);
    if (!requestId) continue;

    if (activity.kind === "approval.requested") {
      const requestKind = requestKindFromPayload(payload);
      if (!requestKind) continue;
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(asString(payload?.detail) ? { detail: asString(payload?.detail)! } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved") {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      asString(payload?.detail)?.includes("Unknown pending permission request")
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function derivePendingUserInputs(thread: OrchestrationThread | null): ConsolePendingUserInput[] {
  if (!thread) return [];
  const openByRequestId = new Map<string, ConsolePendingUserInput>();
  const ordered = [...thread.activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    const requestId = asString(payload?.requestId);
    if (!requestId) continue;

    if (activity.kind === "user-input.requested") {
      const questions = parseUserInputQuestions(payload);
      if (!questions) continue;
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      asString(payload?.detail)?.includes("Unknown pending")
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function buildPromptAnswers(
  pendingUserInput: ConsolePendingUserInput,
  prompt: string,
): Record<string, string> | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (pendingUserInput.questions.length === 1) {
    const question = pendingUserInput.questions[0];
    if (!question) return null;
    return { [question.id]: trimmed };
  }

  const lines = trimmed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < pendingUserInput.questions.length) {
    return null;
  }

  const answers: Record<string, string> = {};
  pendingUserInput.questions.forEach((question, index) => {
    const line = lines[index];
    if (!line) return;
    const match = /^([^:]+):\s*(.+)$/.exec(line);
    answers[question.id] = match ? (match[2]?.trim() ?? "") : line;
  });

  return Object.keys(answers).length === pendingUserInput.questions.length ? answers : null;
}

function isTurnRunning(thread: OrchestrationThread | null) {
  if (!thread) return false;
  return thread.latestTurn?.state === "running" || thread.session?.status === "running";
}

function canDispatchLiveCommand(connectionState: ConsoleConnectionState) {
  return connectionState === "connected";
}

export function useConsoleData(): ConsoleDataState {
  const searchConfig = useMemo(readSearchConfig, []);
  const backend = useMemo<ConsoleBackend>(
    () => (searchConfig.mode === "demo" ? new DemoConsoleBackend() : new LiveConsoleBackend()),
    [searchConfig.mode],
  );
  const latestEventSequenceRef = useRef(0);
  const queuedSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapThreadIdRef = useRef<string | null>(null);
  const syncInFlightRef = useRef(false);
  const pendingSyncRef = useRef(false);
  const serverConfigSyncInFlightRef = useRef(false);
  const pendingServerConfigSyncRef = useRef(false);
  const promptSubmittingRef = useRef(false);
  const respondingApprovalRequestIdsRef = useRef(new Set<string>());
  const respondingUserInputRequestIdsRef = useRef(new Set<string>());
  const interruptInFlightRef = useRef(false);
  const stopSessionInFlightRef = useRef(false);

  const [snapshot, setSnapshot] = useState<OrchestrationReadModel | null>(null);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [welcome, setWelcome] = useState<WsWelcomePayload | null>(null);
  const [activeThreadId, setActiveThreadIdState] = useState<string | null>(searchConfig.threadId);
  const [connectionState, setConnectionState] = useState<ConsoleConnectionState>(
    searchConfig.mode === "demo" ? "demo" : "connecting",
  );
  const [isPromptSubmitting, setIsPromptSubmitting] = useState(false);
  const [respondingApprovalRequestIds, setRespondingApprovalRequestIds] = useState<string[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<string[]>([]);
  const [isInterruptingTurn, setIsInterruptingTurn] = useState(false);
  const [isStoppingSession, setIsStoppingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setActiveThreadId = useCallback((threadId: string) => {
    setActiveThreadIdState(threadId);
  }, []);

  useEffect(() => {
    let disposed = false;
    latestEventSequenceRef.current = 0;
    syncInFlightRef.current = false;
    pendingSyncRef.current = false;
    serverConfigSyncInFlightRef.current = false;
    pendingServerConfigSyncRef.current = false;
    promptSubmittingRef.current = false;
    respondingApprovalRequestIdsRef.current.clear();
    respondingUserInputRequestIdsRef.current.clear();
    interruptInFlightRef.current = false;
    stopSessionInFlightRef.current = false;
    setIsPromptSubmitting(false);
    setRespondingApprovalRequestIds([]);
    setRespondingUserInputRequestIds([]);
    setIsInterruptingTurn(false);
    setIsStoppingSession(false);

    const flushSnapshotSync = async (): Promise<void> => {
      const nextSnapshot = await backend.getSnapshot();
      if (disposed) return;
      if (searchConfig.mode === "live") {
        latestEventSequenceRef.current = Math.max(
          latestEventSequenceRef.current,
          nextSnapshot.snapshotSequence,
        );
      }
      setSnapshot(nextSnapshot);
      setActiveThreadIdState((current) =>
        current ??
        searchConfig.threadId ??
        bootstrapThreadIdRef.current ??
        nextSnapshot.threads[0]?.id ??
        null,
      );
      if (pendingSyncRef.current) {
        pendingSyncRef.current = false;
        await flushSnapshotSync();
      }
    };

    const syncSnapshot = async () => {
      if (syncInFlightRef.current) {
        pendingSyncRef.current = true;
        return;
      }
      syncInFlightRef.current = true;
      pendingSyncRef.current = false;
      try {
        await flushSnapshotSync();
        setError(null);
      } catch (nextError) {
        if (disposed) return;
        setError(nextError instanceof Error ? nextError.message : "Snapshot sync failed.");
      } finally {
        syncInFlightRef.current = false;
      }
    };

    const flushServerConfigSync = async (): Promise<void> => {
      const nextServerConfig = await backend.getServerConfig();
      if (disposed) return;
      setServerConfig(nextServerConfig);
      if (pendingServerConfigSyncRef.current) {
        pendingServerConfigSyncRef.current = false;
        await flushServerConfigSync();
      }
    };

    const syncServerConfig = async () => {
      if (serverConfigSyncInFlightRef.current) {
        pendingServerConfigSyncRef.current = true;
        return;
      }
      serverConfigSyncInFlightRef.current = true;
      pendingServerConfigSyncRef.current = false;
      try {
        await flushServerConfigSync();
      } catch (nextError) {
        if (disposed) return;
        setError(nextError instanceof Error ? nextError.message : "Server config sync failed.");
      } finally {
        serverConfigSyncInFlightRef.current = false;
      }
    };

    const scheduleSnapshotSync = () => {
      if (queuedSyncRef.current !== null) return;
      queuedSyncRef.current = setTimeout(() => {
        queuedSyncRef.current = null;
        void syncSnapshot();
      }, 80);
    };

    const unsubscribe = backend.subscribe((event) => {
      if (event.type === "connection.state") {
        setConnectionState(event.state);
        if (event.state === "connected") {
          void syncSnapshot();
          void syncServerConfig();
        }
        return;
      }

      if (event.type === "snapshot.updated") {
        scheduleSnapshotSync();
        return;
      }

      if (event.type === "server.welcome") {
        setWelcome(event.payload);
        if (event.payload.bootstrapThreadId) {
          bootstrapThreadIdRef.current = event.payload.bootstrapThreadId;
          setActiveThreadIdState((current) => current ?? event.payload.bootstrapThreadId ?? null);
        }
        scheduleSnapshotSync();
        return;
      }

      if (event.type === "server.config.updated") {
        void syncServerConfig();
        return;
      }

      if (event.payload.sequence <= latestEventSequenceRef.current) {
        return;
      }
      latestEventSequenceRef.current = event.payload.sequence;
      scheduleSnapshotSync();
    });

    backend.connect();

    if (searchConfig.mode === "demo") {
      setConnectionState("demo");
      void syncSnapshot();
      void syncServerConfig();
    }

    return () => {
      disposed = true;
      syncInFlightRef.current = false;
      pendingSyncRef.current = false;
      serverConfigSyncInFlightRef.current = false;
      pendingServerConfigSyncRef.current = false;
      if (queuedSyncRef.current !== null) {
        clearTimeout(queuedSyncRef.current);
        queuedSyncRef.current = null;
      }
      unsubscribe();
      backend.disconnect();
      backend.dispose();
    };
  }, [backend, searchConfig.mode, searchConfig.threadId]);

  const threads = snapshot?.threads ?? [];

  const thread = useMemo(() => {
    if (!snapshot) return null;
    const preferredThreadId = activeThreadId ?? searchConfig.threadId ?? bootstrapThreadIdRef.current;
    if (!preferredThreadId) {
      return snapshot.threads[0] ?? null;
    }
    return (
      snapshot.threads.find((entry: OrchestrationThread) => entry.id === preferredThreadId) ??
      snapshot.threads[0] ??
      null
    );
  }, [activeThreadId, searchConfig.threadId, snapshot]);

  useEffect(() => {
    if (!snapshot || !thread) return;
    setActiveThreadIdState(thread.id);
  }, [snapshot, thread]);

  const project = useMemo(() => {
    if (!snapshot || !thread) return null;
    return snapshot.projects.find((entry: OrchestrationProject) => entry.id === thread.projectId) ?? null;
  }, [snapshot, thread]);

  const pendingApprovals = useMemo(() => derivePendingApprovals(thread), [thread]);
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(thread), [thread]);
  const turnRunning = useMemo(() => isTurnRunning(thread), [thread]);
  const canSubmitPrompt = useMemo(() => {
    if (!thread) return false;
    if (isPromptSubmitting) return false;
    const activePendingUserInput = pendingUserInputs[0];
    if (
      activePendingUserInput &&
      respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    ) {
      return false;
    }
    if (pendingUserInputs.length === 0 && turnRunning) return false;
    if (searchConfig.mode === "live" && !canDispatchLiveCommand(connectionState)) return false;
    return true;
  }, [
    connectionState,
    isPromptSubmitting,
    pendingUserInputs,
    respondingUserInputRequestIds,
    searchConfig.mode,
    thread,
    turnRunning,
  ]);

  const assertLiveCommandReady = useCallback(() => {
    if (searchConfig.mode === "live" && !canDispatchLiveCommand(connectionState)) {
      throw new Error("Live backend is not connected.");
    }
  }, [connectionState, searchConfig.mode]);

  const submitPrompt = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (trimmed.length === 0) return;
      if (!thread) {
        throw new Error("No orchestration thread is available.");
      }
      assertLiveCommandReady();
      if (promptSubmittingRef.current) {
        return;
      }

      const pendingUserInput = pendingUserInputs[0];
      if (pendingUserInput) {
        const answers = buildPromptAnswers(pendingUserInput, trimmed);
        if (!answers) {
          throw new Error("Pending user input expects one answer per question.");
        }

        if (respondingUserInputRequestIdsRef.current.has(pendingUserInput.requestId)) {
          return;
        }

        respondingUserInputRequestIdsRef.current.add(pendingUserInput.requestId);
        setRespondingUserInputRequestIds((existing) =>
          existing.includes(pendingUserInput.requestId)
            ? existing
            : [...existing, pendingUserInput.requestId],
        );
        try {
          await backend.dispatchCommand({
            type: "thread.user-input.respond",
            commandId: makeCommandId(),
            threadId: thread.id,
            requestId: pendingUserInput.requestId as ApprovalRequestId,
            answers,
            createdAt: new Date().toISOString(),
          });
          return;
        } finally {
          respondingUserInputRequestIdsRef.current.delete(pendingUserInput.requestId);
          setRespondingUserInputRequestIds((existing) =>
            existing.filter((id) => id !== pendingUserInput.requestId),
          );
        }
      }

      if (turnRunning) {
        throw new Error("A turn is already running.");
      }

      promptSubmittingRef.current = true;
      setIsPromptSubmitting(true);
      try {
        const provider = providerFromThread(thread);
        await backend.dispatchCommand({
          type: "thread.turn.start",
          commandId: makeCommandId(),
          threadId: thread.id,
          message: {
            messageId: makeId("message") as MessageId,
            role: "user",
            text: trimmed,
            attachments: [],
          },
          ...(provider ? { provider } : {}),
          model: thread.model,
          assistantDeliveryMode: "streaming",
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString(),
        });
      } finally {
        promptSubmittingRef.current = false;
        setIsPromptSubmitting(false);
      }
    },
    [assertLiveCommandReady, backend, pendingUserInputs, thread, turnRunning],
  );

  const respondToApproval = useCallback(
    async (requestId: string, decision: ProviderApprovalDecision) => {
      if (!thread) {
        throw new Error("No orchestration thread is available.");
      }
      assertLiveCommandReady();
      if (respondingApprovalRequestIdsRef.current.has(requestId)) {
        return;
      }

      respondingApprovalRequestIdsRef.current.add(requestId);
      setRespondingApprovalRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        await backend.dispatchCommand({
          type: "thread.approval.respond",
          commandId: makeCommandId(),
          threadId: thread.id,
          requestId: requestId as ApprovalRequestId,
          decision,
          createdAt: new Date().toISOString(),
        });
      } finally {
        respondingApprovalRequestIdsRef.current.delete(requestId);
        setRespondingApprovalRequestIds((existing) => existing.filter((id) => id !== requestId));
      }
    },
    [assertLiveCommandReady, backend, thread],
  );

  const respondToUserInput = useCallback(
    async (requestId: string, answers: Record<string, unknown>) => {
      if (!thread) {
        throw new Error("No orchestration thread is available.");
      }
      assertLiveCommandReady();
      if (respondingUserInputRequestIdsRef.current.has(requestId)) {
        return;
      }

      respondingUserInputRequestIdsRef.current.add(requestId);
      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        await backend.dispatchCommand({
          type: "thread.user-input.respond",
          commandId: makeCommandId(),
          threadId: thread.id,
          requestId: requestId as ApprovalRequestId,
          answers,
          createdAt: new Date().toISOString(),
        });
      } finally {
        respondingUserInputRequestIdsRef.current.delete(requestId);
        setRespondingUserInputRequestIds((existing) =>
          existing.filter((id) => id !== requestId),
        );
      }
    },
    [assertLiveCommandReady, backend, thread],
  );

  const setRuntimeMode = useCallback(
    async (runtimeMode: RuntimeMode) => {
      if (!thread || thread.runtimeMode === runtimeMode) return;
      assertLiveCommandReady();

      await backend.dispatchCommand({
        type: "thread.runtime-mode.set",
        commandId: makeCommandId(),
        threadId: thread.id,
        runtimeMode,
        createdAt: new Date().toISOString(),
      });
    },
    [assertLiveCommandReady, backend, thread],
  );

  const setInteractionMode = useCallback(
    async (interactionMode: ProviderInteractionMode) => {
      if (!thread || thread.interactionMode === interactionMode) return;
      assertLiveCommandReady();

      await backend.dispatchCommand({
        type: "thread.interaction-mode.set",
        commandId: makeCommandId(),
        threadId: thread.id,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
    },
    [assertLiveCommandReady, backend, thread],
  );

  const interruptTurn = useCallback(async () => {
    if (!thread) {
      throw new Error("No orchestration thread is available.");
    }
    assertLiveCommandReady();
    if (interruptInFlightRef.current) {
      return;
    }

    interruptInFlightRef.current = true;
    setIsInterruptingTurn(true);
    try {
      await backend.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: makeCommandId(),
        threadId: thread.id,
        createdAt: new Date().toISOString(),
      });
    } finally {
      interruptInFlightRef.current = false;
      setIsInterruptingTurn(false);
    }
  }, [assertLiveCommandReady, backend, thread]);

  const stopSession = useCallback(async () => {
    if (!thread) {
      throw new Error("No orchestration thread is available.");
    }
    assertLiveCommandReady();
    if (stopSessionInFlightRef.current) {
      return;
    }

    stopSessionInFlightRef.current = true;
    setIsStoppingSession(true);
    try {
      await backend.dispatchCommand({
        type: "thread.session.stop",
        commandId: makeCommandId(),
        threadId: thread.id,
        createdAt: new Date().toISOString(),
      });
    } finally {
      stopSessionInFlightRef.current = false;
      setIsStoppingSession(false);
    }
  }, [assertLiveCommandReady, backend, thread]);

  return {
    mode: searchConfig.mode,
    connectionState,
    snapshot,
    serverConfig,
    welcome,
    threads,
    activeThreadId: thread?.id ?? null,
    thread,
    project,
    pendingApprovals,
    pendingUserInputs,
    isTurnRunning: turnRunning,
    isPromptSubmitting,
    canSubmitPrompt,
    respondingApprovalRequestIds,
    respondingUserInputRequestIds,
    isInterruptingTurn,
    isStoppingSession,
    error,
    setActiveThreadId,
    submitPrompt,
    respondToApproval,
    respondToUserInput,
    setRuntimeMode,
    setInteractionMode,
    interruptTurn,
    stopSession,
  };
}
