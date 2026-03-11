import type {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationReadModel,
  ServerConfig,
  ServerConfigUpdatedPayload,
  WsWelcomePayload,
} from "@t3tools/contracts";

export type ConsoleBackendMode = "demo" | "live";
export type ConsoleBackendConnectionState = "connecting" | "connected" | "disconnected" | "error";

export type ConsoleBackendEvent =
  | {
      type: "connection.state";
      state: ConsoleBackendConnectionState;
    }
  | {
      type: "snapshot.updated";
    }
  | {
      type: "server.welcome";
      payload: WsWelcomePayload;
    }
  | {
      type: "server.config.updated";
      payload: ServerConfigUpdatedPayload;
    }
  | {
      type: "orchestration.event";
      payload: OrchestrationEvent;
    };

export interface ConsoleBackend {
  readonly mode: ConsoleBackendMode;
  connect(): void;
  disconnect(): void;
  dispose(): void;
  subscribe(listener: (event: ConsoleBackendEvent) => void): () => void;
  getServerConfig(): Promise<ServerConfig>;
  getSnapshot(): Promise<OrchestrationReadModel>;
  dispatchCommand(command: ClientOrchestrationCommand): Promise<void>;
  getTurnDiff(input: OrchestrationGetTurnDiffInput): Promise<OrchestrationGetTurnDiffResult>;
  getFullThreadDiff(
    input: OrchestrationGetFullThreadDiffInput,
  ): Promise<OrchestrationGetFullThreadDiffResult>;
}
