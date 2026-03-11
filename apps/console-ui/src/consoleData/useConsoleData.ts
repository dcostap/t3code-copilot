import {
  type EventId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  type MessageId,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { WsTransport } from "../wsTransport";
import { buildDemoSnapshot } from "./demoSnapshot";

export type ConsoleSourceMode = "demo" | "live";
export type ConsoleConnectionState =
  | "demo"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

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
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly activeThreadId: string | null;
  readonly thread: OrchestrationThread | null;
  readonly project: OrchestrationProject | null;
  readonly pendingApprovals: ReadonlyArray<ConsolePendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<ConsolePendingUserInput>;
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

interface DemoPendingTurn {
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
  readonly threadId: string;
  readonly turnId: TurnId;
  readonly assistantMessageId: MessageId;
  readonly prompt: string;
}

function readSearchConfig(): ConsoleSearchConfig {
  const search = new URLSearchParams(window.location.search);
  const modeQuery = search.get("source");
  const envMode = import.meta.env.VITE_CONSOLE_UI_SOURCE as string | undefined;
  const mode =
    modeQuery === "live" || envMode === "live"
      ? "live"
      : "demo";

  return {
    mode,
    threadId: search.get("threadId"),
  };
}

function makeId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function makeEventId(prefix: string) {
  return makeId(prefix) as EventId;
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

function mapThread(
  snapshot: OrchestrationReadModel,
  threadId: string,
  updater: (thread: OrchestrationThread) => OrchestrationThread,
): OrchestrationReadModel {
  const now = new Date().toISOString();
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    updatedAt: now,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId ? updater(thread) : thread,
    ) as OrchestrationReadModel["threads"],
  };
}

function nextActivitySequence(thread: OrchestrationThread) {
  return Math.max(0, ...thread.activities.map((activity) => activity.sequence ?? 0)) + 1;
}

function appendActivity(
  thread: OrchestrationThread,
  activity: Omit<OrchestrationThread["activities"][number], "sequence"> & { sequence?: number },
) {
  const nextActivities = [
    ...thread.activities,
    {
      ...activity,
      sequence: activity.sequence ?? nextActivitySequence(thread),
    },
  ] as OrchestrationThread["activities"];

  return {
    ...thread,
    updatedAt: activity.createdAt,
    activities: nextActivities,
  };
}

function updateMessageText(
  thread: OrchestrationThread,
  messageId: MessageId,
  nextText: string,
  nextUpdatedAt: string,
  streaming: boolean,
) {
  const nextMessages = thread.messages.map((message) =>
    message.id !== messageId
      ? message
      : {
          ...message,
          text: nextText,
          updatedAt: nextUpdatedAt,
          streaming,
        },
  ) as OrchestrationThread["messages"];

  return {
    ...thread,
    updatedAt: nextUpdatedAt,
    messages: nextMessages,
  };
}

function settleThreadTurn(
  thread: OrchestrationThread,
  turnId: TurnId,
  state: "completed" | "interrupted" | "error",
  completedAt: string,
  assistantMessageId: MessageId | null,
) {
  const sessionStatus: NonNullable<OrchestrationThread["session"]>["status"] =
    state === "completed" ? "ready" : state === "interrupted" ? "interrupted" : "error";
  return {
    ...thread,
    updatedAt: completedAt,
    latestTurn: {
      turnId,
      state,
      requestedAt: thread.latestTurn?.requestedAt ?? completedAt,
      startedAt: thread.latestTurn?.startedAt ?? completedAt,
      completedAt,
      assistantMessageId,
    },
    session: thread.session
      ? {
          ...thread.session,
          status: sessionStatus,
          activeTurnId: null,
          lastError: state === "error" ? "Demo turn failed." : null,
          updatedAt: completedAt,
        }
      : null,
  };
}

function demoReplyForPrompt(prompt: string, answers?: Record<string, unknown>) {
  const answerSummary =
    answers && Object.keys(answers).length > 0
      ? `\n\nI used these answers:\n${Object.entries(answers).map(([key, value]) => `- ${key}: ${String(value)}`).join("\n")}`
      : "";

  return [
    "Demo orchestration mode is active.",
    "",
    `Prompt received: ${prompt}`,
    "",
    "This turn progressed through the same read model shapes the real backend emits: running session, activity append, streaming assistant text, and final turn settlement.",
    answerSummary,
  ].join("\n").trim();
}

function demoShouldFail(prompt: string) {
  const lower = prompt.toLowerCase();
  return lower.includes("fail") || lower.includes("error");
}

export function useConsoleData(): ConsoleDataState {
  const searchConfig = useMemo(readSearchConfig, []);
  const transportRef = useRef<WsTransport | null>(null);
  const latestSequenceRef = useRef(0);
  const queuedSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapThreadIdRef = useRef<string | null>(null);
  const demoTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const demoPendingTurnsRef = useRef<Record<string, DemoPendingTurn>>({});

  const [snapshot, setSnapshot] = useState<OrchestrationReadModel | null>(() =>
    searchConfig.mode === "demo" ? buildDemoSnapshot() : null,
  );
  const [activeThreadId, setActiveThreadIdState] = useState<string | null>(searchConfig.threadId);
  const [connectionState, setConnectionState] = useState<ConsoleConnectionState>(
    searchConfig.mode === "demo" ? "demo" : "connecting",
  );
  const [error, setError] = useState<string | null>(null);

  const scheduleDemo = useCallback((fn: () => void, delayMs: number) => {
    const timeout = setTimeout(() => {
      demoTimersRef.current = demoTimersRef.current.filter((entry) => entry !== timeout);
      fn();
    }, delayMs);
    demoTimersRef.current.push(timeout);
  }, []);

  const clearDemoTimers = useCallback(() => {
    demoTimersRef.current.forEach((timeout) => clearTimeout(timeout));
    demoTimersRef.current = [];
  }, []);

  const setActiveThreadId = useCallback((threadId: string) => {
    setActiveThreadIdState(threadId);
  }, []);

  useEffect(() => {
    if (searchConfig.mode === "demo") {
      clearDemoTimers();
      demoPendingTurnsRef.current = {};
      const nextSnapshot = buildDemoSnapshot();
      setSnapshot(nextSnapshot);
      setActiveThreadIdState(searchConfig.threadId ?? nextSnapshot.threads[0]?.id ?? null);
      setConnectionState("demo");
      setError(null);
      return undefined;
    }

    const transport = new WsTransport();
    transportRef.current = transport;
    let disposed = false;

    const syncSnapshot = async () => {
      try {
        const nextSnapshot = await transport.request<OrchestrationReadModel>(
          ORCHESTRATION_WS_METHODS.getSnapshot,
          {},
        );
        if (disposed) return;
        latestSequenceRef.current = Math.max(
          latestSequenceRef.current,
          nextSnapshot.snapshotSequence,
        );
        setSnapshot(nextSnapshot);
        setActiveThreadIdState((current) =>
          current
            ?? searchConfig.threadId
            ?? bootstrapThreadIdRef.current
            ?? nextSnapshot.threads[0]?.id
            ?? null,
        );
        setError(null);
      } catch (nextError) {
        if (disposed) return;
        setError(nextError instanceof Error ? nextError.message : "Snapshot sync failed.");
        setConnectionState("error");
      }
    };

    const scheduleSnapshotSync = () => {
      if (queuedSyncRef.current !== null) return;
      queuedSyncRef.current = setTimeout(() => {
        queuedSyncRef.current = null;
        void syncSnapshot();
      }, 80);
    };

    const unsubscribeConnection = transport.onConnectionState((state) => {
      setConnectionState(state);
      if (state === "connected") {
        void syncSnapshot();
      }
    });

    const unsubscribeWelcome = transport.subscribe(WS_CHANNELS.serverWelcome, (data) => {
      const payload = data as { bootstrapThreadId?: string } | null;
      if (payload?.bootstrapThreadId) {
        bootstrapThreadIdRef.current = payload.bootstrapThreadId;
        setActiveThreadIdState((current) => current ?? payload.bootstrapThreadId ?? null);
      }
      scheduleSnapshotSync();
    });

    const unsubscribeDomainEvent = transport.subscribe(
      ORCHESTRATION_WS_CHANNELS.domainEvent,
      (data) => {
        const event = data as Partial<OrchestrationEvent> | null;
        const sequence =
          event && typeof event === "object" && typeof event.sequence === "number"
            ? event.sequence
            : null;
        if (sequence !== null && sequence <= latestSequenceRef.current) {
          return;
        }
        scheduleSnapshotSync();
      },
    );

    return () => {
      disposed = true;
      if (queuedSyncRef.current !== null) {
        clearTimeout(queuedSyncRef.current);
        queuedSyncRef.current = null;
      }
      unsubscribeDomainEvent();
      unsubscribeWelcome();
      unsubscribeConnection();
      transport.dispose();
      transportRef.current = null;
    };
  }, [clearDemoTimers, searchConfig.mode, searchConfig.threadId]);

  const threads = snapshot?.threads ?? [];

  const thread = useMemo(() => {
    if (!snapshot) return null;
    const preferredThreadId =
      activeThreadId
      ?? searchConfig.threadId
      ?? bootstrapThreadIdRef.current;
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
    if (!snapshot) return;
    if (thread) {
      setActiveThreadIdState(thread.id);
    }
  }, [snapshot, thread]);

  const project = useMemo(() => {
    if (!snapshot || !thread) return null;
    return snapshot.projects.find((entry: OrchestrationProject) => entry.id === thread.projectId) ?? null;
  }, [snapshot, thread]);

  const pendingApprovals = useMemo(() => derivePendingApprovals(thread), [thread]);
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(thread), [thread]);

  const dispatchLiveCommand = useCallback(
    async (command: Record<string, unknown>) => {
      const transport = transportRef.current;
      if (!transport) {
        throw new Error("Live orchestration transport is not connected.");
      }
      await transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, { command });
    },
    [],
  );

  const continueDemoTurn = useCallback((
    pendingTurn: DemoPendingTurn,
    answers?: Record<string, unknown>,
  ) => {
    const chunks = demoReplyForPrompt(pendingTurn.prompt, answers)
      .split("\n")
      .filter((line, index, all) => index < all.length - 1 || line.length > 0);
    let nextText = "";

    chunks.forEach((chunk, index) => {
      scheduleDemo(() => {
        setSnapshot((current) => {
          if (!current) return current;
          return mapThread(current, pendingTurn.threadId, (currentThread) => {
            nextText = nextText.length === 0 ? chunk : `${nextText}\n${chunk}`;
            return updateMessageText(
              currentThread,
              pendingTurn.assistantMessageId,
              nextText,
              new Date().toISOString(),
              true,
            );
          });
        });
      }, 120 * (index + 1));
    });

    scheduleDemo(() => {
      setSnapshot((current) => {
        if (!current) return current;
        return mapThread(current, pendingTurn.threadId, (currentThread) => {
          let nextThread = updateMessageText(
            currentThread,
            pendingTurn.assistantMessageId,
            nextText,
            new Date().toISOString(),
            false,
          );
          nextThread = settleThreadTurn(
            nextThread,
            pendingTurn.turnId,
            "completed",
            new Date().toISOString(),
            pendingTurn.assistantMessageId,
          );
          return appendActivity(nextThread, {
            id: makeEventId("demo-activity-complete"),
            tone: "info",
            kind: "turn.completed",
            summary: "Turn completed",
            payload: { detail: "Demo turn settled through the orchestration read model." },
            turnId: pendingTurn.turnId,
            createdAt: new Date().toISOString(),
          });
        });
      });
    }, 120 * (chunks.length + 1));
  }, [scheduleDemo]);

  const submitPrompt = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (trimmed.length === 0) return;
      if (!thread) {
        throw new Error("No orchestration thread is available.");
      }

      const pendingUserInput = pendingUserInputs[0];
      if (pendingUserInput) {
        const answers = buildPromptAnswers(pendingUserInput, trimmed);
        if (!answers) {
          throw new Error("Pending user input expects one answer per question.");
        }

        if (searchConfig.mode === "demo") {
          const now = new Date().toISOString();
          const pendingTurn = demoPendingTurnsRef.current[pendingUserInput.requestId];
          setSnapshot((current) => {
            if (!current) return current;
            return mapThread(current, thread.id, (currentThread) =>
              appendActivity(currentThread, {
                id: makeEventId("demo-user-input-resolved"),
                tone: "info",
                kind: "user-input.resolved",
                summary: "User input resolved",
                payload: {
                  requestId: pendingUserInput.requestId,
                  answers,
                },
                turnId: pendingTurn?.turnId ?? currentThread.latestTurn?.turnId ?? null,
                createdAt: now,
              }),
            );
          });
          if (pendingTurn) {
            delete demoPendingTurnsRef.current[pendingUserInput.requestId];
            continueDemoTurn(pendingTurn, answers);
          }
          return;
        }

        await dispatchLiveCommand({
          type: "thread.user-input.respond",
          commandId: makeId("command"),
          threadId: thread.id,
          requestId: pendingUserInput.requestId,
          answers,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      if (searchConfig.mode === "demo") {
        clearDemoTimers();
        const now = new Date().toISOString();
        const turnId = makeId("demo-turn") as TurnId;
        const userMessageId = makeId("demo-user-message") as MessageId;
        const assistantMessageId = makeId("demo-assistant-message") as MessageId;
        let scenario: "direct" | "approval" | "user-input" | "error" = "direct";
        const userTurnCount = thread.messages.filter((message) => message.role === "user").length + 1;

        if (demoShouldFail(trimmed)) {
          scenario = "error";
        } else if (userTurnCount % 3 === 1) {
          scenario = "approval";
        } else if (userTurnCount % 3 === 2) {
          scenario = "user-input";
        }

        setSnapshot((current) => {
          if (!current) return current;
          return mapThread(current, thread.id, (currentThread) => {
            const nextMessages = [
              ...currentThread.messages,
              {
                id: userMessageId,
                role: "user" as const,
                text: trimmed,
                attachments: [],
                turnId,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: assistantMessageId,
                role: "assistant" as const,
                text: "",
                attachments: [],
                turnId,
                streaming: true,
                createdAt: now,
                updatedAt: now,
              },
            ] as OrchestrationThread["messages"];

            let nextThread: OrchestrationThread = {
              ...currentThread,
              updatedAt: now,
              messages: nextMessages,
              latestTurn: {
                turnId,
                state: "running",
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                assistantMessageId,
              },
              session: {
                threadId: currentThread.id,
                status: "running" as const,
                providerName: currentThread.session?.providerName ?? "codex",
                runtimeMode: currentThread.runtimeMode,
                activeTurnId: turnId,
                lastError: null,
                updatedAt: now,
              },
            };

            nextThread = appendActivity(nextThread, {
              id: makeEventId("demo-turn-started"),
              tone: "info",
              kind: "turn.started",
              summary: "Turn started",
              payload: { detail: "Demo mode simulating orchestration turn lifecycle." },
              turnId,
              createdAt: now,
            });

            return nextThread;
          });
        });

        scheduleDemo(() => {
          setSnapshot((current) => {
            if (!current) return current;
            return mapThread(current, thread.id, (currentThread) =>
              appendActivity(currentThread, {
                id: makeEventId("demo-tool-started"),
                tone: "tool",
                kind: "tool.started",
                summary: "Inspect transcript state",
                payload: {
                  itemType: "command_execution",
                  title: "Inspect transcript state",
                  status: "inProgress",
                  data: {
                    item: {
                      input: {
                        command: ["rg", "thread", "apps/console-ui/src"],
                      },
                    },
                  },
                },
                turnId,
                createdAt: new Date().toISOString(),
              }),
            );
          });
        }, 90);

        if (scenario === "approval") {
          const requestId = makeId("demo-approval");
          demoPendingTurnsRef.current[requestId] = {
            requestId,
            kind: "approval",
            threadId: thread.id,
            turnId,
            assistantMessageId,
            prompt: trimmed,
          };
          scheduleDemo(() => {
            setSnapshot((current) => {
              if (!current) return current;
              return mapThread(current, thread.id, (currentThread) =>
                appendActivity(currentThread, {
                  id: makeEventId("demo-approval-requested"),
                  tone: "approval",
                  kind: "approval.requested",
                  summary: "File-change approval requested",
                  payload: {
                    requestId,
                    requestKind: "file-change",
                    requestType: "apply_patch_approval",
                    detail: "Demo mode paused the turn to request a file-change approval.",
                  },
                  turnId,
                  createdAt: new Date().toISOString(),
                }),
              );
            });
          }, 200);
          return;
        }

        if (scenario === "user-input") {
          const requestId = makeId("demo-user-input");
          demoPendingTurnsRef.current[requestId] = {
            requestId,
            kind: "user-input",
            threadId: thread.id,
            turnId,
            assistantMessageId,
            prompt: trimmed,
          };
          scheduleDemo(() => {
            setSnapshot((current) => {
              if (!current) return current;
              return mapThread(current, thread.id, (currentThread) =>
                appendActivity(currentThread, {
                  id: makeEventId("demo-user-input-requested"),
                  tone: "info",
                  kind: "user-input.requested",
                  summary: "User input requested",
                  payload: {
                    requestId,
                    questions: [
                      {
                        id: "demo_source",
                        header: "Source",
                        question: "Which mode should this console stay in?",
                        options: [
                          { label: "Demo", description: "Keep using local orchestration fixtures." },
                          { label: "Live", description: "Connect to the orchestration websocket." },
                        ],
                      },
                    ],
                  },
                  turnId,
                  createdAt: new Date().toISOString(),
                }),
              );
            });
          }, 200);
          return;
        }

        if (scenario === "error") {
          scheduleDemo(() => {
            setSnapshot((current) => {
              if (!current) return current;
              return mapThread(current, thread.id, (currentThread) => {
                let nextThread = appendActivity(currentThread, {
                  id: makeEventId("demo-turn-error"),
                  tone: "error",
                  kind: "provider.turn.failed",
                  summary: "Turn failed",
                  payload: {
                    detail: "Demo mode simulated a provider failure for this prompt.",
                  },
                  turnId,
                  createdAt: new Date().toISOString(),
                });
                nextThread = updateMessageText(
                  nextThread,
                  assistantMessageId,
                  "Demo mode simulated a provider failure for this turn.",
                  new Date().toISOString(),
                  false,
                );
                return settleThreadTurn(
                  nextThread,
                  turnId,
                  "error",
                  new Date().toISOString(),
                  assistantMessageId,
                );
              });
            });
          }, 260);
          return;
        }

        continueDemoTurn({
          requestId: makeId("demo-direct"),
          kind: "approval",
          threadId: thread.id,
          turnId,
          assistantMessageId,
          prompt: trimmed,
        });
        return;
      }

      const createdAt = new Date().toISOString();
      const provider = providerFromThread(thread);
      await dispatchLiveCommand({
        type: "thread.turn.start",
        commandId: makeId("command"),
        threadId: thread.id,
        message: {
          messageId: makeId("message"),
          role: "user",
          text: trimmed,
          attachments: [],
        },
        ...(provider ? { provider } : {}),
        model: thread.model,
        assistantDeliveryMode: "streaming",
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      });
    },
    [
      clearDemoTimers,
      continueDemoTurn,
      dispatchLiveCommand,
      pendingUserInputs,
      scheduleDemo,
      searchConfig.mode,
      thread,
    ],
  );

  const respondToApproval = useCallback(
    async (requestId: string, decision: ProviderApprovalDecision) => {
      if (!thread) {
        throw new Error("No orchestration thread is available.");
      }

      if (searchConfig.mode === "demo") {
        const pendingTurn = demoPendingTurnsRef.current[requestId];
        const now = new Date().toISOString();
        setSnapshot((current) => {
          if (!current) return current;
          return mapThread(current, thread.id, (currentThread) =>
            appendActivity(currentThread, {
              id: makeEventId("demo-approval-resolved"),
              tone: "approval",
              kind: "approval.resolved",
              summary: "Approval resolved",
              payload: {
                requestId,
                requestKind: "file-change",
                decision,
              },
              turnId: pendingTurn?.turnId ?? currentThread.latestTurn?.turnId ?? null,
              createdAt: now,
            }),
          );
        });

        delete demoPendingTurnsRef.current[requestId];
        if (!pendingTurn) {
          return;
        }

        if (decision === "decline" || decision === "cancel") {
          setSnapshot((current) => {
            if (!current) return current;
            return mapThread(current, thread.id, (currentThread) => {
              let nextThread = updateMessageText(
                currentThread,
                pendingTurn.assistantMessageId,
                "The demo turn was interrupted because the approval request was declined.",
                new Date().toISOString(),
                false,
              );
              return settleThreadTurn(
                nextThread,
                pendingTurn.turnId,
                "interrupted",
                new Date().toISOString(),
                pendingTurn.assistantMessageId,
              );
            });
          });
          return;
        }

        continueDemoTurn(pendingTurn);
        return;
      }

      await dispatchLiveCommand({
        type: "thread.approval.respond",
        commandId: makeId("command"),
        threadId: thread.id,
        requestId,
        decision,
        createdAt: new Date().toISOString(),
      });
    },
    [continueDemoTurn, dispatchLiveCommand, searchConfig.mode, thread],
  );

  const respondToUserInput = useCallback(
    async (requestId: string, answers: Record<string, unknown>) => {
      if (!thread) {
        throw new Error("No orchestration thread is available.");
      }

      if (searchConfig.mode === "demo") {
        const pendingTurn = demoPendingTurnsRef.current[requestId];
        const now = new Date().toISOString();
        setSnapshot((current) => {
          if (!current) return current;
          return mapThread(current, thread.id, (currentThread) =>
            appendActivity(currentThread, {
              id: makeEventId("demo-user-input-resolved"),
              tone: "info",
              kind: "user-input.resolved",
              summary: "User input resolved",
              payload: {
                requestId,
                answers,
              },
              turnId: pendingTurn?.turnId ?? currentThread.latestTurn?.turnId ?? null,
              createdAt: now,
            }),
          );
        });

        delete demoPendingTurnsRef.current[requestId];
        if (pendingTurn) {
          continueDemoTurn(pendingTurn, answers);
        }
        return;
      }

      await dispatchLiveCommand({
        type: "thread.user-input.respond",
        commandId: makeId("command"),
        threadId: thread.id,
        requestId,
        answers,
        createdAt: new Date().toISOString(),
      });
    },
    [continueDemoTurn, dispatchLiveCommand, searchConfig.mode, thread],
  );

  const setRuntimeMode = useCallback(
    async (runtimeMode: RuntimeMode) => {
      if (!thread || thread.runtimeMode === runtimeMode) return;

      if (searchConfig.mode === "demo") {
        setSnapshot((current) => {
          if (!current) return current;
          return mapThread(current, thread.id, (currentThread) => ({
            ...currentThread,
            runtimeMode,
            updatedAt: new Date().toISOString(),
            session: currentThread.session
              ? {
                  ...currentThread.session,
                  runtimeMode,
                  updatedAt: new Date().toISOString(),
                }
              : null,
          }));
        });
        return;
      }

      await dispatchLiveCommand({
        type: "thread.runtime-mode.set",
        commandId: makeId("command"),
        threadId: thread.id,
        runtimeMode,
        createdAt: new Date().toISOString(),
      });
    },
    [dispatchLiveCommand, searchConfig.mode, thread],
  );

  const setInteractionMode = useCallback(
    async (interactionMode: ProviderInteractionMode) => {
      if (!thread || thread.interactionMode === interactionMode) return;

      if (searchConfig.mode === "demo") {
        setSnapshot((current) => {
          if (!current) return current;
          return mapThread(current, thread.id, (currentThread) => ({
            ...currentThread,
            interactionMode,
            updatedAt: new Date().toISOString(),
          }));
        });
        return;
      }

      await dispatchLiveCommand({
        type: "thread.interaction-mode.set",
        commandId: makeId("command"),
        threadId: thread.id,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
    },
    [dispatchLiveCommand, searchConfig.mode, thread],
  );

  const interruptTurn = useCallback(async () => {
    if (!thread) {
      throw new Error("No orchestration thread is available.");
    }

    if (searchConfig.mode === "demo") {
      clearDemoTimers();
      setSnapshot((current) => {
        if (!current) return current;
        return mapThread(current, thread.id, (currentThread) => {
          const turnId = currentThread.latestTurn?.turnId ?? null;
          let nextThread = appendActivity(currentThread, {
            id: makeEventId("demo-interrupt"),
            tone: "info",
            kind: "thread.turn.interrupt-requested",
            summary: "Turn interrupt requested",
            payload: {},
            turnId,
            createdAt: new Date().toISOString(),
          });
          if (turnId) {
            nextThread = settleThreadTurn(
              nextThread,
              turnId,
              "interrupted",
              new Date().toISOString(),
              currentThread.latestTurn?.assistantMessageId ?? null,
            );
          }
          return nextThread;
        });
      });
      demoPendingTurnsRef.current = {};
      return;
    }

    await dispatchLiveCommand({
      type: "thread.turn.interrupt",
      commandId: makeId("command"),
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
  }, [clearDemoTimers, dispatchLiveCommand, searchConfig.mode, thread]);

  const stopSession = useCallback(async () => {
    if (!thread) {
      throw new Error("No orchestration thread is available.");
    }

    if (searchConfig.mode === "demo") {
      clearDemoTimers();
      setSnapshot((current) => {
        if (!current) return current;
        return mapThread(current, thread.id, (currentThread) => ({
          ...currentThread,
          updatedAt: new Date().toISOString(),
          session: currentThread.session
            ? {
                ...currentThread.session,
                status: "stopped",
                activeTurnId: null,
                updatedAt: new Date().toISOString(),
              }
            : null,
        }));
      });
      demoPendingTurnsRef.current = {};
      return;
    }

    await dispatchLiveCommand({
      type: "thread.session.stop",
      commandId: makeId("command"),
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
  }, [clearDemoTimers, dispatchLiveCommand, searchConfig.mode, thread]);

  useEffect(() => {
    return () => {
      clearDemoTimers();
    };
  }, [clearDemoTimers]);

  return {
    mode: searchConfig.mode,
    connectionState,
    snapshot,
    threads,
    activeThreadId: thread?.id ?? null,
    thread,
    project,
    pendingApprovals,
    pendingUserInputs,
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
