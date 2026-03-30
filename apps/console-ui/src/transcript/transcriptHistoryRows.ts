import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import { deriveRunningThreadIntentLabel } from "../agentIntent";

export const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

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
      readonly kind: "tool";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: TurnId | null;
      readonly activity: OrchestrationThreadActivity;
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

export function deriveTranscriptHistoryRows(
  thread: OrchestrationThread | null,
): ReadonlyArray<TranscriptHistoryRow> {
  if (!thread) {
    return [];
  }

  const timelineItems: Array<TimelineItem> = [
    ...thread.messages.map((message) => ({
      kind: "message" as const,
      id: `message:${message.id}`,
      createdAt: message.createdAt,
      message,
    })),
    ...thread.activities.map((activity) => ({
      kind: "activity" as const,
      id: `activity:${activity.id}`,
      createdAt: activity.createdAt,
      activity,
    })),
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
      if (item.activity.tone === "tool") {
        flushActivityGroup();
        rows.push({
          kind: "tool",
          id: item.id,
          createdAt: item.createdAt,
          turnId: item.activity.turnId,
          activity: item.activity,
        });
        continue;
      }
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
) {
  switch (row.kind) {
    case "message": {
      return 38 + estimateTextHeight(row.message.text, options?.widthPx) + ((row.message.attachments?.length ?? 0) * 22);
    }

    case "tool": {
      const tool = getToolActivityDisplay(row.activity);
      let height = 42;
      if (!options?.expandedToolRowIds?.has(row.id)) {
        return height;
      }
      if (tool.detail) {
        height += estimateTextHeight(tool.detail, options?.widthPx);
      }
      if (tool.command) {
        height += estimateTextHeight(tool.command, options?.widthPx);
      }
      if (tool.output) {
        height += estimateTextHeight(tool.output, options?.widthPx);
      }
      return height + 12;
    }

    case "activity-group": {
      return 34 + row.activities.reduce((total, activity) => {
        const detail = getActivityDetail(activity);
        return total + 20 + (detail ? estimateTextHeight(detail, options?.widthPx) : 0);
      }, 0);
    }

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

export function getToolActivityDisplay(activity: OrchestrationThreadActivity) {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const input = asRecord(item?.input);
  const result = asRecord(item?.result);
  const command = Array.isArray(input?.command)
    ? input.command.filter((part): part is string => typeof part === "string").join(" ")
    : null;
  const output = asString(result?.content);
  const title = asString(payload?.title) ?? activity.summary;
  const detail = asString(payload?.detail) ?? asString(payload?.message) ?? asString(payload?.explanation);
  const itemType = asString(payload?.itemType);

  return {
    title,
    detail,
    command,
    output,
    itemType,
    status: getToolActivityStatus(activity),
  };
}

export function getToolActivityStatus(activity: OrchestrationThreadActivity): "running" | "done" | "error" | "declined" {
  const payload = asRecord(activity.payload);
  const status = asString(payload?.status);
  if (status === "inProgress") {
    return "running";
  }
  if (status === "completed") {
    return "done";
  }
  if (status === "declined") {
    return "declined";
  }
  if (activity.tone === "error") {
    return "error";
  }
  if (activity.kind.endsWith(".started")) {
    return "running";
  }
  return "done";
}
