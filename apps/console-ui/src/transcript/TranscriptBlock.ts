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
  | FileDiffBlock
  | ApprovalRequestBlock
  | PlanBlock
  | DividerBlock
  | StatusBlock;

// ── Block → annotated lines ─────────────────────────────────────────

function wrapLines(text: string, kind: LineKind): AnnotatedLine[] {
  return text.split("\n").map((line) => ({ text: line, kind }));
}

const DIVIDER_TEXT = "────────────────────────────────────────────────────────────────────────────────";

export function blockToLines(block: TranscriptBlock): AnnotatedLine[] {
  switch (block.type) {
    case "user-message":
      return [
        { text: "", kind: "meta" },
        ...wrapLines(block.text, "userMessage"),
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
