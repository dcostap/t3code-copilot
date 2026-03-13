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

  it("suppresses routine task lifecycle chatter and renders progress as plain text", () => {
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

    expect(derived).toEqual([{ type: "status", text: "Confirming response needed" }]);
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
