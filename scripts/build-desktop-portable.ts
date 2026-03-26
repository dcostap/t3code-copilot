#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workingRoot = path.join(repoRoot, ".tmp", "desktop-portable");
const artifactDir = path.join(workingRoot, "artifacts");
const nextDistDir = path.join(workingRoot, "next-dist");
const distDir = path.join(repoRoot, "dist");
const portableExeName = "T3-Code.exe";

function resetDirectory(targetPath: string) {
  rmSync(targetPath, { recursive: true, force: true });
  mkdirSync(targetPath, { recursive: true });
}

function fail(message: string): never {
  console.error(`[desktop-portable] ${message}`);
  process.exit(1);
}

resetDirectory(artifactDir);
resetDirectory(nextDistDir);

const buildScriptPath = path.join(repoRoot, "scripts", "build-desktop-artifact.ts");
const buildArgs = [
  buildScriptPath,
  "--surface",
  "console",
  "--platform",
  "win",
  "--target",
  "portable",
  "--arch",
  "x64",
  "--output-dir",
  artifactDir,
  ...process.argv.slice(2),
];

console.log(`[desktop-portable] Building portable Windows artifact into ${artifactDir}`);
const buildResult = spawnSync(process.execPath, buildArgs, {
  cwd: repoRoot,
  stdio: "inherit",
});

if (buildResult.status !== 0) {
  fail(`Portable desktop build failed with exit code ${buildResult.status ?? 1}.`);
}

const artifactEntries = readdirSync(artifactDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"));

if (artifactEntries.length !== 1) {
  const produced = artifactEntries.map((entry) => entry.name).join(", ") || "none";
  fail(`Expected exactly one portable .exe artifact, found ${artifactEntries.length} (${produced}).`);
}

const portableArtifact = artifactEntries[0];
if (!portableArtifact) {
  fail("Portable .exe artifact resolution failed.");
}

const portableSourcePath = path.join(artifactDir, portableArtifact.name);
const portableTargetPath = path.join(nextDistDir, portableExeName);
cpSync(portableSourcePath, portableTargetPath);

mkdirSync(distDir, { recursive: true });
const deployedPortablePath = path.join(distDir, portableExeName);

try {
  rmSync(deployedPortablePath, { force: true });
  cpSync(portableTargetPath, deployedPortablePath);
} catch (error) {
  fail(
    `Built portable artifact but could not refresh ${deployedPortablePath}. ` +
      `If the app is running, close it and copy ${portableSourcePath} manually. ` +
      `Original error: ${error instanceof Error ? error.message : String(error)}`,
  );
}

rmSync(workingRoot, { recursive: true, force: true });

console.log(`[desktop-portable] Portable desktop deployed to ${path.join("dist", portableExeName)}`);
