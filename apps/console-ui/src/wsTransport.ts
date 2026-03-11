import { WebSocketResponse, WsPush, WsResponse } from "@t3tools/contracts";
import { Cause, Schema } from "effect";

type PushListener = (data: unknown) => void;
type ConnectionListener = (state: "connecting" | "connected" | "disconnected") => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

const REQUEST_TIMEOUT_MS = 60_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const decodeWsResponseFromJson = Schema.decodeUnknownExit(Schema.fromJsonString(WsResponse));
const isWsPushEnvelope = Schema.is(WsPush);
const isWebSocketResponseEnvelope = Schema.is(WebSocketResponse);

function resolveDefaultWsUrl() {
  const bridge = window as Window & {
    desktopBridge?: {
      getWsUrl?: () => string | undefined;
    };
  };
  const bridgeUrl = bridge.desktopBridge?.getWsUrl?.();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const search = new URLSearchParams(window.location.search);
  const queryUrl = search.get("ws");

  return (
    queryUrl ??
    (bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`)
  );
}

export function resolveWsHttpOrigin(rawUrl = resolveDefaultWsUrl()) {
  try {
    const wsUrl = new URL(rawUrl, window.location.href);
    const protocol =
      wsUrl.protocol === "wss:"
        ? "https:"
        : wsUrl.protocol === "ws:"
          ? "http:"
          : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

export class WsTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<PushListener>>();
  private readonly connectionListeners = new Set<ConnectionListener>();

  constructor(private readonly url = resolveDefaultWsUrl()) {
    this.connect();
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = String(this.nextId++);
    const body = params ? { ...params, _tag: method } : { _tag: method };
    const message: WsRequestEnvelope = { id, body };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      this.send(message);
    });
  }

  subscribe(channel: string, listener: PushListener): () => void {
    const channelListeners = this.listeners.get(channel) ?? new Set<PushListener>();
    channelListeners.add(listener);
    this.listeners.set(channel, channelListeners);

    return () => {
      channelListeners.delete(listener);
      if (channelListeners.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }

  onConnectionState(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    listener(this.ws?.readyState === WebSocket.OPEN ? "connected" : "connecting");

    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Transport disposed"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
  }

  private emitConnectionState(state: "connecting" | "connected" | "disconnected") {
    for (const listener of this.connectionListeners) {
      listener(state);
    }
  }

  private connect() {
    if (this.disposed) return;

    this.emitConnectionState("connecting");
    const ws = new WebSocket(this.url);

    ws.addEventListener("open", () => {
      this.ws = ws;
      this.reconnectAttempt = 0;
      this.emitConnectionState("connected");
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.emitConnectionState("disconnected");
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: unknown) {
    const exit = decodeWsResponseFromJson(raw);
    if (exit._tag === "Failure") {
      console.warn("Dropped inbound WebSocket envelope", {
        reason: "decode-failed",
        raw,
        issue: Cause.pretty(exit.cause),
      });
      return;
    }

    const message = exit.value;
    if (isWsPushEnvelope(message)) {
      const channelListeners = this.listeners.get(message.channel);
      if (!channelListeners) return;
      for (const listener of channelListeners) {
        try {
          listener(message.data);
        } catch {
          // Keep transport resilient to listener failures.
        }
      }
      return;
    }

    if (!isWebSocketResponseEnvelope(message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private send(message: WsRequestEnvelope) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }

    const check = setInterval(() => {
      if (this.disposed) {
        clearInterval(check);
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        this.ws.send(JSON.stringify(message));
      }
    }, 50);
    setTimeout(() => clearInterval(check), REQUEST_TIMEOUT_MS);
  }

  private scheduleReconnect() {
    if (this.disposed) return;

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0];

    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
