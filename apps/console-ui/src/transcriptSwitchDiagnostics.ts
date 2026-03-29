interface TranscriptSwitchDiagnosticEntry {
  readonly label: string;
  readonly at: number;
  readonly durationMs?: number;
  readonly threadId?: string | null;
  readonly paneId?: string | null;
  readonly historyCacheKey?: string | null;
  readonly blockCount?: number;
  readonly rowCount?: number;
  readonly cacheHit?: boolean;
}

declare global {
  interface Window {
    __transcriptSwitchDiagnostics?: TranscriptSwitchDiagnosticEntry[];
  }
}

const MAX_DIAGNOSTIC_ENTRIES = 200;

function getNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function recordTranscriptSwitchDiagnostic(entry: Omit<TranscriptSwitchDiagnosticEntry, "at">) {
  if (typeof window === "undefined") {
    return;
  }
  const nextEntry = {
    ...entry,
    at: getNow(),
  } satisfies TranscriptSwitchDiagnosticEntry;
  const store = window.__transcriptSwitchDiagnostics ?? [];
  store.push(nextEntry);
  if (store.length > MAX_DIAGNOSTIC_ENTRIES) {
    store.splice(0, store.length - MAX_DIAGNOSTIC_ENTRIES);
  }
  window.__transcriptSwitchDiagnostics = store;
}

export function recordSlowTranscriptSwitchDiagnostic(
  entry: Omit<TranscriptSwitchDiagnosticEntry, "at" | "durationMs">,
  startedAt: number,
  thresholdMs = 8,
) {
  const durationMs = getNow() - startedAt;
  if (durationMs < thresholdMs) {
    return durationMs;
  }
  const diagnosticEntry = {
    ...entry,
    durationMs,
  } satisfies Omit<TranscriptSwitchDiagnosticEntry, "at">;
  recordTranscriptSwitchDiagnostic(diagnosticEntry);
  if (typeof console !== "undefined") {
    console.warn("[transcript-diagnostic]", diagnosticEntry);
  }
  return durationMs;
}
