/**
 * Transcript block model.
 *
 * The transcript is a flat sequence of typed blocks. Each block knows how to
 * serialize itself to plain text (for the CodeMirror document) and carries
 * metadata for line-level decoration.
 */

import { highlightCodeFence } from "./codeFenceHighlight";

// ── Line-level decoration kinds (reused from the prototype) ─────────

export type LineKind =
  | "body"
  | "reasoningSeparator"
  | "reasoningSummary"
  | "reasoning"
  | "table"
  | "codeFenceSeparator"
  | "codeFenceHeader"
  | "codeFenceBody"
  | "blockquote"
  | "meta"
  | "list"
  | "attachmentPanel"
  | "userPromptSeparator"
  | "workGroupSeparator"
  | "workGroupHeader"
  | "workGroupFooter"
  | "fileChangeSummary"
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
  | "workingLine"
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
  readonly commandWidgetSignature?: string;
  readonly inlineUnifiedDiff?: string;
  readonly inlineDiffLookup?: InlineDiffLookup;
  readonly inlineDiffChangedFiles?: ReadonlyArray<string>;
  readonly highlightSpans?: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
    readonly className: string;
  }>;
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

export interface ReasoningTextBlock {
  readonly type: "reasoning-text";
  readonly text: string;
}

export interface ReasoningSummaryBlock {
  readonly type: "reasoning-summary";
  readonly text: string;
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

export interface InlineDiffLookup {
  readonly threadId: string;
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
}

export interface WorkGroupItem {
  readonly kind: "tool" | "command" | "file-change";
  readonly label: string;
  readonly status: "running" | "done" | "error" | "declined";
  readonly detail?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly additions?: number;
  readonly deletions?: number;
  readonly inlineUnifiedDiff?: string;
  readonly inlineDiffLookup?: InlineDiffLookup;
}

function workItemStatusClass(item: WorkGroupItem) {
  switch (item.status) {
    case "running":
      return "cm-line-workItemRunning";
    case "done":
      return "cm-line-workItemDone";
    case "error":
      return "cm-line-workItemError";
    case "declined":
      return "cm-line-workItemDeclined";
  }
}

export interface WorkGroupBlock {
  readonly type: "work-group";
  readonly title?: string;
  readonly status: "running" | "done" | "error" | "declined";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly now?: string;
  readonly pulseOriginAt?: string;
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

export interface SendingStateBlock {
  readonly type: "sending-state";
  readonly startedAt: string;
  readonly now: string;
}

export interface InterruptedStateBlock {
  readonly type: "interrupted-state";
  readonly startedAt: string;
  readonly interruptedAt: string;
}

export interface DividerBlock {
  readonly type: "divider";
}

export interface StatusBlock {
  readonly type: "status";
  readonly text: string;
  readonly variant?: "default" | "reasoning";
}

export type TranscriptBlock =
  | UserMessageBlock
  | AssistantTextBlock
  | ReasoningTextBlock
  | ReasoningSummaryBlock
  | ToolCallBlock
  | ToolResultBlock
  | CommandExecBlock
  | WorkGroupBlock
  | FileDiffBlock
  | UserInputRequestBlock
  | PlanBlock
  | ProposedPlanBlock
  | CheckpointSummaryBlock
  | SendingStateBlock
  | WorkingStateBlock
  | InterruptedStateBlock
  | DividerBlock
  | StatusBlock;

// ── Block → annotated lines ─────────────────────────────────────────

function wrapLines(text: string, kind: LineKind): AnnotatedLine[] {
  return text.split("\n").map((line) => ({ text: line, kind }));
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }

  const normalized = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized.split("|").map((cell) => cell.trim());
  if (cells.length < 2 || cells.every((cell) => cell.length === 0)) {
    return null;
  }
  return cells;
}

function isMarkdownTableDividerLine(line: string, expectedColumns: number): boolean {
  const cells = splitMarkdownTableRow(line);
  if (!cells || cells.length !== expectedColumns) {
    return false;
  }

  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function buildTableBorder(
  widths: ReadonlyArray<number>,
  left: string,
  middle: string,
  right: string,
) {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
}

function formatTableRow(cells: ReadonlyArray<string>, widths: ReadonlyArray<number>) {
  return `│ ${cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length, " ")).join(" │ ")} │`;
}

function tableBlockToLines(rows: ReadonlyArray<ReadonlyArray<string>>): AnnotatedLine[] {
  const headerRow = rows[0];
  if (!headerRow) {
    return [];
  }

  const widths = headerRow.map((_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  if (widths.length === 0) {
    return [];
  }

  const header = headerRow;
  const bodyRows = rows.slice(1);
  const lines: AnnotatedLine[] = [
    { text: buildTableBorder(widths, "┌", "┬", "┐"), kind: "table" },
    { text: formatTableRow(header, widths), kind: "table" },
    { text: buildTableBorder(widths, "├", "┼", "┤"), kind: "table" },
  ];

  bodyRows.forEach((row, index) => {
    lines.push({ text: formatTableRow(row, widths), kind: "table" });
    lines.push({
      text: buildTableBorder(
        widths,
        index === bodyRows.length - 1 ? "└" : "├",
        index === bodyRows.length - 1 ? "┴" : "┼",
        index === bodyRows.length - 1 ? "┘" : "┤",
      ),
      kind: "table",
    });
  });

  return lines;
}

function isCodeFenceLine(line: string) {
  return line.trim().startsWith("```");
}

function codeFenceLanguage(line: string) {
  const match = line.trim().match(/^```([^\s`]+)?\s*$/);
  return match?.[1]?.trim() || "";
}

function codeFenceToLines(language: string, lines: ReadonlyArray<string>): AnnotatedLine[] {
  const highlightSpansByLine = highlightCodeFence(language, lines);
  const header = language.length > 0 ? `code · ${language}` : "code";
  return [
    { text: "╭──────────────────────────────────────────────────────────────────────────────", kind: "codeFenceSeparator" },
    { text: header, kind: "codeFenceHeader" },
    ...lines.map((line, index) => ({
      text: line,
      kind: "codeFenceBody" as const,
      ...(highlightSpansByLine[index] && highlightSpansByLine[index].length > 0
        ? { highlightSpans: highlightSpansByLine[index] }
        : {}),
    })),
    { text: "╰──────────────────────────────────────────────────────────────────────────────", kind: "codeFenceSeparator" },
  ];
}

function renderMarkdownLine(line: string, fallbackKind: LineKind): AnnotatedLine {
  const unorderedListMatch = line.match(/^(\s*)[-+*]\s+(.*)$/);
  if (unorderedListMatch) {
    const [, indent = "", content = ""] = unorderedListMatch;
    return {
      text: `${indent}• ${content}`,
      kind: "list",
    };
  }

  const orderedListMatch = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
  if (orderedListMatch) {
    const [, indent = "", ordinal = "1", content = ""] = orderedListMatch;
    return {
      text: `${indent}${ordinal}. ${content}`,
      kind: "list",
    };
  }

  const blockquoteMatch = line.match(/^(\s*)((?:>\s*)+)(.*)$/);
  if (blockquoteMatch) {
    const [, indent = "", quotePrefix = "", content = ""] = blockquoteMatch;
    const depth = (quotePrefix.match(/>/g) ?? []).length;
    return {
      text: `${indent}${"│ ".repeat(Math.max(1, depth))}${content}`,
      kind: "blockquote",
    };
  }

  return { text: line, kind: fallbackKind };
}

function renderMarkdownTextToLines(text: string, fallbackKind: LineKind): AnnotatedLine[] {
  const sourceLines = text.split("\n");
  const rendered: AnnotatedLine[] = [];

  for (let index = 0; index < sourceLines.length; index += 1) {
    if (isCodeFenceLine(sourceLines[index] ?? "")) {
      let closingIndex = index + 1;
      while (closingIndex < sourceLines.length && !isCodeFenceLine(sourceLines[closingIndex] ?? "")) {
        closingIndex += 1;
      }

      if (closingIndex < sourceLines.length) {
        rendered.push(
          ...codeFenceToLines(
            codeFenceLanguage(sourceLines[index] ?? ""),
            sourceLines.slice(index + 1, closingIndex),
          ),
        );
        index = closingIndex;
        continue;
      }
    }

    const headerCells = splitMarkdownTableRow(sourceLines[index] ?? "");
    if (
      headerCells
      && index + 1 < sourceLines.length
      && isMarkdownTableDividerLine(sourceLines[index + 1] ?? "", headerCells.length)
    ) {
      const rows: string[][] = [headerCells];
      let lookahead = index + 2;
      while (lookahead < sourceLines.length) {
        const rowCells = splitMarkdownTableRow(sourceLines[lookahead] ?? "");
        if (!rowCells || rowCells.length !== headerCells.length) {
          break;
        }
        rows.push(rowCells);
        lookahead += 1;
      }

      rendered.push(...tableBlockToLines(rows));
      index = lookahead - 1;
      continue;
    }

    rendered.push(renderMarkdownLine(sourceLines[index] ?? "", fallbackKind));
  }

  return rendered;
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
  const attachmentLines: AnnotatedLine[] = Array.from(
    { length: options.attachmentCount ?? 0 },
    () => ({ text: "", kind: "attachmentPanel" as const }),
  );
  const bodyLines = [...contentLines, ...attachmentLines];

  if (bodyLines.length > 0) {
    const firstLine = bodyLines[0]!;
    bodyLines[0] = {
      ...firstLine,
      extraClasses: [...(firstLine.extraClasses ?? []), "cm-line-userMessageStart"],
    };
  }

  return [
    { text: "", kind: "userPromptSeparator" },
    ...bodyLines,
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
  const referenceAtMs =
    block.status === "running" && block.now
      ? Date.parse(block.now)
      : Date.parse(block.endedAt);
  const elapsedLabel = formatElapsedDuration(referenceAtMs - startedAtMs);

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

function capitalizeInlineLabel(value: string) {
  if (value.length === 0) {
    return value;
  }
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function commandWidgetGlyph(item: WorkGroupItem, now?: string) {
  switch (item.status) {
    case "running": {
      const frames = ["◐", "◓", "◑", "◒"] as const;
      if (!now) {
        return frames[0];
      }
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) {
        return frames[0];
      }
      return frames[Math.floor(nowMs / 100) % frames.length] ?? frames[0];
    }
    case "done":
      return "✓";
    case "error":
    case "declined":
      return "✗";
  }
}

function commandWidgetPrefix(item: WorkGroupItem) {
  switch (item.status) {
    case "running":
      return "Running";
    case "error":
      return "Failed";
    case "declined":
      return "Declined";
    default:
      return "Ran";
  }
}

function isReadFileItem(item: WorkGroupItem) {
  return item.kind === "tool" && /^(read file|read files)$/i.test(item.label.trim());
}

function fileActivityWidgetPrefix(item: WorkGroupItem) {
  if (item.kind === "file-change") {
    switch (item.status) {
      case "running":
        return "Editing";
      case "error":
        return "Failed";
      case "declined":
        return "Declined";
      default:
        return "Edited";
    }
  }

  switch (item.status) {
    case "running":
      return "Reading";
    case "error":
      return "Failed";
    case "declined":
      return "Declined";
    default:
      return "Read";
  }
}

function workItemStatusPrefix(item: WorkGroupItem, now?: string) {
  switch (item.status) {
    case "running": {
      const frames = ["◜", "◠", "◝", "◞", "◡", "◟"] as const;
      if (!now) {
        return frames[0];
      }
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) {
        return frames[0];
      }
      return frames[Math.floor(nowMs / 100) % frames.length] ?? frames[0];
    }
    case "done":
      return "✓";
    case "error":
    case "declined":
      return "✗";
  }
}

function workItemToLines(
  item: WorkGroupItem,
  collapseLabel: boolean,
  now?: string,
  startedAt?: string,
): AnnotatedLine[] {
  const statusPrefix = workItemStatusPrefix(item, now);
  const lines: AnnotatedLine[] = [];

  if (!collapseLabel && item.kind !== "command") {
    lines.push({ text: `  • ${statusPrefix} ${item.label}`, kind: "toolCall" });
  }

  if (item.command) {
    const exitLabel = item.exitCode !== undefined ? ` [exit ${item.exitCode}]` : "";
    const isRunning = item.status === "running";
    const text = isRunning
      ? `      ${item.command}${exitLabel}`
      : `      ${statusPrefix} ${item.command}${exitLabel}`;
    const highlightSpans =
      isRunning && now
        ? workingPulseSpans(text, now, startedAt, 6, text.length)
        : undefined;
    lines.push({
      text,
      kind: "commandExec",
      extraClasses: [workItemStatusClass(item)],
      ...(highlightSpans && highlightSpans.length > 0 ? { highlightSpans } : {}),
    });
  }

  const detailDuplicatesCommand =
    typeof item.detail === "string"
    && typeof item.command === "string"
    && item.detail.trim() === item.command.trim();

  if (item.detail && !detailDuplicatesCommand) {
    lines.push({ text: `      ${item.detail}`, kind: "toolResult" });
  }

  if (item.output) {
    lines.push(...prefixWrappedLines(item.output, "commandOutput", "      "));
  }

  if (item.changedFiles && item.changedFiles.length > 0) {
    const [firstPath, ...restPaths] = item.changedFiles;
    lines.push({
      text: `      changed: ${firstPath}`,
      kind: "toolResult",
    });
    for (const path of restPaths) {
      lines.push({ text: `        ${path}`, kind: "toolResult" });
    }
  }

  if (lines.length === 0) {
    lines.push({ text: `  • ${statusPrefix} ${item.label}`, kind: "toolCall" });
  }

  return lines;
}

function commandWorkGroupLine(
  item: WorkGroupItem,
  options: {
    signature: string;
    timingLabel?: string;
    now?: string;
    startedAt?: string;
  },
): AnnotatedLine {
  const glyph = commandWidgetGlyph(item, options.now);
  const prefix = commandWidgetPrefix(item);
  const commandText = item.command ?? item.detail ?? item.label;
  const exitLabel = item.exitCode !== undefined ? ` [exit ${item.exitCode}]` : "";
  const timingSuffix = options.timingLabel ? `  ${options.timingLabel}` : "";
  const text = `${glyph} ${prefix}  ${commandText}${exitLabel}${timingSuffix}`;
  const prefixStart = glyph.length + 1;
  const commandStart = prefixStart + prefix.length + 2;
  const commandEnd = commandStart + commandText.length;
  const exitStart = commandEnd;
  const exitEnd = exitStart + exitLabel.length;
  const timingStart = options.timingLabel ? text.length - options.timingLabel.length : -1;
  const highlightSpans = [
    { from: 0, to: glyph.length, className: "tok-commandWidgetGlyph" },
    { from: prefixStart, to: prefixStart + prefix.length, className: "tok-commandWidgetPrefix" },
    ...(exitLabel.length > 0
      ? [{ from: exitStart, to: exitEnd, className: "tok-commandWidgetExit" }]
      : []),
    ...(options.timingLabel
      ? [{ from: timingStart, to: text.length, className: "tok-commandWidgetMeta" }]
      : []),
    ...(item.status === "running" && options.now
      ? workingPulseSpans(text, options.now, options.startedAt, commandStart, commandEnd)
      : []),
  ];

  return {
    text,
    kind: "commandExec",
    extraClasses: [workItemStatusClass(item), "cm-line-commandWidget"],
    commandWidgetSignature: options.signature,
    ...(item.kind === "file-change" && item.inlineUnifiedDiff
      ? {
          inlineUnifiedDiff: item.inlineUnifiedDiff,
          ...(item.changedFiles ? { inlineDiffChangedFiles: item.changedFiles } : {}),
        }
      : {}),
    ...(item.kind === "file-change" && item.inlineDiffLookup
      ? { inlineDiffLookup: item.inlineDiffLookup }
      : {}),
    ...(highlightSpans.length > 0 ? { highlightSpans } : {}),
  };
}

function fileActivitySubject(item: WorkGroupItem) {
  if (item.kind === "file-change") {
    const changedFiles = item.changedFiles ?? [];
    return changedFiles.length === 1
      ? changedFiles[0]!
      : changedFiles.length > 1
        ? `${changedFiles.length} files`
        : "files";
  }

  return item.detail ?? item.changedFiles?.[0] ?? item.label;
}

function fileActivityWorkGroupLine(
  item: WorkGroupItem,
  options: {
    signature: string;
    timingLabel?: string;
    now?: string;
    startedAt?: string;
  },
): AnnotatedLine {
  const glyph = commandWidgetGlyph(item, options.now);
  const prefix = fileActivityWidgetPrefix(item);
  const counts = item.kind === "file-change" ? formatEditCounts(item.additions, item.deletions).trimStart() : "";
  const subject = fileActivitySubject(item);
  const countsSegment = counts.length > 0 ? ` ${counts}` : "";
  const timingSuffix = options.timingLabel ? `  ${options.timingLabel}` : "";
  const text = `${glyph} ${prefix}${countsSegment}  ${subject}${timingSuffix}`;
  const prefixStart = glyph.length + 1;
  const countsStart = counts.length > 0 ? prefixStart + prefix.length + 1 : -1;
  const subjectStart =
    counts.length > 0 ? countsStart + counts.length + 2 : prefixStart + prefix.length + 2;
  const subjectEnd = subjectStart + subject.length;
  const timingStart = options.timingLabel ? text.length - options.timingLabel.length : -1;
  const commaIndex = counts.indexOf(",");
  const plusStart = countsStart >= 0 ? countsStart + 1 : -1;
  const plusEnd = commaIndex === -1 ? -1 : countsStart + commaIndex;
  const minusStart = commaIndex === -1 ? -1 : countsStart + commaIndex + 2;
  const minusEnd = countsStart >= 0 ? countsStart + counts.length - 1 : -1;
  const highlightSpans = [
    { from: 0, to: glyph.length, className: "tok-commandWidgetGlyph" },
    { from: prefixStart, to: prefixStart + prefix.length, className: "tok-commandWidgetPrefix" },
    ...(counts.length > 0 && plusStart >= 0 && plusEnd > plusStart
      ? [{ from: plusStart, to: plusEnd, className: "tok-added" }]
      : []),
    ...(counts.length > 0 && minusStart >= 0 && minusEnd > minusStart
      ? [{ from: minusStart, to: minusEnd, className: "tok-removed" }]
      : []),
    ...(options.timingLabel
      ? [{ from: timingStart, to: text.length, className: "tok-commandWidgetMeta" }]
      : []),
    ...(item.status === "running" && options.now
      ? workingPulseSpans(text, options.now, options.startedAt, subjectStart, subjectEnd)
      : []),
  ];

  return {
    text,
    kind: "commandExec",
    extraClasses: [workItemStatusClass(item), "cm-line-commandWidget"],
    commandWidgetSignature: options.signature,
    ...(item.kind === "file-change" && item.inlineUnifiedDiff
      ? {
          inlineUnifiedDiff: item.inlineUnifiedDiff,
          ...(item.changedFiles ? { inlineDiffChangedFiles: item.changedFiles } : {}),
        }
      : {}),
    ...(item.kind === "file-change" && item.inlineDiffLookup
      ? { inlineDiffLookup: item.inlineDiffLookup }
      : {}),
    ...(highlightSpans.length > 0 ? { highlightSpans } : {}),
  };
}

function commandWorkGroupToLines(block: WorkGroupBlock): AnnotatedLine[] {
  const lastCommandIndex = block.items.length - 1;
  const timingLabel = capitalizeInlineLabel(formatWorkGroupFooter(block));

  return [
    ...block.items.flatMap((item, index) => {
      const lines: AnnotatedLine[] = [
        commandWorkGroupLine(item, {
          signature: `${block.startedAt}:${index}:${item.command ?? item.label}`,
          ...(index === lastCommandIndex ? { timingLabel } : {}),
          ...(block.now ? { now: block.now } : {}),
          startedAt: block.pulseOriginAt ?? block.startedAt,
        }),
      ];

      if (item.output) {
        lines.push(...prefixWrappedLines(item.output, "commandOutput", "  "));
      }

      if (item.changedFiles && item.changedFiles.length > 0) {
        const [firstPath, ...restPaths] = item.changedFiles;
        lines.push({
          text: `  changed: ${firstPath}`,
          kind: "toolResult",
        });
        for (const path of restPaths) {
          lines.push({ text: `    ${path}`, kind: "toolResult" });
        }
      }

      return lines;
    }),
    { text: "", kind: "workGroupSeparator" },
  ];
}

function fileActivityWorkGroupToLines(block: WorkGroupBlock): AnnotatedLine[] {
  const lastItemIndex = block.items.length - 1;
  const timingLabel = capitalizeInlineLabel(formatWorkGroupFooter(block));

  return [
    ...block.items.flatMap((item, index) => {
      const lines: AnnotatedLine[] = [
        fileActivityWorkGroupLine(item, {
          signature: `${block.startedAt}:${index}:${item.detail ?? item.changedFiles?.join("|") ?? item.label}`,
          ...(index === lastItemIndex ? { timingLabel } : {}),
          ...(block.now ? { now: block.now } : {}),
          startedAt: block.pulseOriginAt ?? block.startedAt,
        }),
      ];

      if (item.output) {
        lines.push(...prefixWrappedLines(item.output, "commandOutput", "  "));
      }

      return lines;
    }),
    { text: "", kind: "workGroupSeparator" },
  ];
}

function formatEditCounts(additions?: number, deletions?: number) {
  if (typeof additions !== "number" && typeof deletions !== "number") {
    return "";
  }

  const safeAdditions = typeof additions === "number" ? additions : 0;
  const safeDeletions = typeof deletions === "number" ? deletions : 0;
  return ` (+${safeAdditions}, -${safeDeletions})`;
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

function workingPulseIndex(text: string, now: string, startedAt?: string, radius = 0) {
  const textLength = text.length;
  if (textLength === 0) {
    return null;
  }

  const pauseMs = 180;
  const activeMs = 1_900;
  const cycleMs = activeMs + pauseMs;
  const nowMs = Date.parse(now);
  const startMs = startedAt ? Date.parse(startedAt) : nowMs;
  if (!Number.isFinite(nowMs) || !Number.isFinite(startMs)) {
    return null;
  }

  const elapsedMs = Math.max(0, nowMs - startMs);
  const offsetMs = elapsedMs % cycleMs;
  if (offsetMs >= activeMs) {
    return null;
  }

  const activePositions = Math.max(1, textLength + radius);
  return Math.floor((offsetMs / activeMs) * activePositions);
}

function workingPulseSpans(
  text: string,
  now: string,
  startedAt?: string,
  rangeStart = 0,
  rangeEnd = text.length,
): ReadonlyArray<{
  readonly from: number;
  readonly to: number;
  readonly className: string;
}> {
  const safeStart = Math.max(0, Math.min(rangeStart, text.length));
  const safeEnd = Math.max(safeStart, Math.min(rangeEnd, text.length));
  const slice = text.slice(safeStart, safeEnd);
  const baselineChars = 22;
  const baseRadius = 3;
  const edgeRadius = 2;
  const midRadius = 1;
  const extraRadius =
    slice.length <= baselineChars ? 0 : Math.max(0, Math.floor((slice.length - baselineChars) / 6));
  const radius = baseRadius + extraRadius;
  const coreRadius = Math.max(0, radius - edgeRadius - midRadius);
  const center = workingPulseIndex(slice, now, startedAt, radius);
  if (center === null) {
    return [];
  }

  return Array.from({ length: radius * 2 + 1 }, (_, arrayIndex) => arrayIndex - radius).flatMap((offset) => {
    const index = center + offset;
    if (index < 0 || index >= slice.length) {
      return [];
    }
    const absOffset = Math.abs(offset);
    const className =
      absOffset <= coreRadius
        ? "tok-workingPulseCore"
        : absOffset <= coreRadius + midRadius
          ? "tok-workingPulseMid"
          : "tok-workingPulseEdge";
    return [{ from: safeStart + index, to: safeStart + index + 1, className }];
  });
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
      return renderMarkdownTextToLines(block.text, "body");

    case "reasoning-text":
      return [
        ...renderMarkdownTextToLines(block.text, "reasoning"),
        { text: "", kind: "reasoningSeparator" },
      ];

    case "reasoning-summary":
      return [{ text: block.text, kind: "reasoningSummary" }];

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
      if (block.items.every((item) => item.kind === "command")) {
        return commandWorkGroupToLines(block);
      }

      if (block.items.every((item) => item.kind === "file-change" || isReadFileItem(item))) {
        return fileActivityWorkGroupToLines(block);
      }

      const headerText = block.title ?? "Working";
      const collapseSingleItemLabel =
        block.items.length === 1 && block.title !== undefined && block.items[0]?.label === block.title;
      return [
        { text: "", kind: "workGroupSeparator" },
        { text: headerText, kind: "workGroupHeader" },
        ...block.items.flatMap((item) =>
          workItemToLines(item, collapseSingleItemLabel, block.now, block.pulseOriginAt ?? block.startedAt)),
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
        ...renderMarkdownTextToLines(block.body, "proposedPlanBody"),
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

    case "sending-state":
    case "working-state": {
      const elapsedLabel = formatElapsedDuration(Date.parse(block.now) - Date.parse(block.startedAt));
      const text = block.type === "sending-state"
        ? `Sending prompt for ${elapsedLabel}`
        : `Working for ${elapsedLabel}`;
      const highlightSpans = workingPulseSpans(text, block.now, block.startedAt);
      return [{
        text,
        kind: "workingLine",
        ...(highlightSpans.length > 0
          ? {
              highlightSpans,
            }
          : {}),
      }];
    }

    case "interrupted-state": {
      const elapsedLabel = formatElapsedDuration(
        Date.parse(block.interruptedAt) - Date.parse(block.startedAt),
      );
      return [{
        text: `Interrupted after ${elapsedLabel}`,
        kind: "workingLine",
      }];
    }

    case "divider":
      return [
        { text: "", kind: "meta" },
        { text: DIVIDER_TEXT, kind: "divider" },
        { text: "", kind: "meta" },
      ];

    case "status":
      return [{ text: block.text, kind: block.variant === "reasoning" ? "reasoning" : "status" }];
  }
}
