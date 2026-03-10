# AGENTS.md

## Purpose

This fork keeps the existing desktop stack and multi-provider backend, and adds a new frontend direction alongside the current one.

The goal is to build a cleaner, more intentional coding-agent desktop app:

- dark, restrained, monospace-first
- one main transcript column
- bottom composer dock
- slash commands and command palette
- structured blocks for tool calls, patches, plans, and reasoning
- almost no chrome
- keyboard-first, mouse-capable
- fast enough to feel like a CLI

This is not meant to evolve into a generic chat dashboard. The target is a focused agent console with strong transcript UX.

## Product Direction

- Keep the backend stack, provider integrations, event model, and desktop packaging flow.
- Keep the existing frontend in the repo while building a new frontend alongside it.
- Make the new frontend the main product surface over time, without requiring immediate deletion of the current one.
- Reuse pieces of the existing frontend only when they are clearly useful. Do not inherit old UI patterns by default.
- Favor simple, text-first interactions over dense control surfaces.
- The transcript is the product. Input, streaming, diffs, approvals, plans, and tool activity should all support transcript quality first.

## Core Priorities

1. Product clarity over feature sprawl.
2. Responsiveness over ornamental UI.
3. Predictable streaming and transcript behavior over clever rendering.
4. Strong local-first agent workflows over generic SaaS assumptions.
5. Long-term maintainability over quick UI hacks.

If a tradeoff is required, choose coherence, reliability, and transcript quality.

## Engineering Expectations

- Do not treat the existing web UI as the design source of truth.
- Do not assume the current frontend must be rewritten in place. Parallel frontend development is a valid and preferred path.
- Build new UI flows intentionally from first principles.
- Preserve the provider/runtime boundary. Provider-specific quirks belong in the backend adapter layer, not in the frontend.
- Keep shared contracts canonical. If the frontend needs new behavior, prefer evolving contracts and runtime events cleanly rather than inventing ad hoc client state.
- Avoid duplicating logic across frontend surfaces. Extract shared primitives when behavior is reused.
- Keep the UI visually restrained. No generic enterprise dashboard patterns.

## Package Roles

- `apps/server`: canonical provider runtime and WebSocket backend. This is the core integration layer for Codex, Copilot, and future providers.
- `apps/desktop`: desktop shell and native integration surface.
- `apps/web`: current frontend surface. Keep it available while building the new product UI in parallel.
- `packages/contracts`: canonical schemas and protocol contracts shared by backend and frontend.
- `packages/shared`: shared runtime utilities used across packages.

## Backend Boundary

The backend is a major reason this fork exists. Protect these qualities:

- provider abstraction
- canonical runtime events
- resumable sessions
- approval and user-input flows
- provider-specific capability handling

Frontend work should adapt to this backend cleanly, not bypass it.

## Completion Requirements

- `bun lint` must pass before considering work complete.
- `bun typecheck` must pass before considering work complete.
- Never use `bun test`; use `bun run test`.

## Practical Notes

- Prefer evolving this fork over building parallel prototypes in the old TUI repo.
- Prefer adding the new frontend beside the existing one rather than forcing a risky in-place rewrite.
- When making UX decisions, bias toward the desired product feel, not toward preserving legacy frontend behavior.
- When in doubt, make the app feel more like a sharp local instrument and less like a web app in a window.
