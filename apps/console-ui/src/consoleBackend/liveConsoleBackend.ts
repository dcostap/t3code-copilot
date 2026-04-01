import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationReadModel,
  OrchestrationGetTurnDiffResult,
  ServerConfig,
  ServerConfigUpdatedPayload,
  TerminalEvent,
  TerminalSessionSnapshot,
  WS_CHANNELS,
  WS_METHODS,
  WsWelcomePayload,
  type ClientOrchestrationCommand,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalWriteInput,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetTurnDiffInput,
} from "@t3tools/contracts";
import { Cause, Schema } from "effect";

import { WsTransport } from "../wsTransport";
import type { ConsoleBackend, ConsoleBackendEvent } from "./consoleBackend";

function decodeOrThrow<T>(
  schema: Schema.Schema<T>,
  raw: unknown,
  context: string,
): T {
  try {
    return Schema.decodeUnknownSync(schema as never)(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: ${message}`, { cause: error });
  }
}

function decodeAndWarnOnFailure<T>(
  schema: Schema.Schema<T> & { readonly DecodingServices: never },
  raw: unknown,
  context: string,
): T | null {
  const decoded = Schema.decodeUnknownExit(schema)(raw);
  if (decoded._tag === "Failure") {
    console.warn(context, {
      reason: "decode-failed",
      raw,
      issue: Cause.pretty(decoded.cause),
    });
    return null;
  }
  return decoded.value;
}

export class LiveConsoleBackend implements ConsoleBackend {
  private transport: WsTransport | null = null;
  private readonly listeners = new Set<(event: ConsoleBackendEvent) => void>();
  private unsubscribeConnection: (() => void) | null = null;
  private unsubscribeWelcome: (() => void) | null = null;
  private unsubscribeConfigUpdated: (() => void) | null = null;
  private unsubscribeDomainEvent: (() => void) | null = null;
  private unsubscribeTerminalEvent: (() => void) | null = null;
  private lastWelcome: WsWelcomePayload | null = null;
  private lastConfigUpdated: ServerConfigUpdatedPayload | null = null;

  connect() {
    if (this.transport) {
      return;
    }

    const transport = new WsTransport();
    this.transport = transport;

    this.unsubscribeConnection = transport.onConnectionState((state) => {
      this.emit({ type: "connection.state", state });
    });
    this.unsubscribeWelcome = transport.subscribe(WS_CHANNELS.serverWelcome, (raw) => {
      const payload = decodeAndWarnOnFailure(
        WsWelcomePayload,
        raw,
        "Dropped inbound server welcome payload",
      );
      if (!payload) return;
      this.lastWelcome = payload;
      this.emit({ type: "server.welcome", payload });
    });
    this.unsubscribeConfigUpdated = transport.subscribe(WS_CHANNELS.serverConfigUpdated, (raw) => {
      const payload = decodeAndWarnOnFailure(
        ServerConfigUpdatedPayload,
        raw,
        "Dropped inbound server config update payload",
      );
      if (!payload) return;
      this.lastConfigUpdated = payload;
      this.emit({ type: "server.config.updated", payload });
    });
    this.unsubscribeDomainEvent = transport.subscribe(
      ORCHESTRATION_WS_CHANNELS.domainEvent,
      (raw) => {
        const payload = decodeAndWarnOnFailure(
          OrchestrationEvent,
          raw,
          "Dropped inbound orchestration event payload",
        );
        if (!payload) return;
        this.emit({ type: "snapshot.updated" });
        this.emit({ type: "orchestration.event", payload });
      },
    );
    this.unsubscribeTerminalEvent = transport.subscribe(WS_CHANNELS.terminalEvent, (raw) => {
      const payload = decodeAndWarnOnFailure(
        TerminalEvent,
        raw,
        "Dropped inbound terminal event payload",
      );
      if (!payload) return;
      this.emit({ type: "terminal.event", payload });
    });
  }

  disconnect() {
    this.unsubscribeTerminalEvent?.();
    this.unsubscribeTerminalEvent = null;
    this.unsubscribeDomainEvent?.();
    this.unsubscribeDomainEvent = null;
    this.unsubscribeConfigUpdated?.();
    this.unsubscribeConfigUpdated = null;
    this.unsubscribeWelcome?.();
    this.unsubscribeWelcome = null;
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = null;
    this.transport?.dispose();
    this.transport = null;
  }

  dispose() {
    this.disconnect();
    this.listeners.clear();
    this.lastWelcome = null;
    this.lastConfigUpdated = null;
  }

  subscribe(listener: (event: ConsoleBackendEvent) => void) {
    this.listeners.add(listener);
    if (this.lastWelcome) {
      listener({ type: "server.welcome", payload: this.lastWelcome });
    }
    if (this.lastConfigUpdated) {
      listener({ type: "server.config.updated", payload: this.lastConfigUpdated });
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getServerConfig() {
    const transport = this.requireTransport();
    const result = await transport.request(WS_METHODS.serverGetConfig, {});
    return decodeOrThrow(ServerConfig, result, "Failed to decode server config response");
  }

  async getSnapshot() {
    const transport = this.requireTransport();
    const result = await transport.request(ORCHESTRATION_WS_METHODS.getSnapshot, {});
    return decodeOrThrow(
      OrchestrationReadModel,
      result,
      "Failed to decode orchestration snapshot response",
    );
  }

  async replayEvents(fromSequenceExclusive: number) {
    const transport = this.requireTransport();
    const result = await transport.request(ORCHESTRATION_WS_METHODS.replayEvents, {
      fromSequenceExclusive,
    });
    return decodeOrThrow(
      Schema.Array(OrchestrationEvent),
      result,
      "Failed to decode orchestration replay events response",
    );
  }

  async dispatchCommand(command: ClientOrchestrationCommand) {
    const transport = this.requireTransport();
    await transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, { command });
  }

  async getTurnDiff(input: OrchestrationGetTurnDiffInput) {
    const transport = this.requireTransport();
    const result = await transport.request(ORCHESTRATION_WS_METHODS.getTurnDiff, input);
    return decodeOrThrow(
      OrchestrationGetTurnDiffResult,
      result,
      "Failed to decode turn diff response",
    );
  }

  async getFullThreadDiff(input: OrchestrationGetFullThreadDiffInput) {
    const transport = this.requireTransport();
    const result = await transport.request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, input);
    return decodeOrThrow(
      OrchestrationGetFullThreadDiffResult,
      result,
      "Failed to decode full thread diff response",
    );
  }

  async openTerminal(input: TerminalOpenInput) {
    const transport = this.requireTransport();
    const result = await transport.request(WS_METHODS.terminalOpen, input);
    return decodeOrThrow(
      TerminalSessionSnapshot,
      result,
      "Failed to decode terminal open response",
    );
  }

  async writeTerminal(input: TerminalWriteInput) {
    const transport = this.requireTransport();
    await transport.request(WS_METHODS.terminalWrite, input);
  }

  async resizeTerminal(input: TerminalResizeInput) {
    const transport = this.requireTransport();
    await transport.request(WS_METHODS.terminalResize, input);
  }

  async clearTerminal(input: TerminalClearInput) {
    const transport = this.requireTransport();
    await transport.request(WS_METHODS.terminalClear, input);
  }

  async restartTerminal(input: TerminalRestartInput) {
    const transport = this.requireTransport();
    const result = await transport.request(WS_METHODS.terminalRestart, input);
    return decodeOrThrow(
      TerminalSessionSnapshot,
      result,
      "Failed to decode terminal restart response",
    );
  }

  async closeTerminal(input: TerminalCloseInput) {
    const transport = this.requireTransport();
    await transport.request(WS_METHODS.terminalClose, input);
  }

  private requireTransport() {
    if (!this.transport) {
      throw new Error("Live console backend is not connected.");
    }
    return this.transport;
  }

  private emit(event: ConsoleBackendEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
