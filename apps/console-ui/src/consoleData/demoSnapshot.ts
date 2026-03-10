import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { OrchestrationReadModel } from "@t3tools/contracts";

const PROJECT_ID = ProjectId.makeUnsafe("project-console-demo");
const THREAD_ID = ThreadId.makeUnsafe("thread-console-demo");
const TURN_1 = TurnId.makeUnsafe("turn-console-demo-1");
const TURN_2 = TurnId.makeUnsafe("turn-console-demo-2");
const TURN_3 = TurnId.makeUnsafe("turn-console-demo-3");
const START_AT = Date.parse("2026-03-10T09:00:00.000Z");

function isoAt(offsetSeconds: number) {
  return new Date(START_AT + offsetSeconds * 1_000).toISOString();
}

export function buildDemoSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Console UI Demo",
        workspaceRoot: "C:\\Projects\\t3code-copilot",
        defaultModel: "gpt-5",
        scripts: [],
        createdAt: isoAt(0),
        updatedAt: isoAt(140),
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Agent Transcript Demo",
        model: "gpt-5",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: "C:\\Projects\\t3code-copilot",
        latestTurn: {
          turnId: TURN_3,
          state: "completed",
          requestedAt: isoAt(96),
          startedAt: isoAt(98),
          completedAt: isoAt(122),
          assistantMessageId: MessageId.makeUnsafe("assistant-msg-3"),
        },
        createdAt: isoAt(0),
        updatedAt: isoAt(140),
        deletedAt: null,
        messages: [
          {
            id: MessageId.makeUnsafe("user-msg-1"),
            role: "user",
            text: "Find and fix the resize bug in the new console transcript.",
            attachments: [],
            turnId: TURN_1,
            streaming: false,
            createdAt: isoAt(2),
            updatedAt: isoAt(2),
          },
          {
            id: MessageId.makeUnsafe("assistant-msg-1"),
            role: "assistant",
            text: [
              "I traced it to the split scroll model.",
              "",
              "The composer and transcript were competing for height, so I reworked the layout around a single conversation scrollpane.",
            ].join("\n"),
            attachments: [],
            turnId: TURN_1,
            streaming: false,
            createdAt: isoAt(32),
            updatedAt: isoAt(35),
          },
          {
            id: MessageId.makeUnsafe("user-msg-2"),
            role: "user",
            text: "Run the checks and summarize what changed.",
            attachments: [],
            turnId: TURN_2,
            streaming: false,
            createdAt: isoAt(45),
            updatedAt: isoAt(45),
          },
          {
            id: MessageId.makeUnsafe("assistant-msg-2"),
            role: "assistant",
            text: [
              "I validated the package and repo checks.",
              "",
              "The console prototype now renders transcript, plans, tool activity, approvals, and diffs from the orchestration thread model instead of a fake transcript shape.",
            ].join("\n"),
            attachments: [],
            turnId: TURN_2,
            streaming: false,
            createdAt: isoAt(78),
            updatedAt: isoAt(80),
          },
          {
            id: MessageId.makeUnsafe("user-msg-3"),
            role: "user",
            text: "Can you inspect this screenshot next?",
            attachments: [
              {
                type: "image",
                id: "attach-console-demo-1",
                name: "layout-glitch.png",
                mimeType: "image/png",
                sizeBytes: 84211,
              },
            ],
            turnId: TURN_3,
            streaming: false,
            createdAt: isoAt(96),
            updatedAt: isoAt(96),
          },
          {
            id: MessageId.makeUnsafe("assistant-msg-3"),
            role: "assistant",
            text: [
              "Yes. The screenshot confirms the composer should live in the same transcript flow as the rest of the conversation.",
              "",
              "This demo thread is contract-shaped data, so you can test the transcript UI locally without connecting a model.",
            ].join("\n"),
            attachments: [],
            turnId: TURN_3,
            streaming: false,
            createdAt: isoAt(118),
            updatedAt: isoAt(122),
          },
        ],
        proposedPlans: [
          {
            id: "plan-console-demo-1",
            turnId: TURN_2,
            planMarkdown: [
              "## Console UI migration",
              "",
              "- Bind the prototype to `OrchestrationReadModel`.",
              "- Render tool activity, plans, approvals, and diff checkpoints as transcript blocks.",
              "- Keep a demo source for local UI iteration without a provider session.",
            ].join("\n"),
            createdAt: isoAt(56),
            updatedAt: isoAt(57),
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-console-demo-1"),
            tone: "info",
            kind: "task.progress",
            summary: "Reasoning update",
            payload: {
              detail: "Tracing the transcript/composer height chain through the console shell.",
            },
            turnId: TURN_1,
            sequence: 1,
            createdAt: isoAt(8),
          },
          {
            id: EventId.makeUnsafe("activity-console-demo-2"),
            tone: "tool",
            kind: "tool.started",
            summary: "Search workspace started",
            payload: {
              itemType: "web_search",
              title: "Search workspace",
              status: "inProgress",
              data: {
                query: "console-shell transcript composer",
              },
            },
            turnId: TURN_1,
            sequence: 2,
            createdAt: isoAt(10),
          },
          {
            id: EventId.makeUnsafe("activity-console-demo-3"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Search workspace complete",
            payload: {
              itemType: "web_search",
              title: "Search workspace",
              status: "completed",
              detail: "Matched App.tsx, index.css, and TranscriptRenderer.tsx.",
              data: {
                query: "console-shell transcript composer",
              },
            },
            turnId: TURN_1,
            sequence: 3,
            createdAt: isoAt(12),
          },
          {
            id: EventId.makeUnsafe("activity-console-demo-4"),
            tone: "approval",
            kind: "approval.requested",
            summary: "File-change approval requested",
            payload: {
              requestId: "approval-console-demo-1",
              requestKind: "file-change",
              requestType: "apply_patch_approval",
              detail: "Patch apps/console-ui/src/App.tsx and apps/console-ui/src/index.css",
            },
            turnId: TURN_1,
            sequence: 4,
            createdAt: isoAt(15),
          },
          {
            id: EventId.makeUnsafe("activity-console-demo-5"),
            tone: "approval",
            kind: "approval.resolved",
            summary: "Approval resolved",
            payload: {
              requestId: "approval-console-demo-1",
              requestKind: "file-change",
              requestType: "apply_patch_approval",
              decision: "approved",
            },
            turnId: TURN_1,
            sequence: 5,
            createdAt: isoAt(18),
          },
          {
            id: EventId.makeUnsafe("activity-console-demo-6"),
            tone: "info",
            kind: "turn.plan.updated",
            summary: "Plan updated",
            payload: {
              explanation: "Reshape the UI around a single conversation scroll owner.",
              plan: [
                { step: "Replace fake transcript input with contract-shaped data", status: "completed" },
                { step: "Adapt orchestration thread state into transcript blocks", status: "completed" },
                { step: "Keep demo and live data sources behind one console adapter", status: "inProgress" },
              ],
            },
            turnId: TURN_2,
            sequence: 6,
            createdAt: isoAt(55),
          },
          {
            id: EventId.makeUnsafe("activity-console-demo-7"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Run checks complete",
            payload: {
              itemType: "command_execution",
              title: "Run checks",
              status: "completed",
              data: {
                item: {
                  input: {
                    command: ["bun", "typecheck"],
                  },
                  result: {
                    exitCode: 0,
                    content: "8 packages successful in 6.5s",
                  },
                },
              },
            },
            turnId: TURN_2,
            sequence: 7,
            createdAt: isoAt(62),
          },
          {
            id: EventId.makeUnsafe("activity-console-demo-8"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-console-demo-1",
              questions: [
                {
                  id: "source_mode",
                  header: "Source",
                  question: "Which data source should the console use by default?",
                  options: [
                    {
                      label: "Demo",
                      description: "Use local thread fixtures without a provider session.",
                    },
                    {
                      label: "Live",
                      description: "Connect to the orchestration websocket and render real backend state.",
                    },
                  ],
                },
              ],
            },
            turnId: TURN_3,
            sequence: 8,
            createdAt: isoAt(102),
          },
          {
            id: EventId.makeUnsafe("activity-console-demo-9"),
            tone: "info",
            kind: "runtime.warning",
            summary: "Runtime warning",
            payload: {
              message: "Demo mode is active. No provider session is required.",
            },
            turnId: TURN_3,
            sequence: 9,
            createdAt: isoAt(104),
          },
        ],
        checkpoints: [
          {
            turnId: TURN_1,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("provider-diff:console-demo-1"),
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
            assistantMessageId: MessageId.makeUnsafe("assistant-msg-1"),
            completedAt: isoAt(30),
          },
        ],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: isoAt(122),
        },
      },
    ],
    updatedAt: isoAt(140),
  };
}
