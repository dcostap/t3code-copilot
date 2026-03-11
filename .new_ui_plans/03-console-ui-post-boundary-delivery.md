# Console UI Post-Boundary Delivery Plan

## Goal

Now that the console UI has a real backend adapter boundary and a deterministic fake backend, the next goal is to make the new UI meaningfully usable as a backend-driven frontend rather than only a transcript prototype.

This phase focuses on the highest-value missing seams:

- provider capability state
- thread creation and bootstrap flow
- diff fetching and inspection
- live-adapter contract coverage

These are the missing pieces that most directly affect whether the new UI can replace the current frontend for day-to-day local agent workflows.

## Relationship To Plan 02

Plan `02` established the boundary:

- one UI
- one transcript derivation pipeline
- one backend contract surface
- two backend implementations

This plan assumes that foundation exists and stays intact.

This plan does not revisit the adapter split unless implementation exposes a real flaw.

## Current Status

The immediate control-flow regressions found during early implementation have been handled outside this plan:

- serialized snapshot sync instead of overlapping refreshes
- separate event-sequence tracking instead of mixing snapshot and event sequence baselines
- prompt submit guard while a turn is already running
- duplicate-response guards for approval and user-input requests
- interrupt/stop request deduping
- `Shift+Enter` multiline prompt insertion

Those were correctness issues and needed immediate fixes.

The items below remain the intended next feature slices and should stay here as planned follow-up work rather than being mixed into low-level stabilization patches.

## Explicit Deferred Items

These are intentionally still pending after the control-flow hardening pass:

- provider capability UI from canonical server config
- thread creation and bootstrap/empty-state flow
- turn diff and full-thread diff inspection UI
- live-adapter contract coverage

They are still considered required for the console UI to mature into the main frontend surface, but they are not part of the already-completed control-flow fix pass.

## Scope

### In Scope

- surface canonical provider/auth/model state from `server.getConfig` and `server.configUpdated`
- add a real `thread.create` path and clean initial-thread bootstrap behavior
- add canonical turn diff and full-thread diff fetching/inspection
- add contract tests for the live adapter against the real websocket server shape
- expand the command palette so these backend capabilities are actually exercisable

### Out Of Scope

- direct provider SDK integration
- rewriting the transcript rendering model
- broad project/workspace management UI beyond what is needed for thread creation
- image attachment UI

Image attachments are still important, but they are intentionally deferred here because they are lower leverage than capability state, thread creation, diffs, and live contract validation.

## Why These Items Come Next

These are the missing items with the best return on implementation effort:

- capability state proves the new UI is consuming canonical backend readiness signals rather than assuming everything is available
- `thread.create` removes the “single existing thread only” limitation and makes the console viable for real usage
- diff inspection is core to a coding-agent console and is already part of the backend contract
- live-adapter contract tests reduce the risk that the new UI quietly drifts away from the real server while demo mode keeps looking healthy

## Workstream A: Provider Capability Surface

## Objective

Expose backend capability state in a restrained console-oriented way without importing old UI chrome.

## Required Backend Inputs

- `server.getConfig`
- `server.configUpdated`
- canonical provider status list
- canonical model catalogs

## Data To Surface Now

- provider availability
- provider auth state
- provider message / warning text
- available models per provider

## Data Explicitly Deferred

- quota snapshots unless a concrete console UI use appears
- available editors unless needed for a specific command flow

## UI Requirements

- the active provider/model state must be visible without opening secondary pages
- unavailable providers must be visually distinct from ready providers
- unauthenticated providers must be visually distinct from unavailable providers
- provider warning text should be compact and transcript-adjacent, not a large dashboard panel
- model choice commands in the palette must derive from real backend model catalogs, not hardcoded lists

## Suggested Implementation

1. Extend `useConsoleData` to expose canonical server config state cleanly to `App.tsx`.
2. Add a compact capability strip or status segment near the footer/status line.
3. Feed the command palette from actual `serverConfig.providers`.
4. Disable or gate commands that require unavailable/unauthenticated providers.
5. Keep the UI read-only for unsupported capability changes rather than inventing frontend-only state.

## Acceptance

- the console shows provider availability/auth/model state from canonical server config
- config update pushes change the UI without reload
- palette model/provider options are derived from real server config
- demo backend can script ready, unavailable, unauthenticated, and warning states
- no provider/model menu uses hardcoded demo-only options

## Workstream B: Thread Creation And Bootstrap Flow

## Objective

Make the console usable when there is no current thread, when the welcome payload points at a bootstrap thread, and when the user wants to start a new thread intentionally.

## Problems To Solve

- current console behavior still assumes a selected existing thread most of the time
- thread selection is snapshot-first and minimally managed
- there is no proper empty-state action path for creating a new thread

## Required Backend Commands

- `thread.create`
- `thread.turn.start`

## UI Requirements

- if the server welcome provides a bootstrap thread id, prefer it deterministically
- if there are no threads, the console must present a real empty state instead of passive waiting text
- the user must be able to create a new thread from the command palette
- new-thread creation must support immediate “create plus first prompt” flow
- after thread creation, focus and active-thread selection must move predictably to the new thread

## Suggested Implementation

1. Add a small thread-creation state model in `useConsoleData`.
2. Introduce a palette command family:
   - `New Thread`
   - `New Thread With Prompt`
3. Use canonical project/thread fields only:
   - project id
   - thread id
   - title
   - model
   - runtime mode
   - interaction mode
4. On successful create:
   - refresh snapshot
   - switch active thread
   - focus prompt
5. If “with prompt” is used, dispatch `thread.turn.start` immediately after the create path settles.

## Edge Cases

- no projects exist
- welcome bootstrap thread id no longer exists in snapshot
- snapshot arrives before welcome
- thread creation succeeds but immediate first turn fails

## Acceptance

- new thread creation works in both demo and live mode
- empty state exposes a real create-thread path
- bootstrap thread selection is deterministic and test-covered
- creating a thread plus first prompt is possible without manual secondary steps
- active thread selection remains stable after reconnect/resync

## Workstream C: Diff Fetching And Inspection

## Objective

Use the canonical diff query seams to let the console inspect code changes without flattening diffs into vague status text.

## Required Backend Queries

- `orchestration.getTurnDiff`
- `orchestration.getFullThreadDiff`

## Categories

### Turn Diff Inspection

Used when the user wants to inspect the diff associated with a specific assistant turn/checkpoint.

### Full Thread Diff Inspection

Used when the user wants the cumulative diff through a thread up to a selected checkpoint/turn count.

## UI Requirements

- diff fetch should be on-demand, not preloaded for every transcript entry
- transcript blocks should remain compact by default
- when a diff is requested, the result should appear in a dedicated transcript-adjacent surface or expandable inline region
- loading, error, and missing-diff states must be explicit

## Suggested Implementation

1. Add a diff query cache/state layer in `useConsoleData` or a small adjacent hook.
2. Track diff request state by:
   - thread id
   - turn range / turn count
   - query kind
3. Add palette actions for the selected/current checkpoint:
   - `Inspect Turn Diff`
   - `Inspect Full Thread Diff`
4. Render fetched diff text in a restrained monospace panel that feels consistent with transcript output.
5. Preserve transcript compactness by default; do not auto-expand all diffs.

## Edge Cases

- checkpoint summary exists but diff fetch returns missing/error
- repeated request for the same diff
- switching threads while a diff request is in flight
- reconnect during diff inspection

## Acceptance

- turn diff fetch works in demo and live mode
- full-thread diff fetch works in demo and live mode
- diff loading/error/missing states are visible and deterministic
- demo backend returns stable deterministic diff payloads for manual QA and tests
- fetched diff state does not corrupt active-thread or transcript state

## Workstream D: Live Adapter Contract Coverage

## Objective

Validate that the live backend adapter continues to match the real websocket server shape as the fork evolves.

## Why This Matters

The fake backend is useful for UI iteration, but it can create false confidence if the live adapter quietly drifts from:

- websocket envelopes
- welcome payload shape
- config update pushes
- orchestration event pushes
- snapshot/diff response decoding

## Test Targets

- `server.welcome`
- `server.configUpdated`
- `orchestration.domainEvent`
- `orchestration.getSnapshot`
- `orchestration.dispatchCommand`
- `orchestration.getTurnDiff`
- `orchestration.getFullThreadDiff`

## Suggested Test Strategy

1. Add isolated tests for `LiveConsoleBackend` using a mocked websocket transport.
2. Reuse canonical contract decoders rather than hand-built test casts.
3. Validate both success and decode-failure behavior.
4. Add one integration-style test path against the real local websocket server shape where practical.

## Failure Cases To Cover

- malformed welcome payload
- malformed config update payload
- malformed domain event payload
- transport disconnect followed by reconnect
- stale event sequences with snapshot resync

## Acceptance

- live adapter tests cover all subscribed event surfaces
- live adapter tests cover snapshot and diff query decoding
- live adapter tests cover command dispatch path
- decode failures are explicit and do not silently mutate UI state
- reconnect/resync behavior is covered at the adapter boundary

## Workstream E: Command Palette Completion For New Seams

## Objective

Ensure the new backend-driven capabilities are actually exercisable through the command surface that now anchors console interaction.

## Commands To Add Or Replace

- `New Thread`
- `New Thread With Prompt`
- provider/model selection from real server config
- `Inspect Turn Diff`
- `Inspect Full Thread Diff`

## Constraints

- commands must be derived from canonical backend state where applicable
- commands must be hidden or disabled when the required backend state is absent
- palette should not become a generic dumping ground for every backend command

## Acceptance

- every new palette action maps to a real backend command or query
- no palette item claims support for a missing backend seam
- provider/model options are driven by server config, not local constants

## Suggested Phase Order

### Phase 1: Capability Surface

- wire canonical server config into the console shell
- expose provider/auth/model readiness in restrained UI form
- feed palette model/provider commands from real backend state

### Phase 2: Thread Creation

- implement empty-state create-thread flow
- add palette thread creation commands
- stabilize bootstrap thread selection and reconnect behavior

### Phase 3: Diff Inspection

- add diff query state
- implement turn diff and full-thread diff inspection
- expose diff actions in the palette

### Phase 4: Live Contract Coverage

- add `LiveConsoleBackend` tests
- validate decode-failure and reconnect behavior
- add one higher-level integration check if practical

## Manual QA Matrix

Every milestone should be checked in both:

- demo backend mode
- live backend mode

Scenarios:

1. app starts with bootstrap thread from welcome payload
2. app starts with no threads and presents a create-thread path
3. user creates a thread and lands in the prompt of the new thread
4. user creates a thread and immediately sends a first prompt
5. provider status changes from ready to warning
6. provider status changes from authenticated to unauthenticated
7. model choices update after config push
8. user inspects turn diff
9. user inspects full-thread diff
10. diff request fails and the UI shows an explicit error
11. reconnect occurs while a diff view is open
12. reconnect preserves active thread selection

## Completion Bar

This post-boundary phase is complete when:

- canonical server config state is visible in the new UI
- thread creation is supported in both demo and live mode
- bootstrap and empty-state thread flows are deterministic
- turn diff and full-thread diff inspection are supported
- new palette actions map only to real backend seams
- live adapter tests cover welcome, config, events, snapshot, command dispatch, and diff decoding

At that point, the console UI will no longer just be “wired correctly.”

It will cover the next set of backend-driven workflows required for it to feel like a serious primary frontend.
