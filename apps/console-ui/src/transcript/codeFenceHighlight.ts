import type { Parser } from "@lezer/common";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from "@codemirror/lang-javascript";
import { pythonLanguage } from "@codemirror/lang-python";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";

export interface CodeHighlightSpan {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

const shellLanguage = StreamLanguage.define(shell);

const LANGUAGE_PARSERS: Readonly<Record<string, Parser>> = {
  bash: shellLanguage.parser,
  css: cssLanguage.parser,
  html: htmlLanguage.parser,
  javascript: javascriptLanguage.parser,
  js: javascriptLanguage.parser,
  jsx: jsxLanguage.parser,
  python: pythonLanguage.parser,
  py: pythonLanguage.parser,
  sh: shellLanguage.parser,
  shell: shellLanguage.parser,
  ts: typescriptLanguage.parser,
  tsx: tsxLanguage.parser,
  typescript: typescriptLanguage.parser,
};

function resolveParser(language: string) {
  const normalized = language.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  return LANGUAGE_PARSERS[normalized] ?? null;
}

function findLineIndexForOffset(lineStarts: ReadonlyArray<number>, offset: number) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = low + ((high - low) >> 1);
    const lineStart = lineStarts[mid] ?? 0;
    const nextLineStart = mid + 1 < lineStarts.length ? (lineStarts[mid + 1] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;

    if (offset < lineStart) {
      high = mid - 1;
      continue;
    }
    if (offset >= nextLineStart) {
      low = mid + 1;
      continue;
    }
    return mid;
  }

  return Math.max(0, Math.min(lineStarts.length - 1, low));
}

export function highlightCodeFence(
  language: string,
  lines: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<CodeHighlightSpan>> {
  const parser = resolveParser(language);
  if (!parser || lines.length === 0) {
    return lines.map(() => []);
  }

  const code = lines.join("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const spans = lines.map(() => [] as CodeHighlightSpan[]);
  const tree = parser.parse(code);
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (!classes) {
      return;
    }

    const startLineIndex = findLineIndexForOffset(lineStarts, from);
    for (let lineIndex = startLineIndex; lineIndex < lines.length; lineIndex += 1) {
      const lineStart = lineStarts[lineIndex] ?? 0;
      if (to <= lineStart) {
        break;
      }
      const lineEnd = lineStart + (lines[lineIndex]?.length ?? 0);
      if (from >= lineEnd) {
        continue;
      }

      const localFrom = Math.max(0, from - lineStart);
      const localTo = Math.min(lineEnd, to) - lineStart;
      if (localFrom >= localTo) {
        continue;
      }

      spans[lineIndex]?.push({
        from: localFrom,
        to: localTo,
        className: classes,
      });
    }
  });

  return spans;
}
