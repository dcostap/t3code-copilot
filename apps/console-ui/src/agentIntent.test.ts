import { EventId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveRunningThreadIntentLabel,
  extractReportIntentLabel,
  MAX_AGENT_INTENT_LABEL_LENGTH,
} from "./agentIntent";
import { buildTestSnapshot } from "./testSupport/testSnapshot";

describe("agentIntent", () => {
  it("extracts, capitalizes, and truncates report_intent labels", () => {
    expect(
      extractReportIntentLabel({
        title: "report_intent",
        data: {
          arguments: {
            intent: "browsing the internet for very long research updates that overflow",
          },
        },
      }),
    ).toBe("Browsing the internet for very long r...");
    expect(
      extractReportIntentLabel({
        title: "report_intent",
        detail: "intent=summarizing directories",
      }),
    ).toBe("Summarizing directories");
  });

  it("returns the latest running-turn report intent label", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();
    const runningTurnId = TurnId.makeUnsafe("turn-running-intent");

    const derived = deriveRunningThreadIntentLabel({
      ...thread!,
      latestTurn: {
        turnId: runningTurnId,
        state: "running",
        requestedAt: "2026-03-22T21:00:00.000Z",
        startedAt: "2026-03-22T21:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        ...thread!.session!,
        status: "running",
        activeTurnId: runningTurnId,
        updatedAt: "2026-03-22T21:00:06.000Z",
      },
      activities: [
        {
          id: EventId.makeUnsafe("activity-report-intent-stale"),
          tone: "tool",
          kind: "tool.started",
          summary: "report_intent started",
          payload: {
            itemType: "tool",
            itemId: "report-intent-stale",
            title: "report_intent",
            status: "completed",
            data: {
              arguments: {
                intent: "old intent",
              },
            },
          },
          turnId: null,
          sequence: 1,
          createdAt: "2026-03-22T20:59:59.000Z",
        },
        {
          id: EventId.makeUnsafe("activity-report-intent-current"),
          tone: "tool",
          kind: "tool.started",
          summary: "report_intent started",
          payload: {
            itemType: "tool",
            itemId: "report-intent-current",
            title: "report_intent",
            status: "completed",
            data: {
              arguments: {
                intent: "summarizing directories",
              },
            },
          },
          turnId: null,
          sequence: 2,
          createdAt: "2026-03-22T21:00:03.000Z",
        },
      ],
    });

    expect(derived).toBe("Summarizing directories");
  });

  it("keeps normalized labels within the configured max length", () => {
    const label = extractReportIntentLabel({
      title: "report_intent",
      data: {
        arguments: {
          intent: "abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz",
        },
      },
    });

    expect(label).not.toBeNull();
    expect(label!.length).toBeLessThanOrEqual(MAX_AGENT_INTENT_LABEL_LENGTH);
  });
});
