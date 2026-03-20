#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Effect, Layer, Logger } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DesktopSurface = ["web", "console"] as const;
type DesktopSurface = (typeof DesktopSurface)[number];

class StartDesktopBundleError extends Data.TaggedError("StartDesktopBundleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const frontendPackageForSurface = (surface: DesktopSurface) =>
  surface === "console" ? "@t3tools/console-ui" : "@t3tools/web";

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  context: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new StartDesktopBundleError({
      message: `${context} exited with code ${exitCode}`,
    });
  }
});

const startDesktopBundle = Effect.fn("startDesktopBundle")(function* (input: {
  readonly surface: DesktopSurface;
  readonly skipBuild: boolean;
}) {
  const frontendPackage = frontendPackageForSurface(input.surface);

  yield* Effect.log(
    `[desktop-start] surface=${input.surface} frontend=${frontendPackage} backend=t3 desktop=@t3tools/desktop`,
  );

  if (!input.skipBuild) {
    yield* runCommand(
      ChildProcess.make({
        cwd: process.cwd(),
        stdout: "inherit",
        stderr: "inherit",
        shell: process.platform === "win32",
      })`bun run build:desktop -- --surface=${input.surface}`,
      `build desktop surface '${input.surface}'`,
    );
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make({
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      shell: process.platform === "win32",
    })`bun run --cwd apps/desktop start`,
  );

  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new StartDesktopBundleError({
      message: `start desktop surface '${input.surface}' exited with code ${exitCode}`,
    });
  }
});

const cli = Command.make("start-desktop-bundle", {
  surface: Flag.choice("surface", DesktopSurface).pipe(
    Flag.withDescription("Desktop renderer surface to run. Defaults to console."),
    Flag.withDefault("console"),
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription("Reuse existing built artifacts and launch immediately."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Build and launch the desktop app for a specific renderer surface."),
  Command.withHandler(startDesktopBundle),
);

const runtimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(runtimeLayer),
  NodeRuntime.runMain,
);
