/**
 * Transcript block model.
 *
 * The transcript is a flat sequence of typed blocks. Each block knows how to
 * serialize itself to plain text and carries metadata for line-level
 * decoration.
 */

import { highlightCodeFence } from "./codeFenceHighlight";

// ── Line-level decoration kinds (reused from the prototype) ─────────

export type LineKind =
  | "blockGap"
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

export type MarkdownTableAlignment = "left" | "center" | "right";

export interface MarkdownTableData {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly alignments: ReadonlyArray<MarkdownTableAlignment>;
}

export interface AnnotatedLine {
  readonly text: string;
  readonly kind: LineKind;
  readonly extraClasses?: ReadonlyArray<string>;
  readonly commandWidgetSignature?: string;
  readonly timingLabel?: string;
  readonly commandWidgetOutputLines?: ReadonlyArray<string>;
  readonly inlineUnifiedDiff?: string;
  readonly inlineDiffLookup?: InlineDiffLookup;
  readonly inlineDiffChangedFiles?: ReadonlyArray<string>;
  readonly tableData?: MarkdownTableData;
  readonly highlightSpans?: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
    readonly className: string;
    readonly link?: {
      readonly kind: "url" | "file";
      readonly target: string;
    };
  }>;
  readonly userInputRef?: {
    readonly requestId: string;
    readonly questionIndex: number;
    readonly optionIndex?: number;
  };
  readonly animatedText?: {
    readonly kind: "loading";
    readonly from: number;
    readonly to: number;
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
  readonly startedAt?: string;
  readonly endedAt?: string;
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
  return statusClassForWorkItemStatus(item.status);
}

function statusClassForWorkItemStatus(status: WorkGroupItem["status"]) {
  switch (status) {
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

function standaloneExecutionGlyph(status: WorkGroupItem["status"]) {
  switch (status) {
    case "running":
      return "◐";
    case "done":
      return "✓";
    case "error":
    case "declined":
      return "✗";
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
  readonly label?: string;
}

export interface WaitingStateBlock {
  readonly type: "waiting-state";
  readonly startedAt: string;
  readonly now: string;
  readonly label?: string;
}

export interface SendingStateBlock {
  readonly type: "sending-state";
  readonly startedAt: string;
  readonly now: string;
  readonly label?: string;
}

export interface FinishedStateBlock {
  readonly type: "finished-state";
  readonly startedAt: string;
  readonly finishedAt: string;
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
  | WaitingStateBlock
  | WorkingStateBlock
  | FinishedStateBlock
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

function parseMarkdownTableDividerAlignments(
  line: string,
  expectedColumns: number,
): ReadonlyArray<MarkdownTableAlignment> | null {
  const cells = splitMarkdownTableRow(line);
  if (!cells || cells.length !== expectedColumns) {
    return null;
  }

  const alignments = cells.map((cell) => {
    const normalized = cell.replace(/\s+/g, "");
    if (!/^:?-{3,}:?$/.test(normalized)) {
      return null;
    }
    if (normalized.startsWith(":") && normalized.endsWith(":")) {
      return "center";
    }
    if (normalized.endsWith(":")) {
      return "right";
    }
    return "left";
  });
  return alignments.every((alignment) => alignment !== null)
    ? alignments
    : null;
}

function buildTableBorder(
  widths: ReadonlyArray<number>,
  left: string,
  middle: string,
  right: string,
) {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
}

function formatTableCell(
  cell: string,
  width: number,
  alignment: MarkdownTableAlignment,
) {
  if (alignment === "right") {
    return cell.padStart(width, " ");
  }
  if (alignment === "center") {
    const remaining = Math.max(0, width - cell.length);
    const leftPadding = Math.floor(remaining / 2);
    const rightPadding = remaining - leftPadding;
    return `${" ".repeat(leftPadding)}${cell}${" ".repeat(rightPadding)}`;
  }
  return cell.padEnd(width, " ");
}

function formatTableRow(
  cells: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
  alignments: ReadonlyArray<MarkdownTableAlignment>,
) {
  return `│ ${cells.map((cell, index) =>
    formatTableCell(cell, widths[index] ?? cell.length, alignments[index] ?? "left")).join(" │ ")} │`;
}

function tableBlockToLines(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  alignments: ReadonlyArray<MarkdownTableAlignment>,
): AnnotatedLine[] {
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
  const tableData: MarkdownTableData = {
    headers: header,
    rows: bodyRows,
    alignments,
  };
  const lines: AnnotatedLine[] = [
    {
      text: buildTableBorder(widths, "┌", "┬", "┐"),
      kind: "table",
      tableData,
    },
    { text: formatTableRow(header, widths, alignments), kind: "table" },
    { text: buildTableBorder(widths, "├", "┼", "┤"), kind: "table" },
  ];

  bodyRows.forEach((row, index) => {
    lines.push({ text: formatTableRow(row, widths, alignments), kind: "table" });
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

function isInlineMarkdownEscapableCharacter(char: string | undefined) {
  return char === "\\" || char === "`" || char === "*" || char === "[" || char === "]" || char === "(" || char === ")";
}

function findInlineMarkdownClosingMarker(
  text: string,
  start: number,
  marker: "`" | "*" | "**",
) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (marker === "**" ? text.startsWith("**", index) : text[index] === marker) {
      return index;
    }
  }
  return -1;
}

function findUnescapedCharacter(text: string, start: number, target: string) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\" && isInlineMarkdownEscapableCharacter(text[index + 1])) {
      index += 1;
      continue;
    }
    if (text[index] === target) {
      return index;
    }
  }
  return -1;
}

function decodeInlineMarkdownEscapes(text: string) {
  let decoded = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && isInlineMarkdownEscapableCharacter(text[index + 1])) {
      decoded += text[index + 1] ?? "";
      index += 1;
      continue;
    }
    decoded += char;
  }
  return decoded;
}

function trimAutoLinkedSuffix(text: string) {
  return text.replace(/[),.;:!?]+$/u, "");
}

const COMMON_RELATIVE_PATH_ROOTS = new Set([
  "app",
  "apps",
  "assets",
  "components",
  "docs",
  "lib",
  "package",
  "packages",
  "public",
  "script",
  "scripts",
  "src",
  "test",
  "tests",
]);

function isLikelyRelativeSlashPath(target: string) {
  if (!target.includes("/")) {
    return false;
  }

  const segments = target.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return false;
  }

  const firstSegment = segments[0]?.toLowerCase() ?? "";
  const lastSegment = segments.at(-1) ?? "";

  if (target.startsWith("/") || firstSegment === "." || firstSegment === "..") {
    return true;
  }

  if (lastSegment.includes(".")) {
    return true;
  }

  if (segments.length >= 3) {
    return true;
  }

  return COMMON_RELATIVE_PATH_ROOTS.has(firstSegment);
}

function isLikelyRelativeBackslashPath(target: string) {
  if (!target.includes("\\")) {
    return false;
  }

  const segments = target.split("\\").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return false;
  }

  const firstSegment = segments[0]?.toLowerCase() ?? "";
  const lastSegment = segments.at(-1) ?? "";

  if (firstSegment === "." || firstSegment === "..") {
    return true;
  }

  if (lastSegment.includes(".")) {
    return true;
  }

  if (segments.length >= 3) {
    return true;
  }

  return COMMON_RELATIVE_PATH_ROOTS.has(firstSegment);
}

function resolveInlineLinkTarget(target: string): { kind: "url" | "file"; target: string } | null {
  const trimmed = target.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { kind: "url", target: trimmed };
  }
  if (
    /^[A-Za-z]:[\\/]/.test(trimmed)
    || trimmed.startsWith("\\\\")
    || /^\.{1,2}[\\/]/.test(trimmed)
    || isLikelyRelativeBackslashPath(trimmed)
    || isLikelyRelativeSlashPath(trimmed)
  ) {
    return { kind: "file", target: trimmed };
  }
  return null;
}

function detectAutoLinkSpans(text: string): Array<{
  from: number;
  to: number;
  className: string;
  link: {
    kind: "url" | "file";
    target: string;
  };
}> {
  const spans: Array<{
    from: number;
    to: number;
    className: string;
    link: {
      kind: "url" | "file";
      target: string;
    };
  }> = [];
  const addSpan = (
    from: number,
    rawText: string,
    link: {
      kind: "url" | "file";
      target: string;
    },
  ) => {
    const trimmedText = trimAutoLinkedSuffix(rawText);
    if (trimmedText.length === 0) {
      return;
    }
    spans.push({
      from,
      to: from + trimmedText.length,
      className: link.kind === "url" ? "tok-markdownLink tok-linkUrl" : "tok-markdownLink tok-linkFile",
      link: {
        kind: link.kind,
        target: trimmedText,
      },
    });
  };

  const urlPattern = /https?:\/\/[^\s<>()]+/g;
  for (const match of text.matchAll(urlPattern)) {
    const rawText = match[0];
    const index = match.index;
    if (typeof rawText !== "string" || index === undefined) {
      continue;
    }
    addSpan(index, rawText, { kind: "url", target: rawText });
  }

  const absoluteFilePattern =
    /(?:[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+\.[A-Za-z0-9]{1,12}|\\\\(?:[^\\/:*?"<>|\r\n]+\\)+[^\\/:*?"<>|\r\n]+\.[A-Za-z0-9]{1,12})/g;
  for (const match of text.matchAll(absoluteFilePattern)) {
    const rawText = match[0];
    const index = match.index;
    if (typeof rawText !== "string" || index === undefined) {
      continue;
    }
    const trimmedText = rawText.trimEnd();
    const link = resolveInlineLinkTarget(trimmedText);
    if (!link || link.kind !== "file") {
      continue;
    }
    addSpan(index, trimmedText, link);
  }

  const relativeFilePattern = /(?:\.{1,2}[\\/]|(?:[^\\/\s]+[\\/])+)[^\s<>()]+/g;
  for (const match of text.matchAll(relativeFilePattern)) {
    const rawText = match[0];
    const index = match.index;
    if (typeof rawText !== "string" || index === undefined) {
      continue;
    }
    const link = resolveInlineLinkTarget(rawText);
    if (!link || link.kind !== "file") {
      continue;
    }
    addSpan(index, rawText, link);
  }

  return spans;
}

function spansOverlap(
  left: Pick<NonNullable<AnnotatedLine["highlightSpans"]>[number], "from" | "to">,
  right: Pick<NonNullable<AnnotatedLine["highlightSpans"]>[number], "from" | "to">,
) {
  return left.from < right.to && right.from < left.to;
}

function offsetInlineHighlightSpan(
  span: NonNullable<AnnotatedLine["highlightSpans"]>[number],
  offset: number,
): {
  from: number;
  to: number;
  className: string;
  link?: {
    kind: "url" | "file";
    target: string;
  };
} {
  return span.link
    ? {
        from: span.from + offset,
        to: span.to + offset,
        className: span.className,
        link: span.link,
      }
    : {
        from: span.from + offset,
        to: span.to + offset,
        className: span.className,
      };
}

export function renderInlineMarkdown(text: string): Pick<AnnotatedLine, "text" | "highlightSpans"> {
  const highlightSpans: Array<{
    from: number;
    to: number;
    className: string;
    link?: {
      kind: "url" | "file";
      target: string;
    };
  }> = [];
  let rendered = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (char === "\\" && isInlineMarkdownEscapableCharacter(text[index + 1])) {
      rendered += text[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (char === "[") {
      const labelEnd = findUnescapedCharacter(text, index + 1, "]");
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const targetEnd = findUnescapedCharacter(text, labelEnd + 2, ")");
        if (targetEnd !== -1 && targetEnd > labelEnd + 2) {
          const link = resolveInlineLinkTarget(text.slice(labelEnd + 2, targetEnd));
          if (link) {
            const label = renderInlineMarkdown(text.slice(index + 1, labelEnd));
            const from = rendered.length;
            rendered += label.text;
            if (label.highlightSpans) {
              highlightSpans.push(
                ...label.highlightSpans.map((span) => offsetInlineHighlightSpan(span, from)),
              );
            }
            highlightSpans.push({
              from,
              to: rendered.length,
              className: link.kind === "url" ? "tok-markdownLink tok-linkUrl" : "tok-markdownLink tok-linkFile",
              link,
            });
            index = targetEnd;
            continue;
          }
        }
      }
    }

    if (char === "`") {
      const closingIndex = findInlineMarkdownClosingMarker(text, index + 1, "`");
      if (closingIndex > index + 1) {
        const inlineCode = text.slice(index + 1, closingIndex);
        const inlineCodeLink = resolveInlineLinkTarget(inlineCode.trim());
        const from = rendered.length;
        rendered += inlineCode;
        highlightSpans.push({
          from,
          to: rendered.length,
          className: inlineCodeLink
            ? `tok-inlineCode ${inlineCodeLink.kind === "url" ? "tok-markdownLink tok-linkUrl" : "tok-markdownLink tok-linkFile"}`
            : "tok-inlineCode",
          ...(inlineCodeLink ? { link: inlineCodeLink } : {}),
        });
        index = closingIndex;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const closingIndex = findInlineMarkdownClosingMarker(text, index + 2, "**");
      if (closingIndex > index + 2) {
        const strongText = decodeInlineMarkdownEscapes(text.slice(index + 2, closingIndex));
        const from = rendered.length;
        rendered += strongText;
        highlightSpans.push({
          from,
          to: rendered.length,
          className: "tok-markdownStrong",
        });
        index = closingIndex + 1;
        continue;
      }
    }

    if (char === "*") {
      const closingIndex = findInlineMarkdownClosingMarker(text, index + 1, "*");
      if (closingIndex > index + 1) {
        const emphasisText = decodeInlineMarkdownEscapes(text.slice(index + 1, closingIndex));
        const from = rendered.length;
        rendered += emphasisText;
        highlightSpans.push({
          from,
          to: rendered.length,
          className: "tok-markdownEmphasis",
        });
        index = closingIndex;
        continue;
      }
    }

    rendered += char;
  }

  highlightSpans.push(
    ...detectAutoLinkSpans(rendered).filter((candidate) =>
      !highlightSpans.some((existing) => spansOverlap(existing, candidate))),
  );

  return {
    text: rendered,
    ...(highlightSpans.length > 0 ? { highlightSpans } : {}),
  };
}

function renderMarkdownTextLine(
  content: string,
  kind: LineKind,
  options: {
    prefix?: string;
    extraClasses?: ReadonlyArray<string>;
  } = {},
): AnnotatedLine {
  const rendered = renderInlineMarkdown(content);
  const prefix = options.prefix ?? "";
  return {
    text: `${prefix}${rendered.text}`,
    kind,
    ...(options.extraClasses && options.extraClasses.length > 0 ? { extraClasses: [...options.extraClasses] } : {}),
    ...(rendered.highlightSpans && rendered.highlightSpans.length > 0
      ? {
          highlightSpans: rendered.highlightSpans.map((span) => offsetInlineHighlightSpan(span, prefix.length)),
        }
      : {}),
  };
}

function renderMarkdownLine(line: string, fallbackKind: LineKind): AnnotatedLine {
  const headingMatch = line.match(/^(\s{0,3})(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    const [, indent = "", hashes = "#", content = ""] = headingMatch;
    const level = Math.min(3, hashes.length);
    return renderMarkdownTextLine(content, fallbackKind, {
      prefix: indent,
      extraClasses: ["cm-line-markdownHeading", `cm-line-markdownHeading${level}`],
    });
  }

  const unorderedListMatch = line.match(/^(\s*)[-+*]\s+(.*)$/);
  if (unorderedListMatch) {
    const [, indent = "", content = ""] = unorderedListMatch;
    return renderMarkdownTextLine(content, "list", { prefix: `${indent}• ` });
  }

  const orderedListMatch = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
  if (orderedListMatch) {
    const [, indent = "", ordinal = "1", content = ""] = orderedListMatch;
    return renderMarkdownTextLine(content, "list", { prefix: `${indent}${ordinal}. ` });
  }

  const blockquoteMatch = line.match(/^(\s*)((?:>\s*)+)(.*)$/);
  if (blockquoteMatch) {
    const [, indent = "", quotePrefix = "", content = ""] = blockquoteMatch;
    const depth = (quotePrefix.match(/>/g) ?? []).length;
    return renderMarkdownTextLine(content, "blockquote", {
      prefix: `${indent}${"│ ".repeat(Math.max(1, depth))}`,
    });
  }

  return renderMarkdownTextLine(line, fallbackKind);
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
    const dividerAlignments = parseMarkdownTableDividerAlignments(
      sourceLines[index + 1] ?? "",
      headerCells?.length ?? 0,
    );
    if (
      headerCells
      && index + 1 < sourceLines.length
      && dividerAlignments
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

      rendered.push(...tableBlockToLines(rows, dividerAlignments));
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
  const attachmentLines: AnnotatedLine[] =
    (options.attachmentCount ?? 0) > 0
      ? [{ text: "", kind: "attachmentPanel" as const }]
      : [];
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

function workItemTimingLabel(item: WorkGroupItem) {
  if (item.status === "running" || !item.startedAt || !item.endedAt) {
    return undefined;
  }

  const startedAtMs = Date.parse(item.startedAt);
  const endedAtMs = Date.parse(item.endedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return undefined;
  }

  const elapsedMs = endedAtMs - startedAtMs;
  if (elapsedMs < 3_000) {
    return undefined;
  }

  return formatElapsedCompactDuration(elapsedMs);
}

function commandWidgetGlyph(item: WorkGroupItem, _now?: string) {
  switch (item.status) {
    case "running":
      return "○";
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

function humanizeExecutionLabel(label: string) {
  const normalized = label.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return "Tool";
  }
  if (!/[A-Z]/.test(normalized)) {
    return normalized.replace(/\b\w/g, (segment) => segment.toUpperCase());
  }
  return normalized;
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

function executionWidgetPrefix(item: WorkGroupItem) {
  if (item.kind === "command") {
    return commandWidgetPrefix(item);
  }
  if (item.kind === "file-change") {
    return fileActivityWidgetPrefix(item);
  }
  if (isReadFileItem(item)) {
    return fileActivityWidgetPrefix(item);
  }
  return humanizeExecutionLabel(item.label);
}

function executionWidgetSubject(item: WorkGroupItem) {
  if (item.kind === "command") {
    return item.command ?? item.detail ?? item.label;
  }
  if (item.kind === "file-change") {
    return fileActivitySubject(item);
  }
  if (isReadFileItem(item)) {
    return fileActivitySubject(item);
  }
  const detail = item.detail ?? "";
  if (!detail.includes("\n")) {
    return detail;
  }
  const firstLine = detail.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > 0 ? `${firstLine}...` : "...";
}

function executionWidgetOutputLines(item: WorkGroupItem) {
  const lines: string[] = [];

  if (item.kind === "tool" && item.detail && item.detail.includes("\n") && !item.output) {
    lines.push(...item.detail.split(/\r?\n/));
  }

  if (item.output) {
    lines.push(...item.output.split(/\r?\n/));
  }

  if (item.changedFiles && item.changedFiles.length > 0 && item.kind !== "file-change") {
    const [firstPath, ...restPaths] = item.changedFiles;
    if (firstPath) {
      lines.push(`changed: ${firstPath}`);
    }
    lines.push(...restPaths);
  }

  return lines.filter((line) => line.length > 0);
}

function executionWorkGroupLine(
  item: WorkGroupItem,
  options: {
    signature: string;
    timingLabel?: string;
    now?: string;
  },
): AnnotatedLine {
  if (item.kind === "file-change") {
    return fileActivityWorkGroupLine(item, options);
  }

  const glyph = commandWidgetGlyph(item, options.now);
  const prefix = executionWidgetPrefix(item);
  const subject = executionWidgetSubject(item);
  const exitLabel = item.kind === "command" && item.exitCode !== undefined ? ` [exit ${item.exitCode}]` : "";
  const summarySuffix = subject.length > 0 || exitLabel.length > 0 ? `  ${subject}${exitLabel}` : "  ";
  const timingSuffix = options.timingLabel ? `  ${options.timingLabel}` : "";
  const text = `${glyph} ${prefix}${summarySuffix}${timingSuffix}`;
  const outputLines = executionWidgetOutputLines(item);
  const prefixStart = glyph.length + 1;
  const exitStart = prefixStart + prefix.length + 2 + subject.length;
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
  ];

  return {
    text,
    kind: "commandExec",
    extraClasses: [workItemStatusClass(item), "cm-line-commandWidget"],
    commandWidgetSignature: options.signature,
    ...(options.timingLabel ? { timingLabel: options.timingLabel } : {}),
    ...(outputLines.length > 0
      ? { commandWidgetOutputLines: outputLines }
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
  ];

  return {
    text,
    kind: "commandExec",
    extraClasses: [workItemStatusClass(item), "cm-line-commandWidget"],
    commandWidgetSignature: options.signature,
    ...(options.timingLabel ? { timingLabel: options.timingLabel } : {}),
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

function executionWorkGroupToLines(block: WorkGroupBlock): AnnotatedLine[] {
  return [
    ...block.items.flatMap((item, index) => {
      const timingLabel = workItemTimingLabel(item);
      return [
        executionWorkGroupLine(item, {
          signature:
            `${block.startedAt}:${index}:${item.kind}:`
            + `${item.command ?? item.detail ?? item.changedFiles?.join("|") ?? item.label}`,
          ...(timingLabel ? { timingLabel } : {}),
          ...(block.now ? { now: block.now } : {}),
        }),
      ];
    }),
    { text: "", kind: "workGroupSeparator" },
  ];
}

function fileActivityWorkGroupToLines(block: WorkGroupBlock): AnnotatedLine[] {
  return [
    ...block.items.flatMap((item, index) => {
      const timingLabel = workItemTimingLabel(item);
      const lines: AnnotatedLine[] = [
        fileActivityWorkGroupLine(item, {
          signature: `${block.startedAt}:${index}:${item.detail ?? item.changedFiles?.join("|") ?? item.label}`,
          ...(timingLabel ? { timingLabel } : {}),
          ...(block.now ? { now: block.now } : {}),
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

function formatUserInputQuestionLine(header: string, question: string) {
  return header.trim().toLowerCase() === "question" ? question : `${header}: ${question}`;
}

function formatUserInputOptionLine(
  optionIndex: number,
  label: string,
  description: string,
) {
  const normalizedLabel = label.trim().toLowerCase();
  const normalizedDescription = description.trim().toLowerCase();
  const detail = normalizedLabel === normalizedDescription ? label : `${label}: ${description}`;
  return `      ${optionIndex + 1}  ${detail}`;
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
      const glyph = standaloneExecutionGlyph(block.status);
      const prefix = humanizeExecutionLabel(block.label);
      const subject = block.detail ?? "";
      const text = `${glyph} ${prefix}${subject.length > 0 ? `  ${subject}` : "  "}`;
      const prefixStart = glyph.length + 1;
      return [{
        text,
        kind: "commandExec",
        extraClasses: [statusClassForWorkItemStatus(block.status), "cm-line-commandWidget"],
        commandWidgetSignature: `tool-call:${block.status}:${block.label}:${block.detail ?? ""}`,
        highlightSpans: [
          { from: 0, to: glyph.length, className: "tok-commandWidgetGlyph" },
          { from: prefixStart, to: prefixStart + prefix.length, className: "tok-commandWidgetPrefix" },
        ],
      }];
    }

    case "tool-result":
      return [
        ...(block.summary.length > 0 && (block.summary !== "Output" || !block.output)
          ? [{ text: `  ${block.summary}`, kind: "commandOutput" as const }]
          : []),
        ...(block.output ? prefixWrappedLines(block.output, "commandOutput", "  ") : []),
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
      if (block.items.every((item) => item.kind === "file-change")) {
        return fileActivityWorkGroupToLines(block);
      }

      return executionWorkGroupToLines(block);
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
      const lines: AnnotatedLine[] = [];
      block.questions.forEach((question, questionIndex) => {
        const answer = question.id ? block.answers?.[question.id] : undefined;
        lines.push({
          text: `    ${formatUserInputQuestionLine(question.header, question.question)}`,
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
              text: formatUserInputOptionLine(optionIndex, option.label, option.description),
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
    case "waiting-state":
    case "working-state": {
      const elapsedLabel = formatElapsedDuration(Date.parse(block.now) - Date.parse(block.startedAt));
      const prefix = block.label
        ? `${block.label} for `
        : block.type === "sending-state"
          ? "Sending prompt for "
          : block.type === "waiting-state"
            ? "Waiting for agent for "
          : "Working for ";
      const text = `${prefix}${elapsedLabel}`;
      return [
        { text: "", kind: "meta" },
        {
          text,
          kind: "workingLine",
          animatedText: { kind: "loading", from: 0, to: prefix.length },
        },
      ];
    }

    case "finished-state": {
      const elapsedLabel = formatElapsedDuration(Date.parse(block.finishedAt) - Date.parse(block.startedAt));
      return [
        { text: "", kind: "meta" },
        {
          text: `Finished in ${elapsedLabel}`,
          kind: "workingLine",
        },
      ];
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
