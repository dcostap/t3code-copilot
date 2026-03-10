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

## Completion requirements

- `bun lint` must pass before work is considered complete.
- `bun typecheck` must pass before work is considered complete.
- Use `bun run test`, never `bun test`.

## Testing expectations

- Prefer tests that validate semantic behavior, data flow, and stable contracts.
- Do not write or keep brittle tests that fail on non-contractual presentation changes.
- For terminal/transcript UI, test structure, kinds, metadata, state transitions, prompt gating, and selection/copy behavior rather than exact spacing, decorative separators, box-drawing output, class ordering, or internal widget signature formatting unless those details are the contract.
