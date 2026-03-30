import { describe, expect, it } from "vitest";

import { buildTestSnapshot } from "../testSupport/testSnapshot";
import { deriveTranscriptHistoryRows } from "./transcriptHistoryRows";
import { deriveTranscriptHistoryLayoutRow, deriveTranscriptHistoryRowEstimatedHeight } from "./transcriptHistoryLayout";

describe("deriveTranscriptHistoryLayoutRow", () => {
  it("derives wrapped message line segments deterministically", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "message");

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    const layout = deriveTranscriptHistoryLayoutRow(
      {
        ...row,
        message: {
          ...row.message,
          text: "A very long line that should wrap when the transcript width is narrow enough to force additional visual lines.",
        },
      },
      { widthPx: 280 },
    );

    const lineSegment = layout.segments.find((segment) => segment.kind === "lines");
    expect(lineSegment?.kind).toBe("lines");
    if (!lineSegment || lineSegment.kind !== "lines") {
      return;
    }

    expect(lineSegment.lines.length).toBeGreaterThan(1);
    expect(layout.heightPx).toBeGreaterThan(40);
  });

  it("derives explicit markdown table row heights", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "message");

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    const layout = deriveTranscriptHistoryLayoutRow(
      {
        ...row,
        message: {
          ...row.message,
          text: [
            "| name | value |",
            "| --- | --- |",
            "| alpha | short |",
            "| beta | another value |",
          ].join("\n"),
        },
      },
      { widthPx: 320 },
    );

    const tableSegment = layout.segments.find((segment) => segment.kind === "table");
    expect(tableSegment?.kind).toBe("table");
    if (!tableSegment || tableSegment.kind !== "table") {
      return;
    }

    expect(tableSegment.rowHeightsPx).toHaveLength(3);
    expect(tableSegment.rowHeightsPx.every((height) => height > 0)).toBe(true);
    expect(layout.heightPx).toBeGreaterThan(60);
  });
});

describe("deriveTranscriptHistoryRowEstimatedHeight", () => {
  it("gives message rows 0px chrome (no padding-top on message containers)", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "message");

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    const singleLineRow = {
      ...row,
      message: { ...row.message, text: "Hello" },
    };

    // 1-line message: layout height = 1 * 20px = 20px, chrome = 0px, rowIndex = 0 (no gap).
    const height = deriveTranscriptHistoryRowEstimatedHeight(singleLineRow, { widthPx: 800 }, 0);
    expect(height).toBe(20);
  });

  it("gives non-message, non-widget rows 2px chrome (padding-top: 2px)", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "activity-group");

    expect(row?.kind).toBe("activity-group");
    if (!row || row.kind !== "activity-group") {
      return;
    }

    // Single-activity group, no detail payload → 1 line at 20px = 20px content,
    // chrome = 2px (padding-top: 2px), gap = 0 at index 0. Total: 22px.
    const singleActivityRow = {
      ...row,
      activities: [{ ...row.activities[0]!, summary: "Hello", tone: "info" as const, payload: null }],
    };

    const height = deriveTranscriptHistoryRowEstimatedHeight(singleActivityRow, { widthPx: 800 }, 0);
    expect(height).toBe(22);
  });

  it("gives widget rows (tool/checkpoint) 14px chrome", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "tool");

    expect(row?.kind).toBe("tool");
    if (!row || row.kind !== "tool") {
      return;
    }

    // Collapsed tool: 1 line at 18px + 14px chrome + 0 gap at index 0 = 32px.
    const height = deriveTranscriptHistoryRowEstimatedHeight(row, { widthPx: 800 }, 0);
    expect(height).toBe(32);
  });

  it("adds the inter-row gap (4px) for non-first rows", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "message");

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    const singleLineRow = { ...row, message: { ...row.message, text: "Hello" } };
    const heightAt0 = deriveTranscriptHistoryRowEstimatedHeight(singleLineRow, { widthPx: 800 }, 0);
    const heightAt5 = deriveTranscriptHistoryRowEstimatedHeight(singleLineRow, { widthPx: 800 }, 5);

    expect(heightAt5 - heightAt0).toBe(4);
  });

  it("grows estimates when the transcript narrows (more text wrapping)", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "message");

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    const wrapRow = {
      ...row,
      message: {
        ...row.message,
        text: "A very long line that should wrap when the transcript is narrow enough to force additional visual lines in the layout model.",
      },
    };

    expect(
      deriveTranscriptHistoryRowEstimatedHeight(wrapRow, { widthPx: 280 }),
    ).toBeGreaterThan(
      deriveTranscriptHistoryRowEstimatedHeight(wrapRow, { widthPx: 900 }),
    );
  });
});


describe("deriveTranscriptHistoryLayoutRow", () => {
  it("derives wrapped message line segments deterministically", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "message");

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    const layout = deriveTranscriptHistoryLayoutRow(
      {
        ...row,
        message: {
          ...row.message,
          text: "A very long line that should wrap when the transcript width is narrow enough to force additional visual lines.",
        },
      },
      { widthPx: 280 },
    );

    const lineSegment = layout.segments.find((segment) => segment.kind === "lines");
    expect(lineSegment?.kind).toBe("lines");
    if (!lineSegment || lineSegment.kind !== "lines") {
      return;
    }

    expect(lineSegment.lines.length).toBeGreaterThan(1);
    expect(layout.heightPx).toBeGreaterThan(40);
  });

  it("derives explicit markdown table row heights", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const row = deriveTranscriptHistoryRows(thread).find((candidate) => candidate.kind === "message");

    expect(row?.kind).toBe("message");
    if (!row || row.kind !== "message") {
      return;
    }

    const layout = deriveTranscriptHistoryLayoutRow(
      {
        ...row,
        message: {
          ...row.message,
          text: [
            "| name | value |",
            "| --- | --- |",
            "| alpha | short |",
            "| beta | another value |",
          ].join("\n"),
        },
      },
      { widthPx: 320 },
    );

    const tableSegment = layout.segments.find((segment) => segment.kind === "table");
    expect(tableSegment?.kind).toBe("table");
    if (!tableSegment || tableSegment.kind !== "table") {
      return;
    }

    expect(tableSegment.rowHeightsPx).toHaveLength(3);
    expect(tableSegment.rowHeightsPx.every((height) => height > 0)).toBe(true);
    expect(layout.heightPx).toBeGreaterThan(60);
  });
});
