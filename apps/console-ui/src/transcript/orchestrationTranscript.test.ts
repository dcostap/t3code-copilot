import { CheckpointRef, EventId, MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildTestSnapshot } from "../testSupport/testSnapshot";
import { threadToTranscriptBlocks } from "./orchestrationTranscript";

describe("threadToTranscriptBlocks", () => {
  it("keeps activity ordering stable with sequence under bursty timestamps", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const timestamp = "2026-03-11T09:00:00.000Z";
    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-seq-2"),
          tone: "info",
          kind: "note.second",
          summary: "Second",
          payload: { detail: "second" },
          turnId: null,
          sequence: 2,
          createdAt: timestamp,
        },
        {
          id: EventId.makeUnsafe("activity-seq-1"),
          tone: "info",
          kind: "note.first",
          summary: "First",
          payload: { detail: "first" },
          turnId: null,
          sequence: 1,
          createdAt: timestamp,
        },
      ],
    });

    expect(derived).toEqual([
      { type: "status", text: "First: first" },
      { type: "status", text: "Second: second" },
    ]);
  });

  it("keeps image attachments out of user message text and resolves preview urls", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks(
      {
        ...thread!,
        checkpoints: [],
        proposedPlans: [],
        activities: [],
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]",
            attachments: [
              {
                type: "image",
                id: "attachment-1",
                name: "screenshot.png",
                mimeType: "image/png",
                sizeBytes: 128,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: "2026-03-11T09:00:00.000Z",
            updatedAt: "2026-03-11T09:00:00.000Z",
          },
        ],
      },
      { resolveAttachmentPreviewUrl: (attachmentId) => `/attachments/${attachmentId}` },
    );

    expect(derived).toEqual([
      {
        type: "user-message",
        text: "",
        attachments: [
          {
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
            previewUrl: "/attachments/attachment-1",
          },
        ],
      },
    ]);
  });

  it("omits checkpoint captured system messages from transcript history", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      checkpoints: [],
      proposedPlans: [],
      activities: [],
      messages: [
        {
          id: MessageId.makeUnsafe("message-system-checkpoint"),
          role: "system",
          text: "Checkpoint captured",
          turnId: null,
          streaming: false,
          createdAt: "2026-03-11T09:00:00.000Z",
          updatedAt: "2026-03-11T09:00:00.000Z",
        },
        {
          id: MessageId.makeUnsafe("message-assistant"),
          role: "assistant",
          text: "Still here",
          turnId: null,
          streaming: false,
          createdAt: "2026-03-11T09:00:01.000Z",
          updatedAt: "2026-03-11T09:00:01.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      { type: "assistant-text", text: "Still here", streaming: false },
      {
        type: "finished-state",
        startedAt: "2026-03-11T09:00:01.000Z",
        finishedAt: "2026-03-11T09:00:01.000Z",
      },
    ]);
  });

  it("omits checkpoint captured activities from transcript history", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      checkpoints: [],
      proposedPlans: [],
      messages: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-checkpoint-captured"),
          tone: "info",
          kind: "checkpoint.captured",
          summary: "Checkpoint captured",
          payload: {
            turnCount: 3,
            status: "ready",
          },
          turnId: TurnId.makeUnsafe("turn-checkpoint-captured"),
          createdAt: "2026-03-11T09:00:00.000Z",
        },
      ],
    });

    expect(derived).toEqual([]);
  });

  it("groups contiguous work activity into one work-group block", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-work-1"),
          tone: "tool",
          kind: "tool.started",
          summary: "Search workspace started",
          payload: {
            itemType: "web_search",
            title: "Search workspace",
            status: "inProgress",
            data: { query: "transcript renderer" },
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-11T09:00:00.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-work-2"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Search workspace complete",
          payload: {
            itemType: "web_search",
            title: "Search workspace",
            status: "completed",
            detail: "Matched App.tsx and TranscriptRenderer.tsx.",
            data: { query: "transcript renderer" },
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-11T09:00:02.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      expect.objectContaining({
        type: "work-group",
        title: "Search workspace",
        status: "done",
        startedAt: "2026-03-11T09:00:00.000Z",
        endedAt: "2026-03-11T09:00:02.000Z",
        items: [
          expect.objectContaining({
            kind: "tool",
            label: "Search workspace",
            status: "done",
            detail: expect.any(String),
          }),
        ],
      }),
    ]);
  });

  it("keeps matching web search work grouped across turn boundaries", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-web-search-start"),
          tone: "tool",
          kind: "tool.started",
          summary: "Search workspace started",
          payload: {
            itemType: "web_search",
            title: "Search workspace",
            status: "inProgress",
            data: { query: "transcript renderer" },
          },
          turnId: TurnId.makeUnsafe("turn-web-search-1"),
          sequence: 1,
          createdAt: "2026-03-11T09:00:00.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-web-search-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Search workspace complete",
          payload: {
            itemType: "web_search",
            title: "Search workspace",
            status: "completed",
            detail: "Matched App.tsx and TranscriptRenderer.tsx.",
            data: { query: "transcript renderer" },
          },
          turnId: TurnId.makeUnsafe("turn-web-search-2"),
          sequence: 2,
          createdAt: "2026-03-11T09:00:02.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      expect.objectContaining({
        type: "work-group",
        title: "Search workspace",
        status: "done",
        startedAt: "2026-03-11T09:00:00.000Z",
        endedAt: "2026-03-11T09:00:02.000Z",
        items: [
          expect.objectContaining({
            kind: "tool",
            label: "Search workspace",
            status: "done",
            detail: "Matched App.tsx and TranscriptRenderer.tsx.",
          }),
        ],
      }),
    ]);
  });

  it("backpatches completed web searches into their original history position by tool id", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-web-search-1-start"),
          tone: "tool",
          kind: "tool.started",
          summary: "Web search started",
          payload: {
            itemType: "web_search",
            title: "Web search",
            status: "inProgress",
            data: {
              toolCallId: "ws-1",
            },
          },
          turnId: TurnId.makeUnsafe("turn-web-search-a"),
          sequence: 1,
          createdAt: "2026-03-11T09:00:00.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-reasoning-between-searches"),
          tone: "info",
          kind: "reasoning.text",
          summary: "Reasoning",
          payload: {
            text: "Need one more source before concluding.",
          },
          turnId: TurnId.makeUnsafe("turn-web-search-a"),
          sequence: 2,
          createdAt: "2026-03-11T09:00:01.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-web-search-2-start"),
          tone: "tool",
          kind: "tool.started",
          summary: "Web search started",
          payload: {
            itemType: "web_search",
            title: "Web search",
            status: "inProgress",
            data: {
              toolCallId: "ws-2",
            },
          },
          turnId: TurnId.makeUnsafe("turn-web-search-b"),
          sequence: 3,
          createdAt: "2026-03-11T09:00:02.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-web-search-1-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Web search complete",
          payload: {
            itemType: "web_search",
            title: "Web search",
            status: "completed",
            detail: "First search matched the issue tracker.",
            data: {
              toolCallId: "ws-1",
            },
          },
          turnId: TurnId.makeUnsafe("turn-web-search-c"),
          sequence: 4,
          createdAt: "2026-03-11T09:00:03.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-web-search-2-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Web search complete",
          payload: {
            itemType: "web_search",
            title: "Web search",
            status: "completed",
            detail: "Second search matched the docs page.",
            data: {
              toolCallId: "ws-2",
            },
          },
          turnId: TurnId.makeUnsafe("turn-web-search-d"),
          sequence: 5,
          createdAt: "2026-03-11T09:00:04.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "work-group",
        title: "Web search",
        status: "done",
        startedAt: "2026-03-11T09:00:00.000Z",
        endedAt: "2026-03-11T09:00:03.000Z",
        items: [
          {
            kind: "tool",
            label: "Web search",
            status: "done",
            detail: "First search matched the issue tracker.",
          },
        ],
      },
      {
        type: "reasoning-text",
        text: "Need one more source before concluding.",
      },
      {
        type: "work-group",
        title: "Web search",
        status: "done",
        startedAt: "2026-03-11T09:00:02.000Z",
        endedAt: "2026-03-11T09:00:04.000Z",
        items: [
          {
            kind: "tool",
            label: "Web search",
            status: "done",
            detail: "Second search matched the docs page.",
          },
        ],
      },
    ]);
  });

  it("backpatches MCP tool calls by top-level activity item id", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-mcp-start"),
          tone: "tool",
          kind: "tool.started",
          summary: "MCP tool call started",
          payload: {
            itemType: "mcp_tool_call",
            itemId: "mcp-item-1",
            title: "Context7 Query Docs",
            status: "inProgress",
            detail: "Custom select queries in Exposed.",
          },
          turnId: TurnId.makeUnsafe("turn-mcp-a"),
          sequence: 1,
          createdAt: "2026-03-18T14:35:35.334Z",
        },
        {
          id: EventId.makeUnsafe("activity-reasoning-after-mcp-start"),
          tone: "info",
          kind: "reasoning.text",
          summary: "Reasoning",
          payload: {
            text: "Need to inspect the DSL internals before answering.",
          },
          turnId: TurnId.makeUnsafe("turn-mcp-a"),
          sequence: 2,
          createdAt: "2026-03-18T14:35:36.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-mcp-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "MCP tool call",
          payload: {
            itemType: "mcp_tool_call",
            itemId: "mcp-item-1",
            title: "Context7 Query Docs",
            status: "completed",
            detail: "Custom select queries in Exposed. Show how to subclass Query.",
          },
          turnId: TurnId.makeUnsafe("turn-mcp-b"),
          sequence: 3,
          createdAt: "2026-03-18T14:35:38.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "work-group",
        title: "Context7 Query Docs",
        status: "done",
        startedAt: "2026-03-18T14:35:35.334Z",
        endedAt: "2026-03-18T14:35:38.000Z",
        items: [
          {
            kind: "tool",
            label: "Context7 Query Docs",
            status: "done",
            detail: "Custom select queries in Exposed.",
          },
        ],
      },
      {
        type: "reasoning-text",
        text: "Need to inspect the DSL internals before answering.",
      },
    ]);
  });

  it("deduplicates interleaved command lifecycle items into one line per command", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-command-start-1"),
          tone: "tool",
          kind: "tool.started",
          summary: "Command run",
          payload: {
            itemType: "command_execution",
            title: "Command run",
            status: "inProgress",
            data: {
              item: {
                id: "cmd-1",
                command: ["Get-Location"],
                status: "inProgress",
              },
            },
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-13T12:00:00.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-command-start-2"),
          tone: "tool",
          kind: "tool.started",
          summary: "Command run",
          payload: {
            itemType: "command_execution",
            title: "Command run",
            status: "inProgress",
            data: {
              item: {
                id: "cmd-2",
                command: ["git", "status", "--short"],
                status: "inProgress",
              },
            },
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-13T12:00:00.100Z",
        },
        {
          id: EventId.makeUnsafe("activity-command-complete-1"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Command run",
          payload: {
            itemType: "command_execution",
            title: "Command run",
            status: "completed",
            data: {
              item: {
                id: "cmd-1",
                command: ["Get-Location"],
                status: "completed",
              },
            },
          },
          turnId: null,
          sequence: 3,
          createdAt: "2026-03-13T12:00:00.200Z",
        },
        {
          id: EventId.makeUnsafe("activity-command-complete-2"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Command run",
          payload: {
            itemType: "command_execution",
            title: "Command run",
            status: "completed",
            data: {
              item: {
                id: "cmd-2",
                command: ["git", "status", "--short"],
                status: "completed",
              },
            },
          },
          turnId: null,
          sequence: 4,
          createdAt: "2026-03-13T12:00:00.300Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "work-group",
        title: "Command run",
        status: "done",
        startedAt: "2026-03-13T12:00:00.000Z",
        endedAt: "2026-03-13T12:00:00.300Z",
        items: [
          {
            kind: "command",
            label: "Command run",
            status: "done",
            command: "Get-Location",
          },
          {
            kind: "command",
            label: "Command run",
            status: "done",
            command: "git status --short",
          },
        ],
      },
    ]);
  });

  it("captures file-change diff counts for compact edit summaries", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-file-change-start"),
          tone: "tool",
          kind: "tool.started",
          summary: "File change started",
          payload: {
            itemType: "file_change",
            title: "File change",
            status: "inProgress",
            data: {
              item: {
                type: "fileChange",
                id: "call_file_change_1",
                changes: [
                  {
                    path: "src/example.ts",
                    kind: { type: "update", move_path: null },
                    diff: "@@ -1 +1,3 @@\n-old line\n+new line\n+extra line\n",
                  },
                ],
                status: "inProgress",
              },
            },
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-13T10:57:31.912Z",
        },
        {
          id: EventId.makeUnsafe("activity-file-change-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "File change completed",
          payload: {
            itemType: "file_change",
            title: "File change",
            status: "completed",
            data: {
              item: {
                type: "fileChange",
                id: "call_file_change_1",
                changes: [
                  {
                    path: "src/example.ts",
                    kind: { type: "update", move_path: null },
                    diff: "@@ -1 +1,3 @@\n-old line\n+new line\n+extra line\n",
                  },
                ],
                status: "completed",
              },
            },
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-13T10:57:31.931Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "work-group",
        title: "File change",
        status: "done",
        startedAt: "2026-03-13T10:57:31.912Z",
        endedAt: "2026-03-13T10:57:31.931Z",
        items: [
          {
            kind: "file-change",
            label: "File change",
            status: "done",
            changedFiles: ["src/example.ts"],
            additions: 2,
            deletions: 1,
            inlineUnifiedDiff:
              "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1,3 @@\n-old line\n+new line\n+extra line\n",
          },
        ],
      },
    ]);
  });

  it("renders resolved user-input answers as a follow-up user message", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "req-user-input-1",
            questions: [
              {
                id: "answer",
                header: "Source",
                question: "Which mode should this console stay in?",
                options: [
                  { label: "Demo", description: "Keep using local orchestration fixtures." },
                  { label: "Live", description: "Connect to the orchestration websocket." },
                ],
              },
            ],
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-11T09:00:00.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-user-input-resolved"),
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input resolved",
          payload: {
            requestId: "req-user-input-1",
            answers: { answer: "Demo" },
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-11T09:00:01.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "user-input-request",
        requestId: "req-user-input-1",
        resolved: true,
        answers: { answer: "Demo" },
        questions: [
          {
            id: "answer",
            header: "Source",
            question: "Which mode should this console stay in?",
            options: [
              { label: "Demo", description: "Keep using local orchestration fixtures." },
              { label: "Live", description: "Connect to the orchestration websocket." },
            ],
          },
        ],
      },
      {
        type: "user-message",
        text: "Demo",
      },
    ]);
  });

  it("normalizes stale Copilot ask_user fallback replies into the same follow-up user message", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      proposedPlans: [],
      checkpoints: [],
      messages: [{
        id: MessageId.makeUnsafe("message-fallback-answer"),
        role: "user",
        text: "Yes",
        attachments: [],
        turnId: TurnId.makeUnsafe("turn-fallback-answer"),
        streaming: false,
        createdAt: "2026-03-11T09:00:02.000Z",
        updatedAt: "2026-03-11T09:00:02.000Z",
      }],
      activities: [
        {
          id: EventId.makeUnsafe("activity-user-input-requested-stale"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "req-user-input-stale",
            questions: [
              {
                id: "answer",
                header: "Answer",
                question: "Is the ask_user tool working as expected?",
                options: [
                  { label: "Yes", description: "Yes" },
                  { label: "No", description: "No" },
                ],
              },
            ],
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-11T09:00:00.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-user-input-respond-failed-stale"),
          tone: "error",
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          payload: {
            requestId: "req-user-input-stale",
            detail: "Provider adapter request failed (copilot) for session.userInput.respond: Unknown pending GitHub Copilot user-input request 'copilot-user-input-stale'.",
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-11T09:00:01.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "user-input-request",
        requestId: "req-user-input-stale",
        resolved: true,
        answers: { answer: "Yes" },
        questions: [
          {
            id: "answer",
            header: "Answer",
            question: "Is the ask_user tool working as expected?",
            options: [
              { label: "Yes", description: "Yes" },
              { label: "No", description: "No" },
            ],
          },
        ],
      },
      {
        type: "user-message",
        text: "Yes",
      },
    ]);
  });

  it("maps turn.plan.updated activities to structured plan-update blocks", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-plan-update"),
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            explanation: "Reshape the UI around a single conversation scroll owner.",
            plan: [
              { step: "Unify transcript scrolling.", status: "completed" },
              { step: "Render tool activity inline.", status: "inProgress" },
              { step: "Tighten prompt layout.", status: "pending" },
            ],
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-11T09:00:00.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "plan-update",
        explanation: "Reshape the UI around a single conversation scroll owner.",
        steps: [
          { step: "Unify transcript scrolling.", status: "completed" },
          { step: "Render tool activity inline.", status: "inProgress" },
          { step: "Tighten prompt layout.", status: "pending" },
        ],
      },
    ]);
  });

  it("maps proposed plans to distinct proposed-plan blocks", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      checkpoints: [],
      activities: [],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: null,
          planMarkdown: "# Console UI migration\n\n## Summary\n\n- Bind the prototype to the orchestration read model.\n- Keep transcript rendering text-first.",
          createdAt: "2026-03-11T09:00:00.000Z",
          updatedAt: "2026-03-11T09:00:01.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "proposed-plan",
        title: "Console UI migration",
        body: "- Bind the prototype to the orchestration read model.\n- Keep transcript rendering text-first.",
      },
    ]);
  });

  it("skips checkpoint summaries in assistant transcript blocks", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      activities: [],
      proposedPlans: [],
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-checkpoint-message"),
          role: "assistant",
          text: "I traced it to the split scroll model.",
          attachments: [],
          turnId: TurnId.makeUnsafe("turn-checkpoint"),
          streaming: false,
          createdAt: "2026-03-11T09:00:00.000Z",
          updatedAt: "2026-03-11T09:00:01.000Z",
        },
      ],
      checkpoints: [
        {
          turnId: TurnId.makeUnsafe("turn-checkpoint"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("provider-diff:test"),
          status: "ready",
          files: [
            {
              path: "apps/console-ui/src/App.tsx",
              kind: "modified",
              additions: 18,
              deletions: 10,
            },
            {
              path: "apps/console-ui/src/index.css",
              kind: "modified",
              additions: 22,
              deletions: 9,
            },
          ],
          assistantMessageId: MessageId.makeUnsafe("assistant-checkpoint-message"),
          completedAt: "2026-03-11T09:00:02.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "assistant-text",
        text: "I traced it to the split scroll model.",
        streaming: false,
      },
      {
        type: "finished-state",
        startedAt: "2026-03-11T09:00:00.000Z",
        finishedAt: "2026-03-11T09:00:01.000Z",
      },
    ]);
  });

  it("appends a finished-state block after a completed assistant reply reconstructed from events", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const turnId = TurnId.makeUnsafe("turn-completed-after-input");
    const derived = threadToTranscriptBlocks(
      {
        ...thread!,
        checkpoints: [],
        proposedPlans: [],
        activities: [
          {
            id: EventId.makeUnsafe("activity-user-input-boundary"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Need a choice",
            payload: {
              requestId: "req-user-input-inline",
              questions: [
                {
                  id: "demo_source",
                  header: "Source",
                  question: "Which mode should this console stay in?",
                  options: [
                    { label: "Demo", description: "Keep using local orchestration fixtures." },
                    { label: "Live", description: "Connect to the orchestration websocket." },
                  ],
                },
              ],
            },
            turnId,
            sequence: 1,
            createdAt: "2026-03-11T09:00:05.000Z",
          },
        ],
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-completed-after-input"),
            role: "assistant",
            text: "Before the question. After the answer.",
            attachments: [],
            turnId,
            streaming: false,
            createdAt: "2026-03-11T09:00:01.000Z",
            updatedAt: "2026-03-11T09:00:06.000Z",
          },
        ],
      },
      {
        orchestrationEvents: [
          {
            sequence: 1,
            eventId: EventId.makeUnsafe("event-assistant-completed-before"),
            aggregateKind: "thread",
            aggregateId: thread!.id,
            occurredAt: "2026-03-11T09:00:01.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId: thread!.id,
              messageId: MessageId.makeUnsafe("assistant-completed-after-input"),
              role: "assistant",
              text: "Before the question. ",
              turnId,
              streaming: true,
              createdAt: "2026-03-11T09:00:01.000Z",
              updatedAt: "2026-03-11T09:00:01.000Z",
            },
          },
          {
            sequence: 2,
            eventId: EventId.makeUnsafe("event-assistant-completed-after"),
            aggregateKind: "thread",
            aggregateId: thread!.id,
            occurredAt: "2026-03-11T09:00:06.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId: thread!.id,
              messageId: MessageId.makeUnsafe("assistant-completed-after-input"),
              role: "assistant",
              text: "After the answer.",
              turnId,
              streaming: true,
              createdAt: "2026-03-11T09:00:06.000Z",
              updatedAt: "2026-03-11T09:00:06.000Z",
            },
          },
        ],
      },
    );

    expect(derived).toEqual([
      {
        type: "assistant-text",
        text: "Before the question. ",
        streaming: false,
      },
      {
        type: "user-input-request",
        requestId: "req-user-input-inline",
        questions: [
          {
            id: "demo_source",
            header: "Source",
            question: "Which mode should this console stay in?",
            options: [
              { label: "Demo", description: "Keep using local orchestration fixtures." },
              { label: "Live", description: "Connect to the orchestration websocket." },
            ],
          },
        ],
      },
      {
        type: "assistant-text",
        text: "After the answer.",
        streaming: false,
      },
      {
        type: "finished-state",
        startedAt: "2026-03-11T09:00:01.000Z",
        finishedAt: "2026-03-11T09:00:06.000Z",
      },
    ]);
  });

  it("places the assistant finished-state after same-turn tool work and pending user-input prompts", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();
    const derived = threadToTranscriptBlocks({
      ...thread!,
      checkpoints: [],
      proposedPlans: [],
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-finished-after-ask-user"),
          role: "assistant",
          text: "I need one more thing from you.",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-03-11T09:00:00.000Z",
          updatedAt: "2026-03-11T09:00:01.000Z",
        },
      ],
      activities: [
        {
          id: EventId.makeUnsafe("activity-report-intent-before-question"),
          tone: "tool",
          kind: "tool.started",
          summary: "report_intent started",
          payload: {
            itemType: "tool",
            itemId: "report-intent-before-question",
            title: "report_intent",
            status: "completed",
            data: {
              arguments: {
                intent: "Asking user input",
              },
            },
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-11T09:00:02.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-user-input-requested-after-tool"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "req-finished-after-ask-user",
            questions: [
              {
                id: "answer",
                header: "Question",
                question: "What should I do next?",
                options: [
                  { label: "Continue", description: "Continue" },
                  { label: "Stop", description: "Stop" },
                ],
              },
            ],
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-11T09:00:03.000Z",
        },
      ],
      latestTurn: null,
      session: {
        ...thread!.session!,
        status: "running",
        activeTurnId: null,
        updatedAt: "2026-03-11T09:00:03.000Z",
      },
    });

    expect(derived).toEqual([
      {
        type: "assistant-text",
        text: "I need one more thing from you.",
        streaming: false,
      },
      {
        type: "work-group",
        title: "report_intent",
        status: "done",
        startedAt: "2026-03-11T09:00:02.000Z",
        endedAt: "2026-03-11T09:00:02.000Z",
        items: [
          {
            kind: "tool",
            label: "report_intent",
            status: "done",
            detail: "intent=Asking user input",
          },
        ],
      },
      {
        type: "user-input-request",
        requestId: "req-finished-after-ask-user",
        questions: [
          {
            id: "answer",
            header: "Question",
            question: "What should I do next?",
            options: [
              { label: "Continue", description: "Continue" },
              { label: "Stop", description: "Stop" },
            ],
          },
        ],
      },
      {
        type: "finished-state",
        startedAt: "2026-03-11T09:00:00.000Z",
        finishedAt: "2026-03-11T09:00:03.000Z",
      },
    ]);
  });

  it("places the assistant finished-state after later visible turn activities even when turn ids drift", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      checkpoints: [],
      proposedPlans: [],
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-finished-after-drifted-activities"),
          role: "assistant",
          text: "I'm just testing stuff.",
          attachments: [],
          turnId: TurnId.makeUnsafe("assistant-turn"),
          streaming: false,
          createdAt: "2026-03-11T09:00:00.000Z",
          updatedAt: "2026-03-11T09:00:01.000Z",
        },
      ],
      activities: [
        {
          id: EventId.makeUnsafe("activity-reasoning-drifted"),
          tone: "info",
          kind: "reasoning.text",
          summary: "Assembling parameters",
          payload: {
            text: "Assembling parameters for file listing",
          },
          turnId: TurnId.makeUnsafe("activity-turn"),
          sequence: 1,
          createdAt: "2026-03-11T09:00:02.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-report-intent-drifted"),
          tone: "tool",
          kind: "tool.completed",
          summary: "report_intent complete",
          payload: {
            itemType: "tool",
            itemId: "report-intent-drifted",
            title: "report_intent",
            status: "completed",
            data: {
              arguments: {
                intent: "Listing files",
              },
            },
          },
          turnId: TurnId.makeUnsafe("activity-turn"),
          sequence: 2,
          createdAt: "2026-03-11T09:00:03.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-user-input-requested-drifted"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "req-drifted-ordering",
            questions: [
              {
                id: "color",
                header: "Dummy question",
                question: "Which color do you prefer?",
                options: [
                  { label: "Red", description: "Red" },
                  { label: "Blue", description: "Blue" },
                  { label: "Green", description: "Green" },
                ],
              },
            ],
          },
          turnId: TurnId.makeUnsafe("activity-turn"),
          sequence: 3,
          createdAt: "2026-03-11T09:00:04.000Z",
        },
      ],
      latestTurn: null,
      session: {
        ...thread!.session!,
        status: "running",
        activeTurnId: null,
        updatedAt: "2026-03-11T09:00:04.000Z",
      },
    });

    expect(derived).toEqual([
      {
        type: "assistant-text",
        text: "I'm just testing stuff.",
        streaming: false,
      },
      {
        type: "reasoning-text",
        text: "Assembling parameters for file listing",
      },
      {
        type: "work-group",
        title: "report_intent",
        status: "done",
        startedAt: "2026-03-11T09:00:03.000Z",
        endedAt: "2026-03-11T09:00:03.000Z",
        items: [
          {
            kind: "tool",
            label: "report_intent",
            status: "done",
            detail: "intent=Listing files",
          },
        ],
      },
      {
        type: "user-input-request",
        requestId: "req-drifted-ordering",
        questions: [
          {
            id: "color",
            header: "Dummy question",
            question: "Which color do you prefer?",
            options: [
              { label: "Red", description: "Red" },
              { label: "Blue", description: "Blue" },
              { label: "Green", description: "Green" },
            ],
          },
        ],
      },
      {
        type: "finished-state",
        startedAt: "2026-03-11T09:00:00.000Z",
        finishedAt: "2026-03-11T09:00:04.000Z",
      },
    ]);
  });

  it("places the latest-turn assistant finished-state after later visible transcript activities", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();
    const turnId = TurnId.makeUnsafe("turn-latest-finished-after-visible-activity");

    const derived = threadToTranscriptBlocks({
      ...thread!,
      checkpoints: [],
      proposedPlans: [],
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-latest-turn-finished-after-visible-activity"),
          role: "assistant",
          text: "I need one more thing.",
          attachments: [],
          turnId,
          streaming: false,
          createdAt: "2026-03-11T09:00:00.000Z",
          updatedAt: "2026-03-11T09:00:02.000Z",
        },
      ],
      activities: [
        {
          id: EventId.makeUnsafe("activity-report-intent-after-latest-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "report_intent complete",
          payload: {
            itemType: "tool",
            itemId: "report-intent-after-latest-complete",
            title: "report_intent",
            status: "completed",
            data: {
              arguments: {
                intent: "Prompting the user",
              },
            },
          },
          turnId,
          sequence: 1,
          createdAt: "2026-03-11T09:00:03.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-user-input-requested-after-latest-complete"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "req-latest-finished-after-visible-activity",
            questions: [
              {
                id: "next_step",
                header: "Question",
                question: "What should I do next?",
                options: [
                  { label: "Continue", description: "Continue" },
                  { label: "Stop", description: "Stop" },
                ],
              },
            ],
          },
          turnId,
          sequence: 2,
          createdAt: "2026-03-11T09:00:04.000Z",
        },
      ],
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-03-11T09:00:00.000Z",
        startedAt: "2026-03-11T09:00:00.000Z",
        completedAt: "2026-03-11T09:00:02.500Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-latest-turn-finished-after-visible-activity"),
      },
      session: {
        ...thread!.session!,
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-11T09:00:04.000Z",
      },
    });

    expect(derived).toEqual([
      {
        type: "assistant-text",
        text: "I need one more thing.",
        streaming: false,
      },
      {
        type: "work-group",
        title: "report_intent",
        status: "done",
        startedAt: "2026-03-11T09:00:03.000Z",
        endedAt: "2026-03-11T09:00:03.000Z",
        items: [
          {
            kind: "tool",
            label: "report_intent",
            status: "done",
            detail: "intent=Prompting the user",
          },
        ],
      },
      {
        type: "user-input-request",
        requestId: "req-latest-finished-after-visible-activity",
        questions: [
          {
            id: "next_step",
            header: "Question",
            question: "What should I do next?",
            options: [
              { label: "Continue", description: "Continue" },
              { label: "Stop", description: "Stop" },
            ],
          },
        ],
      },
      {
        type: "finished-state",
        startedAt: "2026-03-11T09:00:00.000Z",
        finishedAt: "2026-03-11T09:00:04.000Z",
      },
    ]);
  });

  it("shows a finished-state block for a completed latest turn even if the message still streams", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();
    expect(thread!.latestTurn).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      activities: [],
      proposedPlans: [],
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-streaming-but-complete"),
          role: "assistant",
          text: "I traced it to the split scroll model.",
          attachments: [],
          turnId: thread!.latestTurn!.turnId,
          streaming: true,
          createdAt: "2026-03-11T09:00:00.000Z",
          updatedAt: "2026-03-11T09:00:01.000Z",
        },
      ],
      latestTurn: {
        ...thread!.latestTurn!,
        state: "completed",
        completedAt: "2026-03-11T09:00:02.000Z",
      },
    });

    expect(derived).toEqual([
      {
        type: "assistant-text",
        text: "I traced it to the split scroll model.",
        streaming: true,
      },
      {
        type: "finished-state",
        startedAt: "2026-03-11T09:00:00.000Z",
        finishedAt: "2026-03-11T09:00:02.000Z",
      },
    ]);
  });

  it("does not append a duplicate finished-state to later non-message entries in a completed turn", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();
    expect(thread!.latestTurn).toBeDefined();

    const turnId = TurnId.makeUnsafe("turn-finished-before-reasoning");
    const messageId = MessageId.makeUnsafe("assistant-finished-before-reasoning");
    const derived = threadToTranscriptBlocks({
      ...thread!,
      checkpoints: [],
      proposedPlans: [],
      messages: [
        {
          id: messageId,
          role: "assistant",
          text: "Listing top-level files first.",
          attachments: [],
          turnId,
          streaming: false,
          createdAt: "2026-03-11T09:00:00.000Z",
          updatedAt: "2026-03-11T09:00:01.000Z",
        },
      ],
      activities: [
        {
          id: EventId.makeUnsafe("activity-reasoning-after-message"),
          tone: "info",
          kind: "reasoning.summary",
          summary: "Exploring filesystem",
          payload: {
            streamKind: "reasoning_summary_text",
            text: "**Exploring filesystem**\n\nNeed an accurate top-level snapshot first.",
          },
          turnId,
          sequence: 1,
          createdAt: "2026-03-11T09:00:03.000Z",
        },
      ],
      latestTurn: {
        ...thread!.latestTurn!,
        turnId,
        state: "completed",
        startedAt: "2026-03-11T09:00:00.000Z",
        completedAt: "2026-03-11T09:00:02.500Z",
        assistantMessageId: messageId,
      },
    });

    expect(derived).toEqual([
      {
        type: "assistant-text",
        text: "Listing top-level files first.",
        streaming: false,
      },
      {
        type: "reasoning-summary",
        text: "Exploring filesystem",
      },
      {
        type: "reasoning-text",
        text: "Need an accurate top-level snapshot first.",
      },
      {
        type: "finished-state",
        startedAt: "2026-03-11T09:00:00.000Z",
        finishedAt: "2026-03-11T09:00:03.000Z",
      },
    ]);
  });

  it("attaches lazy diff lookup metadata to completed file edits when only checkpoint diffs are available", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-file-change-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "File change completed",
          payload: {
            itemType: "file_change",
            title: "File change",
            status: "completed",
            data: {
              item: {
                type: "fileChange",
                id: "call_file_change_lookup_1",
                changes: [
                  {
                    path: "src/example.ts",
                  },
                ],
                status: "completed",
              },
            },
          },
          turnId: TurnId.makeUnsafe("turn-file-change"),
          sequence: 1,
          createdAt: "2026-03-13T10:57:31.931Z",
        },
      ],
      checkpoints: [
        {
          turnId: TurnId.makeUnsafe("turn-file-change"),
          checkpointTurnCount: 4,
          checkpointRef: CheckpointRef.makeUnsafe("checkpoint:thread-1:4"),
          status: "ready",
          files: [
            {
              path: "src/example.ts",
              kind: "modified",
              additions: 2,
              deletions: 1,
            },
          ],
          assistantMessageId: null,
          completedAt: "2026-03-13T10:57:32.000Z",
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "work-group",
        title: "File change",
        status: "done",
        startedAt: "2026-03-13T10:57:31.931Z",
        endedAt: "2026-03-13T10:57:31.931Z",
        items: [
          {
            kind: "file-change",
            label: "File change",
            status: "done",
            changedFiles: ["src/example.ts"],
            inlineDiffLookup: {
              threadId: thread!.id,
              fromTurnCount: 3,
              toTurnCount: 4,
            },
          },
        ],
      },
    ]);
  });

  it("appends a transient working-state block while the turn is running", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks(
      {
        ...thread!,
        messages: [],
        proposedPlans: [],
        checkpoints: [],
        activities: [],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-03-12T09:00:00.000Z",
          startedAt: "2026-03-12T09:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          ...thread!.session!,
          status: "running",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          updatedAt: "2026-03-12T09:00:02.000Z",
        },
      },
      { now: "2026-03-12T09:00:04.500Z" },
    );

    expect(derived).toEqual([
      {
        type: "working-state",
        startedAt: "2026-03-12T09:00:01.000Z",
        now: "2026-03-12T09:00:04.500Z",
      },
    ]);
  });

  it("suppresses the working-state block while a user-input request is still pending", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks(
      {
        ...thread!,
        messages: [],
        proposedPlans: [],
        checkpoints: [],
        activities: [{
          id: EventId.makeUnsafe("activity-user-input-pending"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "req-pending",
            questions: [{
              id: "choice",
              header: "Source",
              question: "Which mode should this console stay in?",
              options: [
                { label: "Demo", description: "Keep using local orchestration fixtures." },
                { label: "Live", description: "Connect to the orchestration websocket." },
              ],
            }],
          },
          turnId: TurnId.makeUnsafe("turn-running"),
          sequence: 1,
          createdAt: "2026-03-12T09:00:03.000Z",
        }],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-03-12T09:00:00.000Z",
          startedAt: "2026-03-12T09:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          ...thread!.session!,
          status: "running",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          updatedAt: "2026-03-12T09:00:04.000Z",
        },
      },
      { now: "2026-03-12T09:00:04.500Z" },
    );

    expect(derived).toEqual([
      {
        type: "user-input-request",
        requestId: "req-pending",
        questions: [{
          id: "choice",
          header: "Source",
          question: "Which mode should this console stay in?",
          options: [
            { label: "Demo", description: "Keep using local orchestration fixtures." },
            { label: "Live", description: "Connect to the orchestration websocket." },
          ],
        }],
      },
    ]);
  });

  it("hides ask_user tool activities and their follow-up work events", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-tool-started-ask-user"),
          tone: "tool",
          kind: "tool.started",
          summary: "ask_user started",
          payload: {
            itemId: "tool-ask-user-1",
            title: "ask_user",
            status: "inProgress",
            data: {
              item: {
                id: "tool-ask-user-1",
                toolName: "ask_user",
              },
            },
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-12T09:00:00.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-tool-completed-ask-user"),
          tone: "tool",
          kind: "tool.completed",
          summary: "ask_user complete",
          payload: {
            itemId: "tool-ask-user-1",
            title: "ask_user",
            status: "completed",
            detail: "Asked the user a question.",
            data: {
              item: {
                id: "tool-ask-user-1",
                toolName: "ask_user",
                result: {
                  id: "tool-ask-user-1",
                  toolName: "ask_user",
                },
              },
            },
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-12T09:00:01.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-tool-progress-ask-user"),
          tone: "tool",
          kind: "tool.progress",
          summary: "ask_user progress",
          payload: {
            itemId: "tool-ask-user-1",
            detail: "Waiting for response",
          },
          turnId: null,
          sequence: 3,
          createdAt: "2026-03-12T09:00:02.000Z",
        },
      ],
    });

    expect(derived).toEqual([]);
  });

  it("appends an interrupted-state block with the frozen elapsed time when a running turn is interrupted", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [],
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-interrupted"),
        state: "interrupted",
        requestedAt: "2026-03-12T09:00:00.000Z",
        startedAt: "2026-03-12T09:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        ...thread!.session!,
        status: "stopped",
        activeTurnId: null,
        updatedAt: "2026-03-12T09:00:04.500Z",
      },
    });

    expect(derived).toEqual([
      {
        type: "interrupted-state",
        startedAt: "2026-03-12T09:00:01.000Z",
        interruptedAt: "2026-03-12T09:00:04.500Z",
      },
    ]);
  });

  it("keeps reasoning blocks separate while the working-state line stays generic", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks(
      {
        ...thread!,
        messages: [],
        proposedPlans: [],
        checkpoints: [],
        activities: [
          {
            id: EventId.makeUnsafe("activity-task-progress-working-line"),
            tone: "info",
            kind: "task.progress",
            summary: "Thinking about the file layout",
            payload: {
              taskId: "task-1",
              detail: "**Thinking about the file layout**",
            },
            turnId: TurnId.makeUnsafe("turn-running"),
            sequence: 3,
            createdAt: "2026-03-12T09:00:03.000Z",
          },
          {
            id: EventId.makeUnsafe("activity-reasoning-summary-working-line"),
            tone: "info",
            kind: "reasoning.summary",
            summary: "Clarifying file layout",
            payload: {
              streamKind: "reasoning_summary_text",
              text: "**Clarifying file layout**\n\nNeed to inspect the workspace tree first.",
            },
            turnId: TurnId.makeUnsafe("turn-running"),
            sequence: 4,
            createdAt: "2026-03-12T09:00:04.000Z",
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-03-12T09:00:00.000Z",
          startedAt: "2026-03-12T09:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          ...thread!.session!,
          status: "running",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          updatedAt: "2026-03-12T09:00:04.000Z",
        },
      },
      { now: "2026-03-12T09:00:04.500Z" },
    );

    expect(derived).toEqual([
      {
        type: "reasoning-summary",
        text: "Clarifying file layout",
      },
      {
        type: "reasoning-text",
        text: "Need to inspect the workspace tree first.",
      },
      {
        type: "working-state",
        startedAt: "2026-03-12T09:00:01.000Z",
        now: "2026-03-12T09:00:04.500Z",
      },
    ]);
  });

  it("suppresses routine task lifecycle chatter from transcript history", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-task-started"),
          tone: "info",
          kind: "task.started",
          summary: "default task started",
          payload: {
            taskId: "task-1",
            detail: "Inspect the repo",
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-12T09:00:01.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-task-progress"),
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: "task-1",
            detail: "**Confirming response needed**",
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-12T09:00:02.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-task-completed"),
          tone: "info",
          kind: "task.completed",
          summary: "Task completed",
          payload: {
            taskId: "task-1",
            status: "completed",
            detail: "All good on my end",
          },
          turnId: null,
          sequence: 3,
          createdAt: "2026-03-12T09:00:03.000Z",
        },
      ],
    });

    expect(derived).toEqual([]);
  });

  it("renders cumulative reasoning activities as distinct reasoning blocks", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-reasoning-text"),
          tone: "info",
          kind: "reasoning.text",
          summary: "Reasoning",
          payload: {
            streamKind: "reasoning_text",
            text: "**Checking** transcript ordering before streaming the answer.",
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-12T09:00:02.000Z",
        },
      ],
    });

    expect(derived).toContainEqual({
      type: "reasoning-text",
      text: "Checking transcript ordering before streaming the answer.",
    });
    expect(derived.at(-1)).toEqual({
      type: "finished-state",
      startedAt: "2026-03-10T09:01:58.000Z",
      finishedAt: "2026-03-12T09:00:02.000Z",
    });
  });

  it("renders reasoning summaries as distinct summary blocks", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-reasoning-summary"),
          tone: "info",
          kind: "reasoning.summary",
          summary: "Reasoning summary",
          payload: {
            streamKind: "reasoning_summary_text",
            text: "Clarifying the car wash situation",
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-12T09:00:02.000Z",
        },
      ],
    });

    expect(derived).toContainEqual({
      type: "reasoning-summary",
      text: "Clarifying the car wash situation",
    });
    expect(derived.at(-1)).toEqual({
      type: "finished-state",
      startedAt: "2026-03-10T09:01:58.000Z",
      finishedAt: "2026-03-12T09:00:02.000Z",
    });
  });

  it("force-finishes stuck running work-groups once the assistant turn is completed", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();
    const turnId = TurnId.makeUnsafe("turn-stuck-work-group");

    const derived = threadToTranscriptBlocks({
      ...thread!,
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-report-intent-started"),
          tone: "tool",
          kind: "tool.started",
          summary: "report_intent started",
          payload: {
            itemType: "tool",
            itemId: "report-intent-1",
            title: "report_intent",
            status: "inProgress",
            data: {
              arguments: {
                intent: "Asking user input",
              },
            },
          },
          turnId,
          sequence: 1,
          createdAt: "2026-03-12T09:00:01.000Z",
        },
      ],
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-message-stuck-work-group"),
          role: "assistant",
          text: "All set.",
          attachments: [],
          turnId,
          streaming: false,
          createdAt: "2026-03-12T09:00:02.000Z",
          updatedAt: "2026-03-12T09:00:03.000Z",
        },
      ],
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-03-12T09:00:00.000Z",
        startedAt: "2026-03-12T09:00:01.000Z",
        completedAt: "2026-03-12T09:00:03.500Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-message-stuck-work-group"),
      },
      session: {
        ...thread!.session!,
        status: "ready",
        activeTurnId: null,
        updatedAt: "2026-03-12T09:00:03.500Z",
      },
    });

    expect(derived).toEqual([
      {
        type: "work-group",
        title: "report_intent",
        status: "done",
        startedAt: "2026-03-12T09:00:01.000Z",
        endedAt: "2026-03-12T09:00:03.500Z",
        items: [
          {
            kind: "tool",
            label: "report_intent",
            status: "done",
            detail: "intent=Asking user input",
          },
        ],
      },
      {
        type: "assistant-text",
        text: "All set.",
        streaming: false,
      },
      {
        type: "finished-state",
        startedAt: "2026-03-12T09:00:02.000Z",
        finishedAt: "2026-03-12T09:00:03.500Z",
      },
    ]);
  });

  it("promotes long unstructured reasoning.summary payloads into reasoning text", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-reasoning-summary-long"),
          tone: "info",
          kind: "reasoning.summary",
          summary: "Reasoning summary",
          payload: {
            streamKind: "reasoning_summary_text",
            text:
              "I need to respond to the user's request to run a sleep command for two minutes. "
              + "Before I execute the command, I'll include some commentary to clarify that I'm preparing to do substantial work.",
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-12T09:00:03.000Z",
        },
      ],
    });

    expect(derived).toContainEqual({
      type: "reasoning-text",
      text:
        "I need to respond to the user's request to run a sleep command for two minutes. "
        + "Before I execute the command, I'll include some commentary to clarify that I'm preparing to do substantial work.",
    });
    expect(derived.at(-1)).toEqual({
      type: "finished-state",
      startedAt: "2026-03-10T09:01:58.000Z",
      finishedAt: "2026-03-12T09:00:03.000Z",
    });
  });

  it("splits markdown-formatted reasoning summaries into headings and faded body blocks", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    const derived = threadToTranscriptBlocks({
      ...thread!,
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-reasoning-summary-markdown"),
          tone: "info",
          kind: "reasoning.summary",
          summary: "Reasoning summary",
          payload: {
            streamKind: "reasoning_summary_text",
            text:
              "**Interpreting user humor**\n\nI see the user is asking a lighthearted question about taking their car to a car wash 50 meters away or walking. Since it is only 50 meters, driving might seem funny, but they probably just want practical advice!**Crafting a light response**\n\nIf the car wash is just 50 meters away, walking makes sense for a short trip. However, since the goal is to wash the car, it has to get there somehow.",
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-12T09:00:02.000Z",
        },
      ],
    });

    expect(derived).toContainEqual({
      type: "reasoning-summary",
      text: "Interpreting user humor",
    });
    expect(derived).toContainEqual({
      type: "reasoning-text",
      text:
        "I see the user is asking a lighthearted question about taking their car to a car wash 50 meters away or walking. Since it is only 50 meters, driving might seem funny, but they probably just want practical advice!",
    });
    expect(derived).toContainEqual({
      type: "reasoning-summary",
      text: "Crafting a light response",
    });
    expect(derived).toContainEqual({
      type: "reasoning-text",
      text:
        "If the car wash is just 50 meters away, walking makes sense for a short trip. However, since the goal is to wash the car, it has to get there somehow.",
    });
  });

  it("suppresses coarse task.progress and keeps only detailed reasoning", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();
    const turnId = TurnId.makeUnsafe("turn-reasoning-dedupe");

    const derived = threadToTranscriptBlocks({
      ...thread!,
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-task-progress-dedupe"),
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            detail: "Considering transport options",
          },
          turnId,
          sequence: 1,
          createdAt: "2026-03-12T09:00:01.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-reasoning-text-dedupe"),
          tone: "info",
          kind: "reasoning.text",
          summary: "Reasoning",
          payload: {
            streamKind: "reasoning_text",
            text: "The car needs to be at the wash, so taking it makes more sense.",
          },
          turnId,
          sequence: 2,
          createdAt: "2026-03-12T09:00:02.000Z",
        },
      ],
    });

    expect(derived).not.toContainEqual({
      type: "status",
      text: "Considering transport options",
    });
    expect(derived).toContainEqual({
      type: "reasoning-text",
      text: "The car needs to be at the wash, so taking it makes more sense.",
    });
  });

  it("splits assistant output around inline user-input requests using orchestration events", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();
    const turnId = TurnId.makeUnsafe("turn-inline-user-input");

    const derived = threadToTranscriptBlocks({
      ...thread!,
      proposedPlans: [],
      checkpoints: [],
      activities: [
        {
          id: EventId.makeUnsafe("activity-user-input-requested-inline"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "req-user-input-inline",
            questions: [
              {
                id: "demo_source",
                header: "Source",
                question: "Which mode should this console stay in?",
                options: [
                  { label: "Demo", description: "Keep using local orchestration fixtures." },
                  { label: "Live", description: "Connect to the orchestration websocket." },
                ],
              },
            ],
          },
          turnId,
          sequence: 1,
          createdAt: "2026-03-11T09:00:05.000Z",
        },
      ],
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-stream-after-input"),
          role: "assistant",
          text: "Before the question. After the answer.",
          attachments: [],
          turnId,
          streaming: true,
          createdAt: "2026-03-11T09:00:01.000Z",
          updatedAt: "2026-03-11T09:00:06.000Z",
        },
      ],
    }, {
      orchestrationEvents: [
        {
          sequence: 1,
          eventId: EventId.makeUnsafe("event-assistant-before"),
          aggregateKind: "thread",
          aggregateId: thread!.id,
          occurredAt: "2026-03-11T09:00:01.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId: thread!.id,
            messageId: MessageId.makeUnsafe("assistant-stream-after-input"),
            role: "assistant",
            text: "Before the question. ",
            turnId,
            streaming: true,
            createdAt: "2026-03-11T09:00:01.000Z",
            updatedAt: "2026-03-11T09:00:01.000Z",
          },
        },
        {
          sequence: 2,
          eventId: EventId.makeUnsafe("event-assistant-after"),
          aggregateKind: "thread",
          aggregateId: thread!.id,
          occurredAt: "2026-03-11T09:00:06.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId: thread!.id,
            messageId: MessageId.makeUnsafe("assistant-stream-after-input"),
            role: "assistant",
            text: "After the answer.",
            turnId,
            streaming: true,
            createdAt: "2026-03-11T09:00:06.000Z",
            updatedAt: "2026-03-11T09:00:06.000Z",
          },
        },
      ],
    });

    expect(derived).toEqual([
      {
        type: "assistant-text",
        text: "Before the question. ",
        streaming: false,
      },
      {
        type: "user-input-request",
        requestId: "req-user-input-inline",
        questions: [
          {
            id: "demo_source",
            header: "Source",
            question: "Which mode should this console stay in?",
            options: [
              { label: "Demo", description: "Keep using local orchestration fixtures." },
              { label: "Live", description: "Connect to the orchestration websocket." },
            ],
          },
        ],
      },
      {
        type: "assistant-text",
        text: "After the answer.",
        streaming: true,
      },
    ]);
  });
});
