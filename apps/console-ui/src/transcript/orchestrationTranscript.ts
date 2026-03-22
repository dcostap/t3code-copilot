import type {
  OrchestrationEvent,
  OrchestrationThread,
  OrchestrationThreadActivity,
  UserInputQuestion,
} from "@t3tools/contracts";

import type {
  TranscriptBlock,
  InlineDiffLookup,
  FinishedStateBlock,
  UserInputRequestBlock,
  WorkGroupItem,
} from "./TranscriptBlock";
import {
  formatPendingUserInputAnswersAsPrompt,
  isStaleCopilotUserInputResponseDetail,
  parsePendingUserInputAnswers,
} from "../pendingUserInput";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

interface TranscriptBlockOptions {
  readonly resolveAttachmentPreviewUrl?: (attachmentId: string) => string;
  readonly orchestrationEvents?: ReadonlyArray<OrchestrationEvent>;
  readonly now?: string;
}

interface ActivityBlockOptions {
  readonly resolvedUserInputsByRequestId?: ReadonlyMap<string, ResolvedUserInputRecord>;
}

interface ResolvedUserInputRecord {
  readonly answers: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

interface DerivedFallbackUserInputResolutions {
  readonly answersByRequestId: ReadonlyMap<string, ResolvedUserInputRecord>;
  readonly hiddenMessageIds: ReadonlySet<string>;
}

interface TimelineEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly source: "message" | "plan" | "activity";
  readonly turnId?: string | null;
  readonly sequence?: number;
  readonly blocks?: ReadonlyArray<TranscriptBlock>;
  readonly activity?: OrchestrationThreadActivity;
}

interface UserInputQuestionBlock {
  id?: string;
  header: string;
  question: string;
  options: Array<{
    label: string;
    description: string;
  }>;
}

interface PendingWorkItem extends WorkGroupItem {
  readonly mergeKey: string;
}

interface WorkGroupState {
  readonly entries: Array<{ activity: OrchestrationThreadActivity; item: PendingWorkItem }>;
}

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function stripSimpleMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1");
}

function shouldHideSystemMessage(text: string) {
  return text.trim().toLowerCase() === "checkpoint captured";
}

function splitReasoningSummaryIntoBlocks(text: string): TranscriptBlock[] {
  const headingMatches = [...text.matchAll(/\*\*([^*\n][^*]*?)\*\*/g)];
  if (headingMatches.length === 0) {
    const normalized = stripSimpleMarkdown(text).trim();
    if (!normalized) {
      return [];
    }

    const lineCount = normalized.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    const looksLikeBody = lineCount > 1 || normalized.length > 120;
    return [{ type: looksLikeBody ? "reasoning-text" : "reasoning-summary", text: normalized }];
  }

  const blocks: TranscriptBlock[] = [];

  for (let index = 0; index < headingMatches.length; index += 1) {
    const match = headingMatches[index];
    const headingText = match?.[1]?.trim();
    if (!match || !headingText) {
      continue;
    }

    blocks.push({ type: "reasoning-summary", text: stripSimpleMarkdown(headingText) });

    const bodyStart = match.index + match[0].length;
    const bodyEnd = headingMatches[index + 1]?.index ?? text.length;
    const bodyText = stripSimpleMarkdown(text.slice(bodyStart, bodyEnd)).trim();
    if (bodyText) {
      blocks.push({ type: "reasoning-text", text: bodyText });
    }
  }

  if (blocks.length > 0) {
    return blocks;
  }

  const normalized = stripSimpleMarkdown(text).trim();
  return normalized ? [{ type: "reasoning-summary", text: normalized }] : [];
}

function toolStatusToBlockStatus(status: unknown): "running" | "done" | "error" | "declined" {
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

function activityKindToBlockStatus(kind: string): "running" | "done" | "error" | "declined" {
  if (kind.endsWith(".started")) {
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

function resolveActivityStatus(
  explicitStatus: unknown,
  activityKind: string,
): "running" | "done" | "error" | "declined" {
  if (
    explicitStatus === "running"
    || explicitStatus === "done"
    || explicitStatus === "error"
    || explicitStatus === "declined"
  ) {
    return explicitStatus;
  }

  if (explicitStatus !== undefined && explicitStatus !== null) {
    return toolStatusToBlockStatus(explicitStatus);
  }

  return activityKindToBlockStatus(activityKind);
}

function normalizeCommand(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  const parts = asStringArray(value);
  return parts.length > 0 ? parts.join(" ") : null;
}

function extractCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const input = asRecord(item?.input);
  const result = asRecord(item?.result);
  return (
    normalizeCommand(item?.command) ??
    normalizeCommand(input?.command) ??
    normalizeCommand(result?.command) ??
    normalizeCommand(data?.command)
  );
}

function extractExitCode(payload: Record<string, unknown> | null): number | undefined {
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
          : undefined;
    if (typeof exitCode === "number") {
      return exitCode;
    }
  }

  return undefined;
}

function extractOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  return (
    asString(result?.content) ??
    asString(asRecord(data?.result)?.content) ??
    asString(data?.output) ??
    asString(data?.stdout) ??
    asString(data?.stderr) ??
    asString(payload?.detail)
  );
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const collect = (value: unknown, depth: number) => {
    if (depth > 4 || results.length >= 12) return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        collect(entry, depth + 1);
      }
      return;
    }

    const record = asRecord(value);
    if (!record) return;
    for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
      const path = asString(record[key]);
      if (!path || seen.has(path)) continue;
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

function extractWorkItemId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  const precedingToolUseIds = Array.isArray(data?.precedingToolUseIds)
    ? data.precedingToolUseIds
    : [];
  return (
    asString(payload?.itemId) ??
    asString(item?.id) ??
    asString(result?.id) ??
    asString(data?.id) ??
    asString(item?.toolCallId) ??
    asString(result?.toolCallId) ??
    asString(data?.toolCallId) ??
    asString(item?.toolUseId) ??
    asString(result?.toolUseId) ??
    asString(data?.toolUseId) ??
    precedingToolUseIds.find((entry): entry is string => typeof entry === "string" && entry.length > 0) ??
    null
  );
}

function extractWebSearchQuery(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  return (
    asString(data?.query) ??
    asString(item?.query) ??
    asString(result?.query)
  );
}

function extractFileChangeStats(
  payload: Record<string, unknown> | null,
): { changedFiles: string[]; additions?: number; deletions?: number } | null {
  const item = asRecord(asRecord(payload?.data)?.item);
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (changes.length === 0) {
    const changedFiles = extractChangedFiles(payload);
    return changedFiles.length > 0 ? { changedFiles } : null;
  }

  const changedFiles: string[] = [];
  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    const record = asRecord(change);
    const path =
      asString(record?.path) ??
      asString(record?.filePath) ??
      asString(record?.relativePath) ??
      asString(record?.filename);
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

  const patches: string[] = [];
  for (const change of changes) {
    const record = asRecord(change);
    const diff = asString(record?.diff)?.replace(/\r\n/g, "\n").trim();
    const path =
      asString(record?.path) ??
      asString(record?.filePath) ??
      asString(record?.relativePath) ??
      asString(record?.filename);
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

function uniqueStrings(values: ReadonlyArray<string>) {
  return [...new Set(values)];
}

function planUpdateBlock(payload: Record<string, unknown> | null): TranscriptBlock | null {
  const rawSteps = Array.isArray(payload?.plan) ? payload.plan : [];
  const steps = rawSteps
    .map((entry) => {
      const record = asRecord(entry);
      const step = asString(record?.step);
      const status = asString(record?.status) ?? "pending";
      if (!step) return null;
      return {
        step,
        status:
          status === "completed" || status === "inProgress" || status === "pending"
            ? status
            : "pending",
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => entry !== null,
    );

  const explanation = asString(payload?.explanation);
  if (!explanation && steps.length === 0) return null;

  return {
    type: "plan-update",
    ...(explanation ? { explanation } : {}),
    steps,
  };
}

function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) {
    sourceLines.shift();
  }
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) {
      sourceLines.shift();
    }
  }
  return sourceLines.join("\n");
}

function userInputBlock(payload: Record<string, unknown> | null): UserInputRequestBlock | null {
  const requestId = asString(payload?.requestId);
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const normalizedQuestions = questions
    .map((entry) => {
      const question = asRecord(entry);
      const header = asString(question?.header);
      const prompt = asString(question?.question);
      const questionId = asString(question?.id);
      const options = Array.isArray(question?.options) ? question.options : [];
      if (!header || !prompt) return null;
      const normalizedOptions = options
        .map((option) => {
          const record = asRecord(option);
          const label = asString(record?.label);
          const description = asString(record?.description);
          if (!label || !description) return null;
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== null);

      const normalizedQuestion: UserInputQuestionBlock = {
        header,
        question: prompt,
        options: normalizedOptions,
      };
      if (questionId) {
        normalizedQuestion.id = questionId;
      }

      return normalizedQuestion;
    })
    .filter((question): question is UserInputQuestionBlock => question !== null);

  if (!requestId || normalizedQuestions.length === 0) return null;
  return {
    type: "user-input-request",
    requestId,
    questions: normalizedQuestions,
  };
}

function deriveResolvedUserInputsByRequestId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, ResolvedUserInputRecord> {
  const resolvedByRequestId = new Map<string, ResolvedUserInputRecord>();

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    const payload = asRecord(activity.payload);
    const requestId = asString(payload?.requestId);
    if (!requestId) {
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      const answersRecord = asRecord(payload?.answers);
      const answers = Object.fromEntries(
        Object.entries(answersRecord ?? {})
          .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"),
      );
      resolvedByRequestId.set(requestId, {
        answers,
        createdAt: activity.createdAt,
      });
      continue;
    }
  }

  return resolvedByRequestId;
}

function parseAnswerableUserInputQuestions(payload: Record<string, unknown> | null): ReadonlyArray<UserInputQuestion> | null {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const parsed: UserInputQuestion[] = [];

  for (const entry of questions) {
    const question = asRecord(entry);
    const id = asString(question?.id);
    const header = asString(question?.header);
    const prompt = asString(question?.question);
    const options = Array.isArray(question?.options) ? question.options : [];
    if (!id || !header || !prompt) {
      continue;
    }

    const normalizedOptions: UserInputQuestion["options"] = options
      .map((option) => {
        const record = asRecord(option);
        const label = asString(record?.label);
        const description = asString(record?.description);
        return label && description ? { label, description } : null;
      })
      .filter((option): option is UserInputQuestion["options"][number] => option !== null);

    parsed.push({
      id,
      header,
      question: prompt,
      options: normalizedOptions,
    });
  }

  return parsed.length > 0 ? parsed : null;
}

function deriveRequestedUserInputQuestionsByRequestId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, ReadonlyArray<UserInputQuestion>> {
  const questionsByRequestId = new Map<string, ReadonlyArray<UserInputQuestion>>();

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    if (activity.kind !== "user-input.requested") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const requestId = asString(payload?.requestId);
    const questions = parseAnswerableUserInputQuestions(payload);
    if (!requestId || !questions) {
      continue;
    }

    questionsByRequestId.set(requestId, questions);
  }

  return questionsByRequestId;
}

function deriveFallbackUserInputResolutions(
  thread: OrchestrationThread,
  requestedQuestionsByRequestId: ReadonlyMap<string, ReadonlyArray<UserInputQuestion>>,
): DerivedFallbackUserInputResolutions {
  const staleFailureByRequestId = new Map<string, string>();

  for (const activity of [...thread.activities].toSorted(compareActivitiesByOrder)) {
    const payload = asRecord(activity.payload);
    const requestId = asString(payload?.requestId);
    if (!requestId) {
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      isStaleCopilotUserInputResponseDetail(asString(payload?.detail))
    ) {
      staleFailureByRequestId.set(requestId, activity.createdAt);
    }
  }

  const answersByRequestId = new Map<string, ResolvedUserInputRecord>();
  const hiddenMessageIds = new Set<string>();
  const userMessages = thread.messages
    .filter((message) => message.role === "user")
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

  for (const [requestId, failureCreatedAt] of [...staleFailureByRequestId.entries()].toSorted((left, right) =>
    left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]),
  )) {
    const questions = requestedQuestionsByRequestId.get(requestId);
    if (!questions) {
      continue;
    }

    const fallbackMessage = userMessages.find((message) =>
      !hiddenMessageIds.has(message.id) && message.createdAt >= failureCreatedAt,
    );
    if (!fallbackMessage) {
      continue;
    }

    const answers = parsePendingUserInputAnswers(questions, fallbackMessage.text);
    if (!answers) {
      continue;
    }

    answersByRequestId.set(requestId, {
      answers,
      createdAt: fallbackMessage.createdAt,
    });
    hiddenMessageIds.add(fallbackMessage.id);
  }

  return { answersByRequestId, hiddenMessageIds };
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

function deriveAskUserHiddenWorkItemIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  const hiddenItemIds = new Set<string>();

  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    if (!isAskUserToolPayload(payload)) {
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
  askUserHiddenWorkItemIds: ReadonlySet<string>,
): boolean {
  const payload = asRecord(activity.payload);
  if (isAskUserToolPayload(payload)) {
    return true;
  }

  const itemId = extractWorkItemId(payload);
  if (itemId && askUserHiddenWorkItemIds.has(itemId)) {
    return true;
  }

  if (activity.kind !== "provider.user-input.respond.failed") {
    return false;
  }

  return isStaleCopilotUserInputResponseDetail(asString(payload?.detail));
}

function willActivityRenderInTranscript(
  activity: OrchestrationThreadActivity,
  askUserHiddenWorkItemIds: ReadonlySet<string>,
): boolean {
  if (shouldHideActivityFromTranscript(activity, askUserHiddenWorkItemIds)) {
    return false;
  }

  if (activityToWorkItem(activity)) {
    return true;
  }

  return activityToBlocks(activity, {}).length > 0;
}

function hasOpenPendingUserInputRequest(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  const openRequestIds = new Set<string>();

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    const payload = asRecord(activity.payload);
    const requestId = asString(payload?.requestId);
    if (!requestId) {
      continue;
    }

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed"
      && isStaleCopilotUserInputResponseDetail(asString(payload?.detail))
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size > 0;
}

function buildUserInputAnswerTimelineEntries(
  requestedQuestionsByRequestId: ReadonlyMap<string, ReadonlyArray<UserInputQuestion>>,
  resolvedUserInputsByRequestId: ReadonlyMap<string, ResolvedUserInputRecord>,
): ReadonlyArray<TimelineEntry> {
  const entries: TimelineEntry[] = [];

  for (const [requestId, resolved] of resolvedUserInputsByRequestId) {
    const questions = requestedQuestionsByRequestId.get(requestId);
    const text = questions ? formatPendingUserInputAnswersAsPrompt(questions, resolved.answers) : null;
    if (!text) {
      continue;
    }

    entries.push({
      id: `user-input-answer:${requestId}:${resolved.createdAt}`,
      createdAt: resolved.createdAt,
      source: "message",
      blocks: [{
        type: "user-message",
        text,
      }],
    });
  }

  return entries;
}

function isWorkActivityType(itemType: string | null) {
  return itemType === "command_execution"
    || itemType === "file_change"
    || itemType === "mcp_tool_call"
    || itemType === "dynamic_tool_call"
    || itemType === "collab_agent_tool_call"
    || itemType === "web_search"
    || itemType === "image_view";
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

function activityToWorkItem(activity: OrchestrationThreadActivity): PendingWorkItem | null {
  const payload = asRecord(activity.payload);
  const itemType = asString(payload?.itemType);
  const command = extractCommand(payload);
  const exitCode = extractExitCode(payload);
  const detail = asString(payload?.detail);
  const toolInvocationDetail = extractToolInvocationDetail(payload);
  const rawOutput = extractOutput(payload);
  const output = rawOutput === detail ? null : rawOutput;
  const changedFiles = extractChangedFiles(payload);
  const status = resolveActivityStatus(payload?.status, activity.kind);
  const label = asString(payload?.title) ?? activity.summary;
  const fileChangeStats = itemType === "file_change" ? extractFileChangeStats(payload) : null;
  const fileChangeUnifiedDiff = itemType === "file_change" ? extractFileChangeUnifiedDiff(payload) : null;
  const itemId = extractWorkItemId(payload);
  const webSearchQuery = itemType === "web_search" ? extractWebSearchQuery(payload) : null;
  const toolDetail =
    itemType === "web_search"
      ? detail ?? webSearchQuery ?? toolInvocationDetail
      : toolInvocationDetail ?? detail;

  if (itemType === "file_change") {
    return {
      kind: "file-change",
      label,
      status,
      mergeKey: itemId
        ? `file-change:id:${itemId}`
        : `file-change:path:${(fileChangeStats?.changedFiles ?? changedFiles).join("|")}`,
      ...(fileChangeStats?.changedFiles?.length ? { changedFiles: fileChangeStats.changedFiles } : changedFiles.length > 0 ? { changedFiles } : {}),
      ...(typeof fileChangeStats?.additions === "number" ? { additions: fileChangeStats.additions } : {}),
      ...(typeof fileChangeStats?.deletions === "number" ? { deletions: fileChangeStats.deletions } : {}),
      ...(fileChangeUnifiedDiff ? { inlineUnifiedDiff: fileChangeUnifiedDiff } : {}),
    };
  }

  if (itemType === "command_execution" || command) {
    return {
      kind: "command",
      label,
      status,
      mergeKey: itemId
        ? `command:id:${itemId}`
        : `command:text:${command ?? label}`,
      ...(detail ? { detail } : {}),
      ...(command ? { command } : {}),
      ...(typeof exitCode === "number" ? { exitCode } : {}),
      ...(output ? { output } : {}),
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
    };
  }

  if (activity.tone !== "tool" && !isWorkActivityType(itemType)) {
    return null;
  }

  return {
    kind: "tool",
    label,
    status,
    mergeKey: itemId
      ? `${itemType ?? "tool"}:id:${itemId}`
      : itemType === "web_search" && webSearchQuery
        ? `web_search:query:${webSearchQuery}`
        : `${itemType ?? "tool"}:${label}`,
    ...(toolDetail ? { detail: toolDetail } : {}),
    ...(output ? { output } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
  };
}

function canMergeWorkItems(previous: PendingWorkItem, next: PendingWorkItem) {
  return previous.kind === next.kind
    && previous.mergeKey === next.mergeKey
    && previous.status === "running";
}

function isWebSearchWorkItem(item: PendingWorkItem) {
  return item.kind === "tool" && item.mergeKey.startsWith("web_search:");
}

function shouldKeepWorkItemsGroupedAcrossTurn(
  pendingItems: ReadonlyArray<{ activity: OrchestrationThreadActivity; item: PendingWorkItem }>,
  nextItem: PendingWorkItem,
) {
  if (!isWebSearchWorkItem(nextItem) || pendingItems.length === 0) {
    return false;
  }

  return pendingItems.every(({ item }) =>
    isWebSearchWorkItem(item) && item.label === nextItem.label,
  );
}

function mergeWorkItems(previous: PendingWorkItem, next: PendingWorkItem): PendingWorkItem {
  const changedFiles = previous.changedFiles || next.changedFiles
    ? uniqueStrings([...(previous.changedFiles ?? []), ...(next.changedFiles ?? [])])
    : null;
  const detail =
    isWebSearchWorkItem(previous)
      ? next.detail ?? previous.detail
      : previous.kind === "tool" && previous.detail
      ? previous.detail
      : next.detail ?? previous.detail;

  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(changedFiles ? { changedFiles } : {}),
  };
}

function workGroupTitle(items: ReadonlyArray<WorkGroupItem>) {
  if (items.length === 0) {
    return undefined;
  }
  const firstLabel = items[0]?.label;
  if (!firstLabel) {
    return undefined;
  }
  if (items.length === 1 || items.every((item) => item.label === firstLabel)) {
    return firstLabel;
  }
  return undefined;
}

function workGroupStatus(items: ReadonlyArray<WorkGroupItem>): "running" | "done" | "error" | "declined" {
  if (items.some((item) => item.status === "error")) {
    return "error";
  }
  if (items.some((item) => item.status === "declined")) {
    return "declined";
  }
  if (items.some((item) => item.status === "running")) {
    return "running";
  }
  return "done";
}

function workItemsToBlock(
  items: ReadonlyArray<{ activity: OrchestrationThreadActivity; item: PendingWorkItem }>,
  inlineDiffLookupByTurnId: ReadonlyMap<string, InlineDiffLookup>,
  now?: string,
  pulseOriginAt?: string,
): TranscriptBlock | null {
  if (items.length === 0) {
    return null;
  }

  const mergedItems: PendingWorkItem[] = [];
  const mergedIndexByKey = new Map<string, number>();
  for (const entry of items) {
    const inlineDiffLookup =
      entry.item.kind === "file-change"
      && !entry.item.inlineUnifiedDiff
      && entry.activity.turnId
        ? inlineDiffLookupByTurnId.get(entry.activity.turnId)
        : undefined;
    const itemWithInlineDiffLookup =
      inlineDiffLookup
        ? {
            ...entry.item,
            inlineDiffLookup,
          }
        : entry.item;
    const existingIndex = mergedIndexByKey.get(itemWithInlineDiffLookup.mergeKey);
    if (existingIndex !== undefined) {
      const existing = mergedItems[existingIndex];
      if (existing && canMergeWorkItems(existing, itemWithInlineDiffLookup)) {
        mergedItems[existingIndex] = mergeWorkItems(existing, itemWithInlineDiffLookup);
        continue;
      }
    }

    const previous = mergedItems.at(-1);
    if (previous && canMergeWorkItems(previous, itemWithInlineDiffLookup)) {
      mergedItems[mergedItems.length - 1] = mergeWorkItems(previous, itemWithInlineDiffLookup);
      mergedIndexByKey.set(itemWithInlineDiffLookup.mergeKey, mergedItems.length - 1);
      continue;
    }
    mergedIndexByKey.set(itemWithInlineDiffLookup.mergeKey, mergedItems.length);
    mergedItems.push(itemWithInlineDiffLookup);
  }

  const startedAt = items[0]?.activity.createdAt;
  const endedAt = items.at(-1)?.activity.createdAt;
  if (!startedAt || !endedAt) {
    return null;
  }

  const title = workGroupTitle(mergedItems);

  return {
    type: "work-group",
    ...(title ? { title } : {}),
    status: workGroupStatus(mergedItems),
    startedAt,
    endedAt,
    ...(now ? { now } : {}),
    ...(workGroupStatus(mergedItems) === "running" && pulseOriginAt ? { pulseOriginAt } : {}),
    items: mergedItems.map(({ mergeKey: _mergeKey, ...item }) => item),
  };
}

function activityToBlocks(
  activity: OrchestrationThreadActivity,
  options: ActivityBlockOptions = {},
): TranscriptBlock[] {
  const payload = asRecord(activity.payload);

  if (shouldHideSystemMessage(activity.summary)) {
    return [];
  }

  switch (activity.kind) {
    case "approval.requested":
    case "approval.resolved":
      return [];

    case "task.started":
      return [];

    case "task.progress": {
      return [];
    }

    case "reasoning.summary": {
      const detail =
        asString(payload?.text) ??
        asString(payload?.detail) ??
        asString(payload?.message) ??
        asString(activity.summary);
      return detail ? splitReasoningSummaryIntoBlocks(detail) : [];
    }

    case "reasoning.text": {
      const detail =
        asString(payload?.text) ??
        asString(payload?.detail) ??
        asString(payload?.message) ??
        asString(activity.summary);
      return detail
        ? [{ type: "reasoning-text", text: stripSimpleMarkdown(detail) }]
        : [];
    }

    case "task.completed": {
      const status = asString(payload?.status);
      if (status !== "failed" && status !== "stopped") {
        return [];
      }

      const detail =
        asString(payload?.detail) ??
        asString(payload?.message) ??
        activity.summary;
      return [{ type: "status", text: stripSimpleMarkdown(detail) }];
    }

    case "user-input.requested": {
      const requestId = asString(payload?.requestId);
      const block = userInputBlock(payload);
      const resolvedUserInput =
        requestId && options.resolvedUserInputsByRequestId
          ? options.resolvedUserInputsByRequestId.get(requestId)
          : undefined;
      if (!block) {
        return [{ type: "status", text: activity.summary }];
      }

        return [
        resolvedUserInput
          ? {
              ...block,
              resolved: true,
              answers: resolvedUserInput.answers,
            }
          : block,
      ];
    }

    case "user-input.resolved": {
      return [];
    }

    case "turn.plan.updated": {
      const block = planUpdateBlock(payload);
      return block ? [block] : [{ type: "status", text: activity.summary }];
    }
  }

  if (activity.tone === "tool") {
    const output = extractOutput(payload);
    const blocks: TranscriptBlock[] = [
      {
        type: "tool-call",
        label: asString(payload?.title) ?? activity.summary,
        status: resolveActivityStatus(payload?.status, activity.kind),
        ...(asString(payload?.detail) ? { detail: asString(payload?.detail)! } : {}),
      },
    ];

    if (output) {
      blocks.push({
        type: "tool-result",
        summary: "Output",
        output,
      });
    } else {
      const changedFiles = extractChangedFiles(payload);
      if (changedFiles.length > 0) {
        blocks.push({
          type: "tool-result",
          summary: changedFiles[0] ?? "Changed files",
          ...(changedFiles.length > 1 ? { output: changedFiles.slice(1).join("\n") } : {}),
        });
      }
    }

    return blocks;
  }

  const detail = asString(payload?.detail) ?? asString(payload?.message);
  return [
    {
      type: "status",
      text: stripSimpleMarkdown(detail ? `${activity.summary}: ${detail}` : activity.summary),
    },
  ];
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
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

function compareByCreatedAt(left: TimelineEntry, right: TimelineEntry) {
  if (left.source === "activity" && right.source === "activity") {
    if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  }

  const leftIsFinishedState = left.blocks?.every((block) => block.type === "finished-state") ?? false;
  const rightIsFinishedState = right.blocks?.every((block) => block.type === "finished-state") ?? false;
  if (left.createdAt === right.createdAt && leftIsFinishedState !== rightIsFinishedState) {
    return leftIsFinishedState ? 1 : -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function isAssistantBoundaryActivity(activity: OrchestrationThreadActivity) {
  return activity.kind === "user-input.requested" || activity.kind === "approval.requested";
}

function buildAssistantBoundaryMap(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  const boundariesByTurnId = new Map<string, string[]>();

  for (const activity of activities.toSorted(compareActivitiesByOrder)) {
    if (!activity.turnId || !isAssistantBoundaryActivity(activity)) {
      continue;
    }

    const boundaries = boundariesByTurnId.get(activity.turnId) ?? [];
    boundaries.push(activity.createdAt);
    boundariesByTurnId.set(activity.turnId, boundaries);
  }

  return boundariesByTurnId;
}

function buildAssistantMessageEntriesFromEvents(
  thread: OrchestrationThread,
  message: OrchestrationThread["messages"][number],
  events: ReadonlyArray<OrchestrationEvent>,
  boundariesByTurnId: ReadonlyMap<string, ReadonlyArray<string>>,
): TimelineEntry[] | null {
  if (message.role !== "assistant") {
    return null;
  }

  const assistantEvents = events
    .filter(
      (event): event is ThreadMessageSentEvent =>
        event.type === "thread.message-sent"
        && event.payload.threadId === thread.id
        && event.payload.messageId === message.id
        && event.payload.role === "assistant",
    )
    .filter((event) => event.payload.updatedAt.localeCompare(message.updatedAt) <= 0)
    .toSorted((left, right) => left.sequence - right.sequence);

  if (assistantEvents.length === 0) {
    return null;
  }

  const boundaries = message.turnId
    ? (boundariesByTurnId.get(message.turnId) ?? [])
    : [];
  const entries: TimelineEntry[] = [];
  let boundaryIndex = 0;
  let segmentText = "";
  let segmentCreatedAt: string | null = null;

  const flushSegment = (streaming: boolean) => {
    if (!segmentCreatedAt || segmentText.length === 0) {
      segmentText = "";
      segmentCreatedAt = null;
      return;
    }

    entries.push({
      id: `message:${message.id}:segment:${entries.length}`,
      createdAt: segmentCreatedAt,
      source: "message",
      turnId: message.turnId,
      blocks: [{ type: "assistant-text", text: segmentText, streaming }],
    });
    segmentText = "";
    segmentCreatedAt = null;
  };

  for (const event of assistantEvents) {
    while (
      boundaryIndex < boundaries.length
      && (boundaries[boundaryIndex]?.localeCompare(event.payload.createdAt) ?? 1) < 0
    ) {
      flushSegment(false);
      boundaryIndex += 1;
    }

    if (event.payload.text.length > 0) {
      if (!segmentCreatedAt) {
        segmentCreatedAt = event.payload.createdAt;
      }
      segmentText += event.payload.text;
    }
  }

  if (segmentText.length === 0 && message.text.length > 0) {
    return null;
  }

  const reconstructedText = entries
    .flatMap((entry) => entry.blocks ?? [])
    .map((block) => (block.type === "assistant-text" ? block.text : ""))
    .join("") + segmentText;

  if (!message.text.startsWith(reconstructedText)) {
    return null;
  }

  const remainingText = message.text.slice(reconstructedText.length);
  if (remainingText.length > 0) {
    if (!segmentCreatedAt) {
      segmentCreatedAt = message.updatedAt;
    }
    segmentText += remainingText;
  }

  flushSegment(message.streaming);
  return entries.length > 0 ? entries : null;
}

function buildFinishedStateEntryForAssistantMessage(
  thread: OrchestrationThread,
  message: OrchestrationThread["messages"][number],
  askUserHiddenWorkItemIds: ReadonlySet<string>,
) {
  if (!shouldAppendFinishedState(thread, message)) {
    return null;
  }

  const finishedAt = resolveFinishedAt(thread, message, askUserHiddenWorkItemIds);
  return {
    id: `message:${message.id}:finished`,
    createdAt: finishedAt,
    source: "message" as const,
    turnId: message.turnId,
    blocks: [createFinishedStateBlock(message.createdAt, finishedAt)],
  };
}

function shouldAppendFinishedState(
  thread: OrchestrationThread,
  message: OrchestrationThread["messages"][number],
) {
  return (
    !message.streaming
    || (
      thread.latestTurn?.turnId === message.turnId
      && thread.latestTurn.state === "completed"
    )
  );
}

function resolveFinishedAt(
  thread: OrchestrationThread,
  message: OrchestrationThread["messages"][number],
  askUserHiddenWorkItemIds: ReadonlySet<string>,
) {
  const baseFinishedAt =
    thread.latestTurn?.turnId === message.turnId && thread.latestTurn.state === "completed"
      ? (thread.latestTurn.completedAt ?? message.updatedAt)
      : message.updatedAt;

  const nextMessageCreatedAt = thread.messages
    .filter((candidate) =>
      candidate.id !== message.id
      && candidate.createdAt.localeCompare(message.createdAt) > 0
    )
    .map((candidate) => candidate.createdAt)
    .toSorted((left, right) => left.localeCompare(right))
    .at(0);

  const latestVisibleRelatedActivityAt = thread.activities
    .filter((activity) =>
      willActivityRenderInTranscript(activity, askUserHiddenWorkItemIds)
      && activity.createdAt.localeCompare(baseFinishedAt) >= 0
      && (!nextMessageCreatedAt || activity.createdAt.localeCompare(nextMessageCreatedAt) < 0)
    )
    .map((activity) => activity.createdAt)
    .toSorted((left, right) => left.localeCompare(right))
    .at(-1);

  return latestVisibleRelatedActivityAt && latestVisibleRelatedActivityAt.localeCompare(baseFinishedAt) > 0
    ? latestVisibleRelatedActivityAt
    : baseFinishedAt;
}

function createFinishedStateBlock(startedAt: string, finishedAt: string): FinishedStateBlock {
  return {
    type: "finished-state",
    startedAt,
    finishedAt,
  };
}

function resolveTranscriptFinishedAt(thread: OrchestrationThread, blocks: ReadonlyArray<TranscriptBlock>): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type === "finished-state") {
      return block.finishedAt;
    }
  }

  if (thread.latestTurn?.state === "completed") {
    return thread.latestTurn.completedAt
      ?? thread.session?.updatedAt
      ?? thread.updatedAt;
  }

  return null;
}

function finalizeRunningTranscriptBlocks(
  blocks: ReadonlyArray<TranscriptBlock>,
  finishedAt: string,
): TranscriptBlock[] {
  return blocks.map((block) => {
    if (block.type === "tool-call" && block.status === "running") {
      return {
        ...block,
        status: "done",
      };
    }

    if (block.type === "work-group" && block.status === "running") {
      const { pulseOriginAt: _pulseOriginAt, ...rest } = block;
      return {
        ...rest,
        status: "done",
        endedAt: finishedAt,
        items: block.items.map((item) =>
          item.status === "running"
            ? {
                ...item,
                status: "done",
              }
            : item
        ),
      };
    }

    return block;
  });
}

function isAssistantMessageEntry(entry: TimelineEntry) {
  return entry.source === "message" && entry.blocks?.some((block) => block.type === "assistant-text");
}

function appendFinishedStateToLatestTurnEntries(
  thread: OrchestrationThread,
  entries: TimelineEntry[],
) {
  const latestTurn = thread.latestTurn;
  if (latestTurn?.state !== "completed") {
    return entries;
  }

  let targetIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.turnId === latestTurn.turnId && isAssistantMessageEntry(entries[index]!)) {
      targetIndex = index;
      break;
    }
  }
  const targetEntry = targetIndex >= 0 ? entries[targetIndex] : null;
  const hasFinishedStateEntry = entries.some((entry) =>
    entry.turnId === latestTurn.turnId && (entry.blocks?.some((block) => block.type === "finished-state") ?? false)
  );
  if (!targetEntry || hasFinishedStateEntry) {
    return entries;
  }

  const nextEntries = entries.slice();
  nextEntries.push({
    id: `turn:${latestTurn.turnId}:finished`,
    createdAt: latestTurn.completedAt ?? targetEntry.createdAt,
    source: "message",
    turnId: latestTurn.turnId,
    blocks: [
      createFinishedStateBlock(
        latestTurn.startedAt ?? targetEntry.createdAt,
        latestTurn.completedAt ?? targetEntry.createdAt,
      ),
    ],
  });
  return nextEntries;
}

function findRunningAssistantMessage(thread: OrchestrationThread) {
  const latestTurnId = thread.latestTurn?.turnId ?? thread.session?.activeTurnId ?? null;
  const runningStartedAt =
    thread.latestTurn?.startedAt
    ?? thread.latestTurn?.requestedAt
    ?? thread.session?.updatedAt
    ?? thread.updatedAt;

  return thread.messages
    .filter((message) =>
      message.role === "assistant"
      && (
        latestTurnId
          ? message.turnId === latestTurnId
          : message.createdAt.localeCompare(runningStartedAt) >= 0
      ))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1)
    ?? null;
}

export function threadToTranscriptBlocks(
  thread: OrchestrationThread,
  options: TranscriptBlockOptions = {},
): TranscriptBlock[] {
  const requestedUserInputQuestionsByRequestId = deriveRequestedUserInputQuestionsByRequestId(thread.activities);
  const explicitResolvedUserInputsByRequestId = deriveResolvedUserInputsByRequestId(thread.activities);
  const fallbackUserInputResolutions = deriveFallbackUserInputResolutions(
    thread,
    requestedUserInputQuestionsByRequestId,
  );
  const resolvedUserInputsByRequestId = new Map(explicitResolvedUserInputsByRequestId);
  for (const [requestId, resolved] of fallbackUserInputResolutions.answersByRequestId) {
    if (!resolvedUserInputsByRequestId.has(requestId)) {
      resolvedUserInputsByRequestId.set(requestId, resolved);
    }
  }
  const askUserHiddenWorkItemIds = deriveAskUserHiddenWorkItemIds(thread.activities);
  const pendingUserInputOpen = hasOpenPendingUserInputRequest(thread.activities);
  const assistantBoundariesByTurnId = buildAssistantBoundaryMap(thread.activities);
  const checkpointsByAssistantMessageId = new Map(
    thread.checkpoints
      .filter((checkpoint) => checkpoint.assistantMessageId !== null)
      .map((checkpoint) => [checkpoint.assistantMessageId!, checkpoint] as const),
  );

  const entries: TimelineEntry[] = [];

  for (const message of thread.messages) {
    if (fallbackUserInputResolutions.hiddenMessageIds.has(message.id)) {
      continue;
    }
    const text =
      message.attachments && message.attachments.length > 0 && message.text === IMAGE_ONLY_BOOTSTRAP_PROMPT
        ? ""
        : message.text;
    if (message.role === "system" && shouldHideSystemMessage(text)) {
      continue;
    }
    const attachments = message.attachments?.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      ...(options.resolveAttachmentPreviewUrl
        ? { previewUrl: options.resolveAttachmentPreviewUrl(attachment.id) }
        : {}),
    }));

    const assistantEntries =
      message.role === "assistant" && options.orchestrationEvents
        ? buildAssistantMessageEntriesFromEvents(
            thread,
            message,
            options.orchestrationEvents,
            assistantBoundariesByTurnId,
          )
        : null;

    let blocks: TranscriptBlock[] =
      message.role === "user"
        ? [
            {
              type: "user-message",
              text,
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            },
          ]
        : message.role === "assistant"
          ? [{ type: "assistant-text", text, streaming: message.streaming }]
          : [{ type: "status", text }];

    if (message.role === "assistant") {
      const checkpoint = checkpointsByAssistantMessageId.get(message.id);
      const finishedStateEntry = buildFinishedStateEntryForAssistantMessage(thread, message, askUserHiddenWorkItemIds);
      if (assistantEntries) {
        entries.push(...assistantEntries);
        if (finishedStateEntry) {
          entries.push(finishedStateEntry);
        }
      } else if (checkpoint) {
        entries.push({
          id: `message:${message.id}`,
          createdAt: message.createdAt,
          source: "message",
          turnId: message.turnId,
          blocks,
        });
        if (finishedStateEntry) {
          entries.push(finishedStateEntry);
        }
        continue;
      } else {
        entries.push({
          id: `message:${message.id}`,
          createdAt: message.createdAt,
          source: "message",
          turnId: message.turnId,
          blocks,
        });
        if (finishedStateEntry) {
          entries.push(finishedStateEntry);
        }
        continue;
      }
      continue;
    }

    entries.push({
      id: `message:${message.id}`,
      createdAt: message.createdAt,
      source: "message",
      turnId: message.turnId,
      blocks,
    });
  }

  for (const proposedPlan of thread.proposedPlans) {
    entries.push({
      id: `plan:${proposedPlan.id}`,
      createdAt: proposedPlan.createdAt,
      source: "plan",
      blocks: [{
        type: "proposed-plan",
        ...(proposedPlanTitle(proposedPlan.planMarkdown)
          ? { title: proposedPlanTitle(proposedPlan.planMarkdown)! }
          : {}),
        body: stripDisplayedPlanMarkdown(proposedPlan.planMarkdown),
      }],
    });
  }

  entries.push(
    ...buildUserInputAnswerTimelineEntries(
      requestedUserInputQuestionsByRequestId,
      resolvedUserInputsByRequestId,
    ),
  );

  for (const activity of thread.activities) {
    if (shouldHideActivityFromTranscript(activity, askUserHiddenWorkItemIds)) {
      continue;
    }
    entries.push({
      id: `activity:${activity.id}`,
      createdAt: activity.createdAt,
      source: "activity",
      turnId: activity.turnId,
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      activity,
    });
  }

  const blocks: TranscriptBlock[] = [];
  const workGroupStatesByIndex = new Map<number, WorkGroupState>();
  const activeWorkGroupIndexByMergeKey = new Map<string, number>();
  const inlineDiffLookupByTurnId = new Map<string, InlineDiffLookup>(
    thread.checkpoints.map((checkpoint) => [
      checkpoint.turnId,
      {
        threadId: thread.id,
        fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
        toTurnCount: checkpoint.checkpointTurnCount,
      },
    ]),
  );
  let currentWorkGroupIndex: number | null = null;
  let currentWorkTurnId: OrchestrationThreadActivity["turnId"] = null;
  const activePulseOriginAt =
    thread.latestTurn?.startedAt
    ?? thread.latestTurn?.requestedAt
    ?? thread.session?.updatedAt
    ?? thread.updatedAt;

  const closeCurrentWorkGroup = () => {
    currentWorkGroupIndex = null;
    currentWorkTurnId = null;
  };

  const updateWorkGroupBlock = (groupIndex: number) => {
    const state = workGroupStatesByIndex.get(groupIndex);
    if (!state) {
      return;
    }

    const block = workItemsToBlock(
      state.entries,
      inlineDiffLookupByTurnId,
      options.now,
      activePulseOriginAt,
    );
    if (block) {
      blocks[groupIndex] = block;
    }
  };

  for (const entry of appendFinishedStateToLatestTurnEntries(thread, entries.toSorted(compareByCreatedAt))) {
    if (entry.source === "activity" && entry.activity) {
      const workItem = activityToWorkItem(entry.activity);
      if (workItem) {
        const existingGroupIndex = activeWorkGroupIndexByMergeKey.get(workItem.mergeKey);
        if (existingGroupIndex !== undefined) {
          const existingState = workGroupStatesByIndex.get(existingGroupIndex);
          if (existingState) {
            existingState.entries.push({ activity: entry.activity, item: workItem });
            updateWorkGroupBlock(existingGroupIndex);
          }
          if (workItem.status === "running") {
            activeWorkGroupIndexByMergeKey.set(workItem.mergeKey, existingGroupIndex);
          } else {
            activeWorkGroupIndexByMergeKey.delete(workItem.mergeKey);
          }
          if (currentWorkGroupIndex !== existingGroupIndex) {
            closeCurrentWorkGroup();
          }
          continue;
        }

        const currentState =
          currentWorkGroupIndex !== null
            ? workGroupStatesByIndex.get(currentWorkGroupIndex)
            : undefined;
        if (
          currentWorkGroupIndex !== null
          && currentState
          && currentWorkTurnId !== entry.activity.turnId
          && !shouldKeepWorkItemsGroupedAcrossTurn(currentState.entries, workItem)
        ) {
          closeCurrentWorkGroup();
        }

        const targetGroupIndex: number = currentWorkGroupIndex ?? blocks.length;
        const targetState =
          workGroupStatesByIndex.get(targetGroupIndex)
          ?? { entries: [] };
        targetState.entries.push({ activity: entry.activity, item: workItem });
        workGroupStatesByIndex.set(targetGroupIndex, targetState);
        if (targetGroupIndex === blocks.length) {
          blocks.push({
            type: "work-group",
            status: "running",
            startedAt: entry.activity.createdAt,
            endedAt: entry.activity.createdAt,
            ...(options.now ? { now: options.now } : {}),
            ...(activePulseOriginAt ? { pulseOriginAt: activePulseOriginAt } : {}),
            items: [],
          });
        }
        updateWorkGroupBlock(targetGroupIndex);
        currentWorkGroupIndex = targetGroupIndex;
        currentWorkTurnId = entry.activity.turnId;
        if (workItem.status === "running") {
          activeWorkGroupIndexByMergeKey.set(workItem.mergeKey, targetGroupIndex);
        } else {
          activeWorkGroupIndexByMergeKey.delete(workItem.mergeKey);
        }
        continue;
      }
    }

    closeCurrentWorkGroup();

    if (entry.source === "activity" && entry.activity) {
      blocks.push(...activityToBlocks(entry.activity, { resolvedUserInputsByRequestId }));
      continue;
    }

    if (entry.blocks) {
      blocks.push(...entry.blocks);
    }
  }

  const transcriptFinishedAt = resolveTranscriptFinishedAt(thread, blocks);
  if (transcriptFinishedAt) {
    const finalizedBlocks = finalizeRunningTranscriptBlocks(blocks, transcriptFinishedAt);
    blocks.splice(0, blocks.length, ...finalizedBlocks);
  }

  if (!pendingUserInputOpen && (thread.latestTurn?.state === "running" || thread.session?.status === "running")) {
    const waitingStartedAt =
      thread.latestTurn?.startedAt
      ?? thread.latestTurn?.requestedAt
      ?? thread.session?.updatedAt
      ?? thread.updatedAt;
    const runningAssistantMessage = findRunningAssistantMessage(thread);
    const now = options.now ?? new Date().toISOString();
    blocks.push({
      type: runningAssistantMessage ? "working-state" : "waiting-state",
      startedAt: runningAssistantMessage?.createdAt ?? waitingStartedAt,
      now,
    });
  } else if (thread.latestTurn?.state === "interrupted") {
    const startedAt =
      thread.latestTurn.startedAt
      ?? thread.latestTurn.requestedAt
      ?? thread.updatedAt;
    const interruptedAt =
      thread.session?.updatedAt
      ?? thread.latestTurn.completedAt
      ?? thread.updatedAt;
    blocks.push({
      type: "interrupted-state",
      startedAt,
      interruptedAt,
    });
  }

  return blocks;
}
