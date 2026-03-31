import { describe, expect, it } from "vitest";

import {
  createBottomTranscriptScrollAnchor,
  createRowTranscriptScrollAnchor,
  restoreTranscriptScrollOffset,
} from "./transcriptScrollAnchor";

describe("restoreTranscriptScrollOffset", () => {
  it("restores bottom anchors from the current total height", () => {
    const offset = restoreTranscriptScrollOffset({
      anchor: createBottomTranscriptScrollAnchor(36),
      rowStartById: new Map(),
      rowHeightById: new Map(),
      totalHeightPx: 620,
      viewportHeightPx: 200,
    });

    expect(offset).toBe(384);
  });

  it("restores row anchors using the current row start and height", () => {
    const offset = restoreTranscriptScrollOffset({
      anchor: createRowTranscriptScrollAnchor({
        rowId: "row-2",
        offsetWithinRowPx: 40,
        rowHeightPx: 100,
      }),
      rowStartById: new Map([
        ["row-1", 0],
        ["row-2", 180],
      ]),
      rowHeightById: new Map([
        ["row-2", 120],
      ]),
      totalHeightPx: 600,
      viewportHeightPx: 200,
    });

    expect(offset).toBe(220);
  });

  it("returns null when the anchored row no longer exists", () => {
    const offset = restoreTranscriptScrollOffset({
      anchor: createRowTranscriptScrollAnchor({
        rowId: "missing-row",
        offsetWithinRowPx: 24,
        rowHeightPx: 80,
      }),
      rowStartById: new Map([
        ["row-1", 0],
      ]),
      rowHeightById: new Map(),
      totalHeightPx: 600,
      viewportHeightPx: 200,
    });

    expect(offset).toBeNull();
  });
});
