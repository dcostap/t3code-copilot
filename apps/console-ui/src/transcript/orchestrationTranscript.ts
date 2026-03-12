import type {
  OrchestrationEvent,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import type {
  TranscriptBlock,
  UserInputRequestBlock,
  WorkGroupItem,
} from "./TranscriptBlock";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

interface TranscriptBlockOptions {
  readonly resolveAttachmentPreviewUrl?: (attachmentId: string) => string;
  readonly orchestrationEvents?: ReadonlyArray<OrchestrationEvent>;
  readonly now?: string;
}

interface ActivityBlockOptions {
  readonly resolvedUserInputsByRequestId?: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

interface TimelineEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly source: "message" | "plan" | "activity";
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

function decisionToApprovalState(value: unknown): "accepted" | "declined" | undefined {
  if (value === "approved" || value === "accept" || value === "accepted" || value === "allow") {
    return "accepted";
  }
  if (value === "declined" || value === "denied" || value === "reject" || value === "rejected") {
    return "declined";
  }
  return undefined;
}

function requestKindFromPayload(payload: Record<string, unknown> | null): "command" | "file-read" | "file-change" | null {
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

function checkpointToBlock(
  checkpoint: OrchestrationThread["checkpoints"][number],
): TranscriptBlock {
  return {
    type: "checkpoint-summary",
    status: checkpoint.status,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    files: checkpoint.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      additions: file.additions,
      deletions: file.deletions,
    })),
  };
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
): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const resolvedByRequestId = new Map<string, Readonly<Record<string, string>>>();

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
      resolvedByRequestId.set(requestId, answers);
      continue;
    }
  }

  return resolvedByRequestId;
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

function activityToWorkItem(activity: OrchestrationThreadActivity): PendingWorkItem | null {
  const payload = asRecord(activity.payload);
  const itemType = asString(payload?.itemType);
  const command = extractCommand(payload);
  const exitCode = extractExitCode(payload);
  const detail = asString(payload?.detail);
  const rawOutput = extractOutput(payload);
  const output = rawOutput === detail ? null : rawOutput;
  const changedFiles = extractChangedFiles(payload);
  const status = resolveActivityStatus(payload?.status, activity.kind);
  const label = asString(payload?.title) ?? activity.summary;

  if (itemType === "command_execution" || command) {
    return {
      kind: "command",
      label,
      status,
      mergeKey: `command:${command ?? label}`,
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
    mergeKey: `${itemType ?? "tool"}:${label}`,
    ...(detail ? { detail } : {}),
    ...(output ? { output } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
  };
}

function canMergeWorkItems(previous: PendingWorkItem, next: PendingWorkItem) {
  return previous.kind === next.kind
    && previous.mergeKey === next.mergeKey
    && previous.status === "running"
    && next.status !== "running";
}

function mergeWorkItems(previous: PendingWorkItem, next: PendingWorkItem): PendingWorkItem {
  const changedFiles = previous.changedFiles || next.changedFiles
    ? uniqueStrings([...(previous.changedFiles ?? []), ...(next.changedFiles ?? [])])
    : null;

  return {
    ...previous,
    ...next,
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
): TranscriptBlock | null {
  if (items.length === 0) {
    return null;
  }

  const mergedItems: PendingWorkItem[] = [];
  for (const entry of items) {
    const previous = mergedItems.at(-1);
    if (previous && canMergeWorkItems(previous, entry.item)) {
      mergedItems[mergedItems.length - 1] = mergeWorkItems(previous, entry.item);
      continue;
    }
    mergedItems.push(entry.item);
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
    items: mergedItems.map(({ mergeKey: _mergeKey, ...item }) => item),
  };
}

function activityToBlocks(
  activity: OrchestrationThreadActivity,
  options: ActivityBlockOptions = {},
): TranscriptBlock[] {
  const payload = asRecord(activity.payload);

  switch (activity.kind) {
    case "approval.requested": {
      const requestKind = requestKindFromPayload(payload);
      if (!requestKind) {
        return [{ type: "status", text: activity.summary }];
      }
      return [
        {
          type: "approval-request",
          requestId: asString(payload?.requestId) ?? activity.id,
          requestKind,
          ...(asString(payload?.detail) ? { detail: asString(payload?.detail)! } : {}),
        },
      ];
    }

    case "approval.resolved": {
      const requestKind = requestKindFromPayload(payload);
      if (!requestKind) {
        return [{ type: "status", text: activity.summary }];
      }
      const resolved = decisionToApprovalState(payload?.decision);
      return [
        {
          type: "approval-request",
          requestId: asString(payload?.requestId) ?? activity.id,
          requestKind,
          ...(resolved ? { resolved } : {}),
          ...(asString(payload?.detail) ? { detail: asString(payload?.detail)! } : {}),
        },
      ];
    }

    case "user-input.requested": {
      const requestId = asString(payload?.requestId);
      const block = userInputBlock(payload);
      const resolvedAnswers =
        requestId && options.resolvedUserInputsByRequestId
          ? options.resolvedUserInputsByRequestId.get(requestId)
          : undefined;
      if (!block) {
        return [{ type: "status", text: activity.summary }];
      }

      return [
        resolvedAnswers
          ? {
              ...block,
              resolved: true,
              answers: resolvedAnswers,
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
      text: detail ? `${activity.summary}: ${detail}` : activity.summary,
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

export function threadToTranscriptBlocks(
  thread: OrchestrationThread,
  options: TranscriptBlockOptions = {},
): TranscriptBlock[] {
  const resolvedUserInputsByRequestId = deriveResolvedUserInputsByRequestId(thread.activities);
  const assistantBoundariesByTurnId = buildAssistantBoundaryMap(thread.activities);
  const checkpointsByAssistantMessageId = new Map(
    thread.checkpoints
      .filter((checkpoint) => checkpoint.assistantMessageId !== null)
      .map((checkpoint) => [checkpoint.assistantMessageId!, checkpoint] as const),
  );

  const entries: TimelineEntry[] = [];

  for (const message of thread.messages) {
    const text =
      message.attachments && message.attachments.length > 0 && message.text === IMAGE_ONLY_BOOTSTRAP_PROMPT
        ? ""
        : message.text;
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

    const blocks: TranscriptBlock[] =
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
      if (assistantEntries) {
        entries.push(...assistantEntries);
      } else if (checkpoint) {
        entries.push({
          id: `message:${message.id}`,
          createdAt: message.createdAt,
          source: "message",
          blocks,
        });
        entries.push({
          id: `checkpoint:${checkpoint.turnId}:${message.id}`,
          createdAt: checkpoint.completedAt,
          source: "message",
          blocks: [checkpointToBlock(checkpoint)],
        });
        continue;
      } else {
        entries.push({
          id: `message:${message.id}`,
          createdAt: message.createdAt,
          source: "message",
          blocks,
        });
        continue;
      }

      if (checkpoint) {
        const checkpointEntries = [{
          id: `checkpoint:${checkpoint.turnId}:${message.id}`,
          createdAt: checkpoint.completedAt,
          source: "message" as const,
          blocks: [checkpointToBlock(checkpoint)],
        }];
        entries.push(...checkpointEntries);
      }
      continue;
    }

    entries.push({
      id: `message:${message.id}`,
      createdAt: message.createdAt,
      source: "message",
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

  for (const activity of thread.activities) {
    entries.push({
      id: `activity:${activity.id}`,
      createdAt: activity.createdAt,
      source: "activity",
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      activity,
    });
  }

  const blocks: TranscriptBlock[] = [];
  let pendingWorkItems: Array<{ activity: OrchestrationThreadActivity; item: PendingWorkItem }> = [];
  let pendingWorkTurnId: OrchestrationThreadActivity["turnId"] = null;

  const flushWorkItems = () => {
    const block = workItemsToBlock(pendingWorkItems);
    if (block) {
      blocks.push(block);
    }
    pendingWorkItems = [];
    pendingWorkTurnId = null;
  };

  for (const entry of entries.toSorted(compareByCreatedAt)) {
    if (entry.source === "activity" && entry.activity) {
      const workItem = activityToWorkItem(entry.activity);
      if (workItem) {
        if (
          pendingWorkItems.length > 0
          && pendingWorkTurnId !== entry.activity.turnId
        ) {
          flushWorkItems();
        }
        pendingWorkItems.push({ activity: entry.activity, item: workItem });
        pendingWorkTurnId = entry.activity.turnId;
        continue;
      }
    }

    if (pendingWorkItems.length > 0) {
      flushWorkItems();
    }

    if (entry.source === "activity" && entry.activity) {
      blocks.push(...activityToBlocks(entry.activity, { resolvedUserInputsByRequestId }));
      continue;
    }

    if (entry.blocks) {
      blocks.push(...entry.blocks);
    }
  }

  if (pendingWorkItems.length > 0) {
    flushWorkItems();
  }

  if (thread.latestTurn?.state === "running" || thread.session?.status === "running") {
    const startedAt =
      thread.latestTurn?.startedAt
      ?? thread.latestTurn?.requestedAt
      ?? thread.session?.updatedAt
      ?? thread.updatedAt;
    const now = options.now ?? new Date().toISOString();
    blocks.push({
      type: "working-state",
      startedAt,
      now,
    });
  }

  return blocks;
}
