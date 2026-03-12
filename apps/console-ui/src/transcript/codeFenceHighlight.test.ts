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
});
