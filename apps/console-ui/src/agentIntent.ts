import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";

export const MAX_AGENT_INTENT_LABEL_LENGTH = 40;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function normalizeIntentLabel(value: string): string | null {
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) {
    return null;
  }

  const capitalized = `${collapsed.charAt(0).toUpperCase()}${collapsed.slice(1)}`;
  if (capitalized.length <= MAX_AGENT_INTENT_LABEL_LENGTH) {
    return capitalized;
  }

  return `${capitalized.slice(0, MAX_AGENT_INTENT_LABEL_LENGTH - 3).trimEnd()}...`;
}

function extractIntentFromDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const match = detail.match(/(?:^|\s)intent=(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function extractIntentArgument(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result);
  const candidates = [
    asRecord(item?.input),
    asRecord(item?.arguments),
    asRecord(result?.input),
    asRecord(result?.arguments),
    asRecord(data?.input),
    asRecord(data?.arguments),
    asRecord(data?.args),
    asRecord(data?.params),
  ];

  for (const candidate of candidates) {
    const intent = asString(candidate?.intent);
    if (intent) {
      return intent;
    }
  }

  return extractIntentFromDetail(asString(payload?.detail));
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

export function isReportIntentToolPayload(payload: unknown): boolean {
  return normalizeToolName(extractToolName(asRecord(payload))) === "report_intent";
}

export function extractReportIntentLabel(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!isReportIntentToolPayload(record)) {
    return null;
  }

  const intent = extractIntentArgument(record);
  return intent ? normalizeIntentLabel(intent) : null;
}

export function deriveRunningThreadIntentLabel(thread: OrchestrationThread): string | null {
  if (thread.latestTurn?.state !== "running" && thread.session?.status !== "running") {
    return null;
  }

  const activeTurnId = thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
  const activeTurnRequestedAt = thread.latestTurn?.requestedAt ?? thread.latestTurn?.startedAt ?? null;
  let latestIntent: string | null = null;

  for (const activity of [...thread.activities].toSorted(compareActivitiesByTimelineOrder)) {
    if (
      activeTurnId
      && activity.turnId
      && activity.turnId !== activeTurnId
    ) {
      continue;
    }

    if (
      !activity.turnId
      && activeTurnRequestedAt
      && activity.createdAt.localeCompare(activeTurnRequestedAt) < 0
    ) {
      continue;
    }

    const intent = extractReportIntentLabel(activity.payload);
    if (intent) {
      latestIntent = intent;
    }
  }

  return latestIntent;
}
