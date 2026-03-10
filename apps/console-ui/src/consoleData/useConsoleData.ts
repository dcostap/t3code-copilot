import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  type MessageId,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProviderKind,
  type TurnId,
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

export interface ConsoleDataState {
  readonly mode: ConsoleSourceMode;
  readonly connectionState: ConsoleConnectionState;
  readonly snapshot: OrchestrationReadModel | null;
  readonly thread: OrchestrationThread | null;
  readonly project: OrchestrationProject | null;
  readonly error: string | null;
  submitPrompt(prompt: string): Promise<void>;
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

function providerFromThread(thread: OrchestrationThread | null): ProviderKind | undefined {
  if (thread?.session?.providerName === "codex" || thread?.session?.providerName === "copilot") {
    return thread.session.providerName;
  }
  return undefined;
}

function appendDemoTurn(snapshot: OrchestrationReadModel, prompt: string): OrchestrationReadModel {
  const thread = snapshot.threads[0];
  if (!thread) return snapshot;

  const now = new Date().toISOString();
  const userMessageId = makeId("demo-user") as MessageId;
  const assistantMessageId = makeId("demo-assistant") as MessageId;
  const turnId = makeId("demo-turn") as TurnId;
  const nextSequence = snapshot.snapshotSequence + 1;
  const demoReply = [
    "Demo mode is active.",
    "",
    `You submitted: ${prompt}`,
    "",
    "This console is rendering a contract-shaped thread snapshot locally, without starting a provider session.",
  ].join("\n");

  return {
    ...snapshot,
    snapshotSequence: nextSequence,
    threads: snapshot.threads.map((entry: OrchestrationThread) =>
      entry.id !== thread.id
        ? entry
        : {
            ...entry,
            messages: [
              ...entry.messages,
              {
                id: userMessageId,
                role: "user",
                text: prompt,
                attachments: [],
                turnId,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: assistantMessageId,
                role: "assistant",
                text: demoReply,
                attachments: [],
                turnId,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
            latestTurn: {
              turnId,
              state: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              assistantMessageId,
            },
            session: entry.session
              ? {
                  ...entry.session,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: now,
                }
              : null,
            updatedAt: now,
          },
    ),
    updatedAt: now,
  };
}

export function useConsoleData(): ConsoleDataState {
  const searchConfig = useMemo(readSearchConfig, []);
  const transportRef = useRef<WsTransport | null>(null);
  const latestSequenceRef = useRef(0);
  const queuedSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapThreadIdRef = useRef<string | null>(null);

  const [snapshot, setSnapshot] = useState<OrchestrationReadModel | null>(() =>
    searchConfig.mode === "demo" ? buildDemoSnapshot() : null,
  );
  const [connectionState, setConnectionState] = useState<ConsoleConnectionState>(
    searchConfig.mode === "demo" ? "demo" : "connecting",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (searchConfig.mode === "demo") {
      setSnapshot(buildDemoSnapshot());
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
  }, [searchConfig.mode]);

  const thread = useMemo(() => {
    if (!snapshot) return null;
    const preferredThreadId = searchConfig.threadId ?? bootstrapThreadIdRef.current;
    if (!preferredThreadId) {
      return snapshot.threads[0] ?? null;
    }
    return (
      snapshot.threads.find((entry: OrchestrationThread) => entry.id === preferredThreadId) ??
      snapshot.threads[0] ??
      null
    );
  }, [searchConfig.threadId, snapshot]);

  const project = useMemo(() => {
    if (!snapshot || !thread) return null;
    return snapshot.projects.find((entry: OrchestrationProject) => entry.id === thread.projectId) ?? null;
  }, [snapshot, thread]);

  const submitPrompt = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (trimmed.length === 0) return;

      if (searchConfig.mode === "demo") {
        setSnapshot((current: OrchestrationReadModel | null) =>
          current ? appendDemoTurn(current, trimmed) : current,
        );
        return;
      }

      const transport = transportRef.current;
      if (!transport || !thread) {
        throw new Error("No live orchestration thread is available.");
      }

      const createdAt = new Date().toISOString();
      const provider = providerFromThread(thread);
      await transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, {
        command: {
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
        },
      });
    },
    [searchConfig.mode, thread],
  );

  return {
    mode: searchConfig.mode,
    connectionState,
    snapshot,
    thread,
    project,
    error,
    submitPrompt,
  };
}
