# Console UI Transcript Block Taxonomy

## Goal

Preserve the old UI's semantic richness without inheriting its visual density or row sprawl.

The new console should stay text-first and terminal-like, while still representing the important workflow artifacts as explicit structured blocks.

## Product Constraint

The new UI will always run in full permissions.

Implications:

- No approval UX is in scope for the new console.
- The new UI should force `runtimeMode: "full-access"` at dispatch time, not just rely on defaults.
- Approval requests should not be treated as first-class transcript blocks in the new UI.
- No approve, decline, or cancel surfaces should be built for this UI.
- Runtime-mode switching is out of scope for the new console UI.

## Principles

- Preserve semantics, not old layout.
- Keep transcript artifacts separate from composer and workflow state.
- Prefer a compact block taxonomy over one visual component per legacy row kind.
- Treat provider-specific detail as data inside generic block types where possible.
- Keep the prompt editor and transcript renderer conceptually separate, even if they still share infrastructure for now.

## Transcript Backbone

These should be first-class transcript block types in the new console.

### `user_message`

- Carries plain text plus attachments.
- Images render in a compact panel beneath the message.
- Image-only bootstrap text should remain hidden from the user-facing transcript.

### `assistant_message`

- Carries markdown or text, streaming state, timestamps, and message-level metadata.
- Markdown rendering is a content renderer for this block, not a separate taxonomy branch.

### `work_group`

- Represents grouped tool and work activity inline in the transcript.
- This is the main container for:
  - command execution
  - file change
  - MCP tool call
  - dynamic tool call
  - collab agent tool call
  - web search
  - image view
- The group should support lifecycle state like running, completed, failed, and declined.
- The group should hold richer sub-items such as command preview, output, exit code, changed files, and summaries.

### `user_input_request`

- Represents structured user questions and options, and later resolution state.

### `plan_update`

- Represents `turn.plan.updated` output as a structured plan artifact, not ordinary chat text.

### `proposed_plan`

- Distinct from assistant text.
- Distinct from transient plan updates.

### `checkpoint_summary`

- Represents diff and checkpoint state associated with assistant output, including changed-file summaries and diff affordances.

### `working_state`

- Represents active "turn is still working" state.
- This should be treated as transient UI-derived state unless the backend emits a durable event for it.

### `status`

- Fallback and low-level informational row when something does not fit a richer semantic block.

## Block Internals

Do not create one top-level block type for every provider-specific artifact immediately.

Instead, keep the top-level taxonomy small and specialize inside blocks.

### `assistant_message`

- Uses a markdown renderer.
- Can surface lightweight metadata like streaming or elapsed time.

### `user_message`

- Uses an attachment renderer for images and later other attachment types if the contract grows.

### `work_group`

- Contains specialized sub-renderers for:
  - command execution
  - file change
  - web search
  - image view
  - generic tool result
  - grouped lifecycle state

### `checkpoint_summary`

- Contains file stats, file list or tree, and diff actions.

This keeps the renderer compact while preserving semantics.

## Composer State Modes

The composer should be modeled as an explicit mode machine, not as one freeform text box with scattered conditionals.

Required modes:

### `normal_prompt`

- Standard text entry plus attachment staging.

### `pending_user_input_response`

- Composer meaning changes to answering structured questions.

### `plan_follow_up`

- Composer meaning changes to refining, approving, or implementing a plan.

### `attachment_staging`

- Not separate from prompt mode visually, but explicit in state because it affects send behavior and validation.

## Composer Surface Requirements

These are workflow-specific widgets around the prompt and should be treated as core UI, not optional polish.

- Pending user-input panel with structured questions and options.
- Plan follow-up banner or mode indicator that changes what Enter does.
- Attachment tray below the prompt with preview, remove, and persistence or error state.

## What Not To Inherit

Do not copy these from the old UI.

- Visual density and dashboard-like layering.
- A one-to-one mapping from every old timeline row kind to a new block type.
- Mixing transcript semantics and control chrome too tightly.
- Treating reasoning as mandatory legacy parity.
- Approval UX and runtime-mode selection.

## Reasoning

Reasoning should not be treated as a required inherited transcript widget.

The old UI does not strongly model it as a distinct rich artifact.

If the new console wants a dedicated reasoning block later, that should be a deliberate product decision.

## Data Modeling Guidance

Use three conceptual layers.

### 1. Transcript block taxonomy

- Small
- semantic
- durable

### 2. Sub-renderers inside blocks

- Rich UI without taxonomy explosion

### 3. Composer and workflow mode state

- Explicit interpretation of input behavior

This is cleaner than mirroring all old row kinds directly.

## Immediate Implementation Priorities

Order the next work like this.

1. Stabilize `user_message` and `assistant_message`.
   Include attachments and markdown.
2. Replace ad hoc tool and status rendering with `work_group`.
   Group consecutive work and activity entries cleanly.
3. Add explicit `user_input_request` transcript blocks.
   Then pair them with composer-mode panels.
4. Add `plan_update` and `proposed_plan`.
   Keep them distinct.
5. Add `checkpoint_summary`.
   Keep it compact but actionable.
6. Add transient `working_state`.
   Make it derived, not necessarily persisted.

## Architecture Direction

### Short term

- The current stack is good enough to keep shipping.
- Use the current renderer while block richness is still moderate.

### Long term

- The prompt editor should remain editor-centric.
- The transcript likely should evolve toward a real React block tree rather than remaining primarily a flattened text document with decorations.
- If transcript richness keeps growing, shared CodeMirror rendering for everything will become the constraint.

## Concrete Next Deliverable

Turn this plan into a renderer contract for `apps/console-ui`.

That contract should define:

- exact block types
- required fields per block
- transient vs persisted state
- mapping from current console-ui blocks to target blocks
- mapping from old UI semantics to new block taxonomy

It should also explicitly document:

- full-access-only runtime policy
- approval flows as unsupported in the new console
