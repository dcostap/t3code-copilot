import { randomUUID } from "node:crypto";

import {
  type CodexReasoningEffort,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  CopilotClient,
  type CopilotClientOptions,
  type ModelInfo,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from "@github/copilot-sdk";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  assistantUsageFields,
  beginCopilotTurn,
  clearTurnTracking,
  completionTurnRefs,
  isCopilotTurnTerminalEvent,
  markTurnAwaitingCompletion,
  recordTurnUsage,
  type CopilotTurnTrackingState,
} from "./copilotTurnTracking.ts";
import { loadCopilotMcpServersWithDiagnostics } from "./copilotMcpServers.ts";
import {
  normalizeCopilotCliPathOverride,
  resolveBundledCopilotCliPath,
  shouldPassCopilotCliPathToSdk,
} from "./copilotCliPath.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = "copilot" as const;
const USER_INPUT_QUESTION_ID = "answer";
const USER_INPUT_QUESTION_HEADER = "Question";
const COPILOT_SDK_TIMEOUT_MS = 20_000;

export interface CopilotAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotClientHandle;
}

interface PendingApprovalRequest {
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: PermissionRequestResult) => void;
}

interface CopilotUserInputRequest {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
}

interface CopilotUserInputResponse {
  readonly answer: string;
  readonly wasFreeform: boolean;
}

interface PendingUserInputRequest {
  readonly request: CopilotUserInputRequest;
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: CopilotUserInputResponse) => void;
}

interface ActiveCopilotSession extends CopilotTurnTrackingState {
  readonly client: CopilotClientHandle;
  session: CopilotSessionHandle;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  cwd: string | undefined;
  configDir: string | undefined;
  model: string | undefined;
  reasoningEffort: CodexReasoningEffort | undefined;
  interactionMode: "default" | "plan" | undefined;
  latestPlanMarkdown: string | undefined;
  updatedAt: string;
  lastError: string | undefined;
  toolTitlesByCallId: Map<string, string>;
  toolItemTypesByCallId: Map<string, "command_execution" | "dynamic_tool_call" | "mcp_tool_call" | "file_change">;
  toolChangedFilesByCallId: Map<string, string[]>;
  activeToolCallIds: string[];
  pendingApprovalResolvers: Map<string, PendingApprovalRequest>;
  pendingUserInputResolvers: Map<string, PendingUserInputRequest>;
  unsubscribe: () => void;
}

interface CopilotSessionHandle {
  readonly sessionId: string;
  readonly rpc: {
    readonly mode: {
      set(input: { mode: "interactive" | "plan" | "autopilot" }): Promise<{
        mode: "interactive" | "plan" | "autopilot";
      }>;
    };
    readonly plan: {
      read(): Promise<{
        exists: boolean;
        content: string | null;
        path: string | null;
      }>;
    };
  };
  destroy(): Promise<void>;
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: { prompt: string; attachments?: unknown; mode?: string }): Promise<string>;
  abort(): Promise<void>;
  getMessages(): Promise<SessionEvent[]>;
}

interface CopilotClientHandle {
  start(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  createSession(
    config: Parameters<CopilotClient["createSession"]>[0],
  ): Promise<CopilotSessionHandle>;
  resumeSession(
    sessionId: string,
    config: Parameters<CopilotClient["resumeSession"]>[1],
  ): Promise<CopilotSessionHandle>;
  stop(): Promise<Error[]>;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function makeEventId(prefix: string) {
  return EventId.makeUnsafe(`${prefix}-${randomUUID()}`);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return TurnId.makeUnsafe(value);
}

function toRuntimeItemId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeItemId.makeUnsafe(value);
}

function toProviderItemId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return ProviderItemId.makeUnsafe(value);
}

function toRuntimeRequestId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeRequestId.makeUnsafe(value);
}

function toRuntimeTaskId(value: string | undefined) {
  if (!value || value.trim().length === 0) return undefined;
  return RuntimeTaskId.makeUnsafe(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlanStepText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function planStepKey(value: string) {
  return normalizePlanStepText(value).toLowerCase();
}

function parseCopilotPlanSteps(planMarkdown: string): Array<{
  step: string;
  status: "pending" | "completed";
}> {
  const steps: Array<{ step: string; status: "pending" | "completed" }> = [];
  for (const line of planMarkdown.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/u);
    if (!match) {
      continue;
    }
    const step = normalizePlanStepText(match[2] ?? "");
    if (step.length === 0) {
      continue;
    }
    steps.push({
      step,
      status: match[1]?.toLowerCase() === "x" ? "completed" : "pending",
    });
  }
  return steps;
}

function synthesizeCopilotPlanSteps(input: {
  previousPlanMarkdown: string | undefined;
  nextPlanMarkdown: string;
}): Array<{
  step: string;
  status: "pending" | "inProgress" | "completed";
}> {
  const nextSteps = parseCopilotPlanSteps(input.nextPlanMarkdown);
  if (nextSteps.length === 0) {
    return [];
  }

  const previousStatusesByKey = new Map(
    (input.previousPlanMarkdown ? parseCopilotPlanSteps(input.previousPlanMarkdown) : []).map((step) => [
      planStepKey(step.step),
      step.status,
    ]),
  );

  let resolvedSteps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }> = nextSteps.map((step) => ({
    step: step.step,
    status: previousStatusesByKey.get(planStepKey(step.step)) === "completed"
      ? "completed" as const
      : step.status,
  }));

  const hasExplicitCompleted = resolvedSteps.some((step) => step.status === "completed");
  const firstPendingIndex = resolvedSteps.findIndex((step) => step.status === "pending");
  if (hasExplicitCompleted && firstPendingIndex >= 0) {
    resolvedSteps = resolvedSteps.map((step, index) =>
      index === firstPendingIndex
        ? { ...step, status: "inProgress" as const }
        : step
    );
  }

  return resolvedSteps;
}

function mapSupportedModelsById(models: ReadonlyArray<ModelInfo>) {
  return new Map(models.map((model) => [model.id, model]));
}

function withPromiseTimeout<T, E extends ProviderAdapterError>(
  promiseFactory: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => E,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(onTimeout());
    }, timeoutMs);

    promiseFactory()
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function isKnownProviderError(cause: unknown): cause is ProviderAdapterError {
  return Schema.is(ProviderAdapterProcessError)(cause)
    || Schema.is(ProviderAdapterRequestError)(cause)
    || Schema.is(ProviderAdapterValidationError)(cause)
    || Schema.is(ProviderAdapterSessionNotFoundError)(cause);
}

function tryCopilotSdkPromise<A, E extends ProviderAdapterError>(input: {
  readonly try: () => Promise<A>;
  readonly timeoutError: () => E;
  readonly catch: (cause: unknown) => E;
}) {
  return Effect.tryPromise({
    try: () =>
      withPromiseTimeout(input.try, COPILOT_SDK_TIMEOUT_MS, input.timeoutError),
    catch: (cause) => (isKnownProviderError(cause) ? cause : input.catch(cause)),
  });
}

function getCopilotReasoningEffort(
  modelOptions: unknown,
) {
  const record = asRecord(modelOptions);
  const copilot = asRecord(record?.copilot);
  const reasoningEffort = normalizeString(copilot?.reasoningEffort);
  return reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high" ||
    reasoningEffort === "xhigh"
    ? reasoningEffort
    : undefined;
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor.trim();
  }
  const record = asRecord(resumeCursor);
  const sessionId = normalizeString(record?.sessionId);
  return sessionId;
}

function toCopilotSessionMode(interactionMode: "default" | "plan"): "interactive" | "plan" {
  return interactionMode === "plan" ? "plan" : "interactive";
}

function toInteractionMode(mode: string): "default" | "plan" {
  return mode === "plan" ? "plan" : "default";
}

function approvalDecisionToPermissionResult(
  decision: ProviderApprovalDecision,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
    case "cancel":
    default:
      return { kind: "denied-interactively-by-user" };
  }
}

function requestTypeFromPermissionRequest(request: PermissionRequest) {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval" as const;
    case "write":
      return "file_change_approval" as const;
    case "read":
      return "file_read_approval" as const;
    case "mcp":
    case "custom-tool":
      return "dynamic_tool_call" as const;
    default:
      return "unknown" as const;
  }
}

function requestDetailFromPermissionRequest(request: PermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return trimToUndefined(String(request.fullCommandText ?? ""));
    case "write":
      return trimToUndefined(String(request.fileName ?? request.intention ?? ""));
    case "read":
      return trimToUndefined(String(request.path ?? request.intention ?? ""));
    case "mcp":
      return trimToUndefined(String(request.toolTitle ?? request.toolName ?? ""));
    case "url":
      return trimToUndefined(String(request.url ?? request.intention ?? ""));
    case "custom-tool":
      return trimToUndefined(String(request.toolName ?? request.toolDescription ?? ""));
    default:
      return undefined;
  }
}

type CopilotToolExecutionStartEvent = Extract<SessionEvent, { type: "tool.execution_start" }>;
type CopilotToolExecutionCompleteEvent = Extract<SessionEvent, { type: "tool.execution_complete" }>;
type CopilotToolItemType = "command_execution" | "dynamic_tool_call" | "mcp_tool_call" | "file_change";
type CopilotTerminalResultContent = Extract<
  NonNullable<NonNullable<CopilotToolExecutionCompleteEvent["data"]["result"]>["contents"]>[number],
  { type: "terminal" }
>;

const COPILOT_COMMAND_TOOL_NAMES = new Set(["bash", "cmd", "powershell", "pwsh", "shell", "sh", "zsh"]);
const COPILOT_FILE_CHANGE_TOOL_NAME_HINTS = [
  "apply_patch",
  "create_file",
  "write_file",
  "edit_file",
  "replace",
  "rename",
  "move",
  "delete",
  "insert_edit",
  "multi_edit",
  "notebook",
];
const COPILOT_FILE_READ_TOOL_NAME_HINTS = ["read", "view", "search", "list", "glob"];

function extractChangedFiles(value: unknown): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  const collect = (candidate: unknown, depth: number) => {
    if (depth > 4 || candidate == null) {
      return;
    }
    if (typeof candidate === "string") {
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        collect(entry, depth + 1);
      }
      return;
    }
    const record = asRecord(candidate);
    if (!record) {
      return;
    }
    for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
      const path = normalizeString(record[key]);
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      results.push(path);
    }
    for (const key of ["arguments", "result", "input", "data", "changes", "files", "edits", "patch"]) {
      if (key in record) {
        collect(record[key], depth + 1);
      }
    }
  };

  collect(value, 0);
  return results;
}

function hasLikelyFileMutationShape(value: unknown): boolean {
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth > 4 || candidate == null) {
      return false;
    }
    if (Array.isArray(candidate)) {
      return candidate.some((entry) => visit(entry, depth + 1));
    }
    const record = asRecord(candidate);
    if (!record) {
      return false;
    }
    const hasPath = ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]
      .some((key) => typeof record[key] === "string");
    const hasMutationData = [
      "patch",
      "diff",
      "edits",
      "replacement",
      "replacements",
      "old_str",
      "new_str",
      "file_text",
      "newText",
      "oldText",
      "content",
      "contents",
    ].some((key) => key in record);
    if (hasPath && hasMutationData) {
      return true;
    }
    return ["arguments", "result", "input", "data", "changes", "files", "edits", "patch"]
      .some((key) => key in record && visit(record[key], depth + 1));
  };

  return visit(value, 0);
}

function extractUnifiedDiffText(value: unknown): string | undefined {
  const visit = (candidate: unknown, depth: number): string | undefined => {
    if (depth > 4 || candidate == null) {
      return undefined;
    }
    if (typeof candidate === "string") {
      const normalized = candidate.replace(/\r\n/g, "\n").trim();
      if (!normalized) {
        return undefined;
      }
      return normalized.includes("diff --git ") ? normalized : undefined;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const diff = visit(entry, depth + 1);
        if (diff) {
          return diff;
        }
      }
      return undefined;
    }
    const record = asRecord(candidate);
    if (!record) {
      return undefined;
    }
    for (const key of ["diff", "patch", "detailedContent", "content", "result", "arguments", "input", "data", "changes", "files", "edits"]) {
      if (!(key in record)) {
        continue;
      }
      const diff = visit(record[key], depth + 1);
      if (diff) {
        return diff;
      }
    }
    return undefined;
  };

  return visit(value, 0);
}

function isLikelyFileChangeToolName(toolName: string | undefined) {
  const normalized = normalizeString(toolName)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  if (COPILOT_FILE_READ_TOOL_NAME_HINTS.some((hint) => normalized.includes(hint))) {
    return false;
  }
  return COPILOT_FILE_CHANGE_TOOL_NAME_HINTS.some((hint) => normalized.includes(hint));
}

function hasCommandExecutionArguments(event: CopilotToolExecutionStartEvent) {
  const argumentsRecord = asRecord(event.data.arguments);
  const command = argumentsRecord?.command;
  const fullCommandText = normalizeString(argumentsRecord?.fullCommandText);
  return fullCommandText !== undefined
    || typeof command === "string"
    || (Array.isArray(command) && command.every((entry) => typeof entry === "string"));
}

function isLikelyFileChangeToolEvent(event: CopilotToolExecutionStartEvent) {
  return isLikelyFileChangeToolName(event.data.toolName)
    || hasLikelyFileMutationShape(event.data.arguments);
}

function itemTypeFromToolEvent(event: CopilotToolExecutionStartEvent): CopilotToolItemType {
  if (event.data.mcpToolName) {
    return "mcp_tool_call";
  }

  const normalizedToolName = normalizeString(event.data.toolName)?.toLowerCase();
  if ((normalizedToolName && COPILOT_COMMAND_TOOL_NAMES.has(normalizedToolName))
    || hasCommandExecutionArguments(event)) {
    return "command_execution";
  }

  if (isLikelyFileChangeToolEvent(event)) {
    return "file_change";
  }

  return "dynamic_tool_call";
}

function mergeChangedFiles(current: ReadonlyArray<string> | undefined, next: ReadonlyArray<string>) {
  const merged = new Set(current ?? []);
  for (const path of next) {
    const normalized = normalizeString(path);
    if (normalized) {
      merged.add(normalized);
    }
  }
  return [...merged];
}

function rememberToolChangedFiles(record: ActiveCopilotSession, toolCallId: string, changedFiles: ReadonlyArray<string>) {
  if (changedFiles.length === 0) {
    return;
  }
  const merged = mergeChangedFiles(record.toolChangedFilesByCallId.get(toolCallId), changedFiles);
  record.toolChangedFilesByCallId.set(toolCallId, merged);
}

function rememberWorkspaceFileChange(record: ActiveCopilotSession, path: string | undefined) {
  const normalizedPath = normalizeString(path);
  if (!normalizedPath) {
    return;
  }
  const targetToolCallId = record.activeToolCallIds.toReversed().find((toolCallId) => {
    const itemType = record.toolItemTypesByCallId.get(toolCallId);
    return itemType === "file_change" || itemType === "dynamic_tool_call";
  });
  if (!targetToolCallId) {
    return;
  }
  if (record.toolItemTypesByCallId.get(targetToolCallId) === "dynamic_tool_call") {
    record.toolItemTypesByCallId.set(targetToolCallId, "file_change");
  }
  rememberToolChangedFiles(record, targetToolCallId, [normalizedPath]);
}

function buildCanonicalFileChangeData(input: {
  readonly toolCallId: string;
  readonly status: "inProgress" | "completed" | "failed";
  readonly changedFiles: ReadonlyArray<string>;
  readonly source: unknown;
}) {
  const unifiedDiff =
    input.changedFiles.length === 1 ? extractUnifiedDiffText(input.source) : undefined;
  return {
    item: {
      id: input.toolCallId,
      type: "fileChange",
      status: input.status,
      changes: input.changedFiles.map((path) => ({
        path,
        ...(unifiedDiff ? { diff: unifiedDiff } : {}),
      })),
    },
    source: input.source,
  };
}

function toolDetailFromEvent(data: {
  readonly toolName?: string;
  readonly mcpToolName?: string;
  readonly mcpServerName?: string;
}) {
  return trimToUndefined(
    [data.mcpServerName, data.mcpToolName ?? data.toolName].filter(Boolean).join(" / "),
  );
}

function toolDisplayTitleFromEvent(data: {
  readonly toolName?: string;
  readonly mcpToolName?: string;
}) {
  return trimToUndefined(data.mcpToolName ?? data.toolName);
}

function rememberAssistantToolRequestTitles(
  record: ActiveCopilotSession,
  data: unknown,
) {
  const eventRecord = asRecord(data);
  const toolRequests = Array.isArray(eventRecord?.toolRequests) ? eventRecord.toolRequests : [];
  for (const entry of toolRequests) {
    const toolRequest = asRecord(entry);
    const toolCallId = normalizeString(toolRequest?.toolCallId);
    const title =
      normalizeString(toolRequest?.toolTitle)
      ?? normalizeString(toolRequest?.mcpToolName)
      ?? normalizeString(toolRequest?.toolName)
      ?? normalizeString(toolRequest?.name);
    if (!toolCallId || !title || record.toolTitlesByCallId.has(toolCallId)) {
      continue;
    }
    record.toolTitlesByCallId.set(toolCallId, title);
  }
}

function terminalResultFromToolCompleteEvent(
  event: CopilotToolExecutionCompleteEvent,
): CopilotTerminalResultContent | undefined {
  return event.data.result?.contents?.find(
    (content): content is CopilotTerminalResultContent => content.type === "terminal",
  );
}

function toolResultDetailFromEvent(event: CopilotToolExecutionCompleteEvent) {
  return trimToUndefined(event.data.result?.detailedContent ?? event.data.result?.content);
}

function shouldKeepToolExecutionRunning(event: CopilotToolExecutionCompleteEvent) {
  const terminalResult = terminalResultFromToolCompleteEvent(event);
  return event.data.success && terminalResult !== undefined && typeof terminalResult.exitCode !== "number";
}

function withRefs(input: {
  readonly threadId: ThreadId;
  readonly eventId: EventId;
  readonly createdAt: string;
  readonly turnId: TurnId | undefined;
  readonly providerTurnId?: TurnId | undefined;
  readonly itemId: string | undefined;
  readonly requestId: string | undefined;
  readonly rawMethod: string | undefined;
  readonly rawPayload: unknown;
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.providerTurnId ?? input.turnId;
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = trimToUndefined(input.requestId);
  return {
    eventId: input.eventId,
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    raw: {
      source: input.rawMethod ? "copilot.sdk.session-event" : "copilot.sdk.synthetic",
      ...(input.rawMethod ? { method: input.rawMethod } : {}),
      payload: input.rawPayload,
    },
  };
}

function mapHistoryToTurns(
  threadId: ThreadId,
  events: ReadonlyArray<SessionEvent>,
): ProviderThreadSnapshot {
  const turns: Array<ProviderThreadTurnSnapshot> = [];
  let current: { id: TurnId; items: Array<unknown> } | undefined;

  for (const event of events) {
    if (event.type === "assistant.turn_start") {
      current = {
        id: TurnId.makeUnsafe(event.data.turnId),
        items: [event],
      };
      turns.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    current.items.push(event);
    if (isCopilotTurnTerminalEvent(event)) {
      current = undefined;
    }
  }

  return {
    threadId,
    turns: turns.map((turn) => ({
      id: turn.id,
      items: turn.items,
    })),
  };
}

function makeSyntheticEvent(
  threadId: ThreadId,
  type: ProviderRuntimeEvent["type"],
  payload: ProviderRuntimeEvent["payload"],
  extra?: {
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
    readonly requestId?: string | undefined;
  },
): ProviderRuntimeEvent {
  return {
    ...withRefs({
      threadId,
      eventId: makeEventId("copilot-synthetic"),
      createdAt: new Date().toISOString(),
      turnId: extra?.turnId,
      itemId: extra?.itemId,
      requestId: extra?.requestId,
      rawMethod: undefined,
      rawPayload: payload,
    }),
    type,
    payload,
  } as ProviderRuntimeEvent;
}

function resolveUserInputAnswer(
  pending: PendingUserInputRequest,
  answers: ProviderUserInputAnswers,
): CopilotUserInputResponse {
  const direct = answers[USER_INPUT_QUESTION_ID];
  const candidate =
    typeof direct === "string"
      ? direct
      : Object.values(answers).find((value): value is string => typeof value === "string");
  const answer = trimToUndefined(candidate) ?? "";
  return {
    answer,
    wasFreeform: !pending.request.choices?.includes(answer),
  };
}

function createSessionRecord(input: {
  readonly threadId: ThreadId;
  readonly client: CopilotClientHandle;
  readonly session: CopilotSessionHandle;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly pendingApprovalResolvers: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputResolvers: Map<string, PendingUserInputRequest>;
  readonly cwd: string | undefined;
  readonly configDir: string | undefined;
  readonly model: string | undefined;
  readonly reasoningEffort: CodexReasoningEffort | undefined;
}): ActiveCopilotSession {
  return {
    client: input.client,
    session: input.session,
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
    runtimeMode: input.runtimeMode,
    cwd: input.cwd,
    configDir: input.configDir,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    interactionMode: undefined,
    latestPlanMarkdown: undefined,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    currentTurnId: undefined,
    currentProviderTurnId: undefined,
    pendingCompletionTurnId: undefined,
    pendingCompletionProviderTurnId: undefined,
    pendingTurnIds: [],
    pendingTurnUsage: undefined,
    toolTitlesByCallId: new Map(),
    toolItemTypesByCallId: new Map(),
    toolChangedFilesByCallId: new Map(),
    activeToolCallIds: [],
    pendingApprovalResolvers: input.pendingApprovalResolvers,
    pendingUserInputResolvers: input.pendingUserInputResolvers,
    unsubscribe: () => undefined,
  };
}

const makeCopilotAdapter = (options?: CopilotAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const nativeEventLogger = options?.nativeEventLogger;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ActiveCopilotSession>();

    const emitRuntimeEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      Effect.runPromise(Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid)).catch(
        () => undefined,
      );

    const writeNativeEvent = (threadId: ThreadId, event: SessionEvent) => {
      if (!nativeEventLogger) return Promise.resolve();
      return Effect.runPromise(nativeEventLogger.write(event, threadId)).catch(() => undefined);
    };

    const currentSyntheticTurnId = (record: ActiveCopilotSession) =>
      completionTurnRefs(record).turnId ?? record.currentTurnId;

    const syncInteractionMode = (
      record: ActiveCopilotSession,
      interactionMode: "default" | "plan",
    ) => {
      if (record.interactionMode === interactionMode) {
        return Effect.void;
      }
      return Effect.tryPromise({
        try: async () => {
          await record.session.rpc.mode.set({
            mode: toCopilotSessionMode(interactionMode),
          });
          record.interactionMode = interactionMode;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.mode.set",
            detail: toMessage(cause, "Failed to switch GitHub Copilot interaction mode."),
            cause,
          }),
      });
    };

    const emitLatestPlanState = (record: ActiveCopilotSession) =>
      Effect.tryPromise({
        try: () => record.session.rpc.plan.read(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.plan.read",
            detail: toMessage(cause, "Failed to read the GitHub Copilot plan."),
            cause,
          }),
      }).pipe(
        Effect.flatMap((plan) => {
          const planMarkdown = trimToUndefined(plan.content ?? undefined);
          const previousPlanMarkdown = record.latestPlanMarkdown;
          record.latestPlanMarkdown = plan.exists ? planMarkdown : undefined;

          if (!plan.exists || !planMarkdown || previousPlanMarkdown === planMarkdown) {
            return Effect.void;
          }

          const runtimeEvents: ProviderRuntimeEvent[] = [];
          const planSteps = synthesizeCopilotPlanSteps({
            previousPlanMarkdown,
            nextPlanMarkdown: planMarkdown,
          });
          if (planSteps.length > 0) {
            runtimeEvents.push(
              makeSyntheticEvent(
                record.threadId,
                "turn.plan.updated",
                {
                  plan: planSteps,
                },
                { turnId: currentSyntheticTurnId(record) },
              ),
            );
          }
          runtimeEvents.push(
            makeSyntheticEvent(
              record.threadId,
              "turn.proposed.completed",
              {
                planMarkdown,
              },
              { turnId: currentSyntheticTurnId(record) },
            ),
          );
          return Queue.offerAll(runtimeEventQueue, runtimeEvents).pipe(Effect.asVoid);
        }),
      );

    const mapSessionEvent = (
      record: ActiveCopilotSession,
      event: SessionEvent,
    ): ReadonlyArray<ProviderRuntimeEvent> => {
      const currentTurnId = record.currentTurnId;
      const currentProviderTurnId = record.currentProviderTurnId;
      const resolveOrchestrationTurnId = (
        providerTurnId: TurnId | undefined,
      ): TurnId | undefined => {
        if (providerTurnId && currentProviderTurnId && providerTurnId === currentProviderTurnId) {
          return currentTurnId ?? providerTurnId;
        }
        return currentTurnId ?? providerTurnId;
      };
      const base = (input?: {
        readonly turnId?: TurnId | undefined;
        readonly providerTurnId?: TurnId | undefined;
        readonly itemId?: string | undefined;
        readonly requestId?: string | undefined;
      }) =>
        withRefs({
          threadId: record.threadId,
          eventId: EventId.makeUnsafe(event.id),
          createdAt: event.timestamp,
          turnId: resolveOrchestrationTurnId(input?.providerTurnId ?? input?.turnId),
          providerTurnId: input?.providerTurnId ?? input?.turnId,
          itemId: input?.itemId,
          requestId: input?.requestId,
          rawMethod: event.type,
          rawPayload: event,
        });

      switch (event.type) {
        case "session.start":
        case "session.resume":
          return [
            {
              ...base(),
              type: "session.started",
              payload: {
                message:
                  event.type === "session.resume"
                    ? "Resumed GitHub Copilot session"
                    : "Started GitHub Copilot session",
                resume: event.data,
              },
            },
            {
              ...base(),
              type: "thread.started",
              payload: {
                providerThreadId:
                  event.type === "session.start" ? event.data.sessionId : record.session.sessionId,
              },
            },
          ];
        case "session.info":
          return [
            {
              ...base(),
              type: "runtime.warning",
              payload: {
                message: event.data.message,
                detail: event.data,
              },
            },
          ];
        case "session.warning":
          return [
            {
              ...base(),
              type: "runtime.warning",
              payload: {
                message: event.data.message,
                detail: event.data,
              },
            },
          ];
        case "session.error":
          return [
            {
              ...base(),
              type: "runtime.error",
              payload: {
                message: event.data.message,
                class: "provider_error",
                detail: event.data,
              },
            },
            {
              ...base(),
              type: "session.state.changed",
              payload: {
                state: "error",
                reason: "session.error",
                detail: event.data,
              },
            },
          ];
        case "session.idle": {
          const idleCompletionRefs = completionTurnRefs(record);
          const idleCompletionEvents: ProviderRuntimeEvent[] =
            idleCompletionRefs.turnId || idleCompletionRefs.providerTurnId
              ? [
                  {
                    ...base(idleCompletionRefs),
                    type: "turn.completed",
                    payload: {
                      state: "completed",
                      ...assistantUsageFields(record.pendingTurnUsage),
                    },
                  } satisfies ProviderRuntimeEvent,
                ]
              : [];
          return [
            ...idleCompletionEvents,
            {
              ...base(),
              type: "session.state.changed",
              payload: {
                state: "ready",
                reason: "session.idle",
              },
            },
            {
              ...base(),
              type: "thread.state.changed",
              payload: {
                state: "idle",
                detail: event.data,
              },
            },
          ];
        }
        case "session.title_changed":
          return [
            {
              ...base(),
              type: "thread.metadata.updated",
              payload: {
                name: event.data.title,
                metadata: event.data,
              },
            },
          ];
        case "session.model_change":
          return [
            {
              ...base(),
              type: "model.rerouted",
              payload: {
                fromModel: event.data.previousModel ?? "unknown",
                toModel: event.data.newModel,
                reason: "session.model_change",
              },
            },
          ];
        case "session.plan_changed":
          return [];
        case "session.workspace_file_changed":
          return [
            {
              ...base(),
              type: "files.persisted",
              payload: {
                files: [
                  {
                    filename: event.data.path,
                    fileId: event.data.path,
                  },
                ],
              },
            },
          ];
        case "session.context_changed":
          return [
            {
              ...base(),
              type: "thread.metadata.updated",
              payload: {
                metadata: event.data,
              },
            },
          ];
        case "session.usage_info":
          return [
            {
              ...base(),
              type: "thread.token-usage.updated",
              payload: {
                usage: event.data,
              },
            },
          ];
        case "session.task_complete":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId:
                  toRuntimeTaskId(record.threadId) ?? RuntimeTaskId.makeUnsafe(record.threadId),
                status: "completed",
                ...(trimToUndefined(event.data.summary) ? { summary: event.data.summary } : {}),
              },
            },
          ];
        case "assistant.turn_start":
          return [
            {
              ...base({ providerTurnId: toTurnId(event.data.turnId) }),
              type: "turn.started",
              payload: record.model ? { model: record.model } : {},
            },
            {
              ...base({ providerTurnId: toTurnId(event.data.turnId) }),
              type: "session.state.changed",
              payload: {
                state: "running",
                reason: "assistant.turn_start",
              },
            },
          ];
        case "assistant.reasoning":
          return [
            {
              ...base({ itemId: event.data.reasoningId }),
              type: "item.completed",
              payload: {
                itemType: "reasoning",
                status: "completed",
                title: "Reasoning",
                detail: trimToUndefined(event.data.content),
                data: event.data,
              },
            },
          ];
        case "assistant.reasoning_delta":
          return [
            {
              ...base({ itemId: event.data.reasoningId }),
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text",
                delta: event.data.deltaContent,
              },
            },
          ];
        case "assistant.message":
          return [
            {
              ...base({ itemId: event.data.messageId }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                detail: trimToUndefined(event.data.content),
                data: event.data,
              },
            },
          ];
        case "assistant.message_delta":
          return [
            {
              ...base({ itemId: event.data.messageId }),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: event.data.deltaContent,
              },
            },
          ];
        case "assistant.turn_end":
          return [];
        case "assistant.usage": {
          const completionRefs = completionTurnRefs(record);
          const completionBase =
            completionRefs.turnId || completionRefs.providerTurnId ? base(completionRefs) : base();
          return [
            {
              ...completionBase,
              type: "thread.token-usage.updated",
              payload: {
                usage: event.data,
              },
            },
          ];
        }
        case "abort": {
          const abortedTurnRefs = completionTurnRefs(record);
          const abortedBase =
            abortedTurnRefs.turnId || abortedTurnRefs.providerTurnId
              ? base(abortedTurnRefs)
              : base();
          return [
            {
              ...abortedBase,
              type: "turn.aborted",
              payload: {
                reason: event.data.reason,
              },
            },
          ];
        }
        case "tool.execution_start": {
          const itemType = itemTypeFromToolEvent(event);
          const changedFiles = extractChangedFiles(event.data.arguments);
          const title =
            record.toolTitlesByCallId.get(event.data.toolCallId)
            ?? toolDisplayTitleFromEvent(event.data)
            ?? "Tool call";
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "item.started",
              payload: {
                itemType,
                status: "inProgress",
                title,
                ...(toolDetailFromEvent(event.data)
                  ? { detail: toolDetailFromEvent(event.data) }
                  : {}),
                data:
                  itemType === "file_change"
                    ? buildCanonicalFileChangeData({
                        toolCallId: event.data.toolCallId,
                        status: "inProgress",
                        changedFiles,
                        source: event.data,
                      })
                    : event.data,
              },
            },
          ];
        }
        case "tool.execution_progress":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "tool.progress",
              payload: {
                toolUseId: event.data.toolCallId,
                summary: event.data.progressMessage,
              },
            },
          ];
        case "tool.execution_partial_result":
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: "tool.progress",
              payload: {
                toolUseId: event.data.toolCallId,
                summary: event.data.partialOutput,
              },
            },
          ];
        case "tool.execution_complete": {
          const keepRunning = shouldKeepToolExecutionRunning(event);
          const detail = toolResultDetailFromEvent(event);
          const status = keepRunning ? "inProgress" : event.data.success ? "completed" : "failed";
          const itemType =
            terminalResultFromToolCompleteEvent(event) !== undefined
              ? "command_execution"
              : (record.toolItemTypesByCallId.get(event.data.toolCallId) ?? "dynamic_tool_call");
          const changedFiles = mergeChangedFiles(
            record.toolChangedFilesByCallId.get(event.data.toolCallId),
            extractChangedFiles(event.data),
          );
          return [
            {
              ...base({ itemId: event.data.toolCallId }),
              type: keepRunning ? "item.updated" : "item.completed",
              payload: {
                itemType,
                status,
                title: record.toolTitlesByCallId.get(event.data.toolCallId) ?? "Tool call",
                ...(detail ? { detail } : {}),
                data:
                  itemType === "file_change"
                    ? buildCanonicalFileChangeData({
                        toolCallId: event.data.toolCallId,
                        status,
                        changedFiles,
                        source: event.data,
                      })
                    : event.data,
              },
            },
            ...(!keepRunning && trimToUndefined(event.data.result?.content)
              ? [
                  {
                    ...base({ itemId: event.data.toolCallId }),
                    type: "tool.summary" as const,
                    payload: {
                      summary: event.data.result?.content ?? "",
                      precedingToolUseIds: [event.data.toolCallId],
                    },
                  },
                ]
              : []),
          ];
        }
        case "skill.invoked":
          return [
            {
              ...base(),
              type: "task.progress",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.name) ?? RuntimeTaskId.makeUnsafe(event.data.name),
                description: `Invoked skill ${event.data.name}`,
              },
            },
          ];
        case "subagent.started":
          return [
            {
              ...base(),
              type: "task.started",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.makeUnsafe(event.data.toolCallId),
                description: trimToUndefined(event.data.agentDescription),
                taskType: "subagent",
              },
            },
          ];
        case "subagent.completed":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.makeUnsafe(event.data.toolCallId),
                status: "completed",
                ...(trimToUndefined(event.data.agentDisplayName)
                  ? { summary: event.data.agentDisplayName }
                  : {}),
              },
            },
          ];
        case "subagent.failed":
          return [
            {
              ...base(),
              type: "task.completed",
              payload: {
                taskId:
                  toRuntimeTaskId(event.data.toolCallId) ??
                  RuntimeTaskId.makeUnsafe(event.data.toolCallId),
                status: "failed",
                ...(trimToUndefined(event.data.error) ? { summary: event.data.error } : {}),
              },
            },
          ];
        default:
          return [];
      }
    };

    const createInteractionHandlers = (
      threadId: ThreadId,
      getCurrentTurnId: () => TurnId | undefined,
      getRuntimeMode: () => ProviderSession["runtimeMode"],
      pendingApprovalResolvers: Map<string, PendingApprovalRequest>,
      pendingUserInputResolvers: Map<string, PendingUserInputRequest>,
    ) => {
      const onPermissionRequest = (request: PermissionRequest) =>
        getRuntimeMode() === "full-access"
          ? Promise.resolve<PermissionRequestResult>({ kind: "approved" })
          : new Promise<PermissionRequestResult>((resolve) => {
              const requestId = `copilot-approval-${randomUUID()}`;
              const turnId = getCurrentTurnId();
              pendingApprovalResolvers.set(requestId, {
                requestType: requestTypeFromPermissionRequest(request),
                turnId,
                resolve,
              });
              void emitRuntimeEvents([
                makeSyntheticEvent(
                  threadId,
                  "request.opened",
                  {
                    requestType: requestTypeFromPermissionRequest(request),
                    ...(requestDetailFromPermissionRequest(request)
                      ? { detail: requestDetailFromPermissionRequest(request) }
                      : {}),
                    args: request,
                  },
                  { requestId, turnId },
                ),
              ]);
            });

      const onUserInputRequest = (request: CopilotUserInputRequest) =>
        new Promise<CopilotUserInputResponse>((resolve) => {
          const requestId = `copilot-user-input-${randomUUID()}`;
          const turnId = getCurrentTurnId();
          pendingUserInputResolvers.set(requestId, {
            request,
            turnId,
            resolve,
          });
          void emitRuntimeEvents([
            makeSyntheticEvent(
              threadId,
              "user-input.requested",
              {
                questions: [
                  {
                    id: USER_INPUT_QUESTION_ID,
                    header: USER_INPUT_QUESTION_HEADER,
                    question: request.question,
                    options: (request.choices ?? []).map((choice: string) => ({
                      label: choice,
                      description: choice,
                    })),
                  },
                ],
              },
              { requestId, turnId },
            ),
          ]);
        });

      return {
        onPermissionRequest,
        onUserInputRequest,
      };
    };

    const validateSessionConfiguration = (input: {
      readonly client: CopilotClientHandle;
      readonly threadId: ThreadId;
      readonly model: string | undefined;
      readonly reasoningEffort: CodexReasoningEffort | undefined;
    }) =>
      Effect.gen(function* () {
        if (!input.model && !input.reasoningEffort) {
          return;
        }

        yield* tryCopilotSdkPromise({
          try: () => input.client.start(),
          timeoutError: () =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Timed out after ${COPILOT_SDK_TIMEOUT_MS}ms while starting GitHub Copilot client.`,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start GitHub Copilot client."),
              cause,
            }),
        });

        const supportedModels = mapSupportedModelsById(
          yield* tryCopilotSdkPromise({
            try: () => input.client.listModels(),
            timeoutError: () =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `Timed out after ${COPILOT_SDK_TIMEOUT_MS}ms while loading GitHub Copilot model metadata.`,
              }),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to load GitHub Copilot model metadata."),
                cause,
              }),
          }),
        );
        const selectedModel = input.model ? supportedModels.get(input.model) : undefined;

        if (input.model && !selectedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.model",
            issue: `GitHub Copilot model '${input.model}' is not available in the current Copilot runtime.`,
          });
        }

        if (!input.reasoningEffort) {
          return;
        }

        if (!selectedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue:
              "GitHub Copilot reasoning effort requires an explicit supported model selection.",
          });
        }

        const supportedReasoningEfforts = selectedModel.supportedReasoningEfforts ?? [];
        if (supportedReasoningEfforts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue: `GitHub Copilot model '${selectedModel.id}' does not support reasoning effort configuration.`,
          });
        }

        if (!supportedReasoningEfforts.includes(input.reasoningEffort)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session.reasoningEffort",
            issue: `GitHub Copilot model '${selectedModel.id}' does not support reasoning effort '${input.reasoningEffort}'.`,
          });
        }
      });

    const reconfigureSession = (
      record: ActiveCopilotSession,
      input: {
        readonly model: string | undefined;
        readonly reasoningEffort: CodexReasoningEffort | undefined;
      },
    ) =>
      tryCopilotSdkPromise({
        try: async () => {
          const sessionId = record.session.sessionId;
          const previousSession = record.session;
          const previousUnsubscribe = record.unsubscribe;
          previousUnsubscribe();
          await previousSession.destroy();

          const handlers = createInteractionHandlers(
            record.threadId,
            () => record.currentTurnId,
            () => record.runtimeMode,
            record.pendingApprovalResolvers,
            record.pendingUserInputResolvers,
          );
          const nextSession = await record.client.resumeSession(sessionId, {
            ...handlers,
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            ...(record.cwd ? { workingDirectory: record.cwd } : {}),
            ...(record.configDir ? { configDir: record.configDir } : {}),
            streaming: true,
          });

          record.session = nextSession;
          record.model = input.model;
          record.reasoningEffort = input.reasoningEffort;
          record.interactionMode = undefined;
          record.updatedAt = new Date().toISOString();
          record.unsubscribe = nextSession.on((event) => {
            handleSessionEvent(record, event);
          });
        },
        timeoutError: () =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.reconfigure",
            detail: `Timed out after ${COPILOT_SDK_TIMEOUT_MS}ms while reconfiguring GitHub Copilot session.`,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.reconfigure",
            detail: toMessage(cause, "Failed to reconfigure GitHub Copilot session."),
            cause,
          }),
      });

    const handleSessionEvent = (record: ActiveCopilotSession, event: SessionEvent) => {
      record.updatedAt = event.timestamp;
      if (event.type === "assistant.turn_start") {
        beginCopilotTurn(record, TurnId.makeUnsafe(event.data.turnId));
      }
      if (event.type === "assistant.usage") {
        recordTurnUsage(record, event.data);
      }
      if (event.type === "session.error") {
        record.lastError = event.data.message;
      }
      if (event.type === "session.model_change") {
        record.model = event.data.newModel;
      }
      if (event.type === "session.mode_changed") {
        record.interactionMode = toInteractionMode(event.data.newMode);
      }
      if (event.type === "session.plan_changed" && event.data.operation === "delete") {
        record.latestPlanMarkdown = undefined;
      }
      if (event.type === "session.workspace_file_changed") {
        rememberWorkspaceFileChange(record, event.data.path);
      }
      if (event.type === "assistant.message") {
        rememberAssistantToolRequestTitles(record, event.data);
      }
      if (event.type === "tool.execution_start") {
        const title = toolDisplayTitleFromEvent(event.data);
        if (title && !record.toolTitlesByCallId.has(event.data.toolCallId)) {
          record.toolTitlesByCallId.set(event.data.toolCallId, title);
        }
      }
      if (event.type === "tool.execution_start") {
        const itemType = itemTypeFromToolEvent(event);
        record.toolItemTypesByCallId.set(event.data.toolCallId, itemType);
        record.activeToolCallIds = [...record.activeToolCallIds.filter((id) => id !== event.data.toolCallId), event.data.toolCallId];
        rememberToolChangedFiles(record, event.data.toolCallId, extractChangedFiles(event.data.arguments));
      }

      void writeNativeEvent(record.threadId, event);
      const runtimeEvents = mapSessionEvent(record, event);
      if (runtimeEvents.length > 0) {
        void emitRuntimeEvents(runtimeEvents);
      }
      if (event.type === "session.plan_changed" && event.data.operation !== "delete") {
        void Effect.runPromise(emitLatestPlanState(record)).catch((cause) => {
          void emitRuntimeEvents([
            makeSyntheticEvent(
              record.threadId,
              "runtime.warning",
              {
                message: "Failed to read GitHub Copilot plan.",
                detail: toMessage(cause, "Failed to read GitHub Copilot plan."),
              },
              { turnId: currentSyntheticTurnId(record) },
            ),
          ]);
        });
      }
      if (event.type === "tool.execution_complete" && !shouldKeepToolExecutionRunning(event)) {
        record.toolTitlesByCallId.delete(event.data.toolCallId);
        record.toolItemTypesByCallId.delete(event.data.toolCallId);
        record.toolChangedFilesByCallId.delete(event.data.toolCallId);
        record.activeToolCallIds = record.activeToolCallIds.filter((id) => id !== event.data.toolCallId);
      }
      if (event.type === "assistant.turn_end") {
        markTurnAwaitingCompletion(record);
      }
      if (event.type === "abort" || event.type === "session.idle") {
        clearTurnTracking(record);
      }
    };

    const getSessionRecord = (threadId: ThreadId) => {
      const record = sessions.get(threadId);
      if (!record) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(record);
    };

    const stopRecord = async (record: ActiveCopilotSession) => {
      record.unsubscribe();
      try {
        await record.session.destroy();
      } catch {
        // best effort
      }
      try {
        await record.client.stop();
      } catch {
        // best effort
      }
      for (const pending of record.pendingApprovalResolvers.values()) {
        pending.resolve({ kind: "denied-interactively-by-user" });
      }
      for (const pending of record.pendingUserInputResolvers.values()) {
        pending.resolve({ answer: "", wasFreeform: true });
      }
      sessions.delete(record.threadId);
    };

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}', received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) {
          return {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: existing.runtimeMode,
            ...(existing.cwd ? { cwd: existing.cwd } : {}),
            ...(existing.model ? { model: existing.model } : {}),
            threadId: input.threadId,
            resumeCursor: existing.session.sessionId,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
            ...(existing.lastError ? { lastError: existing.lastError } : {}),
          } satisfies ProviderSession;
        }

        const cliPath =
          normalizeCopilotCliPathOverride(input.providerOptions?.copilot?.cliPath) ??
          resolveBundledCopilotCliPath();
        const configDir = trimToUndefined(input.providerOptions?.copilot?.configDir);
        const sdkCliPath = shouldPassCopilotCliPathToSdk(cliPath) ? cliPath : undefined;
        const mcpLoadResult = yield* Effect.tryPromise({
          try: () => loadCopilotMcpServersWithDiagnostics(configDir),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to load GitHub Copilot MCP configuration."),
              cause,
            }),
        });
        const mcpServers = mcpLoadResult.servers;
        const resumeSessionId = extractResumeSessionId(input.resumeCursor);
        yield* Effect.logInfo("GitHub Copilot session bootstrap resolved", {
          provider: PROVIDER,
          threadId: input.threadId,
          mcpConfigPath: mcpLoadResult.configPath,
          loadedMcpServerNames: mcpLoadResult.loadedServerNames,
          ignoredMcpServerNames: mcpLoadResult.ignoredServerNames,
          resolvedCliPath: cliPath,
          passedCliPathToSdk: sdkCliPath !== undefined,
        });
        const clientOptions: CopilotClientOptions = {
          ...(sdkCliPath ? { cliPath: sdkCliPath } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          logLevel: "error",
        };
        const client = options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
        const pendingApprovalResolvers = new Map<string, PendingApprovalRequest>();
        const pendingUserInputResolvers = new Map<string, PendingUserInputRequest>();
        const reasoningEffort = getCopilotReasoningEffort(input.modelOptions);
        let sessionRecord: ActiveCopilotSession | undefined;
        const handlers = createInteractionHandlers(
          input.threadId,
          () => sessionRecord?.currentTurnId,
          () => sessionRecord?.runtimeMode ?? input.runtimeMode,
          pendingApprovalResolvers,
          pendingUserInputResolvers,
        );

        yield* validateSessionConfiguration({
          client,
          threadId: input.threadId,
          model: input.model,
          reasoningEffort,
        });

        const session = yield* tryCopilotSdkPromise({
          try: async () => {
            if (resumeSessionId) {
              return client.resumeSession(resumeSessionId, {
                ...handlers,
                ...(input.model ? { model: input.model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
                ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                ...(configDir ? { configDir } : {}),
                ...(mcpServers ? { mcpServers } : {}),
                streaming: true,
              });
            }
            return client.createSession({
              ...handlers,
              ...(input.model ? { model: input.model } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(input.cwd ? { workingDirectory: input.cwd } : {}),
              ...(configDir ? { configDir } : {}),
              ...(mcpServers ? { mcpServers } : {}),
              streaming: true,
            });
          },
          timeoutError: () =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Timed out after ${COPILOT_SDK_TIMEOUT_MS}ms while starting GitHub Copilot session.`,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start GitHub Copilot session."),
              cause,
            }),
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("GitHub Copilot session start failed", {
              provider: PROVIDER,
              threadId: input.threadId,
              mcpConfigPath: mcpLoadResult.configPath,
              loadedMcpServerNames: mcpLoadResult.loadedServerNames,
              ignoredMcpServerNames: mcpLoadResult.ignoredServerNames,
              resolvedCliPath: cliPath,
              passedCliPathToSdk: sdkCliPath !== undefined,
              cause,
            }),
          ),
        );

        const record = createSessionRecord({
          threadId: input.threadId,
          client,
          session,
          runtimeMode: input.runtimeMode,
          pendingApprovalResolvers,
          pendingUserInputResolvers,
          cwd: input.cwd,
          configDir,
          model: input.model,
          reasoningEffort,
        });
        const unsubscribe = session.on((event) => {
          handleSessionEvent(record, event);
        });
        record.unsubscribe = unsubscribe;
        sessionRecord = record;
        sessions.set(input.threadId, record);

        yield* Queue.offerAll(runtimeEventQueue, [
          makeSyntheticEvent(input.threadId, "session.started", {
            message: resumeSessionId
              ? "Resumed GitHub Copilot session"
              : "Started GitHub Copilot session",
            resume: { sessionId: session.sessionId },
          }),
          makeSyntheticEvent(input.threadId, "session.configured", {
            config: {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(configDir ? { configDir } : {}),
              streaming: true,
            },
          }),
          makeSyntheticEvent(input.threadId, "thread.started", {
            providerThreadId: session.sessionId,
          }),
          makeSyntheticEvent(input.threadId, "session.state.changed", {
            state: "ready",
            reason: "session.started",
          }),
        ]);

        return {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          threadId: input.threadId,
          resumeCursor: session.sessionId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        } satisfies ProviderSession;
      });

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(input.threadId);
        const explicitReasoningEffort = getCopilotReasoningEffort(input.modelOptions);
        const nextModel = input.model ?? record.model;
        const nextReasoningEffort =
          explicitReasoningEffort !== undefined
            ? explicitReasoningEffort
            : input.model && input.model !== record.model
              ? undefined
              : record.reasoningEffort;
        const attachments = (input.attachments ?? []).map((attachment) => {
          const attachmentPath = resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment,
          });
          if (!attachmentPath) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.send",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          return {
            type: "file" as const,
            path: attachmentPath,
            displayName: attachment.name,
          };
        });

        yield* validateSessionConfiguration({
          client: record.client,
          threadId: input.threadId,
          model: nextModel,
          reasoningEffort: nextReasoningEffort,
        });

        if (nextModel !== record.model || nextReasoningEffort !== record.reasoningEffort) {
          yield* reconfigureSession(record, {
            model: nextModel,
            reasoningEffort: nextReasoningEffort,
          });
        }

        const interactionMode = input.interactionMode ?? record.interactionMode ?? "default";
        yield* syncInteractionMode(record, interactionMode);

        const turnId = TurnId.makeUnsafe(`copilot-turn-${randomUUID()}`);
        record.pendingTurnIds.push(turnId);
        record.currentTurnId = turnId;
        record.currentProviderTurnId = undefined;

        yield* tryCopilotSdkPromise({
          try: () =>
            record.session.send({
              prompt: input.input ?? "",
              ...(attachments.length > 0 ? { attachments } : {}),
              mode: "immediate",
            }),
          timeoutError: () =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.send",
              detail: `Timed out after ${COPILOT_SDK_TIMEOUT_MS}ms while sending GitHub Copilot turn.`,
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.send",
              detail: toMessage(cause, "Failed to send GitHub Copilot turn."),
              cause,
            }),
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              record.pendingTurnIds = record.pendingTurnIds.filter(
                (candidate) => candidate !== turnId,
              );
              if (record.currentTurnId === turnId) {
                record.currentTurnId = undefined;
              }
            }),
          ),
        );

        record.updatedAt = new Date().toISOString();

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: record.session.sessionId,
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        yield* tryCopilotSdkPromise({
          try: () => record.session.abort(),
          timeoutError: () =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.abort",
              detail: `Timed out after ${COPILOT_SDK_TIMEOUT_MS}ms while interrupting GitHub Copilot turn.`,
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.abort",
              detail: toMessage(cause, "Failed to interrupt GitHub Copilot turn."),
              cause,
            }),
        });
      });

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        const pending = record.pendingApprovalResolvers.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.permission.respond",
            detail: `Unknown pending GitHub Copilot approval request '${requestId}'.`,
          });
        }
        record.pendingApprovalResolvers.delete(requestId);
        pending.resolve(approvalDecisionToPermissionResult(decision));
        yield* Queue.offer(
          runtimeEventQueue,
          makeSyntheticEvent(
            threadId,
            "request.resolved",
            {
              requestType: pending.requestType,
              decision,
              resolution: approvalDecisionToPermissionResult(decision),
            },
            { requestId, turnId: pending.turnId },
          ),
        );
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        const pending = record.pendingUserInputResolvers.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.userInput.respond",
            detail: `Unknown pending GitHub Copilot user-input request '${requestId}'.`,
          });
        }
        record.pendingUserInputResolvers.delete(requestId);
        pending.resolve(resolveUserInputAnswer(pending, answers));
        yield* Queue.offer(
          runtimeEventQueue,
          makeSyntheticEvent(
            threadId,
            "user-input.resolved",
            {
              answers,
            },
            { requestId, turnId: pending.turnId },
          ),
        );
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        yield* tryCopilotSdkPromise({
          try: async () => {
            await stopRecord(record);
          },
          timeoutError: () =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Timed out after ${COPILOT_SDK_TIMEOUT_MS}ms while stopping GitHub Copilot session.`,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to stop GitHub Copilot session."),
              cause,
            }),
        });
      });

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values()).map(
          (record) =>
            ({
              provider: PROVIDER,
              status: record.currentTurnId ? "running" : "ready",
              runtimeMode: record.runtimeMode,
              threadId: record.threadId,
              resumeCursor: record.session.sessionId,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              ...(record.cwd ? { cwd: record.cwd } : {}),
              ...(record.model ? { model: record.model } : {}),
              ...(record.currentTurnId ? { activeTurnId: record.currentTurnId } : {}),
              ...(record.lastError ? { lastError: record.lastError } : {}),
            }) satisfies ProviderSession,
        ),
      );

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const record = yield* getSessionRecord(threadId);
        return yield* tryCopilotSdkPromise({
          try: async () => {
            const messages = await record.session.getMessages();
            return mapHistoryToTurns(threadId, messages);
          },
          timeoutError: () =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.getMessages",
              detail: `Timed out after ${COPILOT_SDK_TIMEOUT_MS}ms while reading GitHub Copilot thread history.`,
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.getMessages",
              detail: toMessage(cause, "Failed to read GitHub Copilot thread history."),
              cause,
            }),
        });
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (_threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread.rollback",
          detail:
            "GitHub Copilot SDK does not expose a supported conversation rollback API for existing sessions.",
        }),
      );

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.tryPromise({
        try: async () => {
          await Promise.all(Array.from(sessions.values()).map((record) => stopRecord(record)));
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.makeUnsafe("_all"),
            detail: toMessage(cause, "Failed to stop GitHub Copilot sessions."),
            cause,
          }),
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies CopilotAdapterShape;
  });

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
