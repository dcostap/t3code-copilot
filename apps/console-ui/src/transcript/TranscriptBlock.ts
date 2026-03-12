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
  | "userPromptSeparator"
  | "workGroupSeparator"
  | "workGroupHeader"
  | "workGroupFooter"
  | "planSeparator"
  | "planHeader"
  | "planExplanation"
  | "planStepPending"
  | "planStepInProgress"
  | "planStepCompleted"
  | "proposedPlanBody"
  | "checkpointSeparator"
  | "checkpointHeader"
  | "checkpointSummary"
  | "checkpointFile"
  | "workingSeparator"
  | "workingHeader"
  | "workingFooter"
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
  | "commandOutput";

export interface AnnotatedLine {
  readonly text: string;
  readonly kind: LineKind;
  readonly extraClasses?: ReadonlyArray<string>;
  readonly userInputRef?: {
    readonly requestId: string;
    readonly questionIndex: number;
    readonly optionIndex?: number;
  };
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

export interface UserInputRequestBlock {
  readonly type: "user-input-request";
  readonly requestId: string;
  readonly resolved?: boolean;
  readonly answers?: Readonly<Record<string, string>>;
  readonly questions: ReadonlyArray<{
    readonly id?: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description: string;
    }>;
  }>;
}

export interface PlanBlock {
  readonly type: "plan-update";
  readonly explanation?: string;
  readonly steps: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface ProposedPlanBlock {
  readonly type: "proposed-plan";
  readonly title?: string;
  readonly body: string;
}

export interface CheckpointSummaryBlock {
  readonly type: "checkpoint-summary";
  readonly status: "ready" | "missing" | "error";
  readonly checkpointTurnCount: number;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
}

export interface WorkingStateBlock {
  readonly type: "working-state";
  readonly startedAt: string;
  readonly now: string;
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
  | UserInputRequestBlock
  | PlanBlock
  | ProposedPlanBlock
  | CheckpointSummaryBlock
  | WorkingStateBlock
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

function userPromptToLines(
  text: string,
  options: { attachmentCount?: number } = {},
): AnnotatedLine[] {
  const contentLines = text.length > 0 ? wrapLines(text, "userMessage") : [];
  const attachmentLines = Array.from(
    { length: options.attachmentCount ?? 0 },
    () => ({ text: "", kind: "attachmentPanel" as const }),
  );

  return [
    { text: "", kind: "userPromptSeparator" },
    ...contentLines,
    ...attachmentLines,
    { text: "", kind: "userPromptSeparator" },
  ];
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

function planStepKind(status: "pending" | "inProgress" | "completed"): LineKind {
  switch (status) {
    case "completed":
      return "planStepCompleted";
    case "inProgress":
      return "planStepInProgress";
    default:
      return "planStepPending";
  }
}

function planStepPrefix(status: "pending" | "inProgress" | "completed") {
  switch (status) {
    case "completed":
      return "[x]";
    case "inProgress":
      return "[~]";
    default:
      return "[ ]";
  }
}

function formatSignedCount(value: number) {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function summarizeCheckpointFiles(
  files: ReadonlyArray<CheckpointSummaryBlock["files"][number]>,
) {
  return files.reduce(
    (summary, file) => ({
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function blockToLines(block: TranscriptBlock): AnnotatedLine[] {
  switch (block.type) {
    case "user-message":
      return userPromptToLines(block.text, {
        attachmentCount: block.attachments?.length ?? 0,
      });

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

    case "user-input-request": {
      const lines: AnnotatedLine[] = [
        {
          text: block.resolved ? "[✓] User input answered" : "[?] User input requested",
          kind: "approvalPrompt",
          ...(block.resolved ? { extraClasses: ["cm-line-userInputResolved"] } : {}),
        },
      ];
      block.questions.forEach((question, questionIndex) => {
        const answer = question.id ? block.answers?.[question.id] : undefined;
        lines.push({
          text: `    ${question.header}: ${question.question}`,
          kind: "approvalPrompt",
          extraClasses: [
            "cm-line-userInputQuestion",
            ...(block.resolved ? ["cm-line-userInputResolved"] : []),
          ],
          userInputRef: {
            requestId: block.requestId,
            questionIndex,
          },
        });
        question.options.forEach((option, optionIndex) => {
          lines.push(
            {
              text: `      ${optionIndex + 1}  ${option.label}: ${option.description}`,
              kind: "approvalPrompt",
              extraClasses: [
                "cm-line-userInputOption",
                ...(block.resolved
                  ? ["cm-line-userInputResolved", "cm-line-userInputResolvedOption"]
                  : []),
                ...(answer === option.label ? ["cm-line-userInputAnsweredOption"] : []),
              ],
              userInputRef: {
                requestId: block.requestId,
                questionIndex,
                optionIndex,
              },
            },
          );
        });
        if (block.resolved && answer && !question.options.some((option) => option.label === answer)) {
          lines.push(
            ...userPromptToLines(
              block.questions.length > 1 ? `${question.header}: ${answer}` : answer,
            ),
          );
        }
      });
      return lines;
    }

    case "plan-update":
      return [
        { text: "", kind: "planSeparator" },
        { text: "Plan update", kind: "planHeader" },
        ...(block.explanation ? wrapLines(block.explanation, "planExplanation") : []),
        ...(block.explanation && block.steps.length > 0 ? [{ text: "", kind: "meta" as const }] : []),
        ...block.steps.map((step) => ({
          text: `${planStepPrefix(step.status)} ${step.step}`,
          kind: planStepKind(step.status),
        })),
        { text: "", kind: "planSeparator" },
      ];

    case "proposed-plan":
      return [
        { text: "", kind: "planSeparator" },
        { text: block.title ?? "Proposed plan", kind: "planHeader", extraClasses: ["cm-line-proposedPlanHeader"] },
        ...wrapLines(block.body, "proposedPlanBody"),
        { text: "", kind: "planSeparator" },
      ];

    case "checkpoint-summary": {
      const totals = summarizeCheckpointFiles(block.files);
      const fileCountLabel = `${block.files.length} file${block.files.length === 1 ? "" : "s"} changed`;
      const statusLabel =
        block.status === "ready"
          ? "Checkpoint captured"
          : block.status === "missing"
            ? "Checkpoint unavailable"
            : "Checkpoint error";
      const summaryText =
        block.status === "ready"
          ? `${fileCountLabel} (${formatSignedCount(totals.additions)} ${formatSignedCount(-totals.deletions)})`
          : fileCountLabel;

      return [
        { text: "", kind: "checkpointSeparator" },
        {
          text: `${statusLabel} · #${block.checkpointTurnCount}`,
          kind: "checkpointHeader",
        },
        {
          text: summaryText,
          kind: "checkpointSummary",
        },
        ...block.files.map((file) => ({
          text: `  ${file.path}  (${formatSignedCount(file.additions)} ${formatSignedCount(-file.deletions)})`,
          kind: "checkpointFile" as const,
        })),
        { text: "", kind: "checkpointSeparator" },
      ];
    }

    case "working-state": {
      const elapsedLabel = formatElapsedDuration(Date.parse(block.now) - Date.parse(block.startedAt));
      return [
        { text: "", kind: "workingSeparator" },
        { text: "Working", kind: "workingHeader" },
        { text: `running for ${elapsedLabel}`, kind: "workingFooter" },
        { text: "", kind: "workingSeparator" },
      ];
    }

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
