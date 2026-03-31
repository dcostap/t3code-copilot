import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_TRANSCRIPT_PREPARED_HISTORY_DIAGNOSTICS,
  createTranscriptPreparedHistoryDiagnostic,
  formatTranscriptPreparedHistoryDiagnostics,
  recordTranscriptPreparedHistoryDiagnostic,
} from "./transcriptPreparedHistoryDiagnostics";

const globalWindow = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis;
};

describe("createTranscriptPreparedHistoryDiagnostic", () => {
  it("stamps phase entries with a timestamp", () => {
    const diagnostic = createTranscriptPreparedHistoryDiagnostic({
      kind: "phase",
      threadId: "thread-1",
      widthPx: 640,
      phase: "preparing",
      preparedKey: "prepared-key",
      sealedRowCount: 12,
    });

    expect(diagnostic.at).toBeGreaterThanOrEqual(0);
    expect(diagnostic.kind).toBe("phase");
  });
});

describe("recordTranscriptPreparedHistoryDiagnostic", () => {
  afterEach(() => {
    delete globalWindow.window;
  });

  it("caps stored diagnostics to the configured maximum", () => {
    globalWindow.window = {} as Window & typeof globalThis;

    for (let index = 0; index < MAX_TRANSCRIPT_PREPARED_HISTORY_DIAGNOSTICS + 20; index += 1) {
      recordTranscriptPreparedHistoryDiagnostic({
        kind: "phase",
        threadId: "thread-1",
        widthPx: 640,
        phase: "preparing",
        preparedKey: `key-${index}`,
        sealedRowCount: 10,
      });
    }

    const diagnostics = globalWindow.window.__transcriptPreparedHistoryDiagnostics ?? [];
    expect(diagnostics).toHaveLength(MAX_TRANSCRIPT_PREPARED_HISTORY_DIAGNOSTICS);
    expect(diagnostics[0]).toMatchObject({
      kind: "phase",
      preparedKey: "key-20",
    });
  });
});

describe("formatTranscriptPreparedHistoryDiagnostics", () => {
  it("includes phase counts and anchor restore outcomes", () => {
    const output = formatTranscriptPreparedHistoryDiagnostics([
      createTranscriptPreparedHistoryDiagnostic({
        kind: "phase",
        threadId: "thread-1",
        widthPx: 640,
        phase: "preparing",
        preparedKey: "key-a",
        sealedRowCount: 12,
      }),
      createTranscriptPreparedHistoryDiagnostic({
        kind: "anchor-restore",
        threadId: "thread-1",
        widthPx: 640,
        outcome: "row-geometry",
        rowId: "row-1",
      }),
    ]);

    expect(output).toContain("# Transcript prepared-history diagnostics");
    expect(output).toContain("- preparing: 1");
    expect(output).toContain("- row-geometry: 1");
  });
});
