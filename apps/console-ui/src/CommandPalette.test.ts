import { describe, expect, it } from "vitest";

import { filterCommandPaletteCommands } from "./commandPaletteCommands";

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
