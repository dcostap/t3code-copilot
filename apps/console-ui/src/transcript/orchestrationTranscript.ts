import type {
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

import type { TranscriptBlock } from "./TranscriptBlock";

interface TimelineEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly source: "message" | "plan" | "activity";
  readonly sequence?: number;
  readonly blocks: ReadonlyArray<TranscriptBlock>;
}

interface UserInputQuestionBlock {
  header: string;
  question: string;
  options: Array<{
    label: string;
    description: string;
  }>;
}

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

function planUpdateMarkdown(payload: Record<string, unknown> | null): string | null {
  const rawSteps = Array.isArray(payload?.plan) ? payload.plan : [];
  const steps = rawSteps
    .map((entry) => {
      const record = asRecord(entry);
      const step = asString(record?.step);
      const status = asString(record?.status) ?? "pending";
      if (!step) return null;
      const marker =
        status === "completed" ? "[x]" : status === "inProgress" ? "[~]" : "[ ]";
      return `${marker} ${step}`;
    })
    .filter((entry): entry is string => entry !== null);

  const explanation = asString(payload?.explanation);
  if (!explanation && steps.length === 0) return null;

  return [
    "Plan update",
    "",
    ...(explanation ? [explanation, ""] : []),
    ...steps,
  ].join("\n");
}

function userInputBlock(payload: Record<string, unknown> | null): TranscriptBlock | null {
  const requestId = asString(payload?.requestId);
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const normalizedQuestions = questions
    .map((entry) => {
      const question = asRecord(entry);
      const header = asString(question?.header);
      const prompt = asString(question?.question);
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
      return {
        header,
        question: prompt,
        options: normalizedOptions,
      };
    })
    .filter((question): question is UserInputQuestionBlock => question !== null);

  if (!requestId || normalizedQuestions.length === 0) return null;
  return {
    type: "user-input-request",
    requestId,
    questions: normalizedQuestions,
  };
}

function activityToBlocks(activity: OrchestrationThreadActivity): TranscriptBlock[] {
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
      const block = userInputBlock(payload);
      return block ? [block] : [{ type: "status", text: activity.summary }];
    }

    case "turn.plan.updated": {
      const markdown = planUpdateMarkdown(payload);
      return markdown ? [{ type: "plan", markdown }] : [{ type: "status", text: activity.summary }];
    }
  }

  const itemType = asString(payload?.itemType);
  const command = extractCommand(payload);
  const output = extractOutput(payload);
  const exitCode = extractExitCode(payload);

  if (itemType === "command_execution" && command) {
    return [
      {
        type: "command-exec",
        command,
        ...(typeof exitCode === "number" ? { exitCode } : {}),
        ...(output ? { output } : {}),
      },
    ];
  }

  if (activity.tone === "tool") {
    const blocks: TranscriptBlock[] = [
      {
        type: "tool-call",
        label: asString(payload?.title) ?? activity.summary,
        status: toolStatusToBlockStatus(payload?.status),
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

function compareByCreatedAt(left: TimelineEntry, right: TimelineEntry) {
  if (left.source === "activity" && right.source === "activity") {
    if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function threadToTranscriptBlocks(thread: OrchestrationThread): TranscriptBlock[] {
  const checkpointsByAssistantMessageId = new Map(
    thread.checkpoints
      .filter((checkpoint) => checkpoint.assistantMessageId !== null)
      .map((checkpoint) => [checkpoint.assistantMessageId!, checkpoint] as const),
  );

  const entries: TimelineEntry[] = [];

  for (const message of thread.messages) {
    const text = message.attachments && message.attachments.length > 0
      ? [message.text, "", ...message.attachments.map((attachment) => `[image] ${attachment.name}`)]
          .filter((line) => line.length > 0)
          .join("\n")
      : message.text;

    const blocks: TranscriptBlock[] =
      message.role === "user"
        ? [{ type: "user-message", text }]
        : message.role === "assistant"
          ? [{ type: "assistant-text", text, streaming: message.streaming }]
          : [{ type: "status", text }];

    if (message.role === "assistant") {
      const checkpoint = checkpointsByAssistantMessageId.get(message.id);
      if (checkpoint) {
        blocks.push(
          ...checkpoint.files.map((file) => ({
            type: "file-diff" as const,
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
          })),
        );
      }
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
      blocks: [{ type: "plan", markdown: proposedPlan.planMarkdown }],
    });
  }

  for (const activity of thread.activities) {
    entries.push({
      id: `activity:${activity.id}`,
      createdAt: activity.createdAt,
      source: "activity",
      ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
      blocks: activityToBlocks(activity),
    });
  }

  return entries.toSorted(compareByCreatedAt).flatMap((entry) => entry.blocks);
}
