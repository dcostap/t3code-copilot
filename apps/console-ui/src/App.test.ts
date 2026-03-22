import { describe, expect, it } from "vitest";
import { EventId } from "@t3tools/contracts";

import {
  findDuplicateProjectForWorkspaceRoot,
  findReusableDraftPaneForThreadOpen,
  formatManageThreadTimestamp,
  isPaletteToggleShortcut,
  normalizeProjectWorkspaceRootForComparison,
  parsePersistedArchivedProjectIds,
  resolveManagedThreadRowSelection,
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
