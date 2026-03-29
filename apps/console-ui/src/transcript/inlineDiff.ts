import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export interface InlineDiffRowData {
  readonly kind: "metadata" | "context" | "addition" | "deletion" | "gap";
  readonly oldLineNumber?: number;
  readonly newLineNumber?: number;
  readonly text: string;
}

export interface InlineDiffHunkData {
  readonly header: string;
  readonly rows: ReadonlyArray<InlineDiffRowData>;
}

export interface InlineDiffFileData {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: ReadonlyArray<InlineDiffHunkData>;
}

const inlineDiffCache = new Map<string, ReadonlyArray<InlineDiffFileData>>();
const inlineDiffCacheLimit = 256;

function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.set(key, value);
  if (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  return value;
}

function normalizeDiffPath(path: string) {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function resolveInlineDiffPath(file: FileDiffMetadata) {
  return normalizeDiffPath(file.name ?? file.prevName ?? "");
}

export function normalizeInlineDiffRowText(text: string) {
  return text.replace(/\r?\n$/, "");
}

function buildInlineDiffRows(file: FileDiffMetadata): InlineDiffFileData {
  const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
  const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
  let previousOldLineNumber: number | null = null;
  let previousNewLineNumber: number | null = null;
  const hunks: InlineDiffHunkData[] = file.hunks.map((hunk) => {
    const rows: InlineDiffRowData[] = [];
    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            kind: "context",
            oldLineNumber,
            newLineNumber,
            text: normalizeInlineDiffRowText(file.additionLines[content.additionLineIndex + index] ?? ""),
          });
          oldLineNumber += 1;
          newLineNumber += 1;
        }
        continue;
      }

      for (let index = 0; index < content.deletions; index += 1) {
        rows.push({
          kind: "deletion",
          oldLineNumber,
          text: normalizeInlineDiffRowText(file.deletionLines[content.deletionLineIndex + index] ?? ""),
        });
        oldLineNumber += 1;
      }

      for (let index = 0; index < content.additions; index += 1) {
        rows.push({
          kind: "addition",
          newLineNumber,
          text: normalizeInlineDiffRowText(file.additionLines[content.additionLineIndex + index] ?? ""),
        });
        newLineNumber += 1;
      }
    }

    const firstVisibleRow = rows[0];
    if (
      firstVisibleRow
      && (
        (
          previousOldLineNumber !== null
          && firstVisibleRow.oldLineNumber !== undefined
          && firstVisibleRow.oldLineNumber > previousOldLineNumber + 1
        )
        || (
          previousNewLineNumber !== null
          && firstVisibleRow.newLineNumber !== undefined
          && firstVisibleRow.newLineNumber > previousNewLineNumber + 1
        )
      )
    ) {
      rows.unshift({
        kind: "gap",
        text: "",
      });
    }

    if (rows.length > 0) {
      previousOldLineNumber = oldLineNumber - 1;
      previousNewLineNumber = newLineNumber - 1;
    }

    return {
      header: hunk.hunkContext ? `${hunk.hunkSpecs ?? "@@"} ${hunk.hunkContext}` : (hunk.hunkSpecs ?? "@@"),
      rows,
    };
  });

  return {
    path: resolveInlineDiffPath(file),
    ...(file.prevName ? { previousPath: normalizeDiffPath(file.prevName) } : {}),
    additions,
    deletions,
    hunks,
  };
}

export function parseInlineDiffFiles(
  unifiedDiff: string,
  changedFiles?: ReadonlyArray<string>,
): ReadonlyArray<InlineDiffFileData> {
  const normalizedPatch = unifiedDiff.replace(/\r\n/g, "\n").trim();
  if (normalizedPatch.length === 0) {
    return [];
  }

  const normalizedPaths = changedFiles?.map((path) => normalizeDiffPath(path)) ?? [];
  const cacheKey = `${normalizedPaths.join("|")}::${normalizedPatch}`;
  const cached = inlineDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const parsed = parsePatchFiles(normalizedPatch);
    const files = parsed.flatMap((patch) => patch.files);
    const allowedPaths = new Set(normalizedPaths);
    const filteredFiles = allowedPaths.size > 0
      ? files.filter((file) => {
          const nextPath = resolveInlineDiffPath(file);
          const previousPath = file.prevName ? normalizeDiffPath(file.prevName) : null;
          return allowedPaths.has(nextPath) || (previousPath !== null && allowedPaths.has(previousPath));
        })
      : files;
    const inlineFiles = filteredFiles.map((file) => buildInlineDiffRows(file));
    return setBoundedCacheEntry(inlineDiffCache, cacheKey, inlineFiles, inlineDiffCacheLimit);
  } catch {
    return setBoundedCacheEntry(inlineDiffCache, cacheKey, [], inlineDiffCacheLimit);
  }
}

export function countInlineDiffRows(files: ReadonlyArray<InlineDiffFileData>) {
  let rowCount = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      rowCount += hunk.rows.length;
    }
  }
  return rowCount;
}

export function getInlineDiffRowMarker(row: InlineDiffRowData) {
  switch (row.kind) {
    case "addition":
      return "+";
    case "deletion":
      return "-";
    case "gap":
      return "⋮";
    case "context":
      return " ";
    default:
      return "@";
  }
}

export function getInlineDiffRowCopyText(row: InlineDiffRowData) {
  if (row.kind === "gap") {
    return undefined;
  }
  return `${row.kind === "addition" ? "+" : row.kind === "deletion" ? "-" : " "}${row.text}`;
}
