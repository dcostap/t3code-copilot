import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_TRANSCRIPT_MEASUREMENT_DIAGNOSTICS,
  createTranscriptMeasurementDiagnostic,
  formatTranscriptMeasurementDiagnostics,
  recordTranscriptMeasurementDiagnostic,
  summarizeTranscriptMeasurementDiagnostics,
} from "./transcriptMeasurementDiagnostics";

const globalWindow = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis;
};

describe("createTranscriptMeasurementDiagnostic", () => {
  it("derives signed and relative deltas from measured and expected heights", () => {
    const diagnostic = createTranscriptMeasurementDiagnostic({
      comparisonKind: "estimate-to-visible",
      threadId: "thread-1",
      rowId: "row-1",
      rowKind: "message",
      widthPx: 640,
      expectedHeight: 80,
      actualHeight: 110,
    });

    expect(diagnostic.signedDeltaPx).toBe(30);
    expect(diagnostic.absoluteDeltaPx).toBe(30);
    expect(diagnostic.relativeDelta).toBe(0.375);
  });
});

describe("recordTranscriptMeasurementDiagnostic", () => {
  afterEach(() => {
    delete globalWindow.window;
  });

  it("caps stored diagnostics to the configured maximum", () => {
    globalWindow.window = {} as Window & typeof globalThis;

    for (let index = 0; index < MAX_TRANSCRIPT_MEASUREMENT_DIAGNOSTICS + 25; index += 1) {
      recordTranscriptMeasurementDiagnostic({
        comparisonKind: "estimate-to-premeasure",
        threadId: "thread-1",
        rowId: `row-${index}`,
        rowKind: "message",
        widthPx: 720,
        expectedHeight: 100,
        actualHeight: 120,
      });
    }

    const diagnostics = globalWindow.window.__transcriptMeasurementDiagnostics ?? [];
    expect(diagnostics).toHaveLength(MAX_TRANSCRIPT_MEASUREMENT_DIAGNOSTICS);
    expect(diagnostics[0]?.rowId).toBe("row-25");
    expect(diagnostics.at(-1)?.rowId).toBe(
      `row-${MAX_TRANSCRIPT_MEASUREMENT_DIAGNOSTICS + 24}`,
    );
  });
});

describe("summarizeTranscriptMeasurementDiagnostics", () => {
  it("groups entries by comparison kind and computes aggregate deltas", () => {
    const diagnostics = [
      createTranscriptMeasurementDiagnostic({
        comparisonKind: "estimate-to-visible",
        threadId: "thread-1",
        rowId: "row-1",
        rowKind: "message",
        widthPx: 640,
        expectedHeight: 100,
        actualHeight: 112,
      }),
      createTranscriptMeasurementDiagnostic({
        comparisonKind: "estimate-to-visible",
        threadId: "thread-1",
        rowId: "row-2",
        rowKind: "message",
        widthPx: 640,
        expectedHeight: 100,
        actualHeight: 120,
      }),
      createTranscriptMeasurementDiagnostic({
        comparisonKind: "premeasure-to-visible",
        threadId: "thread-1",
        rowId: "row-3",
        rowKind: "tool",
        widthPx: 640,
        expectedHeight: 90,
        actualHeight: 93,
      }),
      createTranscriptMeasurementDiagnostic({
        comparisonKind: "prepared-to-visible",
        threadId: "thread-1",
        rowId: "row-4",
        rowKind: "message",
        widthPx: 640,
        expectedHeight: 88,
        actualHeight: 88,
      }),
    ];

    const summary = summarizeTranscriptMeasurementDiagnostics(diagnostics);

    expect(summary.totalCount).toBe(4);
    expect(summary.byComparisonKind["estimate-to-visible"]).toMatchObject({
      count: 2,
      averageAbsoluteDeltaPx: 16,
      maxAbsoluteDeltaPx: 20,
    });
    expect(summary.byComparisonKind["premeasure-to-visible"]).toMatchObject({
      count: 1,
      averageAbsoluteDeltaPx: 3,
      maxAbsoluteDeltaPx: 3,
    });
    expect(summary.byComparisonKind["prepared-to-visible"]).toMatchObject({
      count: 1,
      averageAbsoluteDeltaPx: 0,
      maxAbsoluteDeltaPx: 0,
    });
  });
});

describe("formatTranscriptMeasurementDiagnostics", () => {
  it("includes the summary and raw entry dump", () => {
    const output = formatTranscriptMeasurementDiagnostics([
      createTranscriptMeasurementDiagnostic({
        comparisonKind: "estimate-to-premeasure",
        threadId: "thread-1",
        rowId: "row-1",
        rowKind: "message",
        widthPx: 640,
        expectedHeight: 100,
        actualHeight: 118,
      }),
    ]);

    expect(output).toContain("# Transcript measurement diagnostics");
    expect(output).toContain("estimate-to-premeasure");
    expect(output).toContain("\"rowId\": \"row-1\"");
  });
});
