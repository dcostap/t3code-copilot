import {
  type ApprovalRequestId,
  type CommandId,
  type MessageId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationEvent,
  type ProviderModelOptions,
  type ProviderInteractionMode,
  type ProviderKind,
  type CodexReasoningEffort,
  type ServerConfig,
  type ThreadId,
  type UploadChatImageAttachment,
  type UserInputQuestion,
  type WsWelcomePayload,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  LiveConsoleBackend,
  type ConsoleBackend,
  type ConsoleBackendConnectionState,
} from "../consoleBackend";
import {
  formatPendingUserInputAnswersAsPrompt,
  isStaleCopilotUserInputResponseDetail,
  parsePendingUserInputAnswers,
} from "../pendingUserInput";
import { reconcileReadModelWithEvents } from "./readModelReconciliation";

export type ConsoleConnectionState = ConsoleBackendConnectionState;

interface ConsoleSearchConfig {
  readonly threadId: string | null;
}

const EMPTY_THREADS: ReadonlyArray<OrchestrationThread> = [];
const EMPTY_PENDING_USER_INPUTS: ReadonlyArray<ConsolePendingUserInput> = [];

export interface ConsolePendingUserInput {
  readonly requestId: string;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

export interface PendingConsoleThread {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly worktreePath: string | null;
}

export interface ConsoleDataState {
  readonly connectionState: ConsoleConnectionState;
  readonly snapshot: OrchestrationReadModel | null;
  readonly serverConfig: ServerConfig | null;
  readonly welcome: WsWelcomePayload | null;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly activeThreadId: string | null;
  readonly thread: OrchestrationThread | null;
  readonly project: OrchestrationProject | null;
  readonly pendingUserInputs: ReadonlyArray<ConsolePendingUserInput>;
  readonly isTurnRunning: boolean;
  readonly isPromptSubmitting: boolean;
  readonly canSubmitPrompt: boolean;
  readonly respondingUserInputRequestIds: ReadonlyArray<string>;
  readonly isInterruptingTurn: boolean;
  readonly isStoppingSession: boolean;
  readonly error: string | null;
  setActiveThreadId(threadId: string): void;
  createProject(input: {
    workspaceRoot: string;
    title?: string;
    defaultModel?: string;
  }): Promise<{ projectId: OrchestrationProject["id"] }>;
  createThread(input?: {
    projectId: OrchestrationProject["id"];
    provider: ProviderKind;
    title?: string;
    model?: string;
    interactionMode?: ProviderInteractionMode;
    branch?: string | null;
    worktreePath?: string | null;
    createdAt?: string;
  }): Promise<{ threadId: ThreadId; pendingThread: PendingConsoleThread }>;
  getThreadEvents(threadId: string | null): ReadonlyArray<OrchestrationEvent>;
  getPendingUserInputs(threadId: string | null): ReadonlyArray<ConsolePendingUserInput>;
  getProjectForThread(threadId: string | null): OrchestrationProject | null;
  getTurnDiff(input: {
    threadId: ThreadId;
    fromTurnCount: number;
    toTurnCount: number;
  }): Promise<string>;
  isThreadTurnRunning(threadId: string | null): boolean;
  canSubmitPromptForThread(threadId: string | null, pendingThread?: PendingConsoleThread | null): boolean;
  submitPrompt(input: {
    threadId: string;
    prompt: string;
    attachments?: ReadonlyArray<UploadChatImageAttachment>;
    pendingThread?: PendingConsoleThread | null;
  }): Promise<void>;
  respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>,
    fallbackPrompt?: string,
  ): Promise<void>;
  setThreadModel(threadId: string, provider: ProviderKind, model: string): Promise<void>;
  setThreadReasoningEffort(
    threadId: string,
    provider: ProviderKind,
    reasoningEffort: CodexReasoningEffort | null,
  ): Promise<void>;
  setInteractionMode(threadId: string, interactionMode: ProviderInteractionMode): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  interruptTurn(threadId: string): Promise<void>;
  stopSession(threadId: string): Promise<void>;
}

interface OptimisticThreadMetaPatch {
  readonly model?: string;
  readonly modelOptions?: ProviderModelOptions;
}

interface PendingUserInputFallback {
  readonly threadId: OrchestrationThread["id"];
  readonly prompt: string | null;
  readonly dispatchedFallback: boolean;
}

function readSearchConfig(): ConsoleSearchConfig {
  const search = new URLSearchParams(window.location.search);
  return {
    threadId: search.get("threadId"),
  };
}

function makeId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function makeCommandId() {
  return makeId("command") as CommandId;
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
      isStaleCopilotUserInputResponseDetail(asString(payload?.detail))
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function derivePendingApprovalRequestIds(thread: OrchestrationThread | null): string[] {
  if (!thread) return [];
  const openByRequestId = new Set<string>();
  const ordered = [...thread.activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    const requestId = asString(payload?.requestId);
    if (!requestId) continue;

    if (activity.kind === "approval.requested") {
      openByRequestId.add(requestId);
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

  return [...openByRequestId];
}

function buildPromptAnswers(
  pendingUserInput: ConsolePendingUserInput,
  prompt: string,
): Record<string, string> | null {
  return parsePendingUserInputAnswers(pendingUserInput.questions, prompt);
}

function isTurnRunning(thread: OrchestrationThread | null) {
  if (!thread) return false;
  return thread.latestTurn?.state === "running" || thread.session?.status === "running";
}

function canDispatchLiveCommand(connectionState: ConsoleConnectionState) {
  return connectionState === "connected";
}

function findThreadById(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: string,
) {
  return threads.find((thread) => thread.id === threadId) ?? null;
}

async function dispatchThreadTurnStart(input: {
  readonly backend: ConsoleBackend;
  readonly threadId: ThreadId;
  readonly threadSeed: Pick<PendingConsoleThread, "model" | "interactionMode">;
  readonly modelOptions?: ProviderModelOptions;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<UploadChatImageAttachment>;
}) {
  await input.backend.dispatchCommand({
    type: "thread.turn.start",
    commandId: makeCommandId(),
    threadId: input.threadId,
    message: {
      messageId: makeId("message") as MessageId,
      role: "user",
      text: input.prompt,
      attachments: input.attachments,
    },
    model: input.threadSeed.model,
    ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
    assistantDeliveryMode: "streaming",
    runtimeMode: "full-access",
    interactionMode: input.threadSeed.interactionMode,
    createdAt: new Date().toISOString(),
  });
}

function updateReasoningEffortModelOptions(
  existing: ProviderModelOptions | undefined,
  provider: ProviderKind,
  reasoningEffort: CodexReasoningEffort | null,
): ProviderModelOptions {
  if (provider === "codex") {
    const nextCodexOptions = {
      ...existing?.codex,
      ...(reasoningEffort !== null ? { reasoningEffort } : {}),
    };

    if (reasoningEffort === null) {
      delete nextCodexOptions.reasoningEffort;
    }

    return {
      ...existing,
      codex: nextCodexOptions,
    };
  }

  const nextCopilotOptions = {
    ...existing?.copilot,
    ...(reasoningEffort !== null ? { reasoningEffort } : {}),
  };

  if (reasoningEffort === null) {
    delete nextCopilotOptions.reasoningEffort;
  }

  return {
    ...existing,
    copilot: nextCopilotOptions,
  };
}

function clearProviderReasoningEffort(
  existing: ProviderModelOptions | undefined,
  provider: ProviderKind,
): ProviderModelOptions | undefined {
  if (!existing) {
    return existing;
  }

  if (provider === "codex") {
    if (!existing.codex?.reasoningEffort) {
      return existing;
    }
    const nextCodex = { ...existing.codex };
    delete nextCodex.reasoningEffort;
    return { ...existing, codex: nextCodex };
  }

  if (!existing.copilot?.reasoningEffort) {
    return existing;
  }
  const nextCopilot = { ...existing.copilot };
  delete nextCopilot.reasoningEffort;
  return { ...existing, copilot: nextCopilot };
}

function getProviderReasoningEffort(
  existing: ProviderModelOptions | undefined,
  provider: ProviderKind,
): CodexReasoningEffort | null {
  return provider === "codex"
    ? (existing?.codex?.reasoningEffort ?? null)
    : (existing?.copilot?.reasoningEffort ?? null);
}

function normalizeModelOptionsForModel(
  existing: ProviderModelOptions | undefined,
  provider: ProviderKind,
  model: string,
  serverConfig: ServerConfig | null,
): ProviderModelOptions | undefined {
  const providerStatus = serverConfig?.providers.find((entry) => entry.provider === provider);
  const modelStatus = providerStatus?.models?.find((entry) => entry.id === model);
  if (!modelStatus) {
    return existing;
  }

  const reasoningEffort = getProviderReasoningEffort(existing, provider);
  if (!reasoningEffort) {
    return existing;
  }

  if (!modelStatus.supportsReasoningEffort) {
    return clearProviderReasoningEffort(existing, provider);
  }

  const supportedReasoningEfforts = modelStatus.supportedReasoningEfforts;
  if (
    supportedReasoningEfforts &&
    supportedReasoningEfforts.length > 0 &&
    !supportedReasoningEfforts.includes(reasoningEffort)
  ) {
    return clearProviderReasoningEffort(existing, provider);
  }

  return existing;
}

function findProjectById(
  snapshot: OrchestrationReadModel | null,
  projectId: OrchestrationProject["id"] | null,
) {
  if (!snapshot || !projectId) {
    return null;
  }
  return snapshot.projects.find((entry: OrchestrationProject) => entry.id === projectId) ?? null;
}

function mergeOrchestrationEvents(
  existing: ReadonlyArray<OrchestrationEvent>,
  incoming: ReadonlyArray<OrchestrationEvent>,
) {
  if (incoming.length === 0) {
    return existing;
  }

  const bySequence = new Map(existing.map((event) => [event.sequence, event] as const));
  incoming.forEach((event) => {
    bySequence.set(event.sequence, event);
  });

  return [...bySequence.values()].toSorted((left, right) => left.sequence - right.sequence);
}

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export function useConsoleData(): ConsoleDataState {
  const searchConfig = useMemo(readSearchConfig, []);
  const backend = useMemo<ConsoleBackend>(() => new LiveConsoleBackend(), []);
  const latestEventSequenceRef = useRef(0);
  const orchestrationEventsRef = useRef<ReadonlyArray<OrchestrationEvent>>([]);
  const queuedSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapThreadIdRef = useRef<string | null>(null);
  const syncInFlightRef = useRef(false);
  const pendingSyncRef = useRef(false);
  const serverConfigSyncInFlightRef = useRef(false);
  const pendingServerConfigSyncRef = useRef(false);
  const promptSubmittingRef = useRef(false);
  const autoApprovedRequestIdsRef = useRef(new Set<string>());
  const respondingUserInputRequestIdsRef = useRef(new Set<string>());
  const pendingUserInputFallbacksRef = useRef(new Map<string, PendingUserInputFallback>());
  const interruptInFlightRef = useRef(false);
  const stopSessionInFlightRef = useRef(false);

  const [snapshot, setSnapshot] = useState<OrchestrationReadModel | null>(null);
  const [optimisticThreadMetaById, setOptimisticThreadMetaById] = useState<
    Record<string, OptimisticThreadMetaPatch>
  >({});
  const [orchestrationEvents, setOrchestrationEvents] = useState<ReadonlyArray<OrchestrationEvent>>([]);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [welcome, setWelcome] = useState<WsWelcomePayload | null>(null);
  const [activeThreadId, setActiveThreadIdState] = useState<string | null>(searchConfig.threadId);
  const [connectionState, setConnectionState] = useState<ConsoleConnectionState>("connecting");
  const [isPromptSubmitting, setIsPromptSubmitting] = useState(false);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<string[]>([]);
  const [isInterruptingTurn, setIsInterruptingTurn] = useState(false);
  const [isStoppingSession, setIsStoppingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setActiveThreadId = useCallback((threadId: string) => {
    setActiveThreadIdState(threadId);
  }, []);

  const clearRespondingUserInputRequest = useCallback((requestId: string) => {
    pendingUserInputFallbacksRef.current.delete(requestId);
    respondingUserInputRequestIdsRef.current.delete(requestId);
    setRespondingUserInputRequestIds((existing) =>
      existing.includes(requestId) ? existing.filter((id) => id !== requestId) : existing,
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    latestEventSequenceRef.current = 0;
    syncInFlightRef.current = false;
    pendingSyncRef.current = false;
    serverConfigSyncInFlightRef.current = false;
    pendingServerConfigSyncRef.current = false;
    promptSubmittingRef.current = false;
    autoApprovedRequestIdsRef.current.clear();
    respondingUserInputRequestIdsRef.current.clear();
    pendingUserInputFallbacksRef.current.clear();
    interruptInFlightRef.current = false;
    stopSessionInFlightRef.current = false;
    orchestrationEventsRef.current = [];
    setOrchestrationEvents([]);
    setIsPromptSubmitting(false);
    setRespondingUserInputRequestIds([]);
    setIsInterruptingTurn(false);
    setIsStoppingSession(false);

    const flushSnapshotSync = async (): Promise<void> => {
      const nextSnapshot = await backend.getSnapshot();
      if (disposed) return;
      latestEventSequenceRef.current = Math.max(
        latestEventSequenceRef.current,
        nextSnapshot.snapshotSequence,
      );
      setSnapshot(reconcileReadModelWithEvents(nextSnapshot, orchestrationEventsRef.current));
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

    const syncEvents = async (fromSequenceExclusive: number) => {
      const nextEvents = await backend.replayEvents(fromSequenceExclusive);
      if (disposed || nextEvents.length === 0) {
        return;
      }

      latestEventSequenceRef.current = Math.max(
        latestEventSequenceRef.current,
        ...nextEvents.map((event) => event.sequence),
      );
      orchestrationEventsRef.current = mergeOrchestrationEvents(orchestrationEventsRef.current, nextEvents);
      setOrchestrationEvents(orchestrationEventsRef.current);
      setSnapshot((current) => reconcileReadModelWithEvents(current, nextEvents));
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
          void syncEvents(latestEventSequenceRef.current);
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

      if (event.type === "orchestration.event") {
        latestEventSequenceRef.current = Math.max(
          latestEventSequenceRef.current,
          event.payload.sequence,
        );
        orchestrationEventsRef.current = mergeOrchestrationEvents(orchestrationEventsRef.current, [
          event.payload,
        ]);
        setOrchestrationEvents(orchestrationEventsRef.current);
        setSnapshot((current) => reconcileReadModelWithEvents(current, [event.payload]));
        scheduleSnapshotSync();
        return;
      }
    });

    backend.connect();

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
  }, [backend, searchConfig.threadId]);

  const threads = useMemo(() => {
    const baseThreads = snapshot?.threads ?? EMPTY_THREADS;
    return baseThreads.map((thread) => {
      const optimistic = optimisticThreadMetaById[thread.id];
      if (!optimistic) {
        return thread;
      }
      return {
        ...thread,
        ...(optimistic.model !== undefined ? { model: optimistic.model } : {}),
        ...(optimistic.modelOptions !== undefined ? { modelOptions: optimistic.modelOptions } : {}),
      };
    });
  }, [optimisticThreadMetaById, snapshot?.threads]);

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

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    setOptimisticThreadMetaById((existing) => {
      let changed = false;
      const next: Record<string, OptimisticThreadMetaPatch> = {};

      for (const [threadId, patch] of Object.entries(existing)) {
        const thread = snapshot.threads.find((entry) => entry.id === threadId);
        if (!thread) {
          changed = true;
          continue;
        }

        const modelSettled = patch.model === undefined || thread.model === patch.model;
        const modelOptionsSettled =
          patch.modelOptions === undefined
          || JSON.stringify(thread.modelOptions ?? null) === JSON.stringify(patch.modelOptions ?? null);

        if (modelSettled && modelOptionsSettled) {
          changed = true;
          continue;
        }

        next[threadId] = patch;
      }

      return changed ? next : existing;
    });
  }, [snapshot]);

  useEffect(() => {
    if (!thread || !canDispatchLiveCommand(connectionState)) {
      return;
    }

    for (const requestId of derivePendingApprovalRequestIds(thread)) {
      if (autoApprovedRequestIdsRef.current.has(requestId)) {
        continue;
      }

      autoApprovedRequestIdsRef.current.add(requestId);
      void backend.dispatchCommand({
        type: "thread.approval.respond",
        commandId: makeCommandId(),
        threadId: thread.id,
        requestId: requestId as ApprovalRequestId,
        decision: "acceptForSession",
        createdAt: new Date().toISOString(),
      }).catch((nextError) => {
        setError(
          nextError instanceof Error
            ? `Automatic approval handling failed: ${nextError.message}`
            : "Automatic approval handling failed.",
        );
      });
    }
  }, [backend, connectionState, thread]);

  useEffect(() => {
    if (!canDispatchLiveCommand(connectionState) || pendingUserInputFallbacksRef.current.size === 0) {
      return;
    }

    void (async () => {
      for (const [requestId, fallback] of pendingUserInputFallbacksRef.current.entries()) {
        const targetThread = findThreadById(threads, fallback.threadId);
        if (!targetThread) {
          clearRespondingUserInputRequest(requestId);
          continue;
        }

        const requestActivities = [...targetThread.activities]
          .toSorted(compareActivitiesByOrder)
          .filter((activity) => asString(asRecord(activity.payload)?.requestId) === requestId);

        if (requestActivities.some((activity) => activity.kind === "user-input.resolved")) {
          clearRespondingUserInputRequest(requestId);
          continue;
        }

        const staleFailure = requestActivities.find((activity) =>
          activity.kind === "provider.user-input.respond.failed"
          && isStaleCopilotUserInputResponseDetail(asString(asRecord(activity.payload)?.detail)),
        );
        if (!staleFailure) {
          if (requestActivities.some((activity) => activity.kind === "provider.user-input.respond.failed")) {
            clearRespondingUserInputRequest(requestId);
          }
          continue;
        }

        if (!fallback.prompt) {
          clearRespondingUserInputRequest(requestId);
          continue;
        }

        if (fallback.dispatchedFallback) {
          clearRespondingUserInputRequest(requestId);
          continue;
        }

        pendingUserInputFallbacksRef.current.set(requestId, {
          ...fallback,
          dispatchedFallback: true,
        });

        try {
          await dispatchThreadTurnStart({
            backend,
            threadId: targetThread.id,
            threadSeed: {
              model: targetThread.model,
              interactionMode: targetThread.interactionMode,
            },
            ...(targetThread.modelOptions !== undefined ? { modelOptions: targetThread.modelOptions } : {}),
            prompt: fallback.prompt,
            attachments: [],
          });
        } catch (nextError) {
          setError(
            nextError instanceof Error
              ? `Fallback ask_user submission failed: ${nextError.message}`
              : "Fallback ask_user submission failed.",
          );
        } finally {
          clearRespondingUserInputRequest(requestId);
        }
      }
    })();
  }, [backend, clearRespondingUserInputRequest, connectionState, threads]);

  const project = useMemo(() => {
    if (!snapshot || !thread) return null;
    return snapshot.projects.find((entry: OrchestrationProject) => entry.id === thread.projectId) ?? null;
  }, [snapshot, thread]);
  const getThreadEvents = useCallback(
    (threadId: string | null) =>
      threadId
        ? orchestrationEvents.filter(
            (event) => event.aggregateKind === "thread" && event.aggregateId === threadId,
          )
        : [],
    [orchestrationEvents],
  );

  const pendingUserInputs = useMemo(() => derivePendingUserInputs(thread), [thread]);
  const getPendingUserInputs = useCallback(
    (threadId: string | null) =>
      threadId ? derivePendingUserInputs(findThreadById(threads, threadId)) : EMPTY_PENDING_USER_INPUTS,
    [threads],
  );
  const turnRunning = useMemo(() => isTurnRunning(thread), [thread]);
  const isThreadTurnRunning = useCallback(
    (threadId: string | null) => isTurnRunning(threadId ? findThreadById(threads, threadId) : null),
    [threads],
  );
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
    if (!canDispatchLiveCommand(connectionState)) return false;
    return true;
  }, [
    connectionState,
    isPromptSubmitting,
    pendingUserInputs,
    respondingUserInputRequestIds,
    thread,
    turnRunning,
  ]);
  const canSubmitPromptForThread = useCallback(
    (threadId: string | null, pendingThread?: PendingConsoleThread | null) => {
      const nextThread = threadId ? findThreadById(threads, threadId) : null;
      if (isPromptSubmitting) return false;
      if (!canDispatchLiveCommand(connectionState)) return false;
      if (!nextThread) {
        return !!threadId && !!pendingThread;
      }
      const nextPendingUserInputs = derivePendingUserInputs(nextThread);
      const activePendingUserInput = nextPendingUserInputs[0];
      if (
        activePendingUserInput &&
        respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
      ) {
        return false;
      }
      if (nextPendingUserInputs.length === 0 && isTurnRunning(nextThread)) return false;
      return true;
    },
    [connectionState, isPromptSubmitting, respondingUserInputRequestIds, threads],
  );
  const getProjectForThread = useCallback(
    (threadId: string | null) => {
      const nextThread = threadId ? findThreadById(threads, threadId) : null;
      return findProjectById(snapshot, nextThread?.projectId ?? null);
    },
    [snapshot, threads],
  );

  const assertLiveCommandReady = useCallback(() => {
    if (!canDispatchLiveCommand(connectionState)) {
      throw new Error("Live backend is not connected.");
    }
  }, [connectionState]);

  const createProject = useCallback(
    async (input: {
      workspaceRoot: string;
      title?: string;
      defaultModel?: string;
    }) => {
      const workspaceRoot = input.workspaceRoot.trim();
      const title = input.title?.trim();
      if (workspaceRoot.length === 0) {
        throw new Error("Project path is required.");
      }
      if (!title) {
        throw new Error("Project title is required.");
      }
      assertLiveCommandReady();
      const projectId = makeId("project") as OrchestrationProject["id"];
      await backend.dispatchCommand({
        type: "project.create",
        commandId: makeId("command") as CommandId,
        projectId,
        title,
        workspaceRoot,
        ...(input.defaultModel?.trim() ? { defaultModel: input.defaultModel.trim() } : {}),
        createdAt: new Date().toISOString(),
      });
      return { projectId };
    },
    [assertLiveCommandReady, backend],
  );

  const createThread = useCallback(
    async (input?: {
      projectId: OrchestrationProject["id"];
      provider: ProviderKind;
      title?: string;
      model?: string;
      interactionMode?: ProviderInteractionMode;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
    }): Promise<{ threadId: ThreadId; pendingThread: PendingConsoleThread }> => {
      const projectId = input?.projectId ?? null;
      if (!projectId) {
        throw new Error("No orchestration project is available.");
      }
      assertLiveCommandReady();
      const project = findProjectById(snapshot, projectId);
      const sameProjectThread = thread?.projectId === projectId ? thread : null;

      const createdAt = input?.createdAt ?? new Date().toISOString();
      const threadId = makeId("thread");
      const provider = input?.provider ?? "codex";
      const model =
        input?.model?.trim() ||
        sameProjectThread?.model ||
        project?.defaultModel ||
        snapshot?.projects[0]?.defaultModel ||
        "gpt-5-codex";
      const interactionMode = input?.interactionMode ?? sameProjectThread?.interactionMode ?? "default";
      const worktreePath = input?.worktreePath ?? sameProjectThread?.worktreePath ?? null;
      await backend.dispatchCommand({
        type: "thread.create",
        commandId: makeCommandId(),
        threadId: threadId as ThreadId,
        projectId,
        provider,
        title: input?.title?.trim() || "New thread",
        model,
        runtimeMode: "full-access",
        interactionMode,
        branch: input?.branch ?? sameProjectThread?.branch ?? null,
        worktreePath,
        createdAt,
      });

      return {
        threadId: threadId as ThreadId,
        pendingThread: {
          provider,
          model,
          interactionMode,
          worktreePath,
        },
      };
    },
    [assertLiveCommandReady, backend, snapshot, thread],
  );

  const dispatchUserInputResponse = useCallback(
    async (
      targetThread: OrchestrationThread,
      requestId: string,
      answers: Record<string, unknown>,
      fallbackPrompt?: string,
    ) => {
      if (pendingUserInputFallbacksRef.current.has(requestId) || respondingUserInputRequestIdsRef.current.has(requestId)) {
        return;
      }

      pendingUserInputFallbacksRef.current.set(requestId, {
        threadId: targetThread.id,
        prompt: fallbackPrompt ?? null,
        dispatchedFallback: false,
      });
      respondingUserInputRequestIdsRef.current.add(requestId);
      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      try {
        await backend.dispatchCommand({
          type: "thread.user-input.respond",
          commandId: makeCommandId(),
          threadId: targetThread.id,
          requestId: requestId as ApprovalRequestId,
          answers,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        clearRespondingUserInputRequest(requestId);
        throw error;
      }
    },
    [backend, clearRespondingUserInputRequest],
  );

  const submitPrompt = useCallback(
    async (input: {
      threadId: string;
      prompt: string;
      attachments?: ReadonlyArray<UploadChatImageAttachment>;
      pendingThread?: PendingConsoleThread | null;
    }) => {
      const trimmed = input.prompt.trim();
      const attachments = [...(input.attachments ?? [])];
      if (trimmed.length === 0 && attachments.length === 0) return;
      const targetThread = findThreadById(threads, input.threadId);
      const threadSeed = targetThread ?? input.pendingThread;
      if (!threadSeed) {
        throw new Error("No orchestration thread is available.");
      }
      assertLiveCommandReady();
      if (promptSubmittingRef.current) {
        return;
      }

      const pendingUserInput = targetThread ? derivePendingUserInputs(targetThread)[0] : undefined;
      if (pendingUserInput) {
        if (attachments.length > 0) {
          throw new Error("Image attachments are not supported while a user-input request is pending.");
        }
        const answers = buildPromptAnswers(pendingUserInput, trimmed);
        if (!answers) {
          throw new Error("Pending user input expects one answer per question.");
        }

        if (!targetThread) {
          throw new Error("No orchestration thread is available.");
        }
        await dispatchUserInputResponse(
          targetThread,
          pendingUserInput.requestId,
          answers,
          formatPendingUserInputAnswersAsPrompt(pendingUserInput.questions, answers) ?? undefined,
        );
        return;
      }

      if (targetThread && isTurnRunning(targetThread)) {
        throw new Error("A turn is already running.");
      }

      promptSubmittingRef.current = true;
      setIsPromptSubmitting(true);
      try {
        const dispatchThreadId = targetThread?.id ?? (input.threadId as ThreadId);
        await dispatchThreadTurnStart({
          backend,
          threadId: dispatchThreadId,
          threadSeed,
          ...(targetThread?.modelOptions !== undefined ? { modelOptions: targetThread.modelOptions } : {}),
          prompt: trimmed || IMAGE_ONLY_BOOTSTRAP_PROMPT,
          attachments,
        });
      } finally {
        promptSubmittingRef.current = false;
        setIsPromptSubmitting(false);
      }
    },
    [assertLiveCommandReady, backend, dispatchUserInputResponse, threads],
  );

  const respondToUserInput = useCallback(
    async (
      threadId: string,
      requestId: string,
      answers: Record<string, unknown>,
      fallbackPrompt?: string,
    ) => {
      const targetThread = findThreadById(threads, threadId);
      if (!targetThread) {
        throw new Error("No orchestration thread is available.");
      }
      assertLiveCommandReady();
      await dispatchUserInputResponse(targetThread, requestId, answers, fallbackPrompt);
    },
    [assertLiveCommandReady, dispatchUserInputResponse, threads],
  );

  const setThreadModel = useCallback(async (threadId: string, provider: ProviderKind, model: string) => {
    const targetThread = findThreadById(threads, threadId);
    const normalizedModel = model.trim();
    if (!targetThread || normalizedModel.length === 0 || targetThread.model === normalizedModel) {
      return;
    }
    const normalizedModelOptions = normalizeModelOptionsForModel(
      targetThread.modelOptions,
      provider,
      normalizedModel,
      serverConfig,
    );
    assertLiveCommandReady();
    const previousModel = targetThread.model;
    const previousModelOptions = targetThread.modelOptions;
    setOptimisticThreadMetaById((existing) => ({
      ...existing,
      [targetThread.id]: {
        ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
        ...(normalizedModelOptions !== undefined ? { modelOptions: normalizedModelOptions } : {}),
      },
    }));

    try {
      await backend.dispatchCommand({
        type: "thread.meta.update",
        commandId: makeCommandId(),
        threadId: targetThread.id,
        model: normalizedModel,
        ...(normalizedModelOptions !== undefined ? { modelOptions: normalizedModelOptions } : {}),
      });
    } catch (error) {
      setOptimisticThreadMetaById((existing) => ({
        ...existing,
        [targetThread.id]: {
          model: previousModel,
          ...(previousModelOptions !== undefined ? { modelOptions: previousModelOptions } : {}),
        },
      }));
      throw error;
    }
  }, [assertLiveCommandReady, backend, serverConfig, threads]);

  const setThreadReasoningEffort = useCallback(async (
    threadId: string,
    provider: ProviderKind,
    reasoningEffort: CodexReasoningEffort | null,
  ) => {
    const targetThread = findThreadById(threads, threadId);
    if (!targetThread) {
      return;
    }
    const nextModelOptions = updateReasoningEffortModelOptions(
      targetThread.modelOptions,
      provider,
      reasoningEffort,
    );
    const currentReasoningEffort = getProviderReasoningEffort(targetThread.modelOptions, provider);
    if (currentReasoningEffort === reasoningEffort) {
      return;
    }
    assertLiveCommandReady();
    const previousModelOptions = targetThread.modelOptions;
    setOptimisticThreadMetaById((existing) => ({
      ...existing,
      [targetThread.id]: {
        ...(existing[targetThread.id]?.model !== undefined
          ? { model: existing[targetThread.id]!.model }
          : {}),
        modelOptions: nextModelOptions,
      },
    }));

    try {
      await backend.dispatchCommand({
        type: "thread.meta.update",
        commandId: makeCommandId(),
        threadId: targetThread.id,
        modelOptions: nextModelOptions,
      });
    } catch (error) {
      setOptimisticThreadMetaById((existing) => ({
        ...existing,
        [targetThread.id]: {
          ...(existing[targetThread.id]?.model !== undefined
            ? { model: existing[targetThread.id]!.model }
            : {}),
          ...(previousModelOptions !== undefined ? { modelOptions: previousModelOptions } : {}),
        },
      }));
      throw error;
    }
  }, [assertLiveCommandReady, backend, threads]);

  const setInteractionMode = useCallback(
    async (threadId: string, interactionMode: ProviderInteractionMode) => {
      const targetThread = findThreadById(threads, threadId);
      if (!targetThread || targetThread.interactionMode === interactionMode) return;
      assertLiveCommandReady();

      await backend.dispatchCommand({
        type: "thread.interaction-mode.set",
        commandId: makeCommandId(),
        threadId: targetThread.id,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
    },
    [assertLiveCommandReady, backend, threads],
  );

  const deleteThread = useCallback(async (threadId: string) => {
    const targetThread = findThreadById(threads, threadId);
    if (!targetThread) {
      throw new Error("No orchestration thread is available.");
    }
    assertLiveCommandReady();
    await backend.dispatchCommand({
      type: "thread.delete",
      commandId: makeCommandId(),
      threadId: targetThread.id,
    });
  }, [assertLiveCommandReady, backend, threads]);

  const interruptTurn = useCallback(async (threadId: string) => {
    const targetThread = findThreadById(threads, threadId);
    if (!targetThread) {
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
        threadId: targetThread.id,
        createdAt: new Date().toISOString(),
      });
    } finally {
      interruptInFlightRef.current = false;
      setIsInterruptingTurn(false);
    }
  }, [assertLiveCommandReady, backend, threads]);

  const stopSession = useCallback(async (threadId: string) => {
    const targetThread = findThreadById(threads, threadId);
    if (!targetThread) {
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
        threadId: targetThread.id,
        createdAt: new Date().toISOString(),
      });
    } finally {
      stopSessionInFlightRef.current = false;
      setIsStoppingSession(false);
    }
  }, [assertLiveCommandReady, backend, threads]);

  const getTurnDiff = useCallback(async (input: {
    threadId: ThreadId;
    fromTurnCount: number;
    toTurnCount: number;
  }) => {
    const result = await backend.getTurnDiff(input);
    return result.diff;
  }, [backend]);

  return {
    connectionState,
    snapshot,
    serverConfig,
    welcome,
    threads,
    activeThreadId: thread?.id ?? null,
    thread,
    project,
    pendingUserInputs,
    isTurnRunning: turnRunning,
    isPromptSubmitting,
    canSubmitPrompt,
    respondingUserInputRequestIds,
    isInterruptingTurn,
    isStoppingSession,
    error,
    setActiveThreadId,
    createProject,
    createThread,
    getThreadEvents,
    getPendingUserInputs,
    getProjectForThread,
    getTurnDiff,
    isThreadTurnRunning,
    canSubmitPromptForThread,
    submitPrompt,
    respondToUserInput,
    setThreadModel,
    setThreadReasoningEffort,
    setInteractionMode,
    deleteThread,
    interruptTurn,
    stopSession,
  };
}
