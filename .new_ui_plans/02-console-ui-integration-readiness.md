# Console UI Integration Readiness Plan

## Goal

Keep the new UI usable as an offline demo, but stop treating demo mode as a separate frontend reality.

The new UI should become a real client of the existing backend contracts, with a fake backend mode for demo and testing.

That gives us:

- one UI architecture
- one transcript model
- one command surface
- one set of backend contracts
- two backends:
  - live websocket backend
  - deterministic fake backend

## Assumptions

This plan assumes all of the following are true and intentional:

- the new UI is a new frontend alongside the existing frontend, not an in-place rewrite
- the existing frontend remains in the repo and continues to work
- the existing backend in `apps/server` remains the canonical backend
- the backend/provider/runtime boundary is preserved
- the backend is already designed to support both the Codex CLI path and the Copilot integration path
- the new UI should reuse that backend rather than creating a second provider integration architecture
- the repo is a fork that will continue to absorb external/upstream changes over time
- keeping the new UI aligned to canonical contracts is a maintenance strategy, not just an implementation detail

The practical consequence is:

- backend fixes should benefit both frontends
- provider/runtime fixes should benefit both frontends
- contract changes should be absorbed in one shared place
- the new UI should stay thinly coupled to canonical contracts so it can evolve with the fork instead of fighting it

## Desired End State

The new UI should be able to:

- render canonical orchestration snapshots
- react to canonical orchestration domain events
- dispatch canonical orchestration commands
- surface provider capability state from canonical server config payloads
- run fully offline against a scripted fake backend
- run against the real local backend without needing real external providers

The fake backend should simulate:

- streaming assistant turns
- tool activity
- approval requests and responses
- user-input requests and responses
- runtime warnings and errors
- reconnect and resync
- provider availability and auth states
- model catalogs
- quota snapshots
- diff availability

## Non-Goals

- connecting the new UI directly to provider SDKs
- inventing frontend-only runtime contracts
- keeping demo behavior embedded in presentation components
- blocking progress on real-provider access before transcript integration is ready

## Core Principle

The UI should depend on a backend adapter interface, not on ad hoc demo mutations.

The adapter interface should expose only canonical repo concepts:

- server config
- orchestration snapshot
- repo-level events
- orchestration commands
- diff queries

The adapter must stay thin.

It should not:

- invent a second client protocol
- return transcript rows or frontend-shaped render models
- hide canonical backend state behind custom UI abstractions

It should:

- wrap the existing websocket/native API shape in live mode
- emit canonical data and events in demo mode
- let transcript derivation stay shared between live and demo
- expose a small number of repo-meaningful event surfaces rather than raw websocket channel mechanics

Everything else should be an implementation detail of either:

- the live websocket adapter
- the fake scripted adapter

## Design Notes

These are deliberate choices in the plan, not omissions.

### 1. We Are Not Building a Console-Specific Backend Contract

The adapter exists to unify live and demo backends behind canonical repo concepts.

It does not exist to:

- redefine the backend protocol for the console
- introduce frontend-only runtime concepts
- return transcript-specific structures instead of canonical data

If that happens, the new UI becomes harder to keep in sync with the shared backend and harder to maintain as the fork absorbs external changes.

### 2. We Prefer Repo-Level Event Surfaces, Not Raw Transport Mirroring

The plan does not force exactly one unified event stream.

That is intentional.

The real requirement is:

- do not expose websocket channels one-for-one
- do expose a very small number of semantically meaningful event surfaces

Why this is not forced into exactly one stream:

- one giant event union can become harder to consume than a couple of well-defined repo-level streams
- semantic clarity matters more than artificial collapse
- we want to avoid raw channel mechanics, not force a worse consumer API in the name of purity

### 3. We Narrowed Capability State, But Did Not Delete It

Provider availability, auth state, and model catalog are required early because they are part of interface readiness for a real backend-driven frontend.

Quota/editor metadata were moved to later because they are lower priority for the current maturity of the new UI.

They were not removed entirely because:

- they are still canonical backend data
- the new UI may need them later
- deleting them from the plan entirely would imply they are legacy-only, which is too strong

### 4. Fake Backend Determinism Is a Boundary Requirement, Not Test Polish

The deterministic scenario model is included early because the main risk is false confidence.

If the fake backend is not deterministic:

- tests become noisy
- transcript behavior becomes timing-dependent
- the demo path drifts from the backend model it is supposed to validate

That is why clock ownership, event ordering, scheduling, command acknowledgement, and reconnect semantics are all explicit.

### 5. Attachments and Diff Inspection Are Important, But Not the Main Architectural Risk

The plan now splits submission seams from inspection seams because that improves execution clarity.

But this area was never the primary architectural danger.

The primary dangers were:

- inventing a frontend-only protocol
- letting demo mode become a separate product architecture
- making the fake backend nondeterministic

That is why those issues are guarded more aggressively than the exact grouping of attachments and diffs.

## Architecture Recommendation

### 1. Add a Console Backend Adapter Layer

Introduce a small `ConsoleBackend` abstraction in `apps/console-ui`.

Responsibilities:

- connect/disconnect
- expose connection state
- fetch server config
- fetch orchestration snapshot
- subscribe to repo-level events
- dispatch orchestration commands
- fetch turn diff / full thread diff

Preferred shape:

- one repo-level event subscription if it stays semantically clean
- otherwise a very small number of repo-meaningful event streams

Avoid:

- mirroring websocket channels one-for-one
- turning the adapter into a mini client SDK

Implementations:

- `LiveConsoleBackend`
- `DemoConsoleBackend`

The UI and console data hooks should talk only to this abstraction.

Important constraint:

- transcript derivation remains outside the adapter
- both live and demo backends feed the same derivation pipeline

### 2. Move Demo Logic Behind the Adapter

Current demo behavior is already much better than a static transcript, but it still lives inside the console data hook.

Refactor demo behavior so that:

- fake snapshot evolution
- fake streaming
- fake approvals
- fake user input
- fake provider states
- fake diff responses

are produced by `DemoConsoleBackend`, not by UI state reducers.

This keeps the UI honest.

### 2.5. Define a Deterministic Scenario Execution Model

The fake backend must be deterministic from day one.

Define explicit rules for:

- event ordering
- clock ownership
- timer/scheduler control
- command acknowledgement behavior
- reconnect/resync semantics

Recommended rules:

- scenarios emit a totally ordered sequence of events
- tests do not depend on wall-clock timers
- scenario time is driven by a fake clock or scripted scheduler
- command acknowledgement is explicit and deterministic
- reconnect behavior defines exactly what is replayed, refetched, or resynced
- pending approvals and pending user-input state must survive reconnect according to the scripted backend rules

If this is not defined early, the fake backend will become flaky and give false confidence.

### 3. Reuse Contract Decoding Everywhere

The new UI should decode inbound payloads with the same schemas the old UI uses.

That includes:

- `WsWelcomePayload`
- `ServerConfigUpdatedPayload`
- `OrchestrationEvent`
- websocket envelopes

Do not rely on unchecked object casts for integration-facing paths.

### 4. Keep the Transcript Product-Centric

The transcript remains the product surface.

But transcript rendering should be fed by:

- canonical messages
- canonical activities
- canonical plans
- canonical checkpoints
- canonical diff query results

not by separate demo-only block types.

## Workstreams

## Workstream A: Backend Adapter Foundation

Deliverables:

- `ConsoleBackend` interface
- live implementation over websocket transport
- demo implementation with scripted scenarios
- shared decoding utilities

Acceptance:

- `useConsoleData` no longer owns transport details directly
- `useConsoleData` no longer owns demo orchestration simulation directly
- switching between live and demo is just backend selection
- the adapter returns canonical repo payloads only, never transcript rows
- transcript derivation is shared between live and demo
- fake backend scenarios run under deterministic clock and ordering rules

## Workstream B: Command Surface Parity

Implement the missing or incomplete command paths needed for realistic testing:

- `thread.create`
- `thread.turn.start`
- `thread.turn.interrupt`
- `thread.approval.respond`
- `thread.user-input.respond`
- `thread.runtime-mode.set`
- `thread.interaction-mode.set`
- `thread.session.stop`

Also verify thread switching and bootstrap behavior against:

- welcome bootstrap ids
- snapshot fallback selection
- empty-state handling

Acceptance:

- every command exposed in the new UI maps to a real backend command
- the fake backend supports the same commands

## Workstream C: Provider Capability Surface

The new UI should consume server config data from the backend.

Required now:

- provider availability
- auth state
- provider messages
- model catalogs
- config update pushes

Later, if the new UI actually needs them:

- quota snapshots
- available editors

This does not mean copying the old UI visually.

It means preserving the same backend-facing capability model in a simpler console-oriented form.

Acceptance:

- new UI can reflect unavailable providers
- new UI can reflect unauthenticated providers
- new UI can expose real model choices
- fake backend can script provider/auth/model states
- quota and editor metadata are optional until the new UI has a concrete use for them

## Workstream D: Attachment and Diff Readiness

Implement the real frontend seams for two different categories.

Submission seams:

- new-thread creation with first prompt
- image attachment submission

Inspection seams:

- checkpoint diff fetching
- full-thread diff fetching

The transcript can stay compact by default, but it should be able to fetch and render real diff data when requested.

Acceptance:

- new UI can submit image attachments through canonical upload command shape
- new UI can request turn diffs and full-thread diffs
- fake backend can return deterministic diff payloads

## Workstream E: Transcript Coverage

Audit runtime/activity kinds that matter for the agent console and decide which deserve:

- dedicated transcript block types
- generic status rendering

Priority categories:

- approvals
- user input
- plans
- tool calls
- command execution
- diffs
- warnings/errors
- reasoning/task progress

Do not aim for a special block type for every backend event.

Do aim for clear rendering of the events that materially affect the user workflow.

Acceptance:

- important workflow events are not silently flattened into vague status lines
- transcript remains compact and text-first
- activities and messages render in stable order under bursty event streams

## Workstream F: Test Harness

Create a test strategy that does not depend on real providers.

Recommended layers:

### Unit

- transcript derivation
- adapter decoding
- command mapping
- pending approval / pending user-input derivation
- diff query state logic

### Integration

Run the console UI against `DemoConsoleBackend` scenarios:

- streaming success
- approval pause then accept
- approval pause then decline
- user-input pause then answer
- runtime error
- reconnect then snapshot resync
- provider unavailable
- provider unauthenticated
- quota warning state
- diff available

Scenario execution rules:

- each scenario defines an ordered event script
- each scenario uses a fake clock or scripted scheduler
- async progression is advanced explicitly by the test harness
- reconnect/resync behavior is part of the scenario definition, not implicit timing

### Contract

Run the live adapter against the real local websocket server shape, but with mocked/local backend behavior rather than external provider access.

This should validate:

- websocket envelope handling
- welcome payload handling
- config update handling
- orchestration command dispatch
- snapshot resync behavior

Acceptance:

- `apps/console-ui` no longer has zero meaningful tests
- demo scenarios become reusable fixtures for local manual QA and automated tests
- reconnect during pending approval is covered
- reconnect during pending user-input is covered

Minimum early scenarios:

- streaming success
- approval pause then accept
- reconnect then snapshot resync
- reconnect while approval is pending
- reconnect while user-input is pending

## Suggested Phase Order

### Phase 1: Stabilize the Boundary

- add `ConsoleBackend`
- split live and demo implementations
- centralize schema decoding
- add a minimal scenario harness
- define deterministic scenario execution rules
- add transcript-derivation tests
- add early scenarios:
  - streaming success
  - approval pause then accept
  - reconnect then snapshot resync
  - reconnect while approval is pending
  - reconnect while user-input is pending

### Phase 2: Complete Core Commands

- verify all current console commands use the adapter
- add missing `thread.create`
- clean up active-thread/bootstrap flow

### Phase 3: Add Capability State

- consume `server.getConfig`
- consume `server.configUpdated`
- expose provider/model/auth state in a restrained console form
- defer quota/editor metadata unless the new UI needs them

### Phase 4: Add Attachments and Diffs

- implement image attachments
- implement turn diff fetching
- implement full thread diff fetching

### Phase 5: Expand the Scenario Harness

- add broader scripted demo backend scenarios
- expand automated tests over those scenarios
- manual QA checklist

## Manual QA Matrix

Every milestone should be checked in both:

- demo backend mode
- live backend mode

Scenarios:

1. open app with bootstrap thread
2. switch threads
3. send prompt
4. observe streaming response
5. accept approval
6. decline approval
7. answer user-input request
8. change runtime mode
9. change interaction mode
10. interrupt running turn
11. stop session
12. inspect diff
13. simulate provider unavailable/auth missing/quota warning
14. reconnect and confirm snapshot resync
15. reconnect while approval is pending
16. reconnect while user-input is pending

## Completion Bar

The new UI is ready to become the main frontend surface when:

- it talks only through canonical backend adapters
- demo mode is powered by a fake backend, not special UI logic
- core orchestration commands are covered
- provider capability state is surfaced
- attachments and diffs are supported
- automated tests cover scripted agent scenarios
- transcript ordering is deterministic under bursty event streams
- keyboard workflow and focus behavior are reliable across transcript and composer interactions
- reconnect/resync is reliable for pending approvals
- reconnect/resync is reliable for pending user-input flows

At that point, "offline demo" and "real backend client" are no longer competing goals.

They are the same UI running against different backend implementations.
