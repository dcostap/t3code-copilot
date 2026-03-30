export type TranscriptMarkdownTableAlignment = "left" | "center" | "right";

export interface TranscriptMarkdownTable {
  readonly headers: ReadonlyArray<string>;
  readonly alignments: ReadonlyArray<TranscriptMarkdownTableAlignment>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

export type TranscriptMessageBlock =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "table";
      readonly table: TranscriptMarkdownTable;
    };

export type TranscriptLinkToken =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "link";
      readonly text: string;
      readonly href: string;
      readonly linkKind: "url" | "file";
    };

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BARE_URL_PATTERN = /https?:\/\/[^\s<>()]+/g;

export function parseTranscriptMessageBlocks(text: string): ReadonlyArray<TranscriptMessageBlock> {
  const lines = text.split(/\r?\n/);
  const blocks: Array<TranscriptMessageBlock> = [];
  let textBuffer: Array<string> = [];

  const flushTextBuffer = () => {
    if (textBuffer.length === 0) {
      return;
    }
    blocks.push({
      kind: "text",
      text: textBuffer.join("\n"),
    });
    textBuffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = lines[index] ?? "";
    const separatorLine = lines[index + 1] ?? "";
    if (isMarkdownTableHeaderLine(headerLine) && isMarkdownTableSeparatorLine(separatorLine)) {
      flushTextBuffer();
      const tableLines = [headerLine, separatorLine];
      let cursor = index + 2;
      while (cursor < lines.length && isMarkdownTableBodyLine(lines[cursor] ?? "")) {
        tableLines.push(lines[cursor] ?? "");
        cursor += 1;
      }
      const parsedTable = parseMarkdownTable(tableLines);
      if (parsedTable) {
        blocks.push({
          kind: "table",
          table: parsedTable,
        });
        index = cursor - 1;
        continue;
      }
    }
    textBuffer.push(headerLine);
  }

  flushTextBuffer();
  return blocks.length > 0 ? blocks : [{ kind: "text", text }];
}

export function tokenizeTranscriptLinks(text: string): ReadonlyArray<TranscriptLinkToken> {
  const matches: Array<{ readonly from: number; readonly to: number; readonly text: string; readonly href: string; readonly linkKind: "url" | "file" }> = [];

  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const raw = match[0];
    const label = match[1];
    const href = match[2];
    const index = match.index ?? -1;
    if (index < 0 || !raw || !label || !href) {
      continue;
    }
    matches.push({
      from: index,
      to: index + raw.length,
      text: label,
      href,
      linkKind: classifyLink(href),
    });
  }

  for (const match of text.matchAll(BARE_URL_PATTERN)) {
    const href = match[0];
    const index = match.index ?? -1;
    if (index < 0 || !href) {
      continue;
    }
    const overlapsExisting = matches.some((existing) => index < existing.to && index + href.length > existing.from);
    if (overlapsExisting) {
      continue;
    }
    matches.push({
      from: index,
      to: index + href.length,
      text: href,
      href,
      linkKind: "url",
    });
  }

  matches.sort((left, right) => left.from - right.from || left.to - right.to);

  const tokens: Array<TranscriptLinkToken> = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.from > cursor) {
      tokens.push({
        kind: "text",
        text: text.slice(cursor, match.from),
      });
    }
    tokens.push({
      kind: "link",
      text: match.text,
      href: match.href,
      linkKind: match.linkKind,
    });
    cursor = match.to;
  }
  if (cursor < text.length) {
    tokens.push({
      kind: "text",
      text: text.slice(cursor),
    });
  }
  return tokens.length > 0 ? tokens : [{ kind: "text", text }];
}

function classifyLink(href: string): "url" | "file" {
  return /^https?:\/\//i.test(href) ? "url" : "file";
}

function isMarkdownTableHeaderLine(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && splitMarkdownTableCells(trimmed).length > 1;
}

function isMarkdownTableBodyLine(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isMarkdownTableSeparatorLine(line: string) {
  const trimmed = line.trim();
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(trimmed);
}

function parseMarkdownTable(lines: ReadonlyArray<string>): TranscriptMarkdownTable | null {
  if (lines.length < 2) {
    return null;
  }
  const headers = splitMarkdownTableCells(lines[0] ?? "");
  const alignmentCells = splitMarkdownTableCells(lines[1] ?? "");
  if (headers.length === 0 || headers.length !== alignmentCells.length) {
    return null;
  }

  const rows = lines.slice(2).map((line) => splitMarkdownTableCells(line));
  return {
    headers,
    alignments: alignmentCells.map(parseAlignment),
    rows: rows.map((row) => normalizeRowCellCount(row, headers.length)),
  };
}

function normalizeRowCellCount(row: ReadonlyArray<string>, cellCount: number) {
  if (row.length === cellCount) {
    return row;
  }
  if (row.length > cellCount) {
    return row.slice(0, cellCount);
  }
  return [...row, ...Array.from({ length: cellCount - row.length }, () => "")];
}

function parseAlignment(cell: string): TranscriptMarkdownTableAlignment {
  const trimmed = cell.trim();
  const startsAligned = trimmed.startsWith(":");
  const endsAligned = trimmed.endsWith(":");
  if (startsAligned && endsAligned) {
    return "center";
  }
  if (endsAligned) {
    return "right";
  }
  return "left";
}

function splitMarkdownTableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
