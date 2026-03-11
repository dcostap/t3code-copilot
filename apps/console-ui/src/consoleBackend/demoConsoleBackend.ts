import {
  EventId,
  MessageId,
  type ChatAttachment,
  type ApprovalRequestId,
  type ClientOrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type TurnId,
  type WsWelcomePayload,
} from "@t3tools/contracts";

import { buildDemoSnapshot } from "../consoleData/demoSnapshot";
import type { ConsoleBackend, ConsoleBackendEvent } from "./consoleBackend";
import {
  createBrowserScenarioScheduler,
  type ScenarioScheduler,
  type ScheduledScenarioTask,
} from "./scenarioScheduler";

interface DemoPendingTurn {
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly assistantMessageId: MessageId;
  readonly prompt: string;
}

const DEMO_TOOL_ACTIVITY_DELAY_MS = 180;
const DEMO_PENDING_REQUEST_DELAY_MS = 420;
const DEMO_ERROR_DELAY_MS = 520;
const DEMO_STREAM_CHUNK_DELAY_MS = 180;

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function makeId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function isoAt(ms: number) {
  return new Date(ms).toISOString();
}

function isoWithOffset(scheduler: ScenarioScheduler, offsetMs: number) {
  return isoAt(scheduler.nowMs() + offsetMs);
}

function nextActivitySequence(thread: OrchestrationThread) {
  return Math.max(0, ...thread.activities.map((activity) => activity.sequence ?? 0)) + 1;
}

function mapThread(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  updater: (thread: OrchestrationThread) => OrchestrationThread,
  updatedAt: string,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    updatedAt,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId ? updater(thread) : thread,
    ) as OrchestrationReadModel["threads"],
  };
}

function appendActivity(
  thread: OrchestrationThread,
  activity: Omit<OrchestrationThreadActivity, "sequence"> & { sequence?: number },
) {
  return {
    ...thread,
    updatedAt: activity.createdAt,
    activities: [
      ...thread.activities,
      {
        ...activity,
        sequence: activity.sequence ?? nextActivitySequence(thread),
      },
    ] as OrchestrationThread["activities"],
  };
}

function updateMessageText(
  thread: OrchestrationThread,
  messageId: MessageId,
  text: string,
  updatedAt: string,
  streaming: boolean,
) {
  return {
    ...thread,
    updatedAt,
    messages: thread.messages.map((message) =>
      message.id !== messageId
        ? message
        : {
            ...message,
            text,
            updatedAt,
            streaming,
          },
    ) as OrchestrationThread["messages"],
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
  const cleanedPrompt = prompt
    .replace(/\[(direct|approval|input|error)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const lower = cleanedPrompt.toLowerCase();
  const answerSummary =
    answers && Object.keys(answers).length > 0
      ? `\n\nI used these answers:\n${Object.entries(answers)
          .map(([key, value]) => `- ${key}: ${String(value)}`)
          .join("\n")}`
      : "";
  let lead = "I can work with that.";
  let body =
    "In demo mode I am using a fake backend, but the flow still goes through the same snapshot, event, and transcript pipeline as the real app.";
  let nextStep =
    "The next likely step is to inspect the relevant UI files, confirm the current behavior, and then tighten the state or interaction logic around the issue.";

  if (lower.includes("screenshot") || lower.includes("image")) {
    lead = "I can inspect the screenshot and reason about the layout from it.";
    body =
      "For a visual issue like this, the useful path is to compare what the screenshot implies with the current transcript, composer, and scroll ownership rules.";
    nextStep =
      "I would look at the layout container, the transcript surface, and any height or overflow logic that could cause the mismatch you are seeing.";
  } else if (
    lower.includes("bug") ||
    lower.includes("fix") ||
    lower.includes("error") ||
    lower.includes("broken") ||
    lower.includes("issue")
  ) {
    lead = "This looks like a bug-fix task.";
    body =
      "The practical approach is to reproduce it, identify which state transition or layout rule is wrong, and then make the smallest change that restores the expected behavior.";
    nextStep =
      "For this prompt, I would trace the submit path, pending workflow state, and transcript update order before changing presentation details.";
  } else if (
    lower.includes("why") ||
    lower.includes("how") ||
    lower.includes("what") ||
    lower.includes("explain")
  ) {
    lead = "Short answer: the behavior comes from how the current state model is wired.";
    body =
      "The important distinction is whether the issue lives in backend state flow, transcript derivation, or editor interaction rules.";
    nextStep =
      "I would separate those layers first so the explanation stays grounded in what the code is actually doing.";
  } else if (
    lower.includes("plan") ||
    lower.includes("roadmap") ||
    lower.includes("next step") ||
    lower.includes("approach")
  ) {
    lead = "I would treat this as a planning task.";
    body =
      "The most useful response is to break the work into a small number of ordered implementation slices rather than mixing architecture fixes and feature work together.";
    nextStep =
      "That usually means stabilizing the boundary first, then adding the next missing backend-driven UI seam.";
  } else if (cleanedPrompt.length <= 16) {
    lead = `I received: ${cleanedPrompt || prompt}.`;
    body =
      "For a short prompt like this, the demo backend keeps the answer concise while still exercising the same read-model update path as a real turn.";
    nextStep =
      "If you want a more specific answer, add a bit more detail and the demo response will follow that direction more closely.";
  }

  return [lead, "", `Your prompt: ${cleanedPrompt || prompt}`, "", body, "", nextStep, answerSummary]
    .join("\n")
    .trim();
}

function resolveScenario(
  prompt: string,
): "direct" | "approval" | "user-input" | "error" {
  const lower = prompt.toLowerCase();
  if (lower.includes("[error]") || lower.includes(" fail") || lower.startsWith("fail")) {
    return "error";
  }
  if (lower.includes("[approval]")) {
    return "approval";
  }
  if (lower.includes("[input]")) {
    return "user-input";
  }
  if (lower.includes("[direct]")) {
    return "direct";
  }
  return "direct";
}

function normalizeAttachments(
  attachments: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>["message"]["attachments"],
): ChatAttachment[] {
  return attachments.map((attachment) => ({
    type: "image",
    id: makeId("demo-attachment"),
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  }));
}

function buildDemoToolActivity(prompt: string) {
  const lower = prompt.toLowerCase();
  if (lower.includes("typecheck") || lower.includes("types")) {
    return {
      title: "Run typecheck",
      command: ["bun", "typecheck"],
    };
  }
  if (lower.includes("lint")) {
    return {
      title: "Run lint",
      command: ["bun", "lint"],
    };
  }
  if (lower.includes("build")) {
    return {
      title: "Build console UI",
      command: ["bun", "run", "build"],
    };
  }
  if (lower.includes("screenshot") || lower.includes("image")) {
    return {
      title: "Inspect image handling",
      command: ["rg", "-n", "image|screenshot|attachment", "apps/console-ui/src"],
    };
  }
  if (lower.includes("plan") || lower.includes("roadmap")) {
    return {
      title: "Inspect planning flow",
      command: ["rg", "-n", "plan|proposedPlans|interactionMode", "apps/console-ui/src"],
    };
  }
  return {
    title: "Inspect transcript state",
    command: ["rg", "-n", "thread|transcript|prompt", "apps/console-ui/src"],
  };
}

function chunkDemoReply(text: string) {
  const tokens = text.match(/\n\n|\n|[^\s]+\s*/g) ?? [text];
  const chunks: string[] = [];
  let buffer = "";
  let wordsInBuffer = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push(buffer);
    buffer = "";
    wordsInBuffer = 0;
  };

  for (const token of tokens) {
    if (token === "\n" || token === "\n\n") {
      flush();
      chunks.push(token);
      continue;
    }

    buffer += token;
    wordsInBuffer += 1;
    if (wordsInBuffer >= 4 || /[.!?]\s*$/.test(token)) {
      flush();
    }
  }

  flush();
  return chunks;
}

function buildDemoWelcome(snapshot: OrchestrationReadModel): WsWelcomePayload {
  const project = snapshot.projects[0];
  const thread = snapshot.threads[0];
  return {
    cwd: project?.workspaceRoot ?? "C:\\Projects\\t3code-copilot",
    projectName: project?.title ?? "Console UI Demo",
    ...(project ? { bootstrapProjectId: project.id } : {}),
    ...(thread ? { bootstrapThreadId: thread.id } : {}),
  };
}

function buildDemoServerConfig(snapshot: OrchestrationReadModel): ServerConfig {
  const project = snapshot.projects[0];
  return {
    cwd: project?.workspaceRoot ?? "C:\\Projects\\t3code-copilot",
    keybindingsConfigPath: `${project?.workspaceRoot ?? "C:\\Projects\\t3code-copilot"}\\keybindings.json`,
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: snapshot.updatedAt,
        message: "Demo provider ready.",
        models: [
          {
            id: "gpt-5",
            name: "GPT-5",
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
        ],
      },
      {
        provider: "copilot",
        status: "warning",
        available: true,
        authStatus: "unknown",
        checkedAt: snapshot.updatedAt,
        message: "Copilot demo status is available for UI testing.",
        models: [
          {
            id: "gpt-4.1",
            name: "GPT-4.1",
            supportsReasoningEffort: false,
          },
        ],
      },
    ],
    availableEditors: ["vscode", "cursor"],
  };
}

export class DemoConsoleBackend implements ConsoleBackend {
  readonly mode = "demo" as const;

  private readonly listeners = new Set<(event: ConsoleBackendEvent) => void>();
  private readonly scheduler: ScenarioScheduler;
  private snapshot: OrchestrationReadModel;
  private serverConfig: ServerConfig;
  private readonly welcome: WsWelcomePayload;
  private readonly pendingTurns = new Map<string, DemoPendingTurn>();
  private readonly scheduledTasks = new Set<ScheduledScenarioTask>();
  private readonly scheduledTasksByThread = new Map<ThreadId, Set<ScheduledScenarioTask>>();
  private connected = false;
  private nextSequence: number;

  constructor(options?: { scheduler?: ScenarioScheduler; initialSnapshot?: OrchestrationReadModel }) {
    this.scheduler = options?.scheduler ?? createBrowserScenarioScheduler();
    this.snapshot = cloneValue(options?.initialSnapshot ?? buildDemoSnapshot());
    this.serverConfig = buildDemoServerConfig(this.snapshot);
    this.welcome = buildDemoWelcome(this.snapshot);
    this.nextSequence = this.snapshot.snapshotSequence + 1;
  }

  connect() {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.emit({ type: "server.welcome", payload: cloneValue(this.welcome) });
    this.emit({
      type: "server.config.updated",
      payload: {
        issues: cloneValue(this.serverConfig.issues),
        providers: cloneValue(this.serverConfig.providers),
      },
    });
  }

  disconnect() {
    this.connected = false;
  }

  dispose() {
    this.disconnect();
    this.pendingTurns.clear();
    this.cancelAllScheduledTasks();
    this.listeners.clear();
  }

  subscribe(listener: (event: ConsoleBackendEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getServerConfig() {
    return cloneValue(this.serverConfig);
  }

  async getSnapshot() {
    return cloneValue(this.snapshot);
  }

  async dispatchCommand(command: ClientOrchestrationCommand) {
    switch (command.type) {
      case "thread.turn.start":
        this.handleTurnStart(command);
        return;
      case "thread.approval.respond":
        this.handleApprovalResponse(command.threadId, command.requestId, command.decision, command.commandId);
        return;
      case "thread.user-input.respond":
        this.handleUserInputResponse(command.threadId, command.requestId, command.answers, command.commandId);
        return;
      case "thread.runtime-mode.set":
        this.handleThreadRuntimeModeSet(command.threadId, command.runtimeMode, command.commandId);
        return;
      case "thread.interaction-mode.set":
        this.handleThreadInteractionModeSet(
          command.threadId,
          command.interactionMode,
          command.commandId,
        );
        return;
      case "thread.turn.interrupt":
        this.handleInterrupt(command.threadId, command.turnId ?? null, command.commandId);
        return;
      case "thread.session.stop":
        this.handleStopSession(command.threadId, command.commandId);
        return;
      case "thread.create":
        this.handleThreadCreate(command);
        return;
      default:
        throw new Error(`Demo console backend does not support ${command.type} yet.`);
    }
  }

  async getTurnDiff(input: OrchestrationGetTurnDiffInput): Promise<OrchestrationGetTurnDiffResult> {
    return {
      threadId: input.threadId,
      fromTurnCount: input.fromTurnCount,
      toTurnCount: input.toTurnCount,
      diff: `diff --git a/apps/console-ui/src/App.tsx b/apps/console-ui/src/App.tsx\n# Demo diff for turns ${input.fromTurnCount}-${input.toTurnCount}`,
    };
  }

  async getFullThreadDiff(
    input: OrchestrationGetFullThreadDiffInput,
  ): Promise<OrchestrationGetFullThreadDiffResult> {
    return {
      threadId: input.threadId,
      fromTurnCount: 1,
      toTurnCount: input.toTurnCount,
      diff: `diff --git a/apps/console-ui/src/transcript/TranscriptRenderer.tsx b/apps/console-ui/src/transcript/TranscriptRenderer.tsx\n# Demo full-thread diff through turn ${input.toTurnCount}`,
    };
  }

  private handleTurnStart(command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>) {
    const now = this.nowIso();
    const assistantCreatedAt = isoWithOffset(this.scheduler, 1);
    const turnId = makeId("demo-turn") as TurnId;
    const assistantMessageId = makeId("demo-assistant-message") as MessageId;
    const scenario = resolveScenario(command.message.text);
    const attachments = normalizeAttachments(command.message.attachments);
    const toolActivity = buildDemoToolActivity(command.message.text);

    this.updateThread(command.threadId, now, (currentThread) => {
      let nextThread: OrchestrationThread = {
        ...currentThread,
        updatedAt: now,
        messages: [
          ...currentThread.messages,
          {
            id: command.message.messageId,
            role: "user",
            text: command.message.text,
            attachments,
            turnId,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: assistantMessageId,
            role: "assistant",
            text: "",
            attachments: [],
            turnId,
            streaming: true,
            createdAt: assistantCreatedAt,
            updatedAt: assistantCreatedAt,
          },
        ] as OrchestrationThread["messages"],
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
          status: "running",
          providerName: currentThread.session?.providerName ?? command.provider ?? "codex",
          runtimeMode: command.runtimeMode,
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
      };

      nextThread = appendActivity(nextThread, {
        id: makeId("demo-turn-started") as EventId,
        tone: "info",
        kind: "turn.started",
        summary: "Turn started",
        payload: { detail: "Demo mode simulating orchestration turn lifecycle." },
        turnId,
        createdAt: now,
      });

      return nextThread;
    });

    this.emitThreadEvent("thread.message-sent", command.threadId, command.commandId, {
      threadId: command.threadId,
      messageId: command.message.messageId,
      role: "user",
      text: command.message.text,
      attachments,
      turnId,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    });
    this.emitThreadEvent("thread.turn-start-requested", command.threadId, command.commandId, {
      threadId: command.threadId,
      messageId: command.message.messageId,
      ...(command.provider ? { provider: command.provider } : {}),
      ...(command.model ? { model: command.model } : {}),
      ...(command.modelOptions ? { modelOptions: command.modelOptions } : {}),
      ...(command.providerOptions ? { providerOptions: command.providerOptions } : {}),
      ...(command.assistantDeliveryMode ? { assistantDeliveryMode: command.assistantDeliveryMode } : {}),
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
      createdAt: now,
    });

    this.schedule(DEMO_TOOL_ACTIVITY_DELAY_MS, () => {
      this.appendActivityAndEmit(command.threadId, {
        id: makeId("demo-tool-started") as EventId,
        tone: "tool",
        kind: "tool.started",
        summary: toolActivity.title,
        payload: {
          itemType: "command_execution",
          title: toolActivity.title,
          status: "inProgress",
          data: {
            item: {
              input: {
                command: toolActivity.command,
              },
            },
          },
        },
        turnId,
        createdAt: this.nowIso(),
      });
    }, command.threadId);

    if (scenario === "approval") {
      const requestId = makeId("demo-approval") as ApprovalRequestId;
      this.pendingTurns.set(requestId, {
        requestId,
        kind: "approval",
        threadId: command.threadId,
        turnId,
        assistantMessageId,
        prompt: command.message.text,
      });
      this.schedule(DEMO_PENDING_REQUEST_DELAY_MS, () => {
        this.appendActivityAndEmit(command.threadId, {
          id: makeId("demo-approval-requested") as EventId,
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
          createdAt: this.nowIso(),
        });
      }, command.threadId);
      return;
    }

    if (scenario === "user-input") {
      const requestId = makeId("demo-user-input") as ApprovalRequestId;
      this.pendingTurns.set(requestId, {
        requestId,
        kind: "user-input",
        threadId: command.threadId,
        turnId,
        assistantMessageId,
        prompt: command.message.text,
      });
      this.schedule(DEMO_PENDING_REQUEST_DELAY_MS, () => {
        this.appendActivityAndEmit(command.threadId, {
          id: makeId("demo-user-input-requested") as EventId,
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
          createdAt: this.nowIso(),
        });
      }, command.threadId);
      return;
    }

    if (scenario === "error") {
      this.schedule(DEMO_ERROR_DELAY_MS, () => {
        const createdAt = this.nowIso();
        this.updateThread(command.threadId, createdAt, (currentThread) => {
          let nextThread = appendActivity(currentThread, {
            id: makeId("demo-turn-error") as EventId,
            tone: "error",
            kind: "provider.turn.failed",
            summary: "Turn failed",
            payload: {
              detail: "Demo mode simulated a provider failure for this prompt.",
            },
            turnId,
            createdAt,
          });
          nextThread = updateMessageText(
            nextThread,
            assistantMessageId,
            "Demo mode simulated a provider failure for this turn.",
            createdAt,
            false,
          );
          return settleThreadTurn(nextThread, turnId, "error", createdAt, assistantMessageId);
        });
        this.emitThreadEvent("thread.activity-appended", command.threadId, command.commandId, {
          threadId: command.threadId,
          activity: this.requireThread(command.threadId).activities.at(-1)!,
        });
      }, command.threadId);
      return;
    }

    this.continuePendingTurn({
      requestId: makeId("demo-direct"),
      kind: "approval",
      threadId: command.threadId,
      turnId,
      assistantMessageId,
      prompt: command.message.text,
    });
  }

  private handleApprovalResponse(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
    commandId: string,
  ) {
    const pendingTurn = this.pendingTurns.get(requestId);
    const createdAt = this.nowIso();
    this.emitThreadEvent("thread.approval-response-requested", threadId, commandId, {
      threadId,
      requestId,
      decision,
      createdAt,
    });

    if (!pendingTurn || pendingTurn.threadId !== threadId || pendingTurn.kind !== "approval") {
      this.appendActivityAndEmit(
        threadId,
        {
          id: makeId("demo-approval-response-failed") as EventId,
          tone: "error",
          kind: "provider.approval.respond.failed",
          summary: "Provider approval response failed",
          payload: {
            requestId,
            detail: `Unknown pending permission request: ${requestId}`,
          },
          turnId: null,
          createdAt,
        },
        commandId,
      );
      return;
    }

    this.appendActivityAndEmit(
      threadId,
      {
        id: makeId("demo-approval-resolved") as EventId,
        tone: "approval",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: {
          requestId,
          requestKind: "file-change",
          decision,
        },
        turnId: pendingTurn.turnId,
        createdAt,
      },
      commandId,
    );
    this.pendingTurns.delete(requestId);

    if (decision === "decline" || decision === "cancel") {
      this.updateThread(threadId, this.nowIso(), (currentThread) => {
        let nextThread = updateMessageText(
          currentThread,
          pendingTurn.assistantMessageId,
          "The demo turn was interrupted because the approval request was declined.",
          this.nowIso(),
          false,
        );
        return settleThreadTurn(
          nextThread,
          pendingTurn.turnId,
          "interrupted",
          this.nowIso(),
          pendingTurn.assistantMessageId,
        );
      });
      return;
    }

    this.continuePendingTurn(pendingTurn);
  }

  private handleUserInputResponse(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: Record<string, unknown>,
    commandId: string,
  ) {
    const pendingTurn = this.pendingTurns.get(requestId);
    const createdAt = this.nowIso();
    this.emitThreadEvent("thread.user-input-response-requested", threadId, commandId, {
      threadId,
      requestId,
      answers,
      createdAt,
    });

    if (!pendingTurn || pendingTurn.threadId !== threadId || pendingTurn.kind !== "user-input") {
      this.appendActivityAndEmit(
        threadId,
        {
          id: makeId("demo-user-input-response-failed") as EventId,
          tone: "error",
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          payload: {
            requestId,
            detail: `Unknown pending user input request: ${requestId}`,
          },
          turnId: null,
          createdAt,
        },
        commandId,
      );
      return;
    }

    this.appendActivityAndEmit(
      threadId,
      {
        id: makeId("demo-user-input-resolved") as EventId,
        tone: "info",
        kind: "user-input.resolved",
        summary: "User input resolved",
        payload: { requestId, answers },
        turnId: pendingTurn.turnId,
        createdAt,
      },
      commandId,
    );
    this.pendingTurns.delete(requestId);
    this.continuePendingTurn(pendingTurn, answers);
  }

  private handleThreadRuntimeModeSet(
    threadId: ThreadId,
    runtimeMode: OrchestrationThread["runtimeMode"],
    commandId: string,
  ) {
    const updatedAt = this.nowIso();
    this.updateThread(threadId, updatedAt, (thread) => ({
      ...thread,
      runtimeMode,
      updatedAt,
      session: thread.session
        ? {
            ...thread.session,
            runtimeMode,
            updatedAt,
          }
        : null,
    }));
    this.emitThreadEvent("thread.runtime-mode-set", threadId, commandId, {
      threadId,
      runtimeMode,
      updatedAt,
    });
  }

  private handleThreadInteractionModeSet(
    threadId: ThreadId,
    interactionMode: OrchestrationThread["interactionMode"],
    commandId: string,
  ) {
    const updatedAt = this.nowIso();
    this.updateThread(threadId, updatedAt, (thread) => ({
      ...thread,
      interactionMode,
      updatedAt,
    }));
    this.emitThreadEvent("thread.interaction-mode-set", threadId, commandId, {
      threadId,
      interactionMode,
      updatedAt,
    });
  }

  private handleInterrupt(threadId: ThreadId, turnId: TurnId | null, commandId: string) {
    const createdAt = this.nowIso();
    this.cancelThreadScheduledTasks(threadId);
    this.clearPendingTurnsForThread(threadId);
    this.updateThread(threadId, createdAt, (thread) => {
      let nextThread = appendActivity(thread, {
        id: makeId("demo-interrupt") as EventId,
        tone: "info",
        kind: "thread.turn.interrupt-requested",
        summary: "Turn interrupt requested",
        payload: {},
        turnId: turnId ?? thread.latestTurn?.turnId ?? null,
        createdAt,
      });
      if (turnId ?? thread.latestTurn?.turnId) {
        nextThread = settleThreadTurn(
          nextThread,
          (turnId ?? thread.latestTurn?.turnId)!,
          "interrupted",
          createdAt,
          thread.latestTurn?.assistantMessageId ?? null,
        );
      }
      return nextThread;
    });
    this.emitThreadEvent("thread.turn-interrupt-requested", threadId, commandId, {
      threadId,
      ...(turnId ? { turnId } : {}),
      createdAt,
    });
  }

  private handleStopSession(threadId: ThreadId, commandId: string) {
    const createdAt = this.nowIso();
    this.cancelThreadScheduledTasks(threadId);
    this.clearPendingTurnsForThread(threadId);
    this.updateThread(threadId, createdAt, (thread) => ({
      ...thread,
      updatedAt: createdAt,
      session: thread.session
        ? {
            ...thread.session,
            status: "stopped",
            activeTurnId: null,
            updatedAt: createdAt,
          }
        : null,
    }));
    this.emitThreadEvent("thread.session-stop-requested", threadId, commandId, {
      threadId,
      createdAt,
    });
  }

  private handleThreadCreate(command: Extract<ClientOrchestrationCommand, { type: "thread.create" }>) {
    const now = this.nowIso();
    const project = this.requireProject(command.projectId);
    const nextThread: OrchestrationThread = {
      id: command.threadId,
      projectId: project.id,
      title: command.title,
      model: command.model,
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
      branch: command.branch,
      worktreePath: command.worktreePath,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: {
        threadId: command.threadId,
        status: "idle",
        providerName: "codex",
        runtimeMode: command.runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    };

    this.snapshot = {
      ...this.snapshot,
      snapshotSequence: this.snapshot.snapshotSequence + 1,
      updatedAt: now,
      threads: [...this.snapshot.threads, nextThread] as OrchestrationReadModel["threads"],
    };

    this.emitThreadEvent("thread.created", command.threadId, command.commandId, {
      threadId: command.threadId,
      projectId: command.projectId,
      title: command.title,
      model: command.model,
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
      branch: command.branch,
      worktreePath: command.worktreePath,
      createdAt: now,
      updatedAt: now,
    });
  }

  private continuePendingTurn(pendingTurn: DemoPendingTurn, answers?: Record<string, unknown>) {
    const chunks = chunkDemoReply(demoReplyForPrompt(pendingTurn.prompt, answers));
    let nextText = "";

    chunks.forEach((chunk, index) => {
      this.schedule(DEMO_STREAM_CHUNK_DELAY_MS * (index + 1), () => {
        const updatedAt = this.nowIso();
        nextText += chunk;
        this.updateThread(pendingTurn.threadId, updatedAt, (thread) =>
          updateMessageText(thread, pendingTurn.assistantMessageId, nextText, updatedAt, true),
        );
        this.emit({ type: "snapshot.updated" });
      }, pendingTurn.threadId);
    });

    this.schedule(DEMO_STREAM_CHUNK_DELAY_MS * (chunks.length + 1), () => {
      const completedAt = this.nowIso();
      this.updateThread(pendingTurn.threadId, completedAt, (thread) => {
        let nextThread = updateMessageText(
          thread,
          pendingTurn.assistantMessageId,
          nextText,
          completedAt,
          false,
        );
        nextThread = settleThreadTurn(
          nextThread,
          pendingTurn.turnId,
          "completed",
          completedAt,
          pendingTurn.assistantMessageId,
        );
        return appendActivity(nextThread, {
          id: makeId("demo-activity-complete") as EventId,
          tone: "info",
          kind: "turn.completed",
          summary: "Turn completed",
          payload: { detail: "Demo turn settled through the orchestration read model." },
          turnId: pendingTurn.turnId,
          createdAt: completedAt,
        });
      });
      this.emitThreadEvent("thread.activity-appended", pendingTurn.threadId, null, {
        threadId: pendingTurn.threadId,
        activity: this.requireThread(pendingTurn.threadId).activities.at(-1)!,
      });
    }, pendingTurn.threadId);
  }

  private appendActivityAndEmit(
    threadId: ThreadId,
    activity: Omit<OrchestrationThreadActivity, "sequence"> & { sequence?: number },
    commandId: string | null = null,
  ) {
    this.updateThread(threadId, activity.createdAt, (thread) => appendActivity(thread, activity));
    this.emitThreadEvent("thread.activity-appended", threadId, commandId, {
      threadId,
      activity: this.requireThread(threadId).activities.at(-1)!,
    });
  }

  private updateThread(
    threadId: ThreadId,
    updatedAt: string,
    updater: (thread: OrchestrationThread) => OrchestrationThread,
  ) {
    this.snapshot = mapThread(this.snapshot, threadId, updater, updatedAt);
  }

  private emitThreadEvent<T extends OrchestrationEvent["type"]>(
    type: T,
    threadId: ThreadId,
    commandId: string | null,
    payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  ) {
    const event = {
      sequence: this.nextSequence++,
      eventId: makeId("demo-event") as EventId,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: this.nowIso(),
      commandId,
      causationEventId: null,
      correlationId: commandId,
      metadata: {},
      type,
      payload,
    } as Extract<OrchestrationEvent, { type: T }>;

    this.emit({ type: "orchestration.event", payload: event });
  }

  private requireThread(threadId: ThreadId) {
    const thread = this.snapshot.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      throw new Error(`Unknown demo thread: ${threadId}`);
    }
    return thread;
  }

  private requireProject(projectId: ProjectId): OrchestrationProject {
    const project = this.snapshot.projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new Error(`Unknown demo project: ${projectId}`);
    }
    return project;
  }

  private schedule(delayMs: number, fn: () => void, threadId?: ThreadId) {
    let task: ScheduledScenarioTask | null = null;
    task = this.scheduler.schedule(delayMs, () => {
      if (task) {
        this.unregisterScheduledTask(task, threadId);
      }
      fn();
    });
    this.registerScheduledTask(task, threadId);
  }

  private registerScheduledTask(task: ScheduledScenarioTask, threadId?: ThreadId) {
    this.scheduledTasks.add(task);
    if (!threadId) {
      return;
    }
    const tasks = this.scheduledTasksByThread.get(threadId) ?? new Set<ScheduledScenarioTask>();
    tasks.add(task);
    this.scheduledTasksByThread.set(threadId, tasks);
  }

  private unregisterScheduledTask(task: ScheduledScenarioTask, threadId?: ThreadId) {
    this.scheduledTasks.delete(task);
    if (!threadId) {
      return;
    }
    const tasks = this.scheduledTasksByThread.get(threadId);
    if (!tasks) {
      return;
    }
    tasks.delete(task);
    if (tasks.size === 0) {
      this.scheduledTasksByThread.delete(threadId);
    }
  }

  private clearPendingTurnsForThread(threadId: ThreadId) {
    for (const [requestId, pendingTurn] of this.pendingTurns.entries()) {
      if (pendingTurn.threadId === threadId) {
        this.pendingTurns.delete(requestId);
      }
    }
  }

  private cancelThreadScheduledTasks(threadId: ThreadId) {
    const tasks = this.scheduledTasksByThread.get(threadId);
    if (!tasks) {
      return;
    }
    for (const task of tasks) {
      task.cancel();
      this.scheduledTasks.delete(task);
    }
    this.scheduledTasksByThread.delete(threadId);
  }

  private cancelAllScheduledTasks() {
    for (const task of this.scheduledTasks) {
      task.cancel();
    }
    this.scheduledTasks.clear();
    this.scheduledTasksByThread.clear();
    this.scheduler.cancelAll();
  }

  private nowIso() {
    return isoAt(this.scheduler.nowMs());
  }

  private emit(event: ConsoleBackendEvent) {
    if (!this.connected) {
      return;
    }
    for (const listener of this.listeners) {
      listener(cloneValue(event));
    }
  }
}
