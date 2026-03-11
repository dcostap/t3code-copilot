/**
 * Transcript block model.
 *
 * The transcript is a flat sequence of typed blocks. Each block knows how to
 * serialize itself to plain text (for the CodeMirror document) and carries
 * metadata for line-level decoration.
 */

// ── Line-level decoration kinds (reused from the prototype) ─────────

export type LineKind =
  | "body"
  | "meta"
  | "list"
  | "attachmentPanel"
  | "workGroupSeparator"
  | "workGroupHeader"
  | "workGroupFooter"
  | "promptInput"
  | "promptSeparator"
  | "toolCall"
  | "toolResult"
  | "diffRemoved"
  | "diffAdded"
  | "diffContext"
  | "diffHeader"
  | "divider"
  | "userMessage"
  | "status"
  | "approvalPrompt"
  | "commandExec"
  | "commandOutput"
  | "planText";

export interface AnnotatedLine {
  readonly text: string;
  readonly kind: LineKind;
}

// ── Block types ─────────────────────────────────────────────────────

export interface UserMessageBlock {
  readonly type: "user-message";
  readonly text: string;
  readonly attachments?: ReadonlyArray<TranscriptImageAttachment>;
}

export interface TranscriptImageAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUrl?: string;
}

export interface AssistantTextBlock {
  readonly type: "assistant-text";
  readonly text: string;
  readonly streaming: boolean;
}

export interface ToolCallBlock {
  readonly type: "tool-call";
  readonly label: string;
  readonly status: "running" | "done" | "error" | "declined";
  readonly detail?: string;
}

export interface ToolResultBlock {
  readonly type: "tool-result";
  readonly summary: string;
  readonly output?: string;
}

export interface CommandExecBlock {
  readonly type: "command-exec";
  readonly command: string;
  readonly exitCode?: number;
  readonly output?: string;
}

export interface WorkGroupItem {
  readonly kind: "tool" | "command";
  readonly label: string;
  readonly status: "running" | "done" | "error" | "declined";
  readonly detail?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly changedFiles?: ReadonlyArray<string>;
}

export interface WorkGroupBlock {
  readonly type: "work-group";
  readonly title?: string;
  readonly status: "running" | "done" | "error" | "declined";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly items: ReadonlyArray<WorkGroupItem>;
}

export interface FileDiffBlock {
  readonly type: "file-diff";
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly lines?: ReadonlyArray<{ text: string; kind: "added" | "removed" | "context" }>;
}

export interface ApprovalRequestBlock {
  readonly type: "approval-request";
  readonly requestId: string;
  readonly requestKind: "command" | "file-read" | "file-change";
  readonly detail?: string;
  readonly resolved?: "accepted" | "declined";
}

export interface UserInputRequestBlock {
  readonly type: "user-input-request";
  readonly requestId: string;
  readonly questions: ReadonlyArray<{
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description: string;
    }>;
  }>;
}

export interface PlanBlock {
  readonly type: "plan";
  readonly markdown: string;
}

export interface DividerBlock {
  readonly type: "divider";
}

export interface StatusBlock {
  readonly type: "status";
  readonly text: string;
}

export type TranscriptBlock =
  | UserMessageBlock
  | AssistantTextBlock
  | ToolCallBlock
  | ToolResultBlock
  | CommandExecBlock
  | WorkGroupBlock
  | FileDiffBlock
  | ApprovalRequestBlock
  | UserInputRequestBlock
  | PlanBlock
  | DividerBlock
  | StatusBlock;

// ── Block → annotated lines ─────────────────────────────────────────

function wrapLines(text: string, kind: LineKind): AnnotatedLine[] {
  return text.split("\n").map((line) => ({ text: line, kind }));
}

function prefixWrappedLines(
  text: string,
  kind: LineKind,
  prefix: string,
): AnnotatedLine[] {
  return text.split("\n").map((line) => ({ text: `${prefix}${line}`, kind }));
}

function formatElapsedDuration(ms: number) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safeMs < 60_000) {
    return `${(safeMs / 1_000).toFixed(safeMs >= 10_000 ? 0 : 1)}s`;
  }

  const totalSeconds = Math.round(safeMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatWorkGroupFooter(block: WorkGroupBlock) {
  const startedAtMs = Date.parse(block.startedAt);
  const endedAtMs = Date.parse(block.endedAt);
  const elapsedLabel = formatElapsedDuration(endedAtMs - startedAtMs);

  switch (block.status) {
    case "running":
      return `running for ${elapsedLabel}`;
    case "error":
      return `failed after ${elapsedLabel}`;
    case "declined":
      return `declined after ${elapsedLabel}`;
    default:
      return `completed in ${elapsedLabel}`;
  }
}

function workItemToLines(
  item: WorkGroupItem,
  collapseLabel: boolean,
): AnnotatedLine[] {
  const statusIcon =
    item.status === "running" ? "⟳" : item.status === "done" ? "✓" : "✗";
  const lines: AnnotatedLine[] = [];

  if (!collapseLabel) {
    lines.push({ text: `  • ${statusIcon} ${item.label}`, kind: "toolCall" });
  }

  if (item.command) {
    const exitLabel = item.exitCode !== undefined ? ` [exit ${item.exitCode}]` : "";
    lines.push({
      text: `    $ ${item.command}${exitLabel}`,
      kind: "commandExec",
    });
  }

  if (item.detail) {
    lines.push({ text: `    ${item.detail}`, kind: "toolResult" });
  }

  if (item.output) {
    lines.push(...prefixWrappedLines(item.output, "commandOutput", "    "));
  }

  if (item.changedFiles && item.changedFiles.length > 0) {
    const [firstPath, ...restPaths] = item.changedFiles;
    lines.push({
      text: `    changed: ${firstPath}`,
      kind: "toolResult",
    });
    for (const path of restPaths) {
      lines.push({ text: `      ${path}`, kind: "toolResult" });
    }
  }

  if (lines.length === 0) {
    lines.push({ text: `  • ${statusIcon} ${item.label}`, kind: "toolCall" });
  }

  return lines;
}

const DIVIDER_TEXT = "────────────────────────────────────────────────────────────────────────────────";

export function blockToLines(block: TranscriptBlock): AnnotatedLine[] {
  switch (block.type) {
    case "user-message":
      return [
        { text: "", kind: "meta" },
        ...wrapLines(block.text, "userMessage"),
        ...((block.attachments ?? []).map(() => ({ text: "", kind: "attachmentPanel" as const }))),
        { text: "", kind: "meta" },
      ];

    case "assistant-text":
      return [
        ...wrapLines(block.text, "body"),
      ];

    case "tool-call": {
      const statusIcon = block.status === "running" ? "⟳" : block.status === "done" ? "✓" : block.status === "declined" ? "✗" : "✗";
      const line = `• ${statusIcon} ${block.label}`;
      const lines: AnnotatedLine[] = [{ text: line, kind: "toolCall" }];
      if (block.detail) {
        lines.push({ text: `  └ ${block.detail}`, kind: "toolResult" });
      }
      return lines;
    }

    case "tool-result":
      return [
        { text: `  └ ${block.summary}`, kind: "toolResult" },
        ...(block.output ? wrapLines(block.output, "toolResult") : []),
      ];

    case "command-exec": {
      const exitLabel = block.exitCode !== undefined ? ` [exit ${block.exitCode}]` : "";
      const lines: AnnotatedLine[] = [
        { text: `$ ${block.command}${exitLabel}`, kind: "commandExec" },
      ];
      if (block.output) {
        lines.push(...wrapLines(block.output, "commandOutput"));
      }
      return lines;
    }

    case "work-group": {
      const headerText = block.title ?? "Working";
      const collapseSingleItemLabel =
        block.items.length === 1 && block.title !== undefined && block.items[0]?.label === block.title;
      return [
        { text: "", kind: "workGroupSeparator" },
        { text: headerText, kind: "workGroupHeader" },
        ...block.items.flatMap((item) => workItemToLines(item, collapseSingleItemLabel)),
        { text: formatWorkGroupFooter(block), kind: "workGroupFooter" },
        { text: "", kind: "workGroupSeparator" },
      ];
    }

    case "file-diff": {
      const counts = `+${block.additions} -${block.deletions}`;
      const lines: AnnotatedLine[] = [
        { text: `  ${block.path}  (${counts})`, kind: "diffHeader" },
      ];
      if (block.lines) {
        for (const dl of block.lines) {
          const prefix = dl.kind === "added" ? "+" : dl.kind === "removed" ? "-" : " ";
          const kind: LineKind = dl.kind === "added" ? "diffAdded" : dl.kind === "removed" ? "diffRemoved" : "diffContext";
          lines.push({ text: `${prefix} ${dl.text}`, kind });
        }
      }
      return lines;
    }

    case "approval-request": {
      const state = block.resolved ?? "pending";
      const icon = state === "accepted" ? "✓" : state === "declined" ? "✗" : "?";
      const kindLabel = block.requestKind.replace(/-/g, " ");
      const lines: AnnotatedLine[] = [
        { text: `[${icon}] Approval needed: ${kindLabel}`, kind: "approvalPrompt" },
      ];
      if (block.detail) {
        lines.push({ text: `    ${block.detail}`, kind: "approvalPrompt" });
      }
      return lines;
    }

    case "user-input-request": {
      const lines: AnnotatedLine[] = [
        { text: "[?] User input requested", kind: "approvalPrompt" },
      ];
      for (const question of block.questions) {
        lines.push({ text: `    ${question.header}: ${question.question}`, kind: "approvalPrompt" });
        for (const option of question.options) {
          lines.push(
            { text: `      - ${option.label}: ${option.description}`, kind: "approvalPrompt" },
          );
        }
      }
      return lines;
    }

    case "plan":
      return [
        { text: "", kind: "meta" },
        ...wrapLines(block.markdown, "planText"),
        { text: "", kind: "meta" },
      ];

    case "divider":
      return [
        { text: "", kind: "meta" },
        { text: DIVIDER_TEXT, kind: "divider" },
        { text: "", kind: "meta" },
      ];

    case "status":
      return [{ text: block.text, kind: "status" }];
  }
}
