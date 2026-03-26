import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  loadCopilotMcpServersWithDiagnostics,
  resolveCopilotMcpConfigPath,
} from "./copilotMcpServers.ts";

describe("copilotMcpServers", () => {
  it("returns config diagnostics for normalized and ignored MCP entries", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "t3-copilot-mcp-"));
    try {
      writeFileSync(
        path.join(configDir, "mcp-config.json"),
        JSON.stringify({
          mcpServers: {
            valid: {
              command: "node",
              args: ["server.js"],
            },
            ignored: {
              type: "stdio",
            },
          },
        }),
        "utf8",
      );

      await expect(loadCopilotMcpServersWithDiagnostics(configDir)).resolves.toEqual({
        configPath: path.join(configDir, "mcp-config.json"),
        servers: {
          valid: {
            type: "local",
            command: "node",
            args: ["server.js"],
            tools: ["*"],
          },
        },
        loadedServerNames: ["valid"],
        ignoredServerNames: ["ignored"],
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("reports the resolved config path when the MCP config file is missing", async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "t3-copilot-mcp-missing-"));
    try {
      await expect(loadCopilotMcpServersWithDiagnostics(configDir)).resolves.toEqual({
        configPath: path.join(configDir, "mcp-config.json"),
        servers: undefined,
        loadedServerNames: [],
        ignoredServerNames: [],
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("resolves the default Copilot MCP config path from the home directory", () => {
    expect(resolveCopilotMcpConfigPath(undefined)).toBe(
      path.join(os.homedir(), ".copilot", "mcp-config.json"),
    );
  });
});
