# T3 Code + Copilot

This repo is a T3 Code fork that stays up to date with upstream and adds GitHub Copilot support.

T3 Code is a minimal web GUI for coding agents. This fork supports both Codex and GitHub Copilot.

## New Console Development

This fork is building a new desktop-first console UI alongside the existing frontend. Use the desktop shell with an explicit surface flag:

```bash
bun install
bun run dev:desktop -- --surface=console
```

Useful commands:

```bash
# New desktop console with live reload
bun run dev:desktop -- --surface=console

# Existing desktop/web surface with live reload
bun run dev:desktop -- --surface=web

# Build desktop runtime artifacts for a chosen surface
bun run build:desktop -- --surface=console

# Run the built desktop app for a chosen surface
bun run start:desktop -- --surface=console
```

The `--surface` flag is required for desktop dev/build/start so it is always explicit whether you are running the new console or the existing web UI.

## Preview

<img width="1792" height="1001" alt="2026-03-09_02-36-10" src="https://github.com/user-attachments/assets/2d2bb48f-1485-44e0-804e-468f4111d376" />
<img width="1912" height="1178" alt="image" src="https://github.com/user-attachments/assets/38cd4bb2-b27e-47e6-9565-d26c4c97fdd3" />

## This fork

- tracks upstream `pingdotgg/t3code`
- adds GitHub Copilot provider support
- keeps Codex support working too

## How to use

> [!WARNING]
> You need to have either [Codex CLI](https://github.com/openai/codex) or GitHub Copilot available and authorized for T3 Code to work.

The easiest way to use this fork is the desktop app.

- Download it from the [releases page](https://github.com/zortos293/t3code-copilot/releases)
- Launch the app and choose either `Codex` or `GitHub Copilot`

You can also run it from source:

```bash
bun install
bun run dev
```

Open the app, connect your provider, and start chatting.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
