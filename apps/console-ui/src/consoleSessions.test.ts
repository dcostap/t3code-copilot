import { describe, expect, it } from "vitest";

import type { OrchestrationProject, OrchestrationThread } from "@t3tools/contracts";

import {
  activateSessionPane,
  closeSessionPane,
  createSessionFromHistoryRef,
  reconcileWorkspaceState,
  resolveThreadCwd,
  splitSessionWithHistoryRef,
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

function makeThread(input: {
  id: string;
  createdAt: string;
  projectId?: OrchestrationProject["id"];
  worktreePath?: string | null;
}): OrchestrationThread {
  return {
    id: input.id as OrchestrationThread["id"],
    projectId: input.projectId ?? project.id,
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

describe("reconcileWorkspaceState", () => {
  it("seeds a first session from the preferred thread", () => {
    const thread = makeThread({
      id: "thread:1",
      createdAt: "2026-03-12T10:00:00.000Z",
    });

    const state = reconcileWorkspaceState({
      state: { sessions: [], activeSessionId: null },
      threads: [thread],
      projects: [project],
      preferredThreadId: thread.id,
    });

    expect(state.sessions).toHaveLength(1);
    expect(state.activeSessionId).toBe(state.sessions[0]?.id ?? null);
    expect(state.sessions[0]?.cwd).toBe(project.workspaceRoot);
    expect(state.sessions[0]?.projectId).toBe(project.id);
    expect(state.sessions[0]?.histories.map((history) => history.threadId)).toEqual([thread.id]);
  });

  it("does not merge unrelated same-cwd threads into an existing session", () => {
    const firstThread = makeThread({
      id: "thread:1",
      createdAt: "2026-03-12T10:00:00.000Z",
    });
    const secondThread = makeThread({
      id: "thread:2",
      createdAt: "2026-03-12T10:05:00.000Z",
    });
    const seededSession = createSessionFromHistoryRef(
      {
        threadId: firstThread.id,
        cwd: project.workspaceRoot,
        projectId: project.id,
        createdAt: firstThread.createdAt,
      },
      [],
    );

    const state = reconcileWorkspaceState({
      state: { sessions: [seededSession], activeSessionId: seededSession.id },
      threads: [firstThread, secondThread],
      projects: [project],
      preferredThreadId: firstThread.id,
    });

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.histories.map((history) => history.threadId)).toEqual([firstThread.id]);
  });

  it("keeps stale persisted sessions but switches focus to a valid live one", () => {
    const staleSession = createSessionFromHistoryRef(
      {
        threadId: "thread:missing" as OrchestrationThread["id"],
        cwd: project.workspaceRoot,
        projectId: project.id,
        createdAt: "2026-03-12T10:00:00.000Z",
      },
      [],
    );
    const freshThread = makeThread({
      id: "thread:fresh",
      createdAt: "2026-03-12T10:05:00.000Z",
    });

    const state = reconcileWorkspaceState({
      state: { sessions: [staleSession], activeSessionId: staleSession.id },
      threads: [freshThread],
      projects: [project],
      preferredThreadId: freshThread.id,
    });

    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[0]?.histories.map((history) => history.threadId)).toEqual(["thread:missing"]);
    expect(state.sessions[1]?.histories.map((history) => history.threadId)).toEqual([freshThread.id]);
    expect(state.activeSessionId).toBe(state.sessions[1]?.id ?? null);
  });

  it("keeps a newly created pending history until the backend snapshot catches up", () => {
    const pendingSession = createSessionFromHistoryRef(
      {
        threadId: "thread:pending" as OrchestrationThread["id"],
        cwd: project.workspaceRoot,
        projectId: project.id,
        createdAt: new Date().toISOString(),
        pending: true,
      },
      [],
    );

    const state = reconcileWorkspaceState({
      state: { sessions: [pendingSession], activeSessionId: pendingSession.id },
      threads: [],
      projects: [project],
      preferredThreadId: null,
    });

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.histories[0]?.threadId).toBe("thread:pending");
  });

  it("falls back to the preferred thread session when the active session is invalid", () => {
    const firstThread = makeThread({
      id: "thread:1",
      createdAt: "2026-03-12T10:00:00.000Z",
    });
    const secondThread = makeThread({
      id: "thread:2",
      createdAt: "2026-03-12T10:05:00.000Z",
    });
    const firstSession = createSessionFromHistoryRef(
      {
        threadId: firstThread.id,
        cwd: project.workspaceRoot,
        projectId: project.id,
        createdAt: firstThread.createdAt,
      },
      [],
    );
    const secondSession = createSessionFromHistoryRef(
      {
        threadId: secondThread.id,
        cwd: project.workspaceRoot,
        projectId: project.id,
        createdAt: secondThread.createdAt,
      },
      [firstSession],
    );

    const state = reconcileWorkspaceState({
      state: {
        sessions: [firstSession, secondSession],
        activeSessionId: "session:missing",
      },
      threads: [firstThread, secondThread],
      projects: [project],
      preferredThreadId: secondThread.id,
    });

    expect(state.activeSessionId).toBe(secondSession.id);
  });

  it("returns the existing state object when reconciliation makes no changes", () => {
    const thread = makeThread({
      id: "thread:1",
      createdAt: "2026-03-12T10:00:00.000Z",
    });
    const seededSession = createSessionFromHistoryRef(
      {
        threadId: thread.id,
        cwd: project.workspaceRoot,
        projectId: project.id,
        createdAt: thread.createdAt,
      },
      [],
    );
    const state = {
      sessions: [seededSession],
      activeSessionId: seededSession.id,
    };

    expect(reconcileWorkspaceState({
      state,
      threads: [thread],
      projects: [project],
      preferredThreadId: thread.id,
    })).toBe(state);
  });
});

describe("session pane operations", () => {
  it("splits the active pane into a second pane with a new history", () => {
    const thread = makeThread({
      id: "thread:1",
      createdAt: "2026-03-12T10:00:00.000Z",
    });
    const session = createSessionFromHistoryRef(
      {
        threadId: thread.id,
        cwd: project.workspaceRoot,
        projectId: project.id,
        createdAt: thread.createdAt,
      },
      [],
    );

    const split = splitSessionWithHistoryRef(session, {
      threadId: "thread:2" as OrchestrationThread["id"],
      cwd: project.workspaceRoot,
      createdAt: "2026-03-12T10:05:00.000Z",
      pending: true,
    });

    expect(split.panes).toHaveLength(2);
    expect(split.activePaneId).toBe(split.panes[1]?.id);
    expect(split.histories.map((history) => history.threadId)).toEqual([
      thread.id,
      "thread:2",
    ]);
  });

  it("activates a different pane without mutating histories", () => {
    const thread = makeThread({
      id: "thread:1",
      createdAt: "2026-03-12T10:00:00.000Z",
    });
    const session = splitSessionWithHistoryRef(
      createSessionFromHistoryRef(
        {
          threadId: thread.id,
          cwd: project.workspaceRoot,
          projectId: project.id,
          createdAt: thread.createdAt,
        },
        [],
      ),
      {
        threadId: "thread:2" as OrchestrationThread["id"],
        cwd: project.workspaceRoot,
        createdAt: "2026-03-12T10:05:00.000Z",
      },
    );

    const activated = activateSessionPane(session, session.panes[0]?.id ?? "");

    expect(activated.activePaneId).toBe(session.panes[0]?.id);
    expect(activated.histories).toEqual(session.histories);
  });

  it("closes a pane without deleting its history", () => {
    const thread = makeThread({
      id: "thread:1",
      createdAt: "2026-03-12T10:00:00.000Z",
    });
    const session = splitSessionWithHistoryRef(
      createSessionFromHistoryRef(
        {
          threadId: thread.id,
          cwd: project.workspaceRoot,
          projectId: project.id,
          createdAt: thread.createdAt,
        },
        [],
      ),
      {
        threadId: "thread:2" as OrchestrationThread["id"],
        cwd: project.workspaceRoot,
        createdAt: "2026-03-12T10:05:00.000Z",
      },
    );

    const closed = closeSessionPane(session, session.activePaneId);

    expect(closed.panes).toHaveLength(1);
    expect(closed.histories).toHaveLength(2);
  });
});
