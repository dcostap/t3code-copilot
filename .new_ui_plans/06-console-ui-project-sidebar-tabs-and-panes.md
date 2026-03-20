# Console UI Project Sidebar, Tabs, And Pane Model

## Goal

Define the first serious project-navigation and workspace-layout model for the new console UI.

This plan turns the console from a single-thread transcript surface into a project-scoped environment with:

- a left project and thread tree
- project-local tabs
- project-local pane layouts
- draft panes that exist before a real thread is created
- deterministic rules for opening, locating, moving, and persisting threads in the layout

The goal is not to build every future archive and management surface now.

The goal is to define a clean, stable v1 interaction model that fits the current backend contracts and the desired keyboard-first desktop console.

## Canonical Boundary

The backend already has a canonical `project` concept.

We should reuse that instead of inventing a second frontend-only workspace model.

Canonical backend concepts:

- `project.id`
- `project.title`
- `project.workspaceRoot`
- `project.defaultModel`
- `thread.projectId`
- `thread.provider`
- `thread.worktreePath`

Current server-side cwd resolution is already the right authority:

- effective cwd = `thread.worktreePath ?? project.workspaceRoot`

This plan treats that as canonical.

The console UI must not redefine project ownership or cwd precedence.

## UI-Owned Layer

The following concepts are intentionally UI-owned and are not backend domain entities:

- left sidebar expansion and ordering state
- project-local tabs
- pane layout within a tab
- draft panes that do not yet have a real thread
- tab activation and pane focus state
- pulse/highlight navigation affordances
- drag-and-drop placement of threads into panes

These can evolve without forcing backend model changes as long as they remain shells around canonical `project` and `thread` entities.

## Project Model In The Console

Each project appears in the left sidebar as one collapsible root item.

Project row rules:

- default expanded the first time it appears
- expanded or collapsed state is persisted
- projects are manually reorderable by drag and drop
- project order is persisted
- the visible project label is the full project path
- the project path is the primary identity shown to the user, not a shortened custom label

Project row interaction:

- the main body of the project row selects that project
- a separate disclosure control toggles collapse and expand
- clicking the row must not ambiguously both select and collapse

Project selection behavior:

- selecting a project activates that project's persisted layout in the main region
- the console should restore the last active tab and pane for that project
- project switching is a project-layout swap, not a partial in-place mutation

Conceptually, each project owns its own self-contained UI workspace.

## Thread List In The Left Sidebar

Under each expanded project, the sidebar shows child rows for that project's real threads.

Thread list rules:

- show only real, unarchived threads
- do not show unsent draft panes here
- sort by most recent activity descending
- activity means the latest meaningful thread activity, not merely creation time

Thread row content:

- primary label is the thread title
- thread title is derived from the first prompt the user sent
- the title is frozen after that
- a future manual rename feature may exist later, but automatic retitling is out of scope
- the visible title truncates to the available row width
- on hover, show a tooltip with the initial prompt, expanded up to 500 characters

Cwd metadata:

- if the thread's effective cwd is the same as the project's `workspaceRoot`, show no cwd sublabel
- if the thread has its own cwd override, show that cwd as smaller muted text beneath the thread title

Compact status chrome:

- each thread row should show compact status UI for activity state
- when the agent is currently working, show a succinct working indicator plus elapsed time so far
- when the agent has finished and is waiting for the user, show the last task duration
- if it has been waiting longer than one minute, also show how long it has been waiting

This status treatment should stay compact and information-dense.

Exact visual styling can be refined later without changing the underlying behavior contract.

## Project Boundary Rules

Project boundaries are strict.

A thread may only be mounted inside the layout of its own project.

Not allowed:

- dragging a thread into another project's tab layout
- opening the same thread inside a different project's workspace
- treating tabs as global across projects

Allowed:

- switching between projects
- restoring each project's own saved layout independently

## Tabs

Each project owns its own set of tabs.

Tabs are structural containers, not named semantic objects.

Tab rules:

- tabs have stable internal ids
- visible tab titles are auto-generated from their current position only
- titles are not stored
- titles use simple labels like `Tab 1`, `Tab 2`, `Tab 3`
- no manual rename in v1
- no manual tab reorder in v1
- tabs stay in creation order

Tab lifecycle:

- a tab must contain at least one pane
- if a tab has no panes, it is removed immediately
- if a project has no tabs, the UI auto-creates one new tab containing one fresh draft pane

Manual new-tab behavior:

- `New Tab` creates exactly one fresh draft pane in that project
- no empty tab shell
- no thread picker-first state

Tab closing behavior:

- when closing a tab, activate the tab immediately to the left if it exists
- otherwise activate the tab to the right
- if the closed tab was the last remaining tab, auto-create a fresh draft tab and activate it

## Panes

A pane is a layout slot inside a tab.

A pane can either:

- show a real thread
- or be a persisted draft pane that has not created a real thread yet

Panes are the unit of split layout.

## Real Thread Pane Uniqueness

Within one project's layout, a real thread may have at most one live pane.

This is a hard rule for v1.

Consequences:

- clicking a thread can deterministically locate its pane
- drag-and-drop can move a thread between panes without duplication
- transcript, scroll, and active work state do not need to be mirrored across multiple visible copies of the same thread

Draft panes do not participate in this uniqueness rule because they are not real threads yet.

## Draft Panes

Draft panes are first-class layout items.

They exist before a real thread exists.

Draft pane rules:

- a project may have multiple draft panes at the same time
- draft panes persist in the saved project layout
- draft panes are not shown in the left thread tree
- closing an unsent draft pane removes only that pane, not a thread

Draft pane contents can include:

- selected provider
- selected model
- interaction mode
- cwd override or worktree override
- draft prompt text
- any other pre-send setup needed by the composer

## Provider Defaults For Drafts

The console should persist the last explicitly chosen provider.

An explicit provider choice includes:

- choosing a provider in the draft pane provider UI
- changing the provider via command palette while the pane is still a draft

New draft panes should default to that last explicitly chosen provider rather than starting blank.

The pane still remains a draft, so the provider can be changed freely before first send.

This preserves low friction without violating the rule that a real thread's provider becomes fixed once the thread is created.

## Pane-First, Thread-Later Lifecycle

This plan intentionally chooses pane-first, thread-later behavior.

Creating a new pane does **not** immediately create a real thread.

Instead:

1. the pane is created as a draft pane
2. the user can choose provider and configure draft state
3. the real thread is created only when the user sends the first prompt

Why:

- it matches the current direction of the console-ui state model
- it avoids polluting the backend with empty placeholder threads
- it fits the current invariant that provider is fixed at thread creation
- it fits the rule that thread title comes from the first prompt

## First Send Behavior

On the first successful send from a draft pane:

1. create a real thread using the draft configuration
2. create the first turn
3. derive the thread title from the first prompt
4. freeze the title afterward
5. replace the draft pane state with a real thread binding
6. insert the newly created thread into the left thread tree

If the pane is closed before the first send:

- no backend thread exists
- nothing should be added to the thread list

## Clicking Projects And Threads

### Clicking a project

Clicking a project row:

- activates that project
- restores that project's last active tab and pane
- does not force navigation to `Tab 1` once the project already has saved state

### Clicking a thread

Clicking a thread row:

1. activates that thread's project
2. checks whether the thread already has a live pane in that project layout
3. if yes, switches to that pane's tab
4. if that tab contains more than one pane, pulse-highlight the target pane with a subtle rapid white-border pulse three times
5. if the thread does not currently have a pane anywhere, create a new tab with that thread as its main pane

This makes the thread tree both a locator and an opener.

## Drag And Drop

### Projects

Projects in the sidebar can be dragged to reorder them.

The resulting order is persisted.

### Threads to panes

Drag-and-drop from the thread tree into a pane is the explicit thread-assignment flow.

Rules:

- dropping a thread onto a draft pane mounts that thread into that pane
- dropping a thread onto a pane already showing another thread replaces the existing pane binding
- the displaced thread is only removed from that pane, not deleted and not archived
- if the dragged thread already has a live pane elsewhere in the project, the thread is moved rather than duplicated

This keeps one live pane per real thread while still supporting fast rearrangement.

## Split Model

The pane tiling model is intentionally simple and deterministic in v1.

It is not a freeform layout tree.

The tab supports at most six panes.

Split creation rule:

- splitting creates a brand-new draft pane by default
- it does not clone the existing thread
- it does not open a thread picker first

Pane count rules:

- maximum of six panes per tab
- when a tab already has six panes, split actions are disabled

Canonical layout algorithm:

1. one pane:
   - single full-size pane
2. two panes:
   - equal-width horizontal split
3. three panes:
   - all panes share width equally
4. four panes:
   - split the third pane in half on the Y axis
   - panes three and four share the third column's horizontal space and divide its vertical space
5. five panes:
   - apply the same Y-axis split pattern to the second pane column
6. six panes:
   - apply the same Y-axis split pattern to the first pane column

This gives a predictable six-pane cap without requiring arbitrary nested layout editing.

## Pane Removal And Reflow

When a pane is closed:

- remove that pane from the tab
- do not delete or archive the underlying thread
- if the pane was a draft pane, only the draft pane is removed
- if the tab becomes empty, remove the tab
- recompute the tab's layout using the canonical layout algorithm for the new pane count

The UI should not try to preserve ad hoc geometry after removal.

Deterministic reflow is simpler and matches the fixed-layout model.

## Persistence

Project-local layout state is persisted and restored.

Persisted per project:

- tab list
- pane list per tab
- pane bindings to real threads
- draft pane state
- pane setup state
- last active tab
- last active pane

Persisted globally or in shared UI preferences:

- manual project ordering
- project expanded or collapsed state
- last explicitly chosen provider for new draft panes

Persisted layout should restore the user to the same working structure they left.

## Relationship To Canonical Thread And Cwd Logic

This plan does not change the server truth that:

- every real thread belongs to a project
- every real thread has one provider lineage
- effective cwd resolves from thread override first, then project root

The UI may render cwd information and manage draft overrides, but it should continue to feed those values into the existing canonical thread model rather than inventing a competing workspace model.

## Deferred Or Later Work

Explicitly not part of this plan:

- archived thread browsing UI
- manual thread rename UI
- tab renaming
- tab reordering
- arbitrary freeform pane trees
- manual pane resizing
- cross-project thread mounting
- duplicate live panes for the same thread
- exact final compact status visuals

These can be revisited later if the product needs them.

## Implementation Guidance

Implementation should respect this separation:

### Reuse as canonical

- backend `project` and `thread.projectId`
- backend cwd precedence
- backend thread creation invariants
- backend provider-per-thread invariant

### Keep UI-owned

- tab state
- pane state
- draft pane persistence
- sidebar ordering and collapse state
- drag-and-drop placement rules
- pulse highlight navigation affordance

If any logic becomes shared between the server and the new console, prefer extracting a small pure helper into a shared package rather than importing UI policy into the backend or backend-only modules directly into UI code.

## Concrete Next Deliverable

Turn this plan into a renderer and state contract for `apps\console-ui`.

That follow-up work should define:

- project sidebar state shape
- project-local tab state shape
- real-thread pane vs draft-pane state shape
- canonical 1–6 pane layout mapping
- drag-and-drop actions and reducers
- persistence schema for project layouts
- mapping between sidebar clicks and layout activation
- thread-to-pane uniqueness enforcement
