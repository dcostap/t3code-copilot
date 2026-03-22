import { describe, expect, it } from "vitest";

import { resolveCommandPaletteFrameStyle } from "./CommandPalette";
import { filterCommandPaletteCommands } from "./commandPaletteCommands";

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

  it("centers the scoped frame using the max palette height when space allows", () => {
    expect(resolveCommandPaletteFrameStyle({
      top: 40,
      left: 18.6,
      width: 640.4,
      height: 1200,
    })).toEqual({
      top: "165px",
      left: "19px",
      width: "640px",
      height: "950px",
    });
  });
});

describe("filterCommandPaletteCommands", () => {
  it("matches ordered query tokens across the command text", () => {
    const commands = [
      {
        id: "model:mini",
        label: "[Model] Set · GPT-5.4 mini",
        keywords: ["model", "gpt-5.4", "mini"],
      },
      {
        id: "mode:plan",
        label: "[Mode] Set · plan",
        keywords: ["mode", "plan"],
      },
    ];

    expect(filterCommandPaletteCommands(commands, "model mini")).toEqual([commands[0]]);
  });

  it("prefers commands whose label matches the full query over looser matches", () => {
    const commands = [
      {
        id: "model-mini-exact",
        label: "model mini",
      },
      {
        id: "model:set-mini",
        label: "[Model] Set · GPT-5.4 mini",
        keywords: ["model", "mini"],
      },
    ];

    expect(filterCommandPaletteCommands(commands, "model mini")).toEqual([
      commands[0],
      commands[1],
    ]);
  });
});
