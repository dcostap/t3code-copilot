import { describe, expect, it } from "vitest";

import { highlightCodeFence } from "./codeFenceHighlight";

describe("highlightCodeFence", () => {
  it("returns token spans for supported javascript fences", () => {
    const spans = highlightCodeFence("ts", ["const answer = 42;"]);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.some((span) => span.className.includes("tok-keyword"))).toBe(true);
  });

  it("falls back cleanly for unsupported languages", () => {
    const spans = highlightCodeFence("unknown-lang", ["hello"]);
    expect(spans).toEqual([[]]);
  });

  it("projects multi-line token spans onto each overlapping line", () => {
    const spans = highlightCodeFence("ts", [
      "const value = `hello",
      "world`;",
    ]);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.length).toBeGreaterThan(0);
    expect(spans[1]?.length).toBeGreaterThan(0);
  });
});
