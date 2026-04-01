import { describe, expect, it } from "vitest";

import type {
  OrchestrationProject,
  OrchestrationThread,
} from "@t3tools/contracts";

import {
  replacePaneWithFreshDraft,
  reconcileProjectLayoutsState,
  reconcileProjectLayoutsStateWhenReady,
  resolveThreadCwd,
  type ConsoleProjectLayoutsState,
} from "./consoleSessions";

const project: OrchestrationProject = {
  id: "project:1" as OrchestrationProject["id"],
  title: "Repo",
  workspaceRoot: "C:\\Projects\\repo",
  defaultModel: "gpt-5-codex",
  scripts: [],
  createdAt: "2026-03-12T10:00:00.000Z",
  updatedAt: "2026-03-12T10:00:00.000Z",
  deletedAt: null,
};

const otherProject: OrchestrationProject = {
  ...project,
  id: "project:2" as OrchestrationProject["id"],
  title: "Repo 2",
  workspaceRoot: "C:\\Projects\\repo-2",
};

function makeThread(input: {
  id: string;
  createdAt: string;
  projectId?: OrchestrationProject["id"];
  worktreePath?: string | null;
}): OrchestrationThread {
  return {
    id: input.id as OrchestrationThread["id"],
    projectId: input.projectId ?? project.id,
    provider: "codex",
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath ?? null,
    latestTurn: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    modelOptions: undefined,
  };
}

function createEmptyState(): ConsoleProjectLayoutsState {
  return {
    projectOrder: [],
    collapsedProjectIds: [],
    activeProjectId: null,
    layoutsByProjectId: {},
    lastChosenProvider: "codex",
    lastChosenModelByProvider: {
      codex: "gpt-5-codex",
      copilot: "gpt-5",
    },
    lastChosenModelOptionsByProvider: {
      codex: undefined,
      copilot: undefined,
    },
  };
}

describe("resolveThreadCwd", () => {
  it("prefers worktreePath over project workspaceRoot", () => {
    const thread = makeThread({
      id: "thread:1",
      createdAt: "2026-03-12T10:00:00.000Z",
      worktreePath: "C:\\Projects\\repo-worktree",
    });

    expect(resolveThreadCwd(thread, [project])).toBe("C:\\Projects\\repo-worktree");
  });
});

describe("reconcileProjectLayoutsState", () => {
  it("creates a default layout per project and focuses the preferred thread project", () => {
    const preferredThread = makeThread({
      id: "thread:2",
      createdAt: "2026-03-12T10:05:00.000Z",
      projectId: otherProject.id,
    });

    const state = reconcileProjectLayoutsState({
      state: createEmptyState(),
      threads: [preferredThread],
      projects: [project, otherProject],
      preferredThreadId: preferredThread.id,
    });

    expect(state.projectOrder).toEqual([project.id, otherProject.id]);
    expect(state.activeProjectId).toBe(otherProject.id);
    expect(state.layoutsByProjectId[project.id]?.tabs).toHaveLength(1);
    expect(state.layoutsByProjectId[otherProject.id]?.tabs).toHaveLength(1);
    const initialPane = state.layoutsByProjectId[project.id]?.panesById[
      state.layoutsByProjectId[project.id]!.tabs[0]!.paneIds[0]!
    ];
    expect(initialPane?.kind).toBe("draft");
    if (initialPane?.kind === "draft") {
      expect(initialPane.setup.selectedProvider).toBe("codex");
      expect(initialPane.setup.selectedModel).toBe("gpt-5-codex");
    }
  });

  it("uses the persisted last model for the draft provider when creating default drafts", () => {
    const state = reconcileProjectLayoutsState({
      state: {
        ...createEmptyState(),
        lastChosenProvider: "copilot",
        lastChosenModelByProvider: {
          codex: "gpt-5-codex",
          copilot: "claude-sonnet-4.5",
        },
        lastChosenModelOptionsByProvider: {
          codex: undefined,
          copilot: {
            copilot: {
              reasoningEffort: "high",
            },
          },
        },
      },
      threads: [],
      projects: [project],
      preferredThreadId: null,
    });

    const pane = state.layoutsByProjectId[project.id]?.panesById[
      state.layoutsByProjectId[project.id]!.tabs[0]!.paneIds[0]!
    ];
    expect(pane?.kind).toBe("draft");
    if (pane?.kind === "draft") {
      expect(pane.setup.selectedProvider).toBe("copilot");
      expect(pane.setup.selectedModel).toBe("claude-sonnet-4.5");
      expect(pane.setup.selectedModelOptions).toEqual({
        copilot: {
          reasoningEffort: "high",
        },
      });
    }
  });

  it("replaces duplicate thread panes with a draft pane so a thread stays mounted once per project", () => {
    const thread = makeThread({
      id: "thread:dup",
      createdAt: "2026-03-12T10:00:00.000Z",
    });

    const state = reconcileProjectLayoutsState({
      state: {
        ...createEmptyState(),
        projectOrder: [project.id],
        activeProjectId: project.id,
        layoutsByProjectId: {
          [project.id]: {
            projectId: project.id,
            activeTabId: "tab:1",
            updatedAt: "2026-03-12T10:00:00.000Z",
            tabs: [
              {
                id: "tab:1",
                paneIds: ["pane:1"],
                activePaneId: "pane:1",
                createdAt: "2026-03-12T10:00:00.000Z",
              },
              {
                id: "tab:2",
                paneIds: ["pane:2"],
                activePaneId: "pane:2",
                createdAt: "2026-03-12T10:01:00.000Z",
              },
            ],
            panesById: {
              "pane:1": { id: "pane:1", kind: "thread", threadId: thread.id },
              "pane:2": { id: "pane:2", kind: "thread", threadId: thread.id },
            },
          },
        },
      },
      threads: [thread],
      projects: [project],
      preferredThreadId: thread.id,
    });

    const layout = state.layoutsByProjectId[project.id]!;
    expect(layout.panesById["pane:1"]?.kind).toBe("thread");
    expect(layout.panesById["pane:2"]?.kind).toBe("draft");
  });

  it("replaces thread panes that no longer belong to the project with fresh drafts", () => {
    const foreignThread = makeThread({
      id: "thread:foreign",
      createdAt: "2026-03-12T10:00:00.000Z",
      projectId: otherProject.id,
    });

    const state = reconcileProjectLayoutsState({
      state: {
        ...createEmptyState(),
        projectOrder: [project.id],
        activeProjectId: project.id,
        layoutsByProjectId: {
          [project.id]: {
            projectId: project.id,
            activeTabId: "tab:1",
            updatedAt: "2026-03-12T10:00:00.000Z",
            tabs: [
              {
                id: "tab:1",
                paneIds: ["pane:1"],
                activePaneId: "pane:1",
                createdAt: "2026-03-12T10:00:00.000Z",
              },
            ],
            panesById: {
              "pane:1": { id: "pane:1", kind: "thread", threadId: foreignThread.id },
            },
          },
        },
      },
      threads: [foreignThread],
      projects: [project, otherProject],
      preferredThreadId: null,
    });

    expect(state.layoutsByProjectId[project.id]?.panesById["pane:1"]?.kind).toBe("draft");
  });

  it("preserves terminal panes during reconciliation", () => {
    const state = reconcileProjectLayoutsState({
      state: {
        ...createEmptyState(),
        projectOrder: [project.id],
        activeProjectId: project.id,
        layoutsByProjectId: {
          [project.id]: {
            projectId: project.id,
            activeTabId: "tab:1",
            updatedAt: "2026-03-12T10:00:00.000Z",
            tabs: [
              {
                id: "tab:1",
                paneIds: ["pane:terminal"],
                activePaneId: "pane:terminal",
                createdAt: "2026-03-12T10:00:00.000Z",
              },
            ],
            panesById: {
              "pane:terminal": {
                id: "pane:terminal",
                kind: "terminal",
                terminalSessionId: "terminal-session:1",
                cwd: "C:\\Projects\\repo\\packages\\console-ui",
              },
            },
          },
        },
      },
      threads: [],
      projects: [project],
      preferredThreadId: null,
    });

    expect(state.layoutsByProjectId[project.id]?.panesById["pane:terminal"]).toEqual({
      id: "pane:terminal",
      kind: "terminal",
      terminalSessionId: "terminal-session:1",
      cwd: "C:\\Projects\\repo\\packages\\console-ui",
    });
  });

  it("preserves panes for pending threads until the thread snapshot arrives", () => {
    const pendingThreadId = "thread:pending" as OrchestrationThread["id"];

    const state = reconcileProjectLayoutsState({
      state: {
        ...createEmptyState(),
        projectOrder: [project.id],
        activeProjectId: project.id,
        layoutsByProjectId: {
          [project.id]: {
            projectId: project.id,
            activeTabId: "tab:1",
            updatedAt: "2026-03-12T10:00:00.000Z",
            tabs: [
              {
                id: "tab:1",
                paneIds: ["pane:1"],
                activePaneId: "pane:1",
                createdAt: "2026-03-12T10:00:00.000Z",
              },
            ],
            panesById: {
              "pane:1": { id: "pane:1", kind: "thread", threadId: pendingThreadId },
            },
          },
        },
      },
      threads: [],
      projects: [project],
      preferredThreadId: null,
      pendingThreadIds: new Set([pendingThreadId]),
    });

    expect(state.layoutsByProjectId[project.id]?.panesById["pane:1"]).toEqual({
      id: "pane:1",
      kind: "thread",
      threadId: pendingThreadId,
    });
  });

  it("preserves the persisted layout state before snapshot hydration", () => {
    const persistedState: ConsoleProjectLayoutsState = {
      ...createEmptyState(),
      projectOrder: [project.id],
      activeProjectId: project.id,
      layoutsByProjectId: {
        [project.id]: {
          projectId: project.id,
          activeTabId: "tab:1",
          updatedAt: "2026-03-12T10:00:00.000Z",
          tabs: [{
            id: "tab:1",
            paneIds: ["pane:thread"],
            activePaneId: "pane:thread",
            createdAt: "2026-03-12T10:00:00.000Z",
          }],
          panesById: {
            "pane:thread": {
              id: "pane:thread",
              kind: "thread",
              threadId: "thread:restored" as OrchestrationThread["id"],
            },
          },
        },
      },
    };

    expect(reconcileProjectLayoutsStateWhenReady({
      state: persistedState,
      projects: [],
      threads: [],
      preferredThreadId: null,
      hydrated: false,
    })).toBe(persistedState);
  });

  it("can swap the current pane back into a fresh draft while inheriting the pane model selection", () => {
    const thread = makeThread({
      id: "thread:replace",
      createdAt: "2026-03-12T10:00:00.000Z",
    });

    const state = replacePaneWithFreshDraft({
      ...createEmptyState(),
      lastChosenProvider: "copilot",
      lastChosenModelByProvider: {
        codex: "gpt-5-codex",
        copilot: "gpt-5.4",
      },
      lastChosenModelOptionsByProvider: {
        codex: undefined,
        copilot: {
          copilot: {
            reasoningEffort: "high",
          },
        },
      },
      projectOrder: [project.id],
      activeProjectId: project.id,
      layoutsByProjectId: {
        [project.id]: {
          projectId: project.id,
          activeTabId: "tab:1",
          updatedAt: "2026-03-12T10:00:00.000Z",
          tabs: [{
            id: "tab:1",
            paneIds: ["pane:1"],
            activePaneId: "pane:1",
            createdAt: "2026-03-12T10:00:00.000Z",
          }],
          panesById: {
            "pane:1": { id: "pane:1", kind: "thread", threadId: thread.id },
          },
        },
      },
    }, project.id, "pane:1", {
      selectedProvider: "codex",
      selectedModel: "gpt-5.3-codex",
      selectedModelOptions: {
        codex: {
          reasoningEffort: "medium",
        },
      },
    });

    const pane = state.layoutsByProjectId[project.id]?.panesById["pane:1"];
    expect(pane?.kind).toBe("draft");
    if (pane?.kind === "draft") {
      expect(pane.setup.selectedProvider).toBe("codex");
      expect(pane.setup.selectedModel).toBe("gpt-5.3-codex");
      expect(pane.setup.selectedModelOptions).toEqual({
        codex: {
          reasoningEffort: "medium",
        },
      });
    }
    expect(state.layoutsByProjectId[project.id]?.tabs[0]?.activePaneId).toBe("pane:1");
  });
});
