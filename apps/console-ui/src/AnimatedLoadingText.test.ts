import { describe, expect, it } from "vitest";

import {
  buildAnimatedLoadingTextSegments,
  resolveAnimatedLoadingTextCharacterDelaySeconds,
} from "./AnimatedLoadingText";

describe("animated loading text", () => {
  it("uses the short-text stagger for compact labels", () => {
    expect(resolveAnimatedLoadingTextCharacterDelaySeconds(12)).toBe(0.028);
  });

  it("caps the stagger for long labels", () => {
    expect(resolveAnimatedLoadingTextCharacterDelaySeconds(140)).toBe(0.04);
  });

  it("preserves character order and converts spaces to non-breaking spaces", () => {
    expect(buildAnimatedLoadingTextSegments("a b")).toEqual([
      { key: "0:a", value: "a", delaySeconds: 0 },
      { key: "1:space", value: "\u00A0", delaySeconds: 0.028 },
      { key: "2:b", value: "b", delaySeconds: 0.056 },
    ]);
  });

  it("supports slower custom stagger timings for short status labels", () => {
    expect(buildAnimatedLoadingTextSegments("abc", { characterDelaySeconds: 0.09 })).toEqual([
      { key: "0:a", value: "a", delaySeconds: 0 },
      { key: "1:b", value: "b", delaySeconds: 0.09 },
      { key: "2:c", value: "c", delaySeconds: 0.18 },
    ]);
  });
});
