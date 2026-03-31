export type TranscriptPreparedHistoryDiagnosticEntry =
  | {
      readonly kind: "phase";
      readonly at: number;
      readonly threadId?: string | null;
      readonly widthPx: number | null;
      readonly phase: "idle" | "preparing" | "recalculating" | "ready";
      readonly preparedKey: string | null;
      readonly sealedRowCount: number;
    }
  | {
      readonly kind: "anchor-capture";
      readonly at: number;
      readonly threadId?: string | null;
      readonly widthPx: number | null;
      readonly anchorKind: "bottom" | "row";
      readonly rowId?: string;
      readonly offsetPx: number;
    }
  | {
      readonly kind: "anchor-restore";
      readonly at: number;
      readonly threadId?: string | null;
      readonly widthPx: number | null;
      readonly outcome: "bottom" | "row-geometry" | "row-dom" | "fallback-bottom" | "miss";
      readonly rowId?: string;
    };

type TranscriptPreparedHistoryDiagnosticInput =
  | Omit<Extract<TranscriptPreparedHistoryDiagnosticEntry, { readonly kind: "phase" }>, "at">
  | Omit<Extract<TranscriptPreparedHistoryDiagnosticEntry, { readonly kind: "anchor-capture" }>, "at">
  | Omit<Extract<TranscriptPreparedHistoryDiagnosticEntry, { readonly kind: "anchor-restore" }>, "at">;

declare global {
  interface Window {
    __transcriptPreparedHistoryDiagnostics?: TranscriptPreparedHistoryDiagnosticEntry[];
    __formatTranscriptPreparedHistoryDiagnostics?: () => string;
    __dumpTranscriptPreparedHistoryDiagnostics?: (path: string) => Promise<boolean>;
  }
}

export const MAX_TRANSCRIPT_PREPARED_HISTORY_DIAGNOSTICS = 300;

function getNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createTranscriptPreparedHistoryDiagnostic(
  input: TranscriptPreparedHistoryDiagnosticInput,
): TranscriptPreparedHistoryDiagnosticEntry {
  return {
    ...input,
    at: getNow(),
  };
}

export function recordTranscriptPreparedHistoryDiagnostic(
  input: TranscriptPreparedHistoryDiagnosticInput,
) {
  if (typeof window === "undefined") {
    return;
  }

  const nextEntry = createTranscriptPreparedHistoryDiagnostic(input);
  const store = window.__transcriptPreparedHistoryDiagnostics ?? [];
  store.push(nextEntry);
  if (store.length > MAX_TRANSCRIPT_PREPARED_HISTORY_DIAGNOSTICS) {
    store.splice(0, store.length - MAX_TRANSCRIPT_PREPARED_HISTORY_DIAGNOSTICS);
  }
  window.__transcriptPreparedHistoryDiagnostics = store;
}

export function formatTranscriptPreparedHistoryDiagnostics(
  diagnostics: ReadonlyArray<TranscriptPreparedHistoryDiagnosticEntry>,
): string {
  const phaseCounts = new Map<string, number>();
  const anchorOutcomeCounts = new Map<string, number>();

  for (const entry of diagnostics) {
    if (entry.kind === "phase") {
      phaseCounts.set(entry.phase, (phaseCounts.get(entry.phase) ?? 0) + 1);
      continue;
    }
    if (entry.kind === "anchor-restore") {
      anchorOutcomeCounts.set(entry.outcome, (anchorOutcomeCounts.get(entry.outcome) ?? 0) + 1);
    }
  }

  const lines = [
    "# Transcript prepared-history diagnostics",
    "",
    `Total entries: ${diagnostics.length}`,
    "",
    "## Phase counts",
  ];

  for (const phase of ["idle", "preparing", "recalculating", "ready"] as const) {
    lines.push(`- ${phase}: ${phaseCounts.get(phase) ?? 0}`);
  }

  lines.push("", "## Anchor restore outcomes");
  for (const outcome of ["row-geometry", "row-dom", "bottom", "fallback-bottom", "miss"] as const) {
    lines.push(`- ${outcome}: ${anchorOutcomeCounts.get(outcome) ?? 0}`);
  }

  lines.push("", "## Raw entries", JSON.stringify(diagnostics, null, 2));
  return lines.join("\n");
}

export function installTranscriptPreparedHistoryDiagnosticsHelpers(input: {
  readonly writeTextFile?: ((path: string, contents: string) => Promise<boolean>) | undefined;
}) {
  if (typeof window === "undefined") {
    return;
  }

  window.__formatTranscriptPreparedHistoryDiagnostics = () =>
    formatTranscriptPreparedHistoryDiagnostics(window.__transcriptPreparedHistoryDiagnostics ?? []);
  window.__dumpTranscriptPreparedHistoryDiagnostics = async (path: string) => {
    if (typeof path !== "string" || path.trim().length === 0 || !input.writeTextFile) {
      return false;
    }

    return input.writeTextFile(
      path,
      window.__formatTranscriptPreparedHistoryDiagnostics?.()
        ?? formatTranscriptPreparedHistoryDiagnostics(window.__transcriptPreparedHistoryDiagnostics ?? []),
    );
  };
}
