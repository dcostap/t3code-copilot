import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveBundledCopilotCliPathFrom, shouldPassCopilotCliPathToSdk } from "./copilotCliPath.ts";

const CURRENT_DIR = "/repo/apps/server/src/provider/Layers";
const SDK_ENTRYPOINT = "/repo/apps/server/node_modules/@github/copilot-sdk/dist/index.js";

describe("copilotCliPath", () => {
  it("prefers the native binary on Windows", () => {
    const npmLoaderPath = join(
      "/repo/apps/server/node_modules",
      "@github",
      "copilot",
      "npm-loader.js",
    );
    const binaryPath = join(
      "/repo/apps/server/node_modules",
      "@github",
      "copilot-win32-x64",
      "copilot.exe",
    );
    const existingPaths = new Set([npmLoaderPath, binaryPath]);

    expect(
      resolveBundledCopilotCliPathFrom({
        currentDir: CURRENT_DIR,
        sdkEntrypoint: SDK_ENTRYPOINT,
        platform: "win32",
        arch: "x64",
        exists: (candidate) => existingPaths.has(candidate),
      }),
    ).toBe(binaryPath);
  });

  it("finds the native binary nested under @github/copilot on Windows", () => {
    const nestedBinaryPath = join(
      "/repo/apps/server/node_modules",
      "@github",
      "copilot",
      "node_modules",
      "@github",
      "copilot-win32-x64",
      "copilot.exe",
    );
    const existingPaths = new Set([nestedBinaryPath]);

    expect(
      resolveBundledCopilotCliPathFrom({
        currentDir: CURRENT_DIR,
        sdkEntrypoint: SDK_ENTRYPOINT,
        platform: "win32",
        arch: "x64",
        exists: (candidate) => existingPaths.has(candidate),
      }),
    ).toBe(nestedBinaryPath);
  });

  it("keeps the native binary preference on non-Windows platforms", () => {
    const npmLoaderPath = join(
      "/repo/apps/server/node_modules",
      "@github",
      "copilot",
      "npm-loader.js",
    );
    const binaryPath = join(
      "/repo/apps/server/node_modules",
      "@github",
      "copilot-linux-x64",
      "copilot",
    );
    const existingPaths = new Set([npmLoaderPath, binaryPath]);

    expect(
      resolveBundledCopilotCliPathFrom({
        currentDir: CURRENT_DIR,
        sdkEntrypoint: SDK_ENTRYPOINT,
        platform: "linux",
        arch: "x64",
        exists: (candidate) => existingPaths.has(candidate),
      }),
    ).toBe(binaryPath);
  });

  it("falls back to npm-loader.js when no native binary is present on Windows", () => {
    const npmLoaderPath = join(
      "/repo/apps/server/node_modules",
      "@github",
      "copilot",
      "npm-loader.js",
    );
    const existingPaths = new Set([npmLoaderPath]);

    expect(
      resolveBundledCopilotCliPathFrom({
        currentDir: CURRENT_DIR,
        sdkEntrypoint: SDK_ENTRYPOINT,
        platform: "win32",
        arch: "x64",
        exists: (candidate) => existingPaths.has(candidate),
      }),
    ).toBe(npmLoaderPath);
  });

  it("finds the native binary nested under the global npm copilot package on Windows PATH", () => {
    const nestedBinaryPath = join(
      "C:\\Users\\Darius\\AppData\\Roaming\\npm",
      "node_modules",
      "@github",
      "copilot",
      "node_modules",
      "@github",
      "copilot-win32-x64",
      "copilot.exe",
    );
    const existingPaths = new Set([nestedBinaryPath]);

    expect(
      resolveBundledCopilotCliPathFrom({
        currentDir: CURRENT_DIR,
        sdkEntrypoint: SDK_ENTRYPOINT,
        platform: "win32",
        arch: "x64",
        pathEnv: "C:\\Users\\Darius\\AppData\\Roaming\\npm",
        exists: (candidate) => existingPaths.has(candidate),
      }),
    ).toBe(nestedBinaryPath);
  });

  it("falls back to npm-loader.js when no native binary is present on non-Windows platforms", () => {
    const npmLoaderPath = join(
      "/repo/apps/server/node_modules",
      "@github",
      "copilot",
      "npm-loader.js",
    );
    const existingPaths = new Set([npmLoaderPath]);

    expect(
      resolveBundledCopilotCliPathFrom({
        currentDir: CURRENT_DIR,
        sdkEntrypoint: SDK_ENTRYPOINT,
        platform: "darwin",
        arch: "arm64",
        exists: (candidate) => existingPaths.has(candidate),
      }),
    ).toBe(npmLoaderPath);
  });

  it("does not pass npm-loader.js to the SDK on Windows", () => {
    expect(
      shouldPassCopilotCliPathToSdk(
        "C:\\repo\\node_modules\\@github\\copilot\\npm-loader.js",
        "win32",
      ),
    ).toBe(false);
  });

  it("does not pass Windows command shims to the SDK", () => {
    expect(
      shouldPassCopilotCliPathToSdk(
        "C:\\Users\\Darius\\AppData\\Roaming\\npm\\copilot.cmd",
        "win32",
      ),
    ).toBe(false);
    expect(
      shouldPassCopilotCliPathToSdk(
        "C:\\Users\\Darius\\AppData\\Roaming\\npm\\copilot.ps1",
        "win32",
      ),
    ).toBe(false);
  });

  it("still passes the native Copilot binary to the SDK on Windows", () => {
    expect(
      shouldPassCopilotCliPathToSdk(
        "C:\\repo\\node_modules\\@github\\copilot-win32-x64\\copilot.exe",
        "win32",
      ),
    ).toBe(true);
  });
});
