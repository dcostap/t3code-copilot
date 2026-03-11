# New UI Brainstorm

## Goal

Build a new desktop UI alongside the existing frontend.

This new UI should become the main product surface over time, but it does not need to replace the current frontend in place.

We are intentionally keeping:

- the current repo
- the current stack
- the current desktop shell
- the current backend
- the current provider integrations

We are intentionally rethinking:

- the frontend product shape
- the transcript surface
- the interaction model
- the visual language

## Product Direction

The target is not a generic chat dashboard.

The target is a focused local agent console with these main tenets:

- dark, restrained, monospace-first
- one main transcript column
- bottom composer dock
- slash commands and command palette
- structured blocks for tool calls, patches, plans, and reasoning
- almost no chrome
- keyboard-first, mouse-capable
- fast enough to feel like a CLI

The desktop app should feel like a sharp local instrument, not like a browser app in a window.

## Why We Are Doing This

The old Go TUI proved the desired interaction style, but the terminal itself creates hard limits:

- mouse support is inconsistent
- native selection belongs to the terminal, not the app
- rich transcript interactions fight the host environment
- streaming and layout behavior are fragile
- expandable blocks, structured diffs, and advanced transcript UX are harder than they should be

The desktop version keeps the terminal aesthetic and interaction discipline, but gives us full control over rendering, selection, cursor behavior, and dynamic UI.

## What We Want The UI To Feel Like

The strongest concept so far is:

- a full monospace surface
- visually close to a terminal or editor
- transcript and input feel like part of one text world
- cursor can move above the input area
- user can navigate and select transcript text naturally
- the composer region is still clearly editable

This should feel closer to a text editor than to a chat app.

## Main Surface Concept

The best current idea is to treat the main UI as an editor-like document surface rather than a normal chat DOM.

Desired behavior:

- one continuous text-oriented surface
- transcript above
- editable composer region at the bottom
- cursor can move through transcript text
- transcript is selectable
- composer remains the only truly editable area
- slash commands and command palette layer on top of this model

This is a much better fit than building another traditional React chat timeline.

## Likely Technical Direction

The strongest candidate for the main transcript surface is CodeMirror 6.

Why:

- it is built for large text buffers
- it only renders the visible viewport
- it has a real document model
- cursor and selection are first-class
- it supports decorations, folding, widgets, and read-only behavior
- it is much closer to the desired terminal/editor interaction model than a normal React list

Important constraint:

We should not think in terms of "HTML chat message cards inside an editor."

We should think in terms of:

- text document
- styled text presentation
- structured regions
- selective widgets only where necessary

## Markdown Rendering Direction

We do not need rich HTML-style markdown rendering.

We only need the level of markdown quality that a good terminal TUI provides:

- headings that feel stronger
- code blocks with syntax highlighting
- inline code styling
- blockquotes
- lists
- tables rendered cleanly in monospace
- links and file refs styled and interactive

This is much more realistic and much more compatible with an editor surface.

The target is:

- excellent terminal/editor markdown

The target is not:

- Notion-style markdown preview
- arbitrary HTML layout

This is a strength, not a compromise.

It keeps the whole transcript text-native and preserves:

- cursor movement
- selection
- copy behavior
- streaming behavior
- large-buffer performance

## Transcript Representation

Current leaning:

- do not use the raw markdown source as the direct visual document
- instead build a rendered text projection per transcript block
- then style and decorate that projection

Why:

- more control over cursor behavior
- cleaner visual output
- easier to preserve the editor illusion
- less weirdness around raw markdown syntax

The transcript should still feel like text, but it does not need to expose the literal raw markdown source as the primary user-facing document.

## Inline Diff Blocks

We want inline diff blocks similar to the Codex CLI diff presentation.

Reference qualities from the target style:

- compact file-change header
- full monospace rendering
- syntax-colored code
- red removed regions
- green added regions
- line numbers
- full-width tinted backgrounds
- visually integrated into the transcript rather than shown as a separate card

Desired behavior:

- collapsed diff block shows a compact summary line, such as file path and counts
- expanded inline diff block shows a styled patch/change region in the transcript flow
- for very large or very detailed diffs, the transcript can open a more dedicated diff view on demand

The transcript should still be the primary narrative surface, but we should not force every heavy diff interaction to stay inline if it becomes awkward.

## Structured Blocks We Want

The transcript should support text-native but clearly differentiated blocks for:

- assistant responses
- reasoning
- plans
- tool calls
- patches / diffs
- approvals
- warnings / errors

These should look like part of the same monospace document, not like unrelated dashboard widgets.

## Interaction Model

The UI should be:

- keyboard-first
- mouse-capable
- transcript-centric

Planned interaction ideas:

- cursor can move through transcript text
- transcript text can be selected and copied
- slash commands from the composer
- command palette
- fold/unfold structured blocks
- open linked files or diffs from transcript regions
- maintain minimal chrome and low-friction navigation

## Performance Requirements

This is a non-negotiable requirement:

- if the transcript is 100k lines long, we should not pay to render 100k lines every frame

That is another major reason to prefer an editor engine.

The UI must be efficient with:

- very long conversations
- streaming updates
- structured transcript blocks
- diff-heavy sessions

The visible surface should be viewport-based and incremental.

## Backend Position

We want to keep the backend and stack from this fork.

That means:

- keep Codex and Copilot integration
- keep the provider abstraction
- keep the canonical runtime event model
- keep the desktop shell and current repo structure

This is a major reason for working in this repo at all.

The frontend should adapt to the backend cleanly.

We should not bypass or undermine:

- provider abstractions
- resumable sessions
- approval flows
- canonical runtime events

## Repo Strategy

The preferred strategy is:

- keep the current frontend in the repo
- build the new frontend alongside it
- avoid a risky in-place rewrite
- selectively reuse pieces from the existing frontend when useful

The old frontend is not the design source of truth for the new UI.

## Things We Should Avoid

- inheriting the current frontend's product shape by accident
- turning the app into a generic chat dashboard
- overusing card-based layouts
- relying on HTML-style markdown rendering assumptions
- forcing rich interactive widgets everywhere in the transcript
- rebuilding the backend just because the frontend is changing

## Open Questions

These still need decisions:

- exactly where the new frontend lives in the repo
- whether CodeMirror is the final editor surface choice
- what the transcript document model looks like in detail
- how the editable composer tail is represented
- how much inline interactivity belongs in the main document versus side panes
- what the first thin vertical slice should be

## Current Recommendation

Current best direction:

- build a new frontend beside the current one
- center the UI around an editor-like transcript surface
- favor text-native markdown rendering
- support inline diff blocks styled like the Codex CLI
- preserve the backend and provider architecture
- treat transcript quality as the core product concern

## Good First Deliverables

Likely first implementation slices:

1. A minimal new shell with the desired visual language.
2. A single editor-like transcript surface with static sample content.
3. A bottom composer dock.
4. Basic slash command palette.
5. Styled markdown-like transcript blocks.
6. One inline diff block prototype.
7. Basic virtualization / large-buffer sanity check.

That path would validate the new interaction model before deeper integration work.
