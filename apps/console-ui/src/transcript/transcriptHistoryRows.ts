import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import { deriveRunningThreadIntentLabel, isReportIntentToolPayload } from "../agentIntent";

export const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
export const TRANSCRIPT_HISTORY_ROW_GAP_PX = 4;

export type TranscriptToolStatus = "running" | "done" | "error" | "declined";

export interface TranscriptReasoningDisplay {
  readonly variant: "summary" | "text";
  readonly text: string;
}

export interface TranscriptToolDisplay {
  readonly mergeKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnId: TurnId | null;
  readonly title: string;
  readonly status: TranscriptToolStatus;
  readonly itemKind: "tool" | "command" | "file-change";
  readonly detail: string | null;
  readonly command: string | null;
  readonly output: string | null;
  readonly changedFiles: ReadonlyArray<string>;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly inlineUnifiedDiff: string | null;
  readonly exitCode: number | null;
  readonly timingLabel: string | null;
}

type TimelineItem =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: OrchestrationMessage;
    }
  | {
      readonly kind: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly activity: OrchestrationThreadActivity;
    }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly reasoning: TranscriptReasoningDisplay;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly createdAt: string;
      readonly tool: TranscriptToolDisplay;
    }
  | {
      readonly kind: "checkpoint";
      readonly id: string;
      readonly createdAt: string;
      readonly checkpoint: OrchestrationCheckpointSummary;
    }
  | {
      readonly kind: "plan";
      readonly id: string;
      readonly createdAt: string;
      readonly plan: OrchestrationProposedPlan;
    };

export type TranscriptHistoryRow =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly message: OrchestrationMessage;
    }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly reasoning: TranscriptReasoningDisplay;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly tool: TranscriptToolDisplay;
    }
  | {
      readonly kind: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
    }
  | {
      readonly kind: "plan";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly plan: OrchestrationProposedPlan;
    }
  | {
      readonly kind: "checkpoint";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId;
      readonly checkpoint: OrchestrationCheckpointSummary;
    }
  | {
      readonly kind: "working";
      readonly id: string;
      readonly createdAt: string | null;
      readonly turnId: TurnId | null;
      readonly label: string | null;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function compareActivitiesByTimelineOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
) {
  const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdAtCompare !== 0) {
    return createdAtCompare;
  }

  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return left.id.localeCompare(right.id);
}

function compareTimelineItems(left: TimelineItem, right: TimelineItem) {
  const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdAtCompare !== 0) {
    return createdAtCompare;
  }

  if (left.kind === "activity" && right.kind === "activity") {
    return compareActivitiesByTimelineOrder(left.activity, right.activity);
  }

  const leftPriority = getTimelineItemPriority(left);
  const rightPriority = getTimelineItemPriority(right);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return left.id.localeCompare(right.id);
}

function getTimelineItemPriority(item: TimelineItem) {
  if (item.kind === "message") {
    if (item.message.role === "user") return 0;
    if (item.message.role === "system") return 1;
    return 3;
  }
  if (item.kind === "plan") {
    return 2;
  }
  if (item.kind === "checkpoint") {
    return 3;
  }
  return 1;
}

function isThreadRunning(thread: OrchestrationThread | null) {
  if (!thread) {
    return false;
  }
  return thread.latestTurn?.state === "running" || thread.session?.status === "running";
}

function normalizeToolName(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function extractToolName(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  return (
    asString(payload?.title)
    ?? asString(item?.toolName)
    ?? asString(result?.toolName)
    ?? asString(data?.toolName)
    ?? asString(data?.mcpToolName)
  );
}

function isAskUserToolPayload(payload: Record<string, unknown> | null): boolean {
  return normalizeToolName(extractToolName(payload)) === "ask_user";
}

function extractWorkItemId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  const precedingToolUseIds = Array.isArray(data?.precedingToolUseIds)
    ? data.precedingToolUseIds
    : [];
  return (
    asString(payload?.itemId)
    ?? asString(item?.id)
    ?? asString(result?.id)
    ?? asString(data?.id)
    ?? asString(item?.toolCallId)
    ?? asString(result?.toolCallId)
    ?? asString(data?.toolCallId)
    ?? asString(item?.toolUseId)
    ?? asString(result?.toolUseId)
    ?? asString(data?.toolUseId)
    ?? precedingToolUseIds.find((entry): entry is string => typeof entry === "string" && entry.length > 0)
    ?? null
  );
}

function deriveHiddenToolWorkItemIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  const hiddenItemIds = new Set<string>();

  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    if (!isAskUserToolPayload(payload) && !isReportIntentToolPayload(payload)) {
      continue;
    }
    const itemId = extractWorkItemId(payload);
    if (itemId) {
      hiddenItemIds.add(itemId);
    }
  }

  return hiddenItemIds;
}

function shouldHideActivityFromTranscript(
  activity: OrchestrationThreadActivity,
  hiddenToolWorkItemIds: ReadonlySet<string>,
) {
  const payload = asRecord(activity.payload);
  if (isAskUserToolPayload(payload) || isReportIntentToolPayload(payload)) {
    return true;
  }

  const itemId = extractWorkItemId(payload);
  return itemId ? hiddenToolWorkItemIds.has(itemId) : false;
}

function stripSimpleMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1");
}

function splitReasoningSummaryIntoDisplays(text: string): ReadonlyArray<TranscriptReasoningDisplay> {
  const headingMatches = [...text.matchAll(/\*\*([^*\n][^*]*?)\*\*/g)];
  if (headingMatches.length === 0) {
    const normalized = stripSimpleMarkdown(text).trim();
    if (!normalized) {
      return [];
    }

    const lineCount = normalized.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    const looksLikeBody = lineCount > 1 || normalized.length > 120;
    return [{ variant: looksLikeBody ? "text" : "summary", text: normalized }];
  }

  const displays: Array<TranscriptReasoningDisplay> = [];

  for (let index = 0; index < headingMatches.length; index += 1) {
    const match = headingMatches[index];
    const headingText = match?.[1]?.trim();
    if (!match || !headingText) {
      continue;
    }

    displays.push({ variant: "summary", text: stripSimpleMarkdown(headingText) });

    const bodyStart = match.index + match[0].length;
    const bodyEnd = headingMatches[index + 1]?.index ?? text.length;
    const bodyText = stripSimpleMarkdown(text.slice(bodyStart, bodyEnd)).trim();
    if (bodyText) {
      displays.push({ variant: "text", text: bodyText });
    }
  }

  return displays;
}

function getReasoningDisplays(activity: OrchestrationThreadActivity): ReadonlyArray<TranscriptReasoningDisplay> {
  const payload = asRecord(activity.payload);
  const detail =
    asString(payload?.text)
    ?? asString(payload?.detail)
    ?? asString(payload?.message)
    ?? asString(activity.summary);

  if (!detail) {
    return [];
  }

  if (activity.kind === "reasoning.summary") {
    return splitReasoningSummaryIntoDisplays(detail);
  }

  if (activity.kind === "reasoning.text") {
    return [{ variant: "text", text: stripSimpleMarkdown(detail) }];
  }

  return [];
}

function toolStatusToDisplayStatus(status: unknown): TranscriptToolStatus {
  switch (status) {
    case "in_progress":
    case "inProgress":
      return "running";
    case "failed":
      return "error";
    case "declined":
      return "declined";
    default:
      return "done";
  }
}

function activityKindToDisplayStatus(kind: string): TranscriptToolStatus {
  if (kind.endsWith(".started") || kind.endsWith(".updated")) {
    return "running";
  }
  if (kind.endsWith(".failed")) {
    return "error";
  }
  if (kind.endsWith(".declined")) {
    return "declined";
  }
  return "done";
}

const SHELL_TOOL_NAMES = new Set(["bash", "cmd", "powershell", "pwsh", "shell", "sh", "zsh"]);

function isShellToolName(value: string | null): boolean {
  return value !== null && SHELL_TOOL_NAMES.has(value);
}

function resolveActivityStatus(
  explicitStatus: unknown,
  activityKind: string,
  itemType?: string | null,
  payload: Record<string, unknown> | null = null,
): TranscriptToolStatus {
  if (
    (itemType === "command_execution" || isCommandLikePayload(payload))
    && (activityKind.endsWith(".started") || activityKind.endsWith(".updated"))
  ) {
    return "running";
  }

  if (activityKind.endsWith(".failed")) {
    return "error";
  }

  if (activityKind.endsWith(".declined")) {
    return "declined";
  }

  if (
    explicitStatus === "running"
    || explicitStatus === "done"
    || explicitStatus === "error"
    || explicitStatus === "declined"
  ) {
    return explicitStatus;
  }

  if (explicitStatus !== undefined && explicitStatus !== null) {
    return toolStatusToDisplayStatus(explicitStatus);
  }

  return activityKindToDisplayStatus(activityKind);
}

function normalizeCommand(value: unknown): string | null {
  const direct = asString(value);
  if (direct) {
    return direct;
  }

  const parts = asStringArray(value);
  return parts.length > 0 ? parts.join(" ") : null;
}

function sanitizeCommandDetail(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const stripped = value
    .replace(/\s*<exited with exit code -?\d+>\s*$/iu, "")
    .replace(/\s+exit code -?\d+\.?\s*$/iu, "")
    .trim();

  return stripped.length > 0 ? stripped : null;
}

function normalizeShellCommandDetail(value: string | null): string | null {
  const sanitized = sanitizeCommandDetail(value);
  if (!sanitized) {
    return null;
  }

  const normalized = sanitized.replace(/^Completed\s+/u, "").trim();
  return normalized.length > 0 ? normalized : null;
}

function extractCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const input = asRecord(item?.input);
  const argumentsRecord = asRecord(data?.arguments);
  const inputArguments = asRecord(input?.arguments);
  const result = asRecord(item?.result);
  const detail = normalizeShellCommandDetail(
    asString(payload?.detail)
    ?? asString(item?.detail)
    ?? asString(result?.content),
  );
  return (
    normalizeCommand(item?.command)
    ?? normalizeCommand(item?.arguments)
    ?? normalizeCommand(input?.command)
    ?? normalizeCommand(argumentsRecord?.fullCommandText)
    ?? normalizeCommand(argumentsRecord?.command)
    ?? normalizeCommand(inputArguments?.fullCommandText)
    ?? normalizeCommand(inputArguments?.command)
    ?? normalizeCommand(result?.command)
    ?? normalizeCommand(data?.command)
    ?? (isShellToolName(normalizeToolName(extractToolName(payload))) ? detail : null)
  );
}

function isCommandLikePayload(payload: Record<string, unknown> | null): boolean {
  if (!payload) {
    return false;
  }

  return extractCommand(payload) !== null
    || isShellToolName(normalizeToolName(extractToolName(payload)));
}

function extractExitCode(payload: Record<string, unknown> | null): number | null {
  const candidates = [
    asRecord(asRecord(asRecord(payload?.data)?.item)?.result),
    asRecord(asRecord(payload?.data)?.result),
    asRecord(payload?.data),
  ];

  for (const candidate of candidates) {
    const exitCode =
      typeof candidate?.exitCode === "number"
        ? candidate.exitCode
        : typeof candidate?.exit_code === "number"
          ? candidate.exit_code
          : null;
    if (typeof exitCode === "number") {
      return exitCode;
    }
  }

  return null;
}

function extractOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  const nestedResult = asRecord(data?.result);
  return (
    asString(result?.detailedContent)
    ?? asString(result?.content)
    ?? asString(nestedResult?.detailedContent)
    ?? asString(nestedResult?.content)
    ?? asString(data?.output)
    ?? asString(data?.stdout)
    ?? asString(data?.stderr)
    ?? asString(payload?.detail)
  );
}

function extractChangedFiles(payload: Record<string, unknown> | null): Array<string> {
  const seen = new Set<string>();
  const results: Array<string> = [];

  const collect = (value: unknown, depth: number) => {
    if (depth > 4 || results.length >= 24) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        collect(entry, depth + 1);
      }
      return;
    }

    const record = asRecord(value);
    if (!record) {
      return;
    }

    for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
      const path = asString(record[key]);
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      results.push(path);
    }

    for (const key of ["item", "result", "input", "data", "changes", "files", "edits", "patch"]) {
      if (key in record) {
        collect(record[key], depth + 1);
      }
    }
  };

  collect(asRecord(payload?.data), 0);
  return results;
}

function extractWebSearchQuery(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  return (
    asString(data?.query)
    ?? asString(item?.query)
    ?? asString(result?.query)
  );
}

function extractFileChangeStats(
  payload: Record<string, unknown> | null,
): { changedFiles: Array<string>; additions?: number; deletions?: number } | null {
  const item = asRecord(asRecord(payload?.data)?.item);
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (changes.length === 0) {
    const changedFiles = extractChangedFiles(payload);
    return changedFiles.length > 0 ? { changedFiles } : null;
  }

  const changedFiles: Array<string> = [];
  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    const record = asRecord(change);
    const path =
      asString(record?.path)
      ?? asString(record?.filePath)
      ?? asString(record?.relativePath)
      ?? asString(record?.filename);
    if (path) {
      changedFiles.push(path);
    }

    const diff = asString(record?.diff);
    if (!diff) {
      continue;
    }

    for (const line of diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        continue;
      }
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return {
    changedFiles: uniqueStrings(changedFiles),
    ...(additions > 0 || deletions > 0 ? { additions, deletions } : {}),
  };
}

function buildSyntheticUnifiedDiffHeader(
  path: string,
  kindRecord: Record<string, unknown> | null,
) {
  const kindType = (asString(kindRecord?.type) ?? "update").toLowerCase();
  const movePath = asString(kindRecord?.move_path);
  const diffOldPath = movePath ?? path;
  const diffNewPath = path;
  const oldPath =
    kindType === "new" || kindType === "create" || kindType === "add"
      ? "/dev/null"
      : `a/${diffOldPath}`;
  const newPath =
    kindType === "delete" || kindType === "remove"
      ? "/dev/null"
      : `b/${diffNewPath}`;
  return [
    `diff --git a/${diffOldPath} b/${diffNewPath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
  ].join("\n");
}

function extractFileChangeUnifiedDiff(payload: Record<string, unknown> | null): string | null {
  const item = asRecord(asRecord(payload?.data)?.item);
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (changes.length === 0) {
    return null;
  }

  const patches: Array<string> = [];
  for (const change of changes) {
    const record = asRecord(change);
    const diff = asString(record?.diff)?.replace(/\r\n/g, "\n").trim();
    const path =
      asString(record?.path)
      ?? asString(record?.filePath)
      ?? asString(record?.relativePath)
      ?? asString(record?.filename);
    if (!diff || !path) {
      continue;
    }

    if (diff.startsWith("diff --git ")) {
      patches.push(`${diff}\n`);
      continue;
    }

    const kindRecord = asRecord(record?.kind);
    patches.push(`${buildSyntheticUnifiedDiffHeader(path, kindRecord)}\n${diff}\n`);
  }

  return patches.length > 0 ? patches.join("\n") : null;
}

function extractToolInvocationDetail(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);

  const formatRecord = (record: Record<string, unknown> | null): string | null => {
    if (!record) {
      return null;
    }

    const nestedInput =
      formatRecord(asRecord(record.input))
      ?? formatRecord(asRecord(record.arguments))
      ?? formatRecord(asRecord(record.args))
      ?? formatRecord(asRecord(record.params));
    if (nestedInput) {
      return nestedInput;
    }

    const pattern = asString(record.pattern);
    const path = asString(record.path);
    if (pattern) {
      return path ? `${pattern} ${path}` : pattern;
    }

    for (const key of ["query", "url", "path", "filePath", "relativePath", "filename", "command", "prompt"]) {
      const value = asString(record[key]);
      if (value) {
        return value;
      }
    }

    const entries = Object.entries(record)
      .filter(([key, value]) =>
        typeof value === "string"
        && value.trim().length > 0
        && ![
          "toolName",
          "mcpToolName",
          "mcpServerName",
          "title",
          "detail",
          "summary",
          "content",
          "output",
          "stdout",
          "stderr",
          "status",
        ].includes(key))
      .slice(0, 3)
      .map(([key, value]) => `${key}=${String(value).trim()}`);
    return entries.length > 0 ? entries.join(" ") : null;
  };

  return (
    formatRecord(asRecord(item?.input))
    ?? formatRecord(asRecord(data?.input))
    ?? formatRecord(asRecord(data?.arguments))
    ?? formatRecord(asRecord(data?.args))
    ?? formatRecord(item)
    ?? formatRecord(data)
  );
}

function uniqueStrings(values: ReadonlyArray<string>) {
  return [...new Set(values)];
}

function formatElapsedCompactDuration(ms: number) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.max(1, Math.floor(safeMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours}h`;
  }
  return `${Math.floor(totalHours / 24)}d`;
}

function getToolTimingLabel(
  createdAt: string,
  updatedAt: string,
  status: TranscriptToolStatus,
) {
  if (status === "running") {
    return null;
  }

  const createdAtMs = Date.parse(createdAt);
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) {
    return null;
  }

  const elapsedMs = updatedAtMs - createdAtMs;
  if (elapsedMs < 3_000) {
    return null;
  }

  return formatElapsedCompactDuration(elapsedMs);
}

function getToolMergeKey(
  itemKind: TranscriptToolDisplay["itemKind"],
  itemId: string | null,
  label: string,
  mergeAnchor: string | null,
  changedFiles: ReadonlyArray<string>,
) {
  if (itemKind === "file-change") {
    return itemId
      ? `file-change:id:${itemId}`
      : `file-change:path:${changedFiles.join("|") || label}`;
  }

  if (itemKind === "command") {
    return itemId
      ? `command:id:${itemId}`
      : `command:text:${mergeAnchor ?? label}`;
  }

  return itemId
    ? `tool:id:${itemId}`
    : `tool:${label}:${mergeAnchor ?? changedFiles[0] ?? ""}`;
}

function createToolDisplay(activity: OrchestrationThreadActivity): TranscriptToolDisplay | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const itemType = asString(payload?.itemType);
  const command = extractCommand(payload);
  const exitCode = extractExitCode(payload);
  const rawDetail = asString(payload?.detail);
  const detail = sanitizeCommandDetail(rawDetail);
  const toolInvocationDetail = extractToolInvocationDetail(payload);
  const rawOutput = extractOutput(payload);
  const output = rawOutput === rawDetail || rawOutput === detail ? null : rawOutput;
  const changedFiles = extractChangedFiles(payload);
  const status = resolveActivityStatus(payload?.status, activity.kind, itemType, payload);
  const title = asString(payload?.title) ?? activity.summary;
  const fileChangeStats = itemType === "file_change" ? extractFileChangeStats(payload) : null;
  const fileChangeUnifiedDiff = itemType === "file_change" ? extractFileChangeUnifiedDiff(payload) : null;
  const itemId = extractWorkItemId(payload);
  const webSearchQuery = itemType === "web_search" ? extractWebSearchQuery(payload) : null;
  const normalizedDetail =
    itemType === "web_search"
      ? detail ?? webSearchQuery ?? toolInvocationDetail
      : toolInvocationDetail ?? detail;
  const itemKind: TranscriptToolDisplay["itemKind"] =
    itemType === "file_change"
      ? "file-change"
      : itemType === "command_execution" || command
        ? "command"
        : "tool";
  const nextChangedFiles = fileChangeStats?.changedFiles?.length
    ? fileChangeStats.changedFiles
    : changedFiles;
  const mergeAnchor =
    itemType === "web_search"
      ? webSearchQuery ?? toolInvocationDetail ?? normalizedDetail
      : toolInvocationDetail ?? command ?? normalizedDetail;
  const mergeKey = getToolMergeKey(
    itemKind,
    itemId,
    title,
    mergeAnchor,
    nextChangedFiles,
  );

  return {
    mergeKey,
    createdAt: activity.createdAt,
    updatedAt: activity.createdAt,
    turnId: activity.turnId,
    title,
    status,
    itemKind,
    detail: normalizedDetail,
    command,
    output,
    changedFiles: nextChangedFiles,
    additions:
      typeof fileChangeStats?.additions === "number"
        ? fileChangeStats.additions
        : null,
    deletions:
      typeof fileChangeStats?.deletions === "number"
        ? fileChangeStats.deletions
        : null,
    inlineUnifiedDiff: fileChangeUnifiedDiff,
    exitCode,
    timingLabel: null,
  };
}

function mergeToolDisplays(
  existing: TranscriptToolDisplay,
  next: TranscriptToolDisplay,
): TranscriptToolDisplay {
  const updatedAt = next.updatedAt.localeCompare(existing.updatedAt) >= 0
    ? next.updatedAt
    : existing.updatedAt;
  const status = next.status;

  return {
    ...existing,
    updatedAt,
    turnId: next.turnId ?? existing.turnId,
    title: next.title || existing.title,
    status,
    itemKind: next.itemKind,
    detail: next.detail ?? existing.detail,
    command: next.command ?? existing.command,
    output: next.output ?? existing.output,
    changedFiles: uniqueStrings([...existing.changedFiles, ...next.changedFiles]),
    additions: next.additions ?? existing.additions,
    deletions: next.deletions ?? existing.deletions,
    inlineUnifiedDiff: next.inlineUnifiedDiff ?? existing.inlineUnifiedDiff,
    exitCode: next.exitCode ?? existing.exitCode,
    timingLabel: getToolTimingLabel(existing.createdAt, updatedAt, status),
  };
}

function finalizeToolDisplay(tool: TranscriptToolDisplay): TranscriptToolDisplay {
  return {
    ...tool,
    timingLabel: getToolTimingLabel(tool.createdAt, tool.updatedAt, tool.status),
  };
}

export function deriveTranscriptHistoryRows(
  thread: OrchestrationThread | null,
): ReadonlyArray<TranscriptHistoryRow> {
  if (!thread) {
    return [];
  }

  const sortedActivities = [...thread.activities].toSorted(compareActivitiesByTimelineOrder);
  const hiddenToolWorkItemIds = deriveHiddenToolWorkItemIds(sortedActivities);
  const activityTimelineItems: Array<TimelineItem> = [];
  const toolDisplayByMergeKey = new Map<string, TranscriptToolDisplay>();
  const toolMergeKeys: Array<string> = [];

  for (const activity of sortedActivities) {
    if (shouldHideActivityFromTranscript(activity, hiddenToolWorkItemIds)) {
      continue;
    }

    const reasoningDisplays = getReasoningDisplays(activity);
    if (reasoningDisplays.length > 0) {
      for (const [index, reasoning] of reasoningDisplays.entries()) {
        activityTimelineItems.push({
          kind: "reasoning",
          id: `reasoning:${activity.id}:${index}`,
          createdAt: activity.createdAt,
          turnId: activity.turnId,
          reasoning,
        });
      }
      continue;
    }

    if (activity.tone === "tool") {
      const toolDisplay = createToolDisplay(activity);
      if (!toolDisplay) {
        continue;
      }

      const existing = toolDisplayByMergeKey.get(toolDisplay.mergeKey);
      if (!existing) {
        toolDisplayByMergeKey.set(toolDisplay.mergeKey, finalizeToolDisplay(toolDisplay));
        toolMergeKeys.push(toolDisplay.mergeKey);
        continue;
      }

      toolDisplayByMergeKey.set(toolDisplay.mergeKey, mergeToolDisplays(existing, toolDisplay));
      continue;
    }

    activityTimelineItems.push({
      kind: "activity",
      id: `activity:${activity.id}`,
      createdAt: activity.createdAt,
      activity,
    });
  }

  const timelineItems: Array<TimelineItem> = [
    ...thread.messages.map((message) => ({
      kind: "message" as const,
      id: `message:${message.id}`,
      createdAt: message.createdAt,
      message,
    })),
    ...activityTimelineItems,
    ...toolMergeKeys.flatMap((mergeKey) => {
      const tool = toolDisplayByMergeKey.get(mergeKey);
      return tool
        ? [{
            kind: "tool" as const,
            id: `tool:${mergeKey}`,
            createdAt: tool.createdAt,
            tool,
          }]
        : [];
    }),
    ...thread.checkpoints.map((checkpoint) => ({
      kind: "checkpoint" as const,
      id: `checkpoint:${checkpoint.turnId}:${checkpoint.checkpointTurnCount}`,
      createdAt: checkpoint.completedAt,
      checkpoint,
    })),
    ...thread.proposedPlans.map((plan) => ({
      kind: "plan" as const,
      id: `plan:${plan.id}`,
      createdAt: plan.createdAt,
      plan,
    })),
  ].toSorted(compareTimelineItems);

  const rows: Array<TranscriptHistoryRow> = [];
  let activityGroup: Array<OrchestrationThreadActivity> = [];

  const flushActivityGroup = () => {
    if (activityGroup.length === 0) {
      return;
    }
    const firstActivity = activityGroup[0]!;
    rows.push({
      kind: "activity-group",
      id: `activity-group:${firstActivity.id}`,
      createdAt: firstActivity.createdAt,
      turnId: firstActivity.turnId,
      activities: activityGroup,
    });
    activityGroup = [];
  };

  for (const item of timelineItems) {
    if (item.kind === "activity") {
      activityGroup.push(item.activity);
      continue;
    }

    flushActivityGroup();

    if (item.kind === "message") {
      rows.push({
        kind: "message",
        id: item.id,
        createdAt: item.createdAt,
        turnId: item.message.turnId,
        message: item.message,
      });
      continue;
    }

    if (item.kind === "reasoning") {
      rows.push({
        kind: "reasoning",
        id: item.id,
        createdAt: item.createdAt,
        turnId: item.turnId,
        reasoning: item.reasoning,
      });
      continue;
    }

    if (item.kind === "tool") {
      rows.push({
        kind: "tool",
        id: item.id,
        createdAt: item.createdAt,
        turnId: item.tool.turnId,
        tool: item.tool,
      });
      continue;
    }

    if (item.kind === "checkpoint") {
      rows.push({
        kind: "checkpoint",
        id: item.id,
        createdAt: item.createdAt,
        turnId: item.checkpoint.turnId,
        checkpoint: item.checkpoint,
      });
      continue;
    }

    rows.push({
      kind: "plan",
      id: item.id,
      createdAt: item.createdAt,
      turnId: item.plan.turnId,
      plan: item.plan,
    });
  }

  flushActivityGroup();

  if (isThreadRunning(thread)) {
    rows.push({
      kind: "working",
      id: "working-indicator",
      createdAt: thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? thread.updatedAt,
      turnId: thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null,
      label: deriveRunningThreadIntentLabel(thread),
    });
  }

  return rows;
}

function rowBelongsToActiveTurn(
  row: TranscriptHistoryRow,
  input: {
    readonly activeTurnId: TurnId | null;
    readonly turnStartedAt: string | null;
  },
) {
  if (row.kind === "working") {
    return true;
  }

  if (input.activeTurnId) {
    if (row.turnId === input.activeTurnId) {
      return true;
    }
    if (row.kind === "activity-group" && row.activities.some((activity) => activity.turnId === input.activeTurnId)) {
      return true;
    }
  }

  if (!input.turnStartedAt || !row.createdAt) {
    return false;
  }

  return row.createdAt.localeCompare(input.turnStartedAt) >= 0;
}

export function getFirstUnvirtualizedRowIndex(
  rows: ReadonlyArray<TranscriptHistoryRow>,
  thread: OrchestrationThread | null,
  tailRowCount = ALWAYS_UNVIRTUALIZED_TAIL_ROWS,
) {
  const firstTailRowIndex = Math.max(rows.length - tailRowCount, 0);
  if (!thread || !isThreadRunning(thread)) {
    return firstTailRowIndex;
  }

  const activeTurnId = thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
  const turnStartedAt = thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? null;

  const firstActiveTurnRowIndex = rows.findIndex((row) =>
    rowBelongsToActiveTurn(row, {
      activeTurnId,
      turnStartedAt,
    }),
  );

  if (firstActiveTurnRowIndex < 0) {
    return firstTailRowIndex;
  }

  return Math.min(firstActiveTurnRowIndex, firstTailRowIndex);
}

export function estimateTranscriptHistoryRowHeight(
  row: TranscriptHistoryRow,
  options?: {
    readonly widthPx?: number | null;
    readonly expandedToolRowIds?: ReadonlySet<string>;
    readonly collapsedCheckpointRowIds?: ReadonlySet<string>;
    readonly checkpointDiffByRowId?: ReadonlyMap<string, {
      readonly status: "loading" | "ready" | "error";
      readonly diff?: string;
    }>;
  },
  rowIndex = 0,
) {
  const baseHeight = (() => {
    switch (row.kind) {
      case "message":
        return 28 + estimateTextHeight(row.message.text, options?.widthPx) + ((row.message.attachments?.length ?? 0) * 22);

      case "reasoning":
        return row.reasoning.variant === "summary"
          ? 32 + estimateTextHeight(row.reasoning.text, options?.widthPx)
          : 40 + estimateTextHeight(row.reasoning.text, options?.widthPx);

      case "tool": {
        let height = 42;
        if (!options?.expandedToolRowIds?.has(row.id)) {
          return height;
        }
        height = 22 + estimateTextHeight(
          [row.tool.title, getToolDisplaySubject(row.tool), row.tool.timingLabel ?? ""].filter(Boolean).join("  "),
          options?.widthPx,
        );
        if (row.tool.detail) {
          height += estimateTextHeight(row.tool.detail, options?.widthPx);
        }
        if (row.tool.command) {
          height += estimateTextHeight(row.tool.command, options?.widthPx);
        }
        if (row.tool.changedFiles.length > 0) {
          height += estimateTextHeight(row.tool.changedFiles.join("\n"), options?.widthPx);
        }
        if (row.tool.output) {
          height += estimateTextHeight(row.tool.output, options?.widthPx);
        }
        if (row.tool.inlineUnifiedDiff) {
          height += Math.max(80, estimateTextHeight(row.tool.inlineUnifiedDiff, options?.widthPx));
        }
        return height + 16;
      }

      case "activity-group":
        return 34 + row.activities.reduce((total, activity) => {
          const detail = getActivityDetail(activity);
          return total + 20 + (detail ? estimateTextHeight(detail, options?.widthPx) : 0);
        }, 0);

      case "plan":
        return 38 + estimateTextHeight(row.plan.planMarkdown, options?.widthPx);

      case "checkpoint": {
        let height = 48 + (row.checkpoint.files.length * 18);
        if (options?.collapsedCheckpointRowIds?.has(row.id)) {
          return height;
        }
        const diffState = options?.checkpointDiffByRowId?.get(row.id);
        if (diffState?.status === "ready" && diffState.diff) {
          height += Math.max(80, estimateTextHeight(diffState.diff, options?.widthPx));
        } else {
          height += 24;
        }
        return height;
      }

      case "working":
        return 38;
    }
  })();

  return baseHeight + (rowIndex > 0 ? TRANSCRIPT_HISTORY_ROW_GAP_PX : 0);
}

function estimateTextHeight(text: string, widthPx?: number | null) {
  const charsPerLine = estimateCharactersPerLine(widthPx);
  const lines = text.split(/\r?\n/);
  let wrappedLineCount = 0;
  for (const line of lines) {
    wrappedLineCount += Math.max(1, Math.ceil(Math.max(line.length, 1) / charsPerLine));
  }
  return wrappedLineCount * 20;
}

function estimateCharactersPerLine(widthPx?: number | null) {
  if (!widthPx || !Number.isFinite(widthPx)) {
    return 72;
  }

  const usableWidthPx = Math.max(widthPx - 44, 160);
  return Math.min(Math.max(Math.floor(usableWidthPx / 8.6), 24), 120);
}

export function getActivityDetail(activity: OrchestrationThreadActivity) {
  const payload = asRecord(activity.payload);
  return (
    asString(payload?.detail)
    ?? asString(payload?.message)
    ?? asString(payload?.explanation)
    ?? null
  );
}

export function getToolDisplaySubject(tool: TranscriptToolDisplay) {
  if (tool.itemKind === "command") {
    const base = tool.command ?? tool.detail ?? tool.title;
    return tool.exitCode !== null ? `${base} [exit ${tool.exitCode}]` : base;
  }

  if (tool.itemKind === "file-change") {
    const fileLabel =
      tool.changedFiles.length === 1
        ? tool.changedFiles[0]!
        : tool.changedFiles.length > 1
          ? `${tool.changedFiles.length} files`
          : tool.title;
    const counts = formatEditCounts(tool.additions, tool.deletions);
    return counts ? `${counts} ${fileLabel}` : fileLabel;
  }

  if (tool.detail && !tool.detail.includes("\n")) {
    return tool.detail;
  }

  if (tool.detail) {
    const firstLine = tool.detail.split(/\r?\n/, 1)[0]?.trim() ?? "";
    return firstLine.length > 0 ? `${firstLine}...` : tool.title;
  }

  if (tool.changedFiles.length > 0) {
    return tool.changedFiles[0]!;
  }

  return tool.title;
}

function formatEditCounts(additions?: number | null, deletions?: number | null) {
  if (typeof additions !== "number" && typeof deletions !== "number") {
    return "";
  }

  const safeAdditions = typeof additions === "number" ? additions : 0;
  const safeDeletions = typeof deletions === "number" ? deletions : 0;
  return `(+${safeAdditions}, -${safeDeletions})`;
}
