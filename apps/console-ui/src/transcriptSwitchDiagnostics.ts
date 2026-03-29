interface TranscriptSwitchDiagnosticEntry {
  readonly label: string;
  readonly at: number;
  readonly durationMs?: number;
  readonly threadId?: string | null;
  readonly paneId?: string | null;
  readonly historyCacheKey?: string | null;
  readonly blockCount?: number;
  readonly cacheHit?: boolean;
}

declare global {
  interface Window {
    __transcriptSwitchDiagnostics?: TranscriptSwitchDiagnosticEntry[];
  }
}

const MAX_DIAGNOSTIC_ENTRIES = 200;
const MIN_DURATION_TO_RECORD_MS = 4;

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

export function measureTranscriptSwitchDiagnostic<T>(
  entry: Omit<TranscriptSwitchDiagnosticEntry, "at" | "durationMs">,
  fn: () => T,
) {
  const startedAt = getNow();
  const result = fn();
  const durationMs = getNow() - startedAt;
  if (durationMs >= MIN_DURATION_TO_RECORD_MS) {
    recordTranscriptSwitchDiagnostic({
      ...entry,
      durationMs,
    });
  }
  return result;
}
