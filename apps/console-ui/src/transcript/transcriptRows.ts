import type { AnnotatedLine } from "./TranscriptBlock";

export interface TranscriptBlockRowDefinition {
  readonly kind: "table" | "divider" | "spacer" | "commandWidget" | "line";
  readonly key: string;
  readonly lineIndexStart: number;
  readonly lineIndexEnd: number;
}

function summarizeText(text: string) {
  return `${text.length}:${text.slice(0, 40)}:${text.slice(-20)}`;
}

export function getTranscriptLineIdentity(line: AnnotatedLine) {
  if (line.commandWidgetSignature) {
    return `command:${line.commandWidgetSignature}`;
  }
  if (line.userInputRef) {
    return `input:${line.userInputRef.requestId}:${line.userInputRef.questionIndex}:${line.userInputRef.optionIndex ?? -1}`;
  }
  return [
    line.kind,
    summarizeText(line.text),
    line.timingLabel ?? "",
    line.extraClasses?.join("|") ?? "",
  ].join(":");
}

function isSpacerLine(line: AnnotatedLine) {
  return line.kind === "meta" || line.kind.endsWith("Separator");
}

function isCommandWidgetLine(line: AnnotatedLine) {
  return line.kind === "commandExec" && typeof line.commandWidgetSignature === "string";
}

export function deriveTranscriptBlockRowDefinitions(
  lines: ReadonlyArray<AnnotatedLine>,
): ReadonlyArray<TranscriptBlockRowDefinition> {
  const lineOccurrences = new Map<string, number>();
  const rows: TranscriptBlockRowDefinition[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const lineIdentity = getTranscriptLineIdentity(line);
    const lineOccurrence = lineOccurrences.get(lineIdentity) ?? 0;
    lineOccurrences.set(lineIdentity, lineOccurrence + 1);
    const lineKey = `${lineIdentity}:${lineOccurrence}`;

    if (line.kind === "table" && line.tableData) {
      let tableLineIndexEnd = lineIndex;
      while (tableLineIndexEnd + 1 < lines.length && lines[tableLineIndexEnd + 1]?.kind === "table") {
        tableLineIndexEnd += 1;
      }
      rows.push({
        kind: "table",
        key: lineKey,
        lineIndexStart: lineIndex,
        lineIndexEnd: tableLineIndexEnd,
      });
      lineIndex = tableLineIndexEnd;
      continue;
    }

    if (line.kind === "divider") {
      rows.push({
        kind: "divider",
        key: lineKey,
        lineIndexStart: lineIndex,
        lineIndexEnd: lineIndex,
      });
      continue;
    }

    if (isSpacerLine(line)) {
      rows.push({
        kind: "spacer",
        key: lineKey,
        lineIndexStart: lineIndex,
        lineIndexEnd: lineIndex,
      });
      continue;
    }

    if (isCommandWidgetLine(line)) {
      rows.push({
        kind: "commandWidget",
        key: lineKey,
        lineIndexStart: lineIndex,
        lineIndexEnd: lineIndex,
      });
      continue;
    }

    rows.push({
      kind: "line",
      key: lineKey,
      lineIndexStart: lineIndex,
      lineIndexEnd: lineIndex,
    });
  }

  return rows;
}
