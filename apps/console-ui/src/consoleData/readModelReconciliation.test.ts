import { describe, expect, it } from "vitest";
import { CommandId, EventId, MessageId, type OrchestrationEvent } from "@t3tools/contracts";

import { buildTestSnapshot } from "../testSupport/testSnapshot";
import { reconcileReadModelWithEvents } from "./readModelReconciliation";

describe("reconcileReadModelWithEvents", () => {
  it("applies newer interaction-mode events to the snapshot", () => {
    const snapshot = buildTestSnapshot();
    const event = {
      sequence: snapshot.snapshotSequence + 1,
      eventId: EventId.makeUnsafe("event:1"),
      aggregateKind: "thread",
      aggregateId: snapshot.threads[0]!.id,
      occurredAt: "2026-03-11T10:00:00.000Z",
      commandId: CommandId.makeUnsafe("command:1"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command:1"),
      metadata: {},
      type: "thread.interaction-mode-set",
      payload: {
        threadId: snapshot.threads[0]!.id,
        interactionMode: "plan",
        updatedAt: "2026-03-11T10:00:00.000Z",
      },
    } satisfies OrchestrationEvent;

    const reconciled = reconcileReadModelWithEvents(snapshot, [event]);

    expect(reconciled?.threads[0]?.interactionMode).toBe("plan");
    expect(reconciled?.snapshotSequence).toBe(event.sequence);
  });

  it("applies newer model-options updates to the snapshot", () => {
    const snapshot = buildTestSnapshot();
    const event = {
      sequence: snapshot.snapshotSequence + 1,
      eventId: EventId.makeUnsafe("event:2"),
      aggregateKind: "thread",
      aggregateId: snapshot.threads[0]!.id,
      occurredAt: "2026-03-11T10:01:00.000Z",
      commandId: CommandId.makeUnsafe("command:2"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command:2"),
      metadata: {},
      type: "thread.meta-updated",
      payload: {
        threadId: snapshot.threads[0]!.id,
        modelOptions: {
          copilot: {
            reasoningEffort: "high",
          },
        },
        updatedAt: "2026-03-11T10:01:00.000Z",
      },
    } satisfies OrchestrationEvent;

    const reconciled = reconcileReadModelWithEvents(snapshot, [event]);

    expect(reconciled?.threads[0]?.modelOptions?.copilot?.reasoningEffort).toBe("high");
    expect(reconciled?.snapshotSequence).toBe(event.sequence);
  });

  it("applies thread.message-sent events immediately so user prompts appear without waiting for a snapshot", () => {
    const snapshot = buildTestSnapshot();
    const event = {
      sequence: snapshot.snapshotSequence + 1,
      eventId: EventId.makeUnsafe("event:3"),
      aggregateKind: "thread",
      aggregateId: snapshot.threads[0]!.id,
      occurredAt: "2026-03-11T10:02:00.000Z",
      commandId: CommandId.makeUnsafe("command:3"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command:3"),
      metadata: {},
      type: "thread.message-sent",
      payload: {
        threadId: snapshot.threads[0]!.id,
        messageId: MessageId.makeUnsafe("user-msg-4"),
        role: "user",
        text: "Show this prompt immediately in the transcript.",
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: "2026-03-11T10:02:00.000Z",
        updatedAt: "2026-03-11T10:02:00.000Z",
      },
    } satisfies OrchestrationEvent;

    const reconciled = reconcileReadModelWithEvents(snapshot, [event]);
    const lastMessage = reconciled?.threads[0]?.messages.at(-1);

    expect(lastMessage?.id).toBe(event.payload.messageId);
    expect(lastMessage?.role).toBe("user");
    expect(lastMessage?.text).toBe(event.payload.text);
    expect(reconciled?.threads[0]?.updatedAt).toBe(event.occurredAt);
    expect(reconciled?.snapshotSequence).toBe(event.sequence);
  });

  it("applies thread.activity-appended events immediately so transcript activities stream live", () => {
    const snapshot = buildTestSnapshot();
    const event = {
      sequence: snapshot.snapshotSequence + 1,
      eventId: EventId.makeUnsafe("event:4"),
      aggregateKind: "thread",
      aggregateId: snapshot.threads[0]!.id,
      occurredAt: "2026-03-11T10:03:00.000Z",
      commandId: CommandId.makeUnsafe("command:4"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command:4"),
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: snapshot.threads[0]!.id,
        activity: {
          id: EventId.makeUnsafe("activity:live"),
          tone: "info",
          kind: "reasoning.text",
          summary: "Reasoning",
          payload: {
            streamKind: "reasoning_text",
            text: "Show streamed reasoning immediately.",
          },
          turnId: null,
          sequence: 999,
          createdAt: "2026-03-11T10:03:00.000Z",
        },
      },
    } satisfies OrchestrationEvent;

    const reconciled = reconcileReadModelWithEvents(snapshot, [event]);
    const lastActivity = reconciled?.threads[0]?.activities.at(-1);

    expect(lastActivity?.id).toBe(event.payload.activity.id);
    expect(lastActivity?.kind).toBe("reasoning.text");
    expect(reconciled?.threads[0]?.updatedAt).toBe(event.occurredAt);
    expect(reconciled?.snapshotSequence).toBe(event.sequence);
  });

  it("does not reapply events already reflected in the snapshot", () => {
    const snapshot = buildTestSnapshot();
    const event = {
      sequence: snapshot.snapshotSequence,
      eventId: EventId.makeUnsafe("event:1"),
      aggregateKind: "thread",
      aggregateId: snapshot.threads[0]!.id,
      occurredAt: "2026-03-11T10:00:00.000Z",
      commandId: CommandId.makeUnsafe("command:1"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command:1"),
      metadata: {},
      type: "thread.interaction-mode-set",
      payload: {
        threadId: snapshot.threads[0]!.id,
        interactionMode: "plan",
        updatedAt: "2026-03-11T10:00:00.000Z",
      },
    } satisfies OrchestrationEvent;

    expect(reconcileReadModelWithEvents(snapshot, [event])).toBe(snapshot);
  });
});
