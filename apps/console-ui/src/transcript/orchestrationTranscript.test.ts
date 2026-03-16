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
      {
        type: "work-group",
        title: "Search workspace",
        status: "done",
        startedAt: "2026-03-11T09:00:00.000Z",
        endedAt: "2026-03-11T09:00:02.000Z",
        items: [
          {
            kind: "tool",
            label: "Search workspace",
            status: "done",
            detail: "Matched App.tsx and TranscriptRenderer.tsx.",
          },
        ],
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

  it("keeps resolved user-input request blocks in the transcript in answered state", () => {
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
            header: "Source",
            question: "Which mode should this console stay in?",
            options: [
              { label: "Demo", description: "Keep using local orchestration fixtures." },
              { label: "Live", description: "Connect to the orchestration websocket." },
            ],
          },
        ],
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

  it("maps assistant checkpoints to checkpoint-summary blocks", () => {
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
        type: "checkpoint-summary",
        status: "ready",
        checkpointTurnCount: 2,
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

    expect(derived.at(-1)).toEqual({
      type: "reasoning-text",
      text: "Checking transcript ordering before streaming the answer.",
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

    expect(derived.at(-1)).toEqual({
      type: "reasoning-summary",
      text: "Clarifying the car wash situation",
    });
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

    expect(derived.at(-1)).toEqual({
      type: "reasoning-text",
      text:
        "I need to respond to the user's request to run a sleep command for two minutes. "
        + "Before I execute the command, I'll include some commentary to clarify that I'm preparing to do substantial work.",
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
