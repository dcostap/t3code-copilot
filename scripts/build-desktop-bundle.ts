#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Effect, Layer, Logger } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DesktopSurface = ["web", "console"] as const;
type DesktopSurface = (typeof DesktopSurface)[number];

class BuildDesktopBundleError extends Data.TaggedError("BuildDesktopBundleError")<{
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
    return yield* new BuildDesktopBundleError({
      message: `${context} exited with code ${exitCode}`,
    });
  }
});

const buildDesktopBundle = Effect.fn("buildDesktopBundle")(function* (input: {
  readonly surface: DesktopSurface;
  readonly verbose: boolean;
}) {
  const commandOutputOptions = {
    stdout: input.verbose ? "inherit" : "ignore",
    stderr: "inherit",
    shell: process.platform === "win32",
  } as const;

  const frontendPackage = frontendPackageForSurface(input.surface);

  yield* Effect.log(
    `[desktop-build] surface=${input.surface} frontend=${frontendPackage} backend=t3 desktop=@t3tools/desktop`,
  );

  yield* runCommand(
    ChildProcess.make({
      cwd: process.cwd(),
      ...commandOutputOptions,
    })`bun turbo run build --filter=${frontendPackage}`,
    `build frontend surface '${input.surface}'`,
  );

  yield* runCommand(
    ChildProcess.make({
      cwd: process.cwd(),
      ...commandOutputOptions,
    })`bun run --cwd apps/server build -- --surface=${input.surface}`,
    "build server bundle",
  );

  yield* runCommand(
    ChildProcess.make({
      cwd: process.cwd(),
      ...commandOutputOptions,
    })`bun turbo run build --filter=@t3tools/desktop`,
    "build desktop shell",
  );
});

const cli = Command.make("build-desktop-bundle", {
  surface: Flag.choice("surface", DesktopSurface).pipe(
    Flag.withDescription("Desktop renderer surface to bundle. Defaults to console."),
    Flag.withDefault("console"),
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Build desktop runtime artifacts for a specific renderer surface."),
  Command.withHandler(buildDesktopBundle),
);

const runtimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(runtimeLayer),
  NodeRuntime.runMain,
);
