export type TranscriptMeasurementComparisonKind =
  | "estimate-to-visible"
  | "estimate-to-premeasure"
  | "premeasure-to-visible"
  | "prepared-to-visible";

export interface TranscriptMeasurementDiagnosticEntry {
  readonly comparisonKind: TranscriptMeasurementComparisonKind;
  readonly at: number;
  readonly threadId?: string | null;
  readonly rowId: string;
  readonly rowKind: string;
  readonly widthPx: number | null;
  readonly expectedHeight: number;
  readonly actualHeight: number;
  readonly signedDeltaPx: number;
  readonly absoluteDeltaPx: number;
  readonly relativeDelta: number | null;
}

export interface TranscriptMeasurementDiagnosticSummary {
  readonly count: number;
  readonly averageAbsoluteDeltaPx: number;
  readonly maxAbsoluteDeltaPx: number;
}

export interface TranscriptMeasurementDiagnosticsSummary {
  readonly totalCount: number;
  readonly byComparisonKind: Record<TranscriptMeasurementComparisonKind, TranscriptMeasurementDiagnosticSummary>;
}

declare global {
  interface Window {
    __transcriptMeasurementDiagnostics?: TranscriptMeasurementDiagnosticEntry[];
    __dumpTranscriptMeasurementDiagnostics?: (path: string) => Promise<boolean>;
    __formatTranscriptMeasurementDiagnostics?: () => string;
  }
}

export const MAX_TRANSCRIPT_MEASUREMENT_DIAGNOSTICS = 500;

function getNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createTranscriptMeasurementDiagnostic(
  input: Omit<
    TranscriptMeasurementDiagnosticEntry,
    "at" | "signedDeltaPx" | "absoluteDeltaPx" | "relativeDelta"
  >,
): TranscriptMeasurementDiagnosticEntry {
  const signedDeltaPx = input.actualHeight - input.expectedHeight;
  const absoluteDeltaPx = Math.abs(signedDeltaPx);

  return {
    ...input,
    at: getNow(),
    signedDeltaPx,
    absoluteDeltaPx,
    relativeDelta: input.expectedHeight > 0 ? absoluteDeltaPx / input.expectedHeight : null,
  };
}

export function recordTranscriptMeasurementDiagnostic(
  input: Omit<
    TranscriptMeasurementDiagnosticEntry,
    "at" | "signedDeltaPx" | "absoluteDeltaPx" | "relativeDelta"
  >,
) {
  if (typeof window === "undefined") {
    return;
  }

  const nextEntry = createTranscriptMeasurementDiagnostic(input);
  const store = window.__transcriptMeasurementDiagnostics ?? [];
  store.push(nextEntry);
  if (store.length > MAX_TRANSCRIPT_MEASUREMENT_DIAGNOSTICS) {
    store.splice(0, store.length - MAX_TRANSCRIPT_MEASUREMENT_DIAGNOSTICS);
  }
  window.__transcriptMeasurementDiagnostics = store;
}

function getEmptySummary(): TranscriptMeasurementDiagnosticSummary {
  return {
    count: 0,
    averageAbsoluteDeltaPx: 0,
    maxAbsoluteDeltaPx: 0,
  };
}

export function summarizeTranscriptMeasurementDiagnostics(
  diagnostics: ReadonlyArray<TranscriptMeasurementDiagnosticEntry>,
): TranscriptMeasurementDiagnosticsSummary {
  const byComparisonKind: TranscriptMeasurementDiagnosticsSummary["byComparisonKind"] = {
    "estimate-to-visible": getEmptySummary(),
    "estimate-to-premeasure": getEmptySummary(),
    "premeasure-to-visible": getEmptySummary(),
    "prepared-to-visible": getEmptySummary(),
  };

  for (const comparisonKind of Object.keys(byComparisonKind) as TranscriptMeasurementComparisonKind[]) {
    const matchingDiagnostics = diagnostics.filter((entry) => entry.comparisonKind === comparisonKind);
    if (matchingDiagnostics.length === 0) {
      continue;
    }

    const totalAbsoluteDeltaPx = matchingDiagnostics.reduce(
      (total, entry) => total + entry.absoluteDeltaPx,
      0,
    );
    byComparisonKind[comparisonKind] = {
      count: matchingDiagnostics.length,
      averageAbsoluteDeltaPx: totalAbsoluteDeltaPx / matchingDiagnostics.length,
      maxAbsoluteDeltaPx: Math.max(...matchingDiagnostics.map((entry) => entry.absoluteDeltaPx)),
    };
  }

  return {
    totalCount: diagnostics.length,
    byComparisonKind,
  };
}

export function formatTranscriptMeasurementDiagnostics(
  diagnostics: ReadonlyArray<TranscriptMeasurementDiagnosticEntry>,
): string {
  const summary = summarizeTranscriptMeasurementDiagnostics(diagnostics);
  const lines = [
    "# Transcript measurement diagnostics",
    "",
    `Total entries: ${summary.totalCount}`,
    "",
    "## Summary by comparison kind",
  ];

  for (const comparisonKind of Object.keys(summary.byComparisonKind) as TranscriptMeasurementComparisonKind[]) {
    const entry = summary.byComparisonKind[comparisonKind];
    lines.push(
      `- ${comparisonKind}: count=${entry.count}, avgAbsDeltaPx=${entry.averageAbsoluteDeltaPx.toFixed(2)}, maxAbsDeltaPx=${entry.maxAbsoluteDeltaPx}`,
    );
  }

  lines.push("", "## Raw entries", JSON.stringify(diagnostics, null, 2));
  return lines.join("\n");
}

export function installTranscriptMeasurementDiagnosticsHelpers(input: {
  readonly writeTextFile?: ((path: string, contents: string) => Promise<boolean>) | undefined;
}) {
  if (typeof window === "undefined") {
    return;
  }

  window.__formatTranscriptMeasurementDiagnostics = () =>
    formatTranscriptMeasurementDiagnostics(window.__transcriptMeasurementDiagnostics ?? []);
  window.__dumpTranscriptMeasurementDiagnostics = async (path: string) => {
    if (typeof path !== "string" || path.trim().length === 0) {
      return false;
    }

    const contents = window.__formatTranscriptMeasurementDiagnostics?.()
      ?? formatTranscriptMeasurementDiagnostics(window.__transcriptMeasurementDiagnostics ?? []);
    if (!input.writeTextFile) {
      return false;
    }
    return input.writeTextFile(path, contents);
  };
}
