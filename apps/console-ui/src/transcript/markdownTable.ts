import {
  renderInlineMarkdown,
  type AnnotatedLine,
  type MarkdownTableAlignment,
  type MarkdownTableData,
} from "./TranscriptBlock";

export interface MarkdownTableDisplayCell {
  readonly text: string;
  readonly highlightSpans?: NonNullable<AnnotatedLine["highlightSpans"]>;
}

export interface MarkdownTableDisplayLine {
  readonly kind: "border" | "header" | "body";
  readonly text: string;
  readonly cells?: ReadonlyArray<MarkdownTableDisplayCell>;
}

function measureMarkdownTableTextWidth(text: string) {
  return Array.from(text).length;
}

function measureMarkdownTableTextWidthInRange(text: string, start: number, end: number) {
  let width = 0;
  for (let index = start; index < end;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    width += 1;
    index += codePoint > 0xFFFF ? 2 : 1;
  }
  return width;
}

function advanceMarkdownTableIndexByWidth(text: string, start: number, width: number) {
  if (width <= 0) {
    return start;
  }
  let index = start;
  let consumed = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined || consumed >= width) {
      break;
    }
    consumed += 1;
    index += codePoint > 0xFFFF ? 2 : 1;
  }
  return index;
}

function padMarkdownTableCell(
  text: string,
  width: number,
  alignment: MarkdownTableAlignment,
) {
  const visibleWidth = measureMarkdownTableTextWidth(text);
  const remaining = Math.max(0, width - visibleWidth);
  const leftPadding = alignment === "right"
    ? remaining
    : alignment === "center"
      ? Math.floor(remaining / 2)
      : 0;
  const rightPadding = remaining - leftPadding;
  return {
    text: `${" ".repeat(leftPadding)}${text}${" ".repeat(rightPadding)}`,
    leftPadding,
  };
}

function projectMarkdownTableHighlightSpans(
  spans: NonNullable<AnnotatedLine["highlightSpans"]> | undefined,
  start: number,
  end: number,
  offset: number,
) {
  if (!spans || spans.length === 0) {
    return undefined;
  }
  const projected = spans.flatMap((span) => {
    if (span.to <= start || span.from >= end) {
      return [];
    }
    return [{
      ...span,
      from: Math.max(start, span.from) - start + offset,
      to: Math.min(end, span.to) - start + offset,
    }];
  });
  return projected.length > 0 ? projected : undefined;
}

function wrapMarkdownTableCell(
  renderedCell: Pick<AnnotatedLine, "text" | "highlightSpans">,
  width: number,
) {
  if (width <= 0) {
    return [{
      text: renderedCell.text,
      ...(renderedCell.highlightSpans ? { highlightSpans: renderedCell.highlightSpans } : {}),
    }];
  }

  const wrappedLines: Array<MarkdownTableDisplayCell> = [];
  const paragraphStarts = [0];
  for (let index = 0; index < renderedCell.text.length; index += 1) {
    if (renderedCell.text[index] === "\n") {
      paragraphStarts.push(index + 1);
    }
  }

  paragraphStarts.forEach((paragraphStart, paragraphIndex) => {
    const paragraphEnd = paragraphIndex + 1 < paragraphStarts.length
      ? (paragraphStarts[paragraphIndex + 1] ?? renderedCell.text.length) - 1
      : renderedCell.text.length;
    if (paragraphStart > paragraphEnd) {
      wrappedLines.push({ text: "" });
      return;
    }

    let cursor = paragraphStart;
    while (cursor < paragraphEnd) {
      const normalizedStart = renderedCell.text.slice(cursor, paragraphEnd).search(/\S/);
      if (normalizedStart === -1) {
        break;
      }
      cursor += normalizedStart;
      if (measureMarkdownTableTextWidthInRange(renderedCell.text, cursor, paragraphEnd) <= width) {
        const text = renderedCell.text.slice(cursor, paragraphEnd);
        const highlightSpans = projectMarkdownTableHighlightSpans(renderedCell.highlightSpans, cursor, paragraphEnd, 0);
        wrappedLines.push({
          text,
          ...(highlightSpans ? { highlightSpans } : {}),
        });
        break;
      }

      const candidateEnd = advanceMarkdownTableIndexByWidth(renderedCell.text, cursor, width + 1);
      const hardEnd = advanceMarkdownTableIndexByWidth(renderedCell.text, cursor, width);
      const candidateText = renderedCell.text.slice(cursor, candidateEnd);
      const lastSpaceIndex = candidateText.lastIndexOf(" ");
      const lineEnd = lastSpaceIndex > 0 ? cursor + lastSpaceIndex : hardEnd;
      const trimmedEnd = renderedCell.text.slice(cursor, lineEnd).trimEnd().length + cursor;
      const safeEnd = Math.max(cursor, trimmedEnd);
      const highlightSpans = projectMarkdownTableHighlightSpans(renderedCell.highlightSpans, cursor, safeEnd, 0);
      wrappedLines.push({
        text: renderedCell.text.slice(cursor, safeEnd),
        ...(highlightSpans ? { highlightSpans } : {}),
      });
      cursor = lastSpaceIndex > 0 ? lineEnd + 1 : hardEnd;
    }

    if (cursor >= paragraphEnd && paragraphEnd === paragraphStart) {
      wrappedLines.push({ text: "" });
    }
  });

  return wrappedLines.length > 0 ? wrappedLines : [{ text: "" }];
}

function padMarkdownTableDisplayCell(
  cell: MarkdownTableDisplayCell,
  width: number,
  alignment: MarkdownTableAlignment,
) {
  const padded = padMarkdownTableCell(cell.text, width, alignment);
  return {
    text: padded.text,
    ...(cell.highlightSpans
      ? {
          highlightSpans: cell.highlightSpans.map((span) => ({
            ...span,
            from: span.from + padded.leftPadding,
            to: span.to + padded.leftPadding,
          })),
        }
      : {}),
  } satisfies MarkdownTableDisplayCell;
}

function buildMarkdownTableCellText(cell: MarkdownTableDisplayCell) {
  return cell.text;
}

function buildMarkdownTableRowText(cells: ReadonlyArray<MarkdownTableDisplayCell>) {
  return `│ ${cells.map((cell) => buildMarkdownTableCellText(cell)).join(" │ ")} │`;
}

function wrapMarkdownTableSourceCell(text: string, width: number) {
  const renderedCell = renderInlineMarkdown(text);
  return wrapMarkdownTableCell(renderedCell, width);
}

function shrinkMarkdownTableWidths(
  widths: number[],
  minWidths: ReadonlyArray<number>,
  maxWidth: number,
) {
  const next = [...widths];
  while (next.reduce((total, width) => total + width, 0) > maxWidth) {
    let candidateIndex = -1;
    let candidateSlack = -1;
    next.forEach((width, index) => {
      const slack = width - (minWidths[index] ?? width);
      if (slack > candidateSlack) {
        candidateSlack = slack;
        candidateIndex = index;
      }
    });
    if (candidateIndex < 0 || candidateSlack <= 0) {
      break;
    }
    const nextWidth = next[candidateIndex];
    if (nextWidth === undefined) {
      break;
    }
    next[candidateIndex] = nextWidth - 1;
  }
  return next;
}

function buildMarkdownTableBorder(
  widths: ReadonlyArray<number>,
  left: string,
  middle: string,
  right: string,
): MarkdownTableDisplayLine {
  return {
    kind: "border",
    text: `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`,
  };
}

function buildMarkdownTableRowLines(input: {
  readonly cells: ReadonlyArray<string>;
  readonly widths: ReadonlyArray<number>;
  readonly alignments: ReadonlyArray<MarkdownTableAlignment>;
  readonly kind: "header" | "body";
}) {
  const wrappedCells = input.cells.map((cell, index) =>
    wrapMarkdownTableSourceCell(cell, input.widths[index] ?? measureMarkdownTableTextWidth(cell)));
  const rowHeight = Math.max(...wrappedCells.map((lines) => lines.length), 1);

  return Array.from({ length: rowHeight }, (_, lineIndex) => {
    const cells = wrappedCells.map((lines, columnIndex) =>
      padMarkdownTableDisplayCell(
        lines[lineIndex] ?? { text: "" },
        input.widths[columnIndex] ?? 0,
        input.alignments[columnIndex] ?? "left",
      ));
    return {
      kind: input.kind,
      text: buildMarkdownTableRowText(cells),
      cells,
    } satisfies MarkdownTableDisplayLine;
  });
}

export function resolveMarkdownTableDisplayWidth(availableWidthPx: number, characterWidthPx = 7.8) {
  return Math.max(24, Math.floor(Math.max(availableWidthPx, 320) / Math.max(characterWidthPx, 6)) - 1);
}

export function layoutMarkdownTable(
  table: MarkdownTableData,
  maxTotalWidth: number,
): ReadonlyArray<MarkdownTableDisplayLine> {
  const columnCount = table.headers.length;
  if (columnCount === 0) {
    return [];
  }

  const borderWidth = (columnCount * 3) + 1;
  const availableContentWidth = Math.max(columnCount * 3, maxTotalWidth - borderWidth);
  const naturalWidths = table.headers.map((header, columnIndex) =>
    Math.max(
      measureMarkdownTableTextWidth(header),
      ...table.rows.map((row) => measureMarkdownTableTextWidth(row[columnIndex] ?? "")),
    ));
  const minWidths = naturalWidths.map((width) => Math.max(3, Math.min(width, 8)));
  const widths = naturalWidths.reduce((total, width) => total + width, 0) > availableContentWidth
    ? shrinkMarkdownTableWidths(naturalWidths, minWidths, availableContentWidth)
    : naturalWidths;

  const lines: MarkdownTableDisplayLine[] = [
    buildMarkdownTableBorder(widths, "┌", "┬", "┐"),
    ...buildMarkdownTableRowLines({
      cells: table.headers,
      widths,
      alignments: table.alignments,
      kind: "header",
    }),
    buildMarkdownTableBorder(widths, "├", "┼", "┤"),
  ];

  table.rows.forEach((row, index) => {
    lines.push(...buildMarkdownTableRowLines({
      cells: row,
      widths,
      alignments: table.alignments,
      kind: "body",
    }));
    lines.push(buildMarkdownTableBorder(
      widths,
      index === table.rows.length - 1 ? "└" : "├",
      index === table.rows.length - 1 ? "┴" : "┼",
      index === table.rows.length - 1 ? "┘" : "┤",
    ));
  });

  if (table.rows.length === 0) {
    lines.push(buildMarkdownTableBorder(widths, "└", "┴", "┘"));
  }

  return lines;
}
