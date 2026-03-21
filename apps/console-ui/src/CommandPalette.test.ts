import { describe, expect, it } from "vitest";

import { resolveCommandPaletteFrameStyle } from "./CommandPalette";

describe("resolveCommandPaletteFrameStyle", () => {
  it("returns undefined for the global palette scope", () => {
    expect(resolveCommandPaletteFrameStyle(null)).toBeUndefined();
  });

  it("maps scoped bounds to absolute frame style", () => {
    expect(resolveCommandPaletteFrameStyle({
      top: 24.2,
      left: 18.6,
      width: 640.4,
      height: 812.8,
    })).toEqual({
      top: "24px",
      left: "19px",
      width: "640px",
      height: "813px",
    });
  });
});
