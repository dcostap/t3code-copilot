import { describe, expect, it } from "vitest";

import { resolveDesktopWindowControlsInsetPx } from "./windowControls";

describe("resolveDesktopWindowControlsInsetPx", () => {
  it("returns zero for non-desktop environments", () => {
    expect(resolveDesktopWindowControlsInsetPx(false, "Win32")).toBe(0);
  });

  it("returns zero for mac desktop environments", () => {
    expect(resolveDesktopWindowControlsInsetPx(true, "MacIntel")).toBe(0);
    expect(resolveDesktopWindowControlsInsetPx(true, "darwin")).toBe(0);
  });

  it("reserves right-side space for non-mac desktop environments", () => {
    expect(resolveDesktopWindowControlsInsetPx(true, "Win32")).toBe(200);
    expect(resolveDesktopWindowControlsInsetPx(true, "Linux x86_64")).toBe(200);
    expect(resolveDesktopWindowControlsInsetPx(true, null)).toBe(200);
  });
});
