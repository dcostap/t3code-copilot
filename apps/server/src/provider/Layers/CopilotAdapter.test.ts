import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { type SessionEvent } from "@github/copilot-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it, vi } from "@effect/vitest";

import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

class FakeCopilotSession {
  public readonly sessionId: string;

  public readonly modeSetImpl = vi.fn(
    async ({ mode }: { mode: "interactive" | "plan" | "autopilot" }) => ({
      mode,
    }),
  );

  public readonly planReadImpl = vi.fn(
    async (): Promise<{
      exists: boolean;
      content: string | null;
      path: string | null;
    }> => ({
      exists: false,
      content: null,
      path: null,
    }),
  );

  public readonly sendImpl = vi.fn(
    async (_options: { prompt: string; attachments?: unknown; mode?: string }) => "message-1",
  );

  public readonly abortImpl = vi.fn(async () => undefined);
  public readonly destroyImpl = vi.fn(async () => undefined);
  public readonly getMessagesImpl = vi.fn(async () => [] as SessionEvent[]);

  private readonly handlers = new Set<(event: SessionEvent) => void>();

  public readonly rpc = {
    mode: {
      set: this.modeSetImpl,
    },
    plan: {
      read: this.planReadImpl,
    },
  };

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  on(handler: (event: SessionEvent) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  send(options: { prompt: string; attachments?: unknown; mode?: string }) {
    return this.sendImpl(options);
  }

  abort() {
    return this.abortImpl();
  }

  destroy() {
    return this.destroyImpl();
  }

  getMessages() {
    return this.getMessagesImpl();
  }

  emit(event: SessionEvent) {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

class FakeCopilotClient {
  public readonly startImpl = vi.fn(async () => undefined);
  public readonly listModelsImpl = vi.fn(async () => []);
  public readonly createSessionImpl = vi.fn(async (_config: unknown) => this.session);
  public readonly resumeSessionImpl = vi.fn(
    async (_sessionId: string, _config: unknown) => this.session,
  );
  public readonly stopImpl = vi.fn(async () => [] as Error[]);

  constructor(private readonly session: FakeCopilotSession) {}

  start() {
    return this.startImpl();
  }

  listModels() {
    return this.listModelsImpl();
  }

  createSession(config: unknown) {
    return this.createSessionImpl(config);
  }

  resumeSession(sessionId: string, config: unknown) {
    return this.resumeSessionImpl(sessionId, config);
  }

  stop() {
    return this.stopImpl();
  }
}

const modeSession = new FakeCopilotSession("copilot-session-mode");
const modeClient = new FakeCopilotClient(modeSession);
const modeLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => modeClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

modeLayer("CopilotAdapterLive interaction mode", (it) => {
  it.effect("switches the Copilot session mode when interactionMode changes", () =>
    Effect.gen(function* () {
      modeSession.modeSetImpl.mockClear();
      modeSession.sendImpl.mockClear();

      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-mode"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Plan the work",
        interactionMode: "plan",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Now execute it",
        interactionMode: "default",
        attachments: [],
      });

      assert.deepStrictEqual(modeSession.modeSetImpl.mock.calls, [
        [{ mode: "plan" }],
        [{ mode: "interactive" }],
      ]);
      assert.equal(modeSession.sendImpl.mock.calls[0]?.[0]?.mode, "immediate");
      assert.equal(modeSession.sendImpl.mock.calls[1]?.[0]?.mode, "immediate");
    }),
  );
});

const planSession = new FakeCopilotSession("copilot-session-plan");
const planClient = new FakeCopilotClient(planSession);
const planLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => planClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

planLayer("CopilotAdapterLive proposed plan events", (it) => {
  it.effect("emits a proposed-plan completion event from Copilot plan updates", () =>
    Effect.gen(function* () {
      planSession.modeSetImpl.mockClear();
      planSession.planReadImpl.mockReset();
      planSession.planReadImpl.mockResolvedValue({
        exists: true,
        content: "# Ship it\n\n- first\n- second",
        path: "/tmp/copilot-session-plan/plan.md",
      });

      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-plan"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Draft a plan",
        interactionMode: "plan",
        attachments: [],
      });

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      planSession.emit({
        id: "evt-plan-changed",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "session.plan_changed",
        data: {
          operation: "update",
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "turn.plan.updated");
      if (events[0]?.type === "turn.plan.updated") {
        assert.equal(events[0].turnId, turn.turnId);
        assert.equal(events[0].payload.explanation, "Plan updated");
      }

      assert.equal(events[1]?.type, "turn.proposed.completed");
      if (events[1]?.type === "turn.proposed.completed") {
        assert.equal(events[1].turnId, turn.turnId);
        assert.equal(events[1].payload.planMarkdown, "# Ship it\n\n- first\n- second");
      }
    }),
  );
});

const mcpSession = new FakeCopilotSession("copilot-session-mcp");
const mcpClient = new FakeCopilotClient(mcpSession);
const mcpLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => mcpClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

mcpLayer("CopilotAdapterLive MCP config loading", (it) => {
  it.effect("passes local MCP servers from mcp-config.json to the SDK", () =>
    Effect.gen(function* () {
      const configDir = mkdtempSync(path.join(os.tmpdir(), "t3-copilot-mcp-"));
      try {
        writeFileSync(
          path.join(configDir, "mcp-config.json"),
          JSON.stringify({
            mcpServers: {
              "local-badge-repro": {
                command: "node",
                args: ["/tmp/t3code-local-mcp-reproduction/dist/index.js"],
              },
            },
          }),
          "utf8",
        );
        mcpClient.createSessionImpl.mockClear();

        const adapter = yield* CopilotAdapter;
        yield* adapter.startSession({
          provider: "copilot",
          threadId: asThreadId("thread-mcp"),
          runtimeMode: "full-access",
          providerOptions: {
            copilot: {
              configDir,
            },
          },
        });

        const config = mcpClient.createSessionImpl.mock.calls[0]?.[0] as
          | {
              configDir?: string;
              mcpServers?: Record<string, unknown>;
            }
          | undefined;

        assert.equal(config?.configDir, configDir);
        assert.deepStrictEqual(config?.mcpServers, {
          "local-badge-repro": {
            type: "local",
            command: "node",
            args: ["/tmp/t3code-local-mcp-reproduction/dist/index.js"],
            tools: ["*"],
          },
        });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    }),
  );
});

const toolLifecycleSession = new FakeCopilotSession("copilot-session-tool-lifecycle");
const toolLifecycleClient = new FakeCopilotClient(toolLifecycleSession);
const toolLifecycleLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => toolLifecycleClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

toolLifecycleLayer("CopilotAdapterLive tool lifecycle mapping", (it) => {
  it.effect("keeps terminal tool executions running until a terminal exit code is present", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-tool-lifecycle"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      toolLifecycleSession.emit({
        id: "evt-turn-start",
        timestamp: "2026-03-22T10:00:00.000Z",
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "turn-1",
        },
      } satisfies SessionEvent);

      toolLifecycleSession.emit({
        id: "evt-tool-start",
        timestamp: "2026-03-22T10:00:01.000Z",
        parentId: "evt-turn-start",
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-call-1",
          toolName: "Powershell",
          arguments: {
            command: "Start-Sleep -Seconds 10",
          },
        },
      } satisfies SessionEvent);

      toolLifecycleSession.emit({
        id: "evt-tool-complete-running",
        timestamp: "2026-03-22T10:00:04.100Z",
        parentId: "evt-tool-start",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-1",
          success: true,
          result: {
            content: "Now executing.",
            contents: [
              {
                type: "terminal",
                text: "Start-Sleep -Seconds 10",
              },
            ],
          },
        },
      } satisfies SessionEvent);

      toolLifecycleSession.emit({
        id: "evt-tool-complete-finished",
        timestamp: "2026-03-22T10:00:10.200Z",
        parentId: "evt-tool-complete-running",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-call-1",
          success: true,
          result: {
            content: "Completed Start-Sleep -Seconds 10.",
            detailedContent: "Completed Start-Sleep -Seconds 10. Exit code 0.",
            contents: [
              {
                type: "terminal",
                text: "Completed Start-Sleep -Seconds 10.",
                exitCode: 0,
                cwd: "C:\\Projects\\webdev\\t3code-copilot",
              },
            ],
          },
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepStrictEqual(
        events.map((event) => event.type),
        [
          "turn.started",
          "session.state.changed",
          "item.started",
          "item.updated",
          "item.completed",
          "tool.summary",
        ],
      );

      const startedEvent = events[2];
      assert.equal(startedEvent?.type, "item.started");
      if (startedEvent?.type === "item.started") {
        assert.equal(startedEvent.payload.itemType, "command_execution");
        assert.equal(startedEvent.payload.status, "inProgress");
        assert.equal(startedEvent.payload.title, "Powershell");
      }

      const runningUpdateEvent = events[3];
      assert.equal(runningUpdateEvent?.type, "item.updated");
      if (runningUpdateEvent?.type === "item.updated") {
        assert.equal(runningUpdateEvent.payload.itemType, "command_execution");
        assert.equal(runningUpdateEvent.payload.status, "inProgress");
        assert.equal(runningUpdateEvent.payload.title, "Powershell");
        assert.equal(runningUpdateEvent.payload.detail, "Now executing.");
      }

      const completedEvent = events[4];
      assert.equal(completedEvent?.type, "item.completed");
      if (completedEvent?.type === "item.completed") {
        assert.equal(completedEvent.payload.itemType, "command_execution");
        assert.equal(completedEvent.payload.status, "completed");
        assert.equal(completedEvent.payload.title, "Powershell");
        assert.equal(
          completedEvent.payload.detail,
          "Completed Start-Sleep -Seconds 10. Exit code 0.",
        );
      }

      const summaryEvent = events[5];
      assert.equal(summaryEvent?.type, "tool.summary");
      if (summaryEvent?.type === "tool.summary") {
        assert.equal(summaryEvent.payload.summary, "Completed Start-Sleep -Seconds 10.");
      }
    }),
  );

});

const fileChangeSession = new FakeCopilotSession("copilot-session-file-change");
const fileChangeClient = new FakeCopilotClient(fileChangeSession);
const fileChangeLayer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => fileChangeClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

fileChangeLayer("CopilotAdapterLive file-change normalization", (it) => {
  it.effect("normalizes Copilot file-writing tools into canonical file-change items", () =>
    Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-file-change"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      fileChangeSession.emit({
        id: "evt-file-turn-start",
        timestamp: "2026-03-22T11:00:00.000Z",
        parentId: null,
        type: "assistant.turn_start",
        data: {
          turnId: "turn-file-1",
        },
      } satisfies SessionEvent);

      fileChangeSession.emit({
        id: "evt-file-tool-start",
        timestamp: "2026-03-22T11:00:01.000Z",
        parentId: "evt-file-turn-start",
        type: "tool.execution_start",
        data: {
          toolCallId: "tool-file-1",
          toolName: "apply_patch",
          arguments: {
            patch: "*** Begin Patch\n*** Add File: src/example.ts\n+export const value = 1;\n*** End Patch\n",
          },
        },
      } satisfies SessionEvent);

      fileChangeSession.emit({
        id: "evt-workspace-file-change",
        timestamp: "2026-03-22T11:00:02.000Z",
        parentId: "evt-file-tool-start",
        type: "session.workspace_file_changed",
        data: {
          path: "src/example.ts",
          operation: "update",
        },
      } satisfies SessionEvent);

      fileChangeSession.emit({
        id: "evt-file-tool-complete",
        timestamp: "2026-03-22T11:00:03.000Z",
        parentId: "evt-file-tool-start",
        type: "tool.execution_complete",
        data: {
          toolCallId: "tool-file-1",
          success: true,
          result: {
            content: "Updated src/example.ts",
            detailedContent: "Updated src/example.ts",
          },
        },
      } satisfies SessionEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      const startedEvent = events.find((event) => event.type === "item.started");
      assert.equal(startedEvent?.type, "item.started");
      if (startedEvent?.type === "item.started") {
        assert.equal(startedEvent.payload.itemType, "file_change");
        assert.deepStrictEqual(startedEvent.payload.data, {
          item: {
            id: "tool-file-1",
            type: "fileChange",
            status: "inProgress",
            changes: [],
          },
          source: {
            toolCallId: "tool-file-1",
            toolName: "apply_patch",
            arguments: {
              patch: "*** Begin Patch\n*** Add File: src/example.ts\n+export const value = 1;\n*** End Patch\n",
            },
          },
        });
      }

      const completedEvent = events.find((event) => event.type === "item.completed");
      assert.equal(completedEvent?.type, "item.completed");
      if (completedEvent?.type === "item.completed") {
        assert.equal(completedEvent.payload.itemType, "file_change");
        assert.deepStrictEqual(completedEvent.payload.data, {
          item: {
            id: "tool-file-1",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: "src/example.ts",
              },
            ],
          },
          source: {
            toolCallId: "tool-file-1",
            success: true,
            result: {
              content: "Updated src/example.ts",
              detailedContent: "Updated src/example.ts",
            },
          },
        });
      }
    }),
  );
});

afterAll(() => {
  void modeSession.destroy();
  void modeClient.stop();
  void planSession.destroy();
  void planClient.stop();
  void mcpSession.destroy();
  void mcpClient.stop();
  void toolLifecycleSession.destroy();
  void toolLifecycleClient.stop();
  void fileChangeSession.destroy();
  void fileChangeClient.stop();
});
