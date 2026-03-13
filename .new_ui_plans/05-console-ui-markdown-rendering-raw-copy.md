# Console UI Markdown Rendering With Raw Copy

## Goal

Allow the new `console-ui` transcript to render assistant markdown in a cleaner, terminal-native way while preserving raw markdown fidelity when the user copies transcript text.

## Problem

The current markdown rendering work in `console-ui` is text-first and works by transforming assistant markdown into nicer displayed transcript text:

- markdown tables become unicode box tables
- fenced code becomes bounded code blocks
- blockquotes and lists are reshaped for readability

This improves the transcript, but it also changes what gets copied from the transcript. Copying currently yields the rendered display text, not the original raw markdown.

That is undesirable for workflows where the user wants:

- the exact fenced markdown back
- the original markdown table source
- original list markers / quote syntax
- faithful copy-paste into markdown files, issues, or docs

## Desired Behavior

- The transcript should continue rendering “pretty” terminal-native markdown.
- Copying transcript content should yield the underlying raw assistant markdown, not the rendered unicode/transformed version.
- This should work especially well for transformed constructs:
  - tables
  - fenced code blocks
  - blockquotes
  - lists

## Architectural Direction

Do not make rendered transcript text the canonical source of truth.

Instead, separate:

1. Raw assistant markdown
   The canonical text emitted by the backend/read model.

2. Rendered transcript lines
   The display-oriented line model used by `TranscriptRenderer`.

3. Source mapping
   A mapping from rendered transcript ranges/lines back to raw source ranges.

## Recommended Implementation Shape

### 1. Extend transcript line metadata

For assistant-derived rendered lines, add metadata that identifies:

- owning transcript block / assistant message
- rendered line index
- raw source slice or raw source line span
- whether the line is transformed or one-to-one

This should live in the transcript line model rather than being inferred from DOM state.

### 2. Add render-to-raw mapping for transformed markdown blocks

At minimum, support mapping for:

- markdown tables
- fenced code blocks
- blockquotes
- lists

For some constructs this may be line-based rather than character-perfect at first.

### 3. Override transcript copy behavior

Intercept copy in the transcript surface and, when the selection touches assistant transformed content:

- resolve the selected rendered region
- map it back to raw markdown
- write raw markdown into the clipboard payload

Fallback to the visible text when:

- mapping is unavailable
- the selection is mixed across unsupported blocks
- the selected region is not assistant-rendered markdown

## Phased Delivery

### Phase 1

Support raw copy for full transformed blocks only.

Examples:

- selecting a full rendered markdown table copies the original markdown table source
- selecting a full rendered fenced code block copies the original fenced markdown block

This is the safest first step.

### Phase 2

Support mixed selections across multiple transformed lines within the same assistant block.

### Phase 3

Support finer-grained partial selection remapping where practical.

This may not be worth full complexity for every construct and should only be pursued if the user experience justifies it.

## Constraints

- Keep the transcript text-first.
- Do not replace the transcript with a full DOM markdown renderer.
- Do not make copy behavior depend on brittle DOM scraping.
- Keep the raw source mapping as transcript-model data, not ad hoc renderer state.

## Product Rationale

This preserves both:

- the improved local-instrument transcript feel
- markdown fidelity for real developer workflows

That combination is stronger than either:

- raw markdown only, which looks worse
- rendered markdown only, which copies poorly

