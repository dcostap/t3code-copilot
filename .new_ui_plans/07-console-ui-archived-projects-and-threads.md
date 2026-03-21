# Console UI Archived Projects And Threads Management

## Goal

Define the future global management surface for archived projects and archived threads in the console UI.

This is not the implementation plan for the first archive button in the sidebar.

This is the follow-on plan for the management UX that lets users inspect, recover, and clean up archived items without mixing that flow into the main left-sidebar workspace navigation.

## Current Baseline

Today:

- active projects live in the main left sidebar
- active threads live under each visible project
- thread archive is not yet implemented through orchestration
- project archive is currently frontend-owned in console UI state
- archived projects are hidden from the left sidebar but not deleted

That is a good short-term step, but it is not the final management UX.

## Product Intent

The archive system should make the main workspace feel lighter and calmer without making older work feel lost.

Archived items should be:

- out of the day-to-day sidebar
- easy to inspect later
- recoverable
- clearly separated from destructive delete actions
- manageable in bulk when needed

## Global Management Surface

The future archive management UI should be global, not tied to one currently visible sidebar project.

Good candidate entry points:

- command palette action like `Manage archived items`
- dedicated global modal
- dedicated secondary window or management view

The key requirement is that this surface can manage archived projects and archived threads across the whole console workspace.

## Information Architecture

The management surface should have two top-level groups:

- Archived projects
- Archived threads

It should be possible to switch between:

- a unified view
- projects-only view
- threads-only view

## Archived Projects View

Each archived project row should show:

- project title
- full workspace path
- archive date
- thread count
- most recent activity date

Project actions:

- unarchive project
- inspect project contents
- bulk select projects
- optional future delete project action, clearly separated and guarded

Inspecting an archived project should reveal its archived and non-archived threads without forcing the project back into the left sidebar first.

## Archived Threads View

Each archived thread row should show:

- thread title
- project title
- provider
- created date
- updated date
- archive date
- compact status summary if relevant

Thread actions:

- unarchive thread
- delete thread
- bulk select threads

Thread management should stay aligned with the existing manage-threads table patterns:

- checkbox-based multi-select
- keyboard navigation
- bulk actions in a footer/action bar

## Search And Filtering

The archive management surface should support:

- free-text filtering across project title, thread title, and workspace path
- filtering by project
- filtering by provider
- sorting by archived date, updated date, or created date

This surface should be optimized for large archived histories, not just a handful of items.

## UX Rules

Archive and delete must remain clearly distinct:

- archive = hidden from main workspace navigation but recoverable
- delete = destructive removal

Important UX rules:

- unarchive should be one step
- delete should stay confirmation-gated
- bulk actions should always show a precise selected-count summary
- empty states should explain where archived items went and how to restore them

## State Ownership Direction

Near-term acceptable model:

- archived project visibility can remain frontend-owned if only console-ui needs it

Likely long-term direction:

- archived thread and project state should eventually become canonical shared state once multiple surfaces need to agree on it

The UI should be designed so that the future migration from frontend-owned archive state to canonical orchestration state is mostly a data-source swap, not a total UX redesign.

## Recommended Future Delivery Order

1. Add a global `Manage archived items` entry point.
2. Implement archived-project listing and unarchive flow.
3. Implement canonical thread archive support.
4. Add archived-thread listing and bulk actions.
5. Revisit whether project archive state should move into shared orchestration contracts.
