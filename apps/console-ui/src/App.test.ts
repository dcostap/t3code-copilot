import { describe, expect, it } from "vitest";
import { EventId, ThreadId } from "@t3tools/contracts";

import {
  canDropDraggedThreadIntoProject,
  canDropDraggedThreadIntoSplitZone,
  findDuplicateProjectForWorkspaceRoot,
  findReusableDraftPaneForThreadOpen,
  formatManageThreadTimestamp,
  getConversationPaneClassName,
  getSidebarProjectSectionClassName,
  getSidebarThreadClassName,
  getSidebarThreadStatusClassName,
  getSidebarThreadGroups,
  getSidebarThreadTitleClassName,
  getThreadStatus,
  getThreadSplitDropZoneClassName,
  isDraggedThreadSplitZoneLimitReached,
  isPaletteToggleShortcut,
  normalizeProjectWorkspaceRootForComparison,
  parsePersistedArchivedProjectIds,
  parsePersistedUnreadThreadIds,
  reconcileUnreadThreadIds,
  reorderProjectIds,
  resolveProjectSelectionAfterArchive,
  resolveManagedThreadRowSelection,
  shouldBlockGlobalPromptTypingForSelection,
  shouldOpenPaneSearchShortcut,
  shouldScopeGlobalSelectAllToHistory,
  summarizeThreadSelection,
  shouldRetainPendingPromptSend,
  shouldSuppressTabFocusNavigation,
  toggleManagedThreadChecksForRows,
} from "./App";
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

describe("getSidebarThreadTitleClassName", () => {
  it("adds the loading classes for working threads", () => {
    expect(getSidebarThreadTitleClassName({
      statusTone: "working",
      isActive: false,
    })).toBe("project-thread__title project-thread__title--loading");
  });

  it("adds the active loading class for the active working thread", () => {
    expect(getSidebarThreadTitleClassName({
      statusTone: "working",
      isActive: true,
    })).toBe("project-thread__title project-thread__title--loading project-thread__title--loadingActive");
  });

  it("keeps idle threads on the static title class", () => {
    expect(getSidebarThreadTitleClassName({
      statusTone: "idle",
      isActive: true,
    })).toBe("project-thread__title");
  });
});

describe("getSidebarThreadStatusClassName", () => {
  it("adds the loading classes for working thread status labels", () => {
    expect(getSidebarThreadStatusClassName({
      statusTone: "working",
      isActive: false,
    })).toBe("project-thread__status project-thread__status--working project-thread__status--loading");
  });

  it("adds the active loading class for the active working thread status label", () => {
    expect(getSidebarThreadStatusClassName({
      statusTone: "working",
      isActive: true,
    })).toBe("project-thread__status project-thread__status--working project-thread__status--loading project-thread__status--loadingActive");
  });

  it("keeps idle status labels on the static classes", () => {
    expect(getSidebarThreadStatusClassName({
      statusTone: "idle",
      isActive: true,
    })).toBe("project-thread__status project-thread__status--idle");
  });
});

describe("getSidebarThreadClassName", () => {
  it("only marks threads as stale once they are at least five days old", () => {
    expect(getSidebarThreadClassName({
      ageMs: (5 * 24 * 60 * 60 * 1000) - 1,
      hasUnreadMarker: false,
      isActive: false,
    })).toBe("project-thread");

    expect(getSidebarThreadClassName({
      ageMs: 5 * 24 * 60 * 60 * 1000,
      hasUnreadMarker: false,
      isActive: false,
    })).toBe("project-thread project-thread--stale");
  });

  it("keeps active and unread classes without the removed age buckets", () => {
    expect(getSidebarThreadClassName({
      ageMs: 2 * 60 * 60 * 1000,
      hasUnreadMarker: true,
      isActive: true,
    })).toBe("project-thread project-thread--active project-thread--unread");
  });
});

describe("getSidebarProjectSectionClassName", () => {
  it("adds active, dragging, and drop-target states independently", () => {
    expect(getSidebarProjectSectionClassName({
      isActive: true,
      isDragging: true,
      isDragOver: false,
    })).toBe("project-tree__section project-tree__section--active project-tree__section--dragging");

    expect(getSidebarProjectSectionClassName({
      isActive: false,
      isDragging: false,
      isDragOver: true,
    })).toBe("project-tree__section project-tree__section--dragOver");
  });
});

describe("reorderProjectIds", () => {
  it("moves the dragged project to the hovered target index", () => {
    expect(reorderProjectIds(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(reorderProjectIds(["a", "b", "c", "d"], "b", "c")).toEqual(["a", "c", "b", "d"]);
    expect(reorderProjectIds(["a", "b", "c", "d"], "b", "d")).toEqual(["a", "c", "d", "b"]);
  });

  it("keeps the current order when the target is unchanged or missing", () => {
    expect(reorderProjectIds(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
    expect(reorderProjectIds(["a", "b", "c"], "b", "z")).toEqual(["a", "b", "c"]);
  });
});

describe("canDropDraggedThreadIntoProject", () => {
  it("allows dropping only when the dragged thread belongs to the target project", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0]!;

    expect(canDropDraggedThreadIntoProject({
      draggedThreadId: thread.id,
      targetProjectId: thread.projectId,
      threads: snapshot.threads,
    })).toBe(true);

    expect(canDropDraggedThreadIntoProject({
      draggedThreadId: thread.id,
      targetProjectId: "project:other" as typeof thread.projectId,
      threads: snapshot.threads,
    })).toBe(false);
  });
});

describe("canDropDraggedThreadIntoSplitZone", () => {
  it("requires a matching project and spare pane capacity", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0]!;

    expect(canDropDraggedThreadIntoSplitZone({
      draggedThreadId: thread.id,
      targetProjectId: thread.projectId,
      activeTabPaneCount: 2,
      threads: snapshot.threads,
    })).toBe(true);

    expect(canDropDraggedThreadIntoSplitZone({
      draggedThreadId: thread.id,
      targetProjectId: thread.projectId,
      activeTabPaneCount: 6,
      threads: snapshot.threads,
    })).toBe(false);
  });
});

describe("isDraggedThreadSplitZoneLimitReached", () => {
  it("reports the split limit only for matching-project drags", () => {
    const snapshot = buildTestSnapshot();
    const thread = snapshot.threads[0]!;

    expect(isDraggedThreadSplitZoneLimitReached({
      draggedThreadId: thread.id,
      targetProjectId: thread.projectId,
      activeTabPaneCount: 6,
      threads: snapshot.threads,
    })).toBe(true);

    expect(isDraggedThreadSplitZoneLimitReached({
      draggedThreadId: thread.id,
      targetProjectId: "project:other" as typeof thread.projectId,
      activeTabPaneCount: 6,
      threads: snapshot.threads,
    })).toBe(false);
  });
});

describe("getConversationPaneClassName", () => {
  it("adds the drop target, drag-over, and highlight classes when applicable", () => {
    expect(getConversationPaneClassName({
      isActive: true,
      isDropEligible: true,
      isDragOver: true,
      isHighlighted: true,
    })).toBe(
      "conversation-pane conversation-pane--active conversation-pane--drop-target conversation-pane--drag-over conversation-pane--highlight",
    );
  });
});

describe("getThreadSplitDropZoneClassName", () => {
  it("builds the expected class list for an active split drop target", () => {
    expect(getThreadSplitDropZoneClassName({
      isDragActive: true,
      isDropEligible: true,
      isDragOver: true,
      isLimitReached: false,
    })).toBe(
      "project-split-dropzone project-split-dropzone--drag-active project-split-dropzone--eligible project-split-dropzone--drag-over",
    );
  });

  it("marks the split zone as limit reached when no more panes fit", () => {
    expect(getThreadSplitDropZoneClassName({
      isDragActive: true,
      isDropEligible: false,
      isDragOver: false,
      isLimitReached: true,
    })).toBe(
      "project-split-dropzone project-split-dropzone--drag-active project-split-dropzone--limit-reached",
    );
  });
});

describe("shouldSuppressTabFocusNavigation", () => {
  it("suppresses plain tab navigation", () => {
    expect(shouldSuppressTabFocusNavigation({
      key: "Tab",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    })).toBe(true);
  });

  it("does not suppress modified tab shortcuts", () => {
    expect(shouldSuppressTabFocusNavigation({
      key: "Tab",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
    })).toBe(false);
  });
});

describe("isPaletteToggleShortcut", () => {
  it("matches ctrl+shift+a", () => {
    expect(isPaletteToggleShortcut({
      key: "a",
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      altKey: false,
    })).toBe(true);
  });

  it("does not match the old ctrl+k shortcut", () => {
    expect(isPaletteToggleShortcut({
      key: "k",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      altKey: false,
    })).toBe(false);
  });
});

describe("shouldOpenPaneSearchShortcut", () => {
  it("matches ctrl+f", () => {
    expect(shouldOpenPaneSearchShortcut({
      key: "f",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
    })).toBe(true);
  });

  it("matches cmd+f", () => {
    expect(shouldOpenPaneSearchShortcut({
      key: "F",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
    })).toBe(true);
  });

  it("ignores alt-modified find shortcuts", () => {
    expect(shouldOpenPaneSearchShortcut({
      key: "f",
      ctrlKey: true,
      metaKey: false,
      altKey: true,
    })).toBe(false);
  });
});

describe("shouldBlockGlobalPromptTypingForSelection", () => {
  it("blocks global prompt typing when selection exists outside active history", () => {
    expect(shouldBlockGlobalPromptTypingForSelection({
      hasSelectionInDocument: true,
      hasSelectionInActiveHistory: false,
    })).toBe(true);
  });

  it("allows global prompt typing when the selection is in active history", () => {
    expect(shouldBlockGlobalPromptTypingForSelection({
      hasSelectionInDocument: true,
      hasSelectionInActiveHistory: true,
    })).toBe(false);
  });
});

describe("shouldScopeGlobalSelectAllToHistory", () => {
  it("routes ctrl+a to history when the active pane is in history mode", () => {
    expect(shouldScopeGlobalSelectAllToHistory({
      key: "a",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      historyActive: true,
    })).toBe(true);
  });

  it("does not route ctrl+a when history is not active", () => {
    expect(shouldScopeGlobalSelectAllToHistory({
      key: "a",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      historyActive: false,
    })).toBe(false);
  });
});

describe("summarizeThreadSelection", () => {
  it("reports partial selection correctly", () => {
    expect(summarizeThreadSelection(["thread:1", "thread:2"], new Set(["thread:2"]))).toEqual({
      totalCount: 2,
      selectedCount: 1,
      allSelected: false,
      partiallySelected: true,
    });
  });

  it("reports all-selected only when every thread id is selected", () => {
    expect(summarizeThreadSelection(["thread:1", "thread:2"], new Set(["thread:1", "thread:2"]))).toEqual({
      totalCount: 2,
      selectedCount: 2,
      allSelected: true,
      partiallySelected: false,
    });
  });
});

describe("formatManageThreadTimestamp", () => {
  it("formats timestamps as yyyy-mm-dd without time", () => {
    expect(formatManageThreadTimestamp("2026-03-21T19:40:00.000Z")).toBe("2026-03-21");
  });
});

describe("getThreadStatus", () => {
  it("treats open pending user input as waiting instead of working", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const pendingUserInputActivity = {
      id: EventId.makeUnsafe("activity-pending-user-input"),
      tone: "info",
      kind: "user-input.requested",
      summary: "Question asked",
      payload: {
        requestId: "user-input-open-1",
        questions: [{
          id: "question-1",
          header: "Snapshot shape",
          question: "How should the snapshot be stored?",
          options: [{
            label: "Per vehicle",
            description: "Store one snapshot per imported vehicle.",
          }],
        }],
      },
      turnId: thread.latestTurn!.turnId,
      sequence: 999,
      createdAt: "2026-03-20T12:06:00.000Z",
    } satisfies (typeof thread.activities)[number];
    const runningTurn = {
      ...thread,
      latestTurn: {
        ...thread.latestTurn!,
        state: "running" as const,
        requestedAt: "2026-03-20T12:00:00.000Z",
        startedAt: "2026-03-20T12:00:05.000Z",
        completedAt: null,
      },
      session: {
        ...thread.session!,
        status: "running" as const,
        activeTurnId: thread.latestTurn!.turnId,
        updatedAt: "2026-03-20T12:05:00.000Z",
      },
      activities: [
        ...thread.activities,
        pendingUserInputActivity,
      ],
    };

    expect(getThreadStatus(
      runningTurn,
      "2026-03-20T12:16:00.000Z",
      true,
      "2026-03-20T12:06:00.000Z",
    )).toEqual({
      tone: "waiting",
      label: "Waiting for input 10m",
    });
  });

  it("uses the running intent label while waiting on user input when available", () => {
    const thread = buildTestSnapshot().threads[0]!;
    const reportIntentActivity = {
      id: EventId.makeUnsafe("activity-report-intent"),
      tone: "tool",
      kind: "tool.completed",
      summary: "Report intent",
      payload: {
        title: "Report Intent",
        detail: "intent=asking user",
        data: {
          item: {
            toolName: "report_intent",
            arguments: {
              intent: "asking user",
            },
          },
        },
      },
      turnId: thread.latestTurn!.turnId,
      sequence: 998,
      createdAt: "2026-03-20T12:05:30.000Z",
    } satisfies (typeof thread.activities)[number];
    const runningTurn = {
      ...thread,
      latestTurn: {
        ...thread.latestTurn!,
        state: "running" as const,
        requestedAt: "2026-03-20T12:00:00.000Z",
        startedAt: "2026-03-20T12:00:05.000Z",
        completedAt: null,
      },
      session: {
        ...thread.session!,
        status: "running" as const,
        activeTurnId: thread.latestTurn!.turnId,
        updatedAt: "2026-03-20T12:05:00.000Z",
      },
      activities: [
        ...thread.activities,
        reportIntentActivity,
      ],
    };

    expect(getThreadStatus(
      runningTurn,
      "2026-03-20T12:16:00.000Z",
      true,
      "2026-03-20T12:06:00.000Z",
    )).toEqual({
      tone: "waiting",
      label: "Asking user 10m",
    });
  });

  it("splits the working status into an animated label and a static timing suffix", () => {
    const thread = buildTestSnapshot().threads[0]!;

    expect(getThreadStatus(
      {
        ...thread,
        latestTurn: {
          ...thread.latestTurn!,
          state: "running",
          requestedAt: "2026-03-20T12:00:00.000Z",
          startedAt: "2026-03-20T12:00:05.000Z",
          completedAt: null,
        },
        session: {
          ...thread.session!,
          status: "running",
          activeTurnId: thread.latestTurn!.turnId,
          updatedAt: "2026-03-20T12:05:00.000Z",
        },
      },
      "2026-03-20T12:16:00.000Z",
      true,
    )).toEqual({
      tone: "working",
      label: "Working 15m",
      animatedLabel: "Working",
      timingLabel: "15m",
    });
  });
});

describe("resolveManagedThreadRowSelection", () => {
  it("replaces the selected row set on plain click", () => {
    expect(resolveManagedThreadRowSelection({
      orderedThreadIds: ["thread:1", "thread:2", "thread:3"],
      currentSelectedRowIds: new Set(["thread:1", "thread:2"]),
      clickedThreadId: "thread:3",
      anchorThreadId: "thread:2",
      additive: false,
      range: false,
    })).toEqual({
      selectedRowIds: new Set(["thread:3"]),
      activeRowId: "thread:3",
      nextAnchorThreadId: "thread:3",
    });
  });

  it("selects a contiguous range on shift-click", () => {
    expect(resolveManagedThreadRowSelection({
      orderedThreadIds: ["thread:1", "thread:2", "thread:3", "thread:4"],
      currentSelectedRowIds: new Set(["thread:2"]),
      clickedThreadId: "thread:4",
      anchorThreadId: "thread:2",
      additive: false,
      range: true,
    })).toEqual({
      selectedRowIds: new Set(["thread:2", "thread:3", "thread:4"]),
      activeRowId: "thread:4",
      nextAnchorThreadId: "thread:4",
    });
  });

  it("toggles membership on ctrl-click", () => {
    expect(resolveManagedThreadRowSelection({
      orderedThreadIds: ["thread:1", "thread:2"],
      currentSelectedRowIds: new Set(["thread:1"]),
      clickedThreadId: "thread:2",
      anchorThreadId: "thread:1",
      additive: true,
      range: false,
    })).toEqual({
      selectedRowIds: new Set(["thread:1", "thread:2"]),
      activeRowId: "thread:2",
      nextAnchorThreadId: "thread:2",
    });
  });
});

describe("toggleManagedThreadChecksForRows", () => {
  it("checks every selected row when any selected row is unchecked", () => {
    expect(toggleManagedThreadChecksForRows(
      new Set(["thread:1"]),
      new Set(["thread:1", "thread:2"]),
      null,
    )).toEqual(new Set(["thread:1", "thread:2"]));
  });

  it("unchecks every selected row when they are all already checked", () => {
    expect(toggleManagedThreadChecksForRows(
      new Set(["thread:1", "thread:2"]),
      new Set(["thread:1", "thread:2"]),
      null,
    )).toEqual(new Set());
  });
});

describe("parsePersistedArchivedProjectIds", () => {
  it("reads archived project ids from stored json", () => {
    expect(parsePersistedArchivedProjectIds(JSON.stringify(["project:1", "project:2"]))).toEqual(
      new Set(["project:1", "project:2"]),
    );
  });

  it("ignores malformed archived project storage", () => {
    expect(parsePersistedArchivedProjectIds("{not-json")).toEqual(new Set());
  });
});

describe("parsePersistedUnreadThreadIds", () => {
  it("reads unread thread ids from stored json", () => {
    expect(parsePersistedUnreadThreadIds(JSON.stringify(["thread:1", "thread:2"]))).toEqual(
      new Set(["thread:1", "thread:2"]),
    );
  });

  it("ignores malformed unread thread storage", () => {
    expect(parsePersistedUnreadThreadIds("{not-json")).toEqual(new Set());
  });
});

describe("reconcileUnreadThreadIds", () => {
  it("marks a thread unread when it transitions from running to finished off-screen", () => {
    const result = reconcileUnreadThreadIds({
      currentUnreadThreadIds: new Set<string>(),
      previousRunningByThreadId: new Map([["thread:1", true]]),
      threadSnapshots: [
        { threadId: "thread:1", isRunning: false, isDeleted: false },
      ],
      activeThreadId: "thread:2",
    });

    expect(result.unreadThreadIds).toEqual(new Set(["thread:1"]));
    expect(result.runningByThreadId).toEqual(new Map([["thread:1", false]]));
  });

  it("does not mark the currently focused thread unread when it finishes", () => {
    const result = reconcileUnreadThreadIds({
      currentUnreadThreadIds: new Set<string>(),
      previousRunningByThreadId: new Map([["thread:1", true]]),
      threadSnapshots: [
        { threadId: "thread:1", isRunning: false, isDeleted: false },
      ],
      activeThreadId: "thread:1",
    });

    expect(result.unreadThreadIds).toEqual(new Set());
  });

  it("clears unread threads once their pane becomes active", () => {
    const result = reconcileUnreadThreadIds({
      currentUnreadThreadIds: new Set(["thread:1", "thread:2"]),
      previousRunningByThreadId: new Map<string, boolean>(),
      threadSnapshots: [
        { threadId: "thread:1", isRunning: false, isDeleted: false },
        { threadId: "thread:2", isRunning: false, isDeleted: false },
      ],
      activeThreadId: "thread:2",
    });

    expect(result.unreadThreadIds).toEqual(new Set(["thread:1"]));
  });

  it("drops unread ids for deleted or missing threads", () => {
    const result = reconcileUnreadThreadIds({
      currentUnreadThreadIds: new Set(["thread:1", "thread:2", "thread:3"]),
      previousRunningByThreadId: new Map<string, boolean>(),
      threadSnapshots: [
        { threadId: "thread:1", isRunning: false, isDeleted: false },
        { threadId: "thread:2", isRunning: false, isDeleted: true },
      ],
      activeThreadId: null,
    });

    expect(result.unreadThreadIds).toEqual(new Set(["thread:1"]));
  });
});

describe("resolveProjectSelectionAfterArchive", () => {
  it("switches to another visible project when the active one is archived", () => {
    expect(resolveProjectSelectionAfterArchive({
      activeProjectId: "project:1",
      archivedProjectId: "project:1",
      visibleProjectIds: ["project:1", "project:2", "project:3"],
    })).toBe("project:2");
  });

  it("clears selection when archiving the only visible active project", () => {
    expect(resolveProjectSelectionAfterArchive({
      activeProjectId: "project:1",
      archivedProjectId: "project:1",
      visibleProjectIds: ["project:1"],
    })).toBeNull();
  });

  it("leaves selection alone when archiving a background project", () => {
    expect(resolveProjectSelectionAfterArchive({
      activeProjectId: "project:2",
      archivedProjectId: "project:1",
      visibleProjectIds: ["project:1", "project:2"],
    })).toBe("project:2");
  });
});

describe("normalizeProjectWorkspaceRootForComparison", () => {
  it("normalizes slashes, trailing separators, quotes, and case", () => {
    expect(normalizeProjectWorkspaceRootForComparison("\"C:/Projects/Repo\\\\\"")).toBe("c:\\projects\\repo");
  });
});

describe("findDuplicateProjectForWorkspaceRoot", () => {
  it("finds an existing matching project by normalized path", () => {
    const snapshot = buildTestSnapshot();
    const match = findDuplicateProjectForWorkspaceRoot({
      projects: snapshot.projects,
      archivedProjectIds: new Set(),
      workspaceRoot: "c:/projects/t3code-copilot/",
    });

    expect(match).toEqual({
      projectId: snapshot.projects[0]!.id,
      title: snapshot.projects[0]!.title,
      workspaceRoot: snapshot.projects[0]!.workspaceRoot,
      isArchived: false,
    });
  });

  it("prefers a visible project over an archived duplicate", () => {
    const snapshot = buildTestSnapshot();
    const visible = snapshot.projects[0]!;
    const archived = {
      ...visible,
      id: "project:archived" as typeof visible.id,
    };

    const match = findDuplicateProjectForWorkspaceRoot({
      projects: [archived, visible],
      archivedProjectIds: new Set([archived.id]),
      workspaceRoot: visible.workspaceRoot,
    });

    expect(match?.projectId).toBe(visible.id);
    expect(match?.isArchived).toBe(false);
  });
});

describe("findReusableDraftPaneForThreadOpen", () => {
  it("reuses a single-pane draft tab when it is empty", () => {
    expect(findReusableDraftPaneForThreadOpen({
      layout: {
        tabs: [{
          id: "tab:1",
          paneIds: ["pane:draft"],
          activePaneId: "pane:draft",
          createdAt: "2026-03-21T00:00:00.000Z",
        }],
        panesById: {
          "pane:draft": {
            id: "pane:draft",
            kind: "draft",
            setup: {
              type: "new-thread",
              selectedProvider: "codex",
              selectedModel: "gpt-5-codex",
              createdAt: "2026-03-21T00:00:00.000Z",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            },
          },
        },
      },
      draftsByPaneId: {},
      attachmentsByPaneId: {},
      pendingDraftPaneIds: new Set(),
    })).toEqual({
      tabId: "tab:1",
      paneId: "pane:draft",
    });
  });

  it("does not reuse a draft tab when it already has prompt text", () => {
    expect(findReusableDraftPaneForThreadOpen({
      layout: {
        tabs: [{
          id: "tab:1",
          paneIds: ["pane:draft"],
          activePaneId: "pane:draft",
          createdAt: "2026-03-21T00:00:00.000Z",
        }],
        panesById: {
          "pane:draft": {
            id: "pane:draft",
            kind: "draft",
            setup: {
              type: "new-thread",
              selectedProvider: "codex",
              selectedModel: "gpt-5-codex",
              createdAt: "2026-03-21T00:00:00.000Z",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            },
          },
        },
      },
      draftsByPaneId: { "pane:draft": "hello" },
      attachmentsByPaneId: {},
      pendingDraftPaneIds: new Set(),
    })).toBeNull();
  });
});

describe("getSidebarThreadGroups", () => {
  it("keeps the existing thread order within each tab group", () => {
    const threadId1 = ThreadId.makeUnsafe("thread:1");
    const threadId2 = ThreadId.makeUnsafe("thread:2");
    const threadId3 = ThreadId.makeUnsafe("thread:3");
    const groups = getSidebarThreadGroups({
      layout: {
        tabs: [
          {
            id: "tab:1",
            paneIds: ["pane:1"],
            activePaneId: "pane:1",
            createdAt: "2026-03-21T00:00:00.000Z",
          },
          {
            id: "tab:2",
            paneIds: ["pane:2"],
            activePaneId: "pane:2",
            createdAt: "2026-03-21T00:00:01.000Z",
          },
        ],
        panesById: {
          "pane:1": { id: "pane:1", kind: "thread", threadId: threadId2 },
          "pane:2": { id: "pane:2", kind: "thread", threadId: threadId3 },
        },
      },
      threadEntries: [
        { thread: { id: threadId3 } },
        { thread: { id: threadId2 } },
        { thread: { id: threadId1 } },
      ],
    });

    expect(groups).toEqual([
      {
        key: "tab:1",
        label: "Tab 1",
        entries: [{ thread: { id: threadId2 } }],
      },
      {
        key: "tab:2",
        label: "Tab 2",
        entries: [{ thread: { id: threadId3 } }],
      },
      {
        key: "ungrouped",
        label: null,
        entries: [{ thread: { id: threadId1 } }],
      },
    ]);
  });

  it("skips tab labels when the project has a single tab", () => {
    const threadId1 = ThreadId.makeUnsafe("thread:1");
    const groups = getSidebarThreadGroups({
      layout: {
        tabs: [{
          id: "tab:1",
          paneIds: ["pane:1"],
          activePaneId: "pane:1",
          createdAt: "2026-03-21T00:00:00.000Z",
        }],
        panesById: {
          "pane:1": { id: "pane:1", kind: "thread", threadId: threadId1 },
        },
      },
      threadEntries: [{ thread: { id: threadId1 } }],
    });

    expect(groups).toEqual([
      {
        key: "all",
        label: null,
        entries: [{ thread: { id: threadId1 } }],
      },
    ]);
  });
});
