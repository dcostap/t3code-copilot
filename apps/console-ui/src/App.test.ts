import { describe, expect, it } from "vitest";
import { EventId } from "@t3tools/contracts";

import { shouldRetainPendingPromptSend } from "./App";
import { buildTestSnapshot } from "./testSupport/testSnapshot";

describe("shouldRetainPendingPromptSend", () => {
  it("clears the pending sending state once a provider turn start failure arrives after the send started", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const startedAt = "2026-03-20T14:00:00.000Z";

    expect(
      shouldRetainPendingPromptSend({
        thread: {
          ...thread,
          activities: [
            ...thread.activities,
            {
              id: EventId.makeUnsafe("activity-provider-turn-start-failed"),
              tone: "error",
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              payload: {
                detail: "Provider adapter process error (copilot): spawn EINVAL",
              },
              turnId: null,
              createdAt: "2026-03-20T14:00:01.000Z",
            },
          ],
        },
        startedAt,
        hasPendingThreadHistory: false,
        isThreadTurnRunning: false,
      }),
    ).toBe(false);
  });

  it("keeps the pending sending state while the turn has not started and no failure has arrived", () => {
    const thread = buildTestSnapshot().threads[0]!;

    expect(
      shouldRetainPendingPromptSend({
        thread,
        startedAt: "2026-03-20T14:00:00.000Z",
        hasPendingThreadHistory: false,
        isThreadTurnRunning: false,
      }),
    ).toBe(true);
  });
});
