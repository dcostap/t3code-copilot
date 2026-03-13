import type { OrchestrationProject, OrchestrationThread, ProviderKind } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "t3code:console-workspace-sessions:v2";
const PENDING_HISTORY_MAX_AGE_MS = 60_000;

export interface ConsoleHistoryRef {
  readonly id: string;
  readonly threadId: OrchestrationThread["id"];
  readonly preferredProvider: ProviderKind;
  readonly cwd: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly pending: boolean;
}

export interface ConsolePane {
  readonly id: string;
  readonly historyId: string | null;
}

export interface ConsoleWorkspaceSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly projectId: OrchestrationProject["id"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activePaneId: string;
  readonly panes: ReadonlyArray<ConsolePane>;
  readonly histories: ReadonlyArray<ConsoleHistoryRef>;
}

export interface ConsoleWorkspaceState {
  readonly sessions: ReadonlyArray<ConsoleWorkspaceSession>;
  readonly activeSessionId: string | null;
}

export interface ConsoleWorkspaceModel {
  readonly sessions: ReadonlyArray<ConsoleWorkspaceSession>;
  readonly activeSession: ConsoleWorkspaceSession | null;
  readonly activePane: ConsolePane | null;
  readonly activeThreadId: string | null;
  readonly activeThread: OrchestrationThread | null;
  readonly activeProject: OrchestrationProject | null;
  activateSession(sessionId: string): void;
  closeSession(sessionId: string): void;
  activatePane(paneId: string): void;
  splitActivePane(input: {
    threadId: OrchestrationThread["id"];
    preferredProvider: ProviderKind;
    cwd: string;
    projectId: OrchestrationProject["id"];
    createdAt: string;
    pending?: boolean;
  }): void;
  closePane(paneId: string): void;
  createSessionFromHistory(input: {
    threadId: OrchestrationThread["id"];
    preferredProvider: ProviderKind;
    cwd: string;
    projectId: OrchestrationProject["id"];
    createdAt: string;
    pending?: boolean;
  }): void;
}

function makeId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function readPersistedState(): ConsoleWorkspaceState {
  if (typeof window === "undefined") {
    return { sessions: [], activeSessionId: null };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { sessions: [], activeSessionId: null };
    }
    const parsed = JSON.parse(raw) as ConsoleWorkspaceState;
    if (!parsed || typeof parsed !== "object") {
      return { sessions: [], activeSessionId: null };
    }
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      activeSessionId:
        typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null,
    };
  } catch {
    return { sessions: [], activeSessionId: null };
  }
}

function persistState(state: ConsoleWorkspaceState) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures and keep the in-memory workspace model usable.
  }
}

function lastPathSegment(path: string): string {
  const parts = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  return parts.at(-1) ?? path;
}

export function makeSessionTitle(cwd: string, sessions: ReadonlyArray<ConsoleWorkspaceSession>): string {
  const base = lastPathSegment(cwd);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const duplicatePattern = new RegExp(`^${escapedBase} \\d+$`);
  const matching = sessions.filter((session) => session.title === base || duplicatePattern.test(session.title));
  return matching.length === 0 ? base : `${base} ${matching.length + 1}`;
}

export function resolveThreadCwd(
  thread: OrchestrationThread,
  projects: ReadonlyArray<OrchestrationProject>,
): string | null {
  if (thread.worktreePath) {
    return thread.worktreePath;
  }
  return projects.find((project) => project.id === thread.projectId)?.workspaceRoot ?? null;
}

function findThreadById(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: string,
): OrchestrationThread | null {
  return threads.find((thread) => thread.id === threadId) ?? null;
}

function preferredProviderFromThread(thread: OrchestrationThread | null): ProviderKind {
  const providerName = thread?.session?.providerName;
  return providerName === "copilot" ? "copilot" : "codex";
}

function createHistoryRef(input: {
  threadId: OrchestrationThread["id"];
  preferredProvider: ProviderKind;
  cwd: string;
  createdAt: string;
  pending?: boolean;
}): ConsoleHistoryRef {
  return {
    id: makeId("history"),
    threadId: input.threadId,
    preferredProvider: input.preferredProvider,
    cwd: input.cwd,
    createdAt: input.createdAt,
    archivedAt: null,
    pending: input.pending ?? false,
  };
}

export function createSessionFromHistoryRef(
  input: {
    threadId: OrchestrationThread["id"];
    preferredProvider: ProviderKind;
    cwd: string;
    projectId: OrchestrationProject["id"];
    createdAt: string;
    pending?: boolean;
  },
  existingSessions: ReadonlyArray<ConsoleWorkspaceSession>,
): ConsoleWorkspaceSession {
  const history = createHistoryRef(input);
  const paneId = makeId("pane");
  return {
    id: makeId("session"),
    title: makeSessionTitle(input.cwd, existingSessions),
    cwd: input.cwd,
    projectId: input.projectId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    activePaneId: paneId,
    panes: [{ id: paneId, historyId: history.id }],
    histories: [history],
  };
}

function activePaneForSession(session: ConsoleWorkspaceSession): ConsolePane | null {
  return session.panes.find((pane) => pane.id === session.activePaneId) ?? session.panes[0] ?? null;
}

function updateSession(
  existing: ReadonlyArray<ConsoleWorkspaceSession>,
  sessionId: string,
  updater: (session: ConsoleWorkspaceSession) => ConsoleWorkspaceSession,
) {
  let changed = false;
  const sessions = existing.map((session) => {
    if (session.id !== sessionId) {
      return session;
    }
    const next = updater(session);
    if (next !== session) {
      changed = true;
    }
    return next;
  });
  return changed ? sessions : existing;
}

export function closeWorkspaceSession(
  state: ConsoleWorkspaceState,
  sessionId: string,
): ConsoleWorkspaceState {
  if (state.sessions.length <= 1 || !state.sessions.some((session) => session.id === sessionId)) {
    return state;
  }

  const closingIndex = state.sessions.findIndex((session) => session.id === sessionId);
  if (closingIndex === -1) {
    return state;
  }

  const sessions = state.sessions.filter((session) => session.id !== sessionId);
  const activeSessionId =
    state.activeSessionId === sessionId
      ? (sessions[Math.max(0, closingIndex - 1)]?.id ?? sessions[0]?.id ?? null)
      : state.activeSessionId;

  if (sessions.length === state.sessions.length && activeSessionId === state.activeSessionId) {
    return state;
  }

  return {
    sessions,
    activeSessionId,
  };
}

function withSessionUpdatedAt(
  session: ConsoleWorkspaceSession,
  input: Omit<ConsoleWorkspaceSession, "updatedAt">,
): ConsoleWorkspaceSession {
  return {
    ...input,
    updatedAt: new Date().toISOString(),
  };
}

export function splitSessionWithHistoryRef(
  session: ConsoleWorkspaceSession,
  historyInput: {
    threadId: OrchestrationThread["id"];
    preferredProvider: ProviderKind;
    cwd: string;
    createdAt: string;
    pending?: boolean;
  },
): ConsoleWorkspaceSession {
  if (session.panes.length >= 2) {
    return session;
  }

  const history = createHistoryRef(historyInput);
  const nextPane: ConsolePane = { id: makeId("pane"), historyId: history.id };
  const activePaneIndex = session.panes.findIndex((pane) => pane.id === session.activePaneId);
  const insertAt = activePaneIndex >= 0 ? activePaneIndex + 1 : session.panes.length;
  const panes = [...session.panes];
  panes.splice(insertAt, 0, nextPane);

  return withSessionUpdatedAt(session, {
    ...session,
    activePaneId: nextPane.id,
    panes,
    histories: [...session.histories, history],
  });
}

export function activateSessionPane(
  session: ConsoleWorkspaceSession,
  paneId: string,
): ConsoleWorkspaceSession {
  if (session.activePaneId === paneId || !session.panes.some((pane) => pane.id === paneId)) {
    return session;
  }
  return withSessionUpdatedAt(session, {
    ...session,
    activePaneId: paneId,
  });
}

export function closeSessionPane(
  session: ConsoleWorkspaceSession,
  paneId: string,
): ConsoleWorkspaceSession {
  if (session.panes.length <= 1 || !session.panes.some((pane) => pane.id === paneId)) {
    return session;
  }

  const panes = session.panes.filter((pane) => pane.id !== paneId);
  const nextActivePaneId =
    session.activePaneId === paneId
      ? (panes[0]?.id ?? session.activePaneId)
      : session.activePaneId;
  if (panes.length === session.panes.length && nextActivePaneId === session.activePaneId) {
    return session;
  }

  return withSessionUpdatedAt(session, {
    ...session,
    activePaneId: nextActivePaneId,
    panes,
  });
}

function isPendingHistoryStillFresh(history: ConsoleHistoryRef, nowMs: number) {
  return history.pending && nowMs - Date.parse(history.createdAt) <= PENDING_HISTORY_MAX_AGE_MS;
}

function isHistoryAvailable(
  history: ConsoleHistoryRef,
  threadsById: ReadonlyMap<string, OrchestrationThread>,
) {
  return threadsById.has(history.threadId);
}

function reconcilePersistedSessionShape(
  session: ConsoleWorkspaceSession,
  threadsById: ReadonlyMap<string, OrchestrationThread>,
  projectsById: ReadonlyMap<string, OrchestrationProject>,
): ConsoleWorkspaceSession | null {
  const projectId =
    projectsById.has(session.projectId)
      ? session.projectId
      : (session.histories
          .map((history) => threadsById.get(history.threadId)?.projectId)
          .find((candidate): candidate is OrchestrationProject["id"] => candidate !== undefined) ?? session.projectId);
  if (session.histories.length === 0) {
    return null;
  }

  const histories = session.histories.map<ConsoleHistoryRef>((history) => {
    if (history.preferredProvider === "codex" || history.preferredProvider === "copilot") {
      return history;
    }

    const preferredProvider = preferredProviderFromThread(threadsById.get(history.threadId) ?? null);
    return {
      ...history,
      preferredProvider,
    };
  });
  const availableHistoryIds = new Set(
    histories
      .filter((history) => isHistoryAvailable(history, threadsById))
      .map((history) => history.id),
  );

  const activePane = activePaneForSession(session);
  const activeHistoryStillExists =
    activePane !== null &&
    activePane.historyId !== null &&
    availableHistoryIds.has(activePane.historyId);
  const fallbackHistoryId =
    activeHistoryStillExists
      ? activePane?.historyId ?? null
      : (histories.find((history) => history.archivedAt === null && availableHistoryIds.has(history.id))?.id ??
        activePane?.historyId ??
        histories.find((history) => history.archivedAt === null)?.id ??
        null);

  const panes =
    session.panes.length > 0
      ? session.panes.map((pane) =>
          pane.id === session.activePaneId && pane.historyId !== fallbackHistoryId
            ? { ...pane, historyId: fallbackHistoryId }
            : pane,
        )
      : [{ id: makeId("pane"), historyId: fallbackHistoryId }];
  const activePaneId = panes.find((pane) => pane.id === session.activePaneId)?.id ?? panes[0]?.id ?? makeId("pane");

  const historiesChanged =
    histories.length !== session.histories.length ||
    histories.some((history, index) => history !== session.histories[index]);
  const panesChanged =
    panes.length !== session.panes.length || panes.some((pane, index) => pane !== session.panes[index]);
  const projectChanged = session.projectId !== projectId;
  if (!historiesChanged && !panesChanged && !projectChanged && activePaneId === session.activePaneId) {
    return session;
  }

  return {
    ...session,
    projectId,
    updatedAt: new Date().toISOString(),
    activePaneId,
    panes,
    histories,
  };
}

function reconcileSessionWithThreads(
  session: ConsoleWorkspaceSession,
  threads: ReadonlyArray<OrchestrationThread>,
  projects: ReadonlyArray<OrchestrationProject>,
): ConsoleWorkspaceSession | null {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const projectsById = new Map(projects.map((project) => [project.id, project] as const));

  const normalizedSession = reconcilePersistedSessionShape(session, threadsById, projectsById);
  if (!normalizedSession) {
    return null;
  }

  const nowMs = Date.now();
  const histories = normalizedSession.histories.map<ConsoleHistoryRef>((history) => {
    const thread = threadsById.get(history.threadId);
    if (!history.pending) {
      const providerName = thread?.session?.providerName;
      if (
        thread &&
        (providerName === "codex" || providerName === "copilot") &&
        history.preferredProvider !== providerName
      ) {
        return { ...history, preferredProvider: providerName };
      }
      return history;
    }
    if (!thread && isPendingHistoryStillFresh(history, nowMs)) {
      return history;
    }
    const providerName = thread?.session?.providerName;
    const preferredProvider =
      providerName === "codex" || providerName === "copilot"
        ? providerName
        : history.preferredProvider;
    return {
      ...history,
      pending: false,
      preferredProvider,
    };
  });
  const historiesChanged = histories.some((history, index) => history !== normalizedSession.histories[index]);
  if (!historiesChanged) {
    return normalizedSession;
  }

  return {
    ...normalizedSession,
    histories,
    updatedAt: new Date().toISOString(),
  };
}

export function reconcileWorkspaceState(input: {
  readonly state: ConsoleWorkspaceState;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly preferredThreadId: string | null;
}): ConsoleWorkspaceState {
  const preferredThread =
    (input.preferredThreadId ? findThreadById(input.threads, input.preferredThreadId) : null) ??
    input.threads[0] ??
    null;

  let sessions = input.state.sessions
    .map((session) => reconcileSessionWithThreads(session, input.threads, input.projects))
    .filter((session): session is ConsoleWorkspaceSession => session !== null);
  let activeSessionId = input.state.activeSessionId;
  const claimedThreadIds = new Set(
    sessions.flatMap((session) => session.histories.map((history) => history.threadId)),
  );

  if (preferredThread && !claimedThreadIds.has(preferredThread.id)) {
    const cwd = resolveThreadCwd(preferredThread, input.projects);
    if (cwd) {
      const seeded = createSessionFromHistoryRef(
        {
          threadId: preferredThread.id,
          preferredProvider: preferredProviderFromThread(preferredThread),
          cwd,
          projectId: preferredThread.projectId,
          createdAt: preferredThread.createdAt,
        },
        sessions,
      );
      const reconciledSeeded = reconcileSessionWithThreads(seeded, input.threads, input.projects);
      if (reconciledSeeded) {
        sessions = [...sessions, reconciledSeeded];
        activeSessionId = activeSessionId ?? reconciledSeeded.id;
      }
    }
  }

  const activeSession = activeSessionId
    ? (sessions.find((session) => session.id === activeSessionId) ?? null)
    : null;
  const activeSessionHasAvailableThread =
    activeSession !== null &&
    activeSession.histories.some((history) => input.threads.some((thread) => thread.id === history.threadId));

  if (
    activeSessionId &&
    (!sessions.some((session) => session.id === activeSessionId) || !activeSessionHasAvailableThread)
  ) {
    activeSessionId =
      (preferredThread
        ? sessions.find((session) =>
            session.histories.some((history) => history.threadId === preferredThread.id),
          )?.id
        : null) ??
      sessions[0]?.id ??
      null;
  }

  if (!activeSessionId && sessions.length > 0) {
    activeSessionId = sessions[0]?.id ?? null;
  }

  const sessionsUnchanged =
    sessions.length === input.state.sessions.length &&
    sessions.every((session, index) => session === input.state.sessions[index]);
  if (sessionsUnchanged && activeSessionId === input.state.activeSessionId) {
    return input.state;
  }

  return {
    sessions,
    activeSessionId,
  };
}

export function useConsoleWorkspaceSessions(input: {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly preferredThreadId: string | null;
}): ConsoleWorkspaceModel {
  const [state, setState] = useState<ConsoleWorkspaceState>(() => readPersistedState());

  useEffect(() => {
    setState((existing) =>
      reconcileWorkspaceState({
        state: existing,
        threads: input.threads,
        projects: input.projects,
        preferredThreadId: input.preferredThreadId,
      }),
    );
  }, [input.preferredThreadId, input.projects, input.threads]);

  useEffect(() => {
    persistState(state);
  }, [state]);

  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId) ?? null,
    [state.activeSessionId, state.sessions],
  );
  const activePane = useMemo(
    () => (activeSession ? activePaneForSession(activeSession) : null),
    [activeSession],
  );

  const activeThreadId = useMemo(() => {
    if (!activeSession || !activePane) {
      return null;
    }
    if (!activePane.historyId) {
      return null;
    }
    return activeSession.histories.find((history) => history.id === activePane.historyId)?.threadId ?? null;
  }, [activePane, activeSession]);

  const activeThread = useMemo(
    () => (activeThreadId ? findThreadById(input.threads, activeThreadId) : null),
    [activeThreadId, input.threads],
  );

  const activeProject = useMemo(
    () =>
      activeSession
        ? (input.projects.find((project) => project.id === activeSession.projectId) ?? null)
        : (activeThread
            ? (input.projects.find((project) => project.id === activeThread.projectId) ?? null)
            : null),
    [activeSession, activeThread, input.projects],
  );

  const activateSession = useCallback((sessionId: string) => {
    setState((existing) =>
      existing.activeSessionId === sessionId ? existing : { ...existing, activeSessionId: sessionId },
    );
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    setState((existing) => closeWorkspaceSession(existing, sessionId));
  }, []);

  const activatePane = useCallback((paneId: string) => {
    setState((existing) => {
      if (!existing.activeSessionId) {
        return existing;
      }
      const sessions = updateSession(existing.sessions, existing.activeSessionId, (session) =>
        activateSessionPane(session, paneId),
      );
      return sessions === existing.sessions ? existing : { ...existing, sessions };
    });
  }, []);

  const splitActivePane = useCallback((history: {
    threadId: OrchestrationThread["id"];
    preferredProvider: ProviderKind;
    cwd: string;
    projectId: OrchestrationProject["id"];
    createdAt: string;
    pending?: boolean;
  }) => {
    setState((existing) => {
      if (!existing.activeSessionId) {
        return existing;
      }
      const sessions = updateSession(existing.sessions, existing.activeSessionId, (session) =>
        splitSessionWithHistoryRef(session, history),
      );
      return sessions === existing.sessions ? existing : { ...existing, sessions };
    });
  }, []);

  const closePane = useCallback((paneId: string) => {
    setState((existing) => {
      if (!existing.activeSessionId) {
        return existing;
      }
      const sessions = updateSession(existing.sessions, existing.activeSessionId, (session) =>
        closeSessionPane(session, paneId),
      );
      return sessions === existing.sessions ? existing : { ...existing, sessions };
    });
  }, []);

  const createSessionFromHistory = useCallback((history: {
    threadId: OrchestrationThread["id"];
    preferredProvider: ProviderKind;
    cwd: string;
    projectId: OrchestrationProject["id"];
    createdAt: string;
    pending?: boolean;
  }) => {
    setState((existing) => {
      const nextSession = createSessionFromHistoryRef(history, existing.sessions);
      return {
        sessions: [...existing.sessions, nextSession],
        activeSessionId: nextSession.id,
      };
    });
  }, []);

  return {
    sessions: state.sessions,
    activeSession,
    activePane,
    activeThreadId,
    activeThread,
    activeProject,
    activateSession,
    closeSession,
    activatePane,
    splitActivePane,
    closePane,
    createSessionFromHistory,
  };
}
