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

  it("does not use internal ids as searchable text", () => {
    const commands = [
      {
        id: "provider:copilot-hidden",
        label: "Switch thread to provider: copilot-cli",
        keywords: ["switch provider", "copilot-cli"],
      },
    ];

    expect(filterCommandPaletteCommands(commands, "hidden")).toEqual([]);
  });

  it("bubbles higher-priority commands above lower-priority matches", () => {
    const commands = [
      {
        id: "provider:codex",
        label: "Switch thread to provider: Codex",
        keywords: ["switch provider", "provider codex"],
        priority: 100,
      },
      {
        id: "provider:copilot",
        label: "Switch thread to provider: Copilot CLI",
        keywords: ["switch provider", "provider copilot cli"],
        priority: 100,
      },
      {
        id: "other:provider",
        label: "Provider settings",
        keywords: ["provider"],
        priority: 0,
      },
    ];

    expect(filterCommandPaletteCommands(commands, "provider")).toEqual([
      commands[0],
      commands[1],
      commands[2],
    ]);
  });
});
