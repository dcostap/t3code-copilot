import { describe, expect, it } from "vitest";
import { CommandId, EventId, type OrchestrationEvent } from "@t3tools/contracts";

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
