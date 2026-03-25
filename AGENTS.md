# AGENTS.md

## What this fork is

This fork keeps the current desktop shell, backend runtime, and provider integrations, while building a new frontend direction alongside the existing one. We focus on working on our brand new console-ui. We keep the existing frontend in the repo while the new one is built. We can even use the existing one as reference, as the existing one will keep evolving in the original repo, and we need to do the same with our new one.

The goal is not a generic chat app. It is a focused coding-agent console.

## Product vision

The app should feel like a sharp local instrument: fast, focused, keyboard-first, with a global command palette for everything, unicode-text-based.

## Philosophy

- Clarity over feature sprawl.
- Responsiveness over ornamental UI.
- Predictable streaming and transcript behavior over clever rendering.
- Long-term maintainability over quick UI hacks.
- We build new flows intentionally from first principles.
- We preserve and leverage the backend/provider/runtime boundary.
- We keep shared contracts canonical.
- If the frontend needs new behavior, we evolve contracts and runtime events cleanly instead of inventing frontend-only protocol or ad hoc client state.
- We avoid duplicating logic across frontend surfaces when a shared primitive would do.

## Fork sync constraints

- Prefer console-ui changes and Copilot-specific adapter changes over edits to shared backend layers when solving provider-specific behavior differences.
- Avoid modifying non-Copilot backend code unless there is no viable Copilot-local path.
- Keep upstream-sensitive backend behavior as close to origin as possible so this fork stays easier to sync.

## Completion requirements

- `bun lint` must pass before work is considered complete.
- `bun typecheck` must pass before work is considered complete.
- Use `bun run test`, never `bun test`.

## Testing expectations

- Prefer tests that validate semantic behavior, data flow, and stable contracts.
- Do not write or keep brittle tests that fail on non-contractual presentation changes.
- For terminal/transcript UI, test structure, kinds, metadata, state transitions, prompt gating, and selection/copy behavior rather than exact spacing, decorative separators, box-drawing output, class ordering, or internal widget signature formatting unless those details are the contract.

## Transcript widget guidelines

- For transcript/history widgets rendered via `WidgetType` and `Decoration.replace(..., block: true)`, do not use external layout `margin` on the widget root.
- Put spacing inside the widget with padding, or represent spacing as explicit transcript spacer lines/gaps in the document model.
- Avoid root-level layout transforms on replacement widgets. Child-only transforms on internal controls are acceptable when they do not affect the widget boundary box.
- Keep widget root geometry aligned with the visible occupied area so pointer hit-testing and text selection stay accurate near widget boundaries.
- If a replacement widget needs custom pointer geometry, use `WidgetType.coordsAt(...)` rather than patching selection behavior elsewhere.
- Prefer fixing spacing in the transcript/block pipeline over papering over it in CSS.
- Be especially careful with widgets placed near selectable plain text, because boundary geometry bugs show up there first.

### Practical rule of thumb

- `padding`: safe
- explicit transcript spacer line: safe
- root `margin`: risky
- root layout transform: risky
