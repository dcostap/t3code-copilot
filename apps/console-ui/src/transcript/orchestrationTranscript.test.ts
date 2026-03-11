import { EventId, MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildDemoSnapshot } from "../consoleData/demoSnapshot";
import { threadToTranscriptBlocks } from "./orchestrationTranscript";

describe("threadToTranscriptBlocks", () => {
  it("keeps activity ordering stable with sequence under bursty timestamps", () => {
    const snapshot = buildDemoSnapshot();
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
    const snapshot = buildDemoSnapshot();
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
    const snapshot = buildDemoSnapshot();
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
});
