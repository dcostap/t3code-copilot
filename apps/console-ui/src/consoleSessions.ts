import {
  DEFAULT_MODEL_BY_PROVIDER,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProviderInteractionMode,
  type ProviderKind,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "t3code:console-project-layouts:v1";

export interface ConsolePaneSetup {
  readonly type: "new-thread";
  readonly selectedProvider: ProviderKind;
  readonly selectedModel: string;
  readonly createdAt: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface ConsoleDraftPane {
  readonly id: string;
  readonly kind: "draft";
  readonly setup: ConsolePaneSetup;
}

export interface ConsoleThreadPane {
  readonly id: string;
  readonly kind: "thread";
  readonly threadId: OrchestrationThread["id"];
}

export type ConsoleProjectPane = ConsoleDraftPane | ConsoleThreadPane;

export interface ConsoleProjectTab {
  readonly id: string;
  readonly paneIds: ReadonlyArray<string>;
  readonly activePaneId: string;
  readonly createdAt: string;
}

export interface ConsoleProjectLayout {
  readonly projectId: OrchestrationProject["id"];
  readonly tabs: ReadonlyArray<ConsoleProjectTab>;
  readonly panesById: Record<string, ConsoleProjectPane>;
  readonly activeTabId: string;
  readonly updatedAt: string;
}

export interface ConsoleProjectLayoutsState {
  readonly projectOrder: ReadonlyArray<OrchestrationProject["id"]>;
  readonly collapsedProjectIds: ReadonlyArray<OrchestrationProject["id"]>;
  readonly activeProjectId: OrchestrationProject["id"] | null;
  readonly layoutsByProjectId: Record<string, ConsoleProjectLayout>;
  readonly lastChosenProvider: ProviderKind;
  readonly lastChosenModelByProvider: Record<ProviderKind, string>;
}

export interface ConsoleProjectView {
  readonly project: OrchestrationProject;
  readonly layout: ConsoleProjectLayout;
  readonly collapsed: boolean;
}

export interface OpenThreadResult {
  readonly paneId: string;
  readonly highlightPane: boolean;
}

export interface ConsoleProjectLayoutsModel {
  readonly state: ConsoleProjectLayoutsState;
  readonly projectViews: ReadonlyArray<ConsoleProjectView>;
  readonly activeProject: OrchestrationProject | null;
  readonly activeLayout: ConsoleProjectLayout | null;
  readonly activeTab: ConsoleProjectTab | null;
  readonly activePane: ConsoleProjectPane | null;
  readonly activeThread: OrchestrationThread | null;
  readonly activeThreadId: OrchestrationThread["id"] | null;
  readonly activePaneId: string | null;
  readonly lastChosenProvider: ProviderKind;
  readonly lastChosenModelByProvider: Record<ProviderKind, string>;
  activateProject(projectId: OrchestrationProject["id"]): void;
  clearActiveProject(): void;
  toggleProjectCollapsed(projectId: OrchestrationProject["id"]): void;
  reorderProjects(projectIds: ReadonlyArray<OrchestrationProject["id"]>): void;
  activateTab(projectId: OrchestrationProject["id"], tabId: string): void;
  activatePane(projectId: OrchestrationProject["id"], tabId: string, paneId: string): void;
  createDraftTab(input: {
    projectId: OrchestrationProject["id"];
    interactionMode?: ProviderInteractionMode;
    branch?: string | null;
    worktreePath?: string | null;
  }): { tabId: string; paneId: string } | null;
  splitPane(input: {
    projectId: OrchestrationProject["id"];
    paneId: string;
  }): { tabId: string; paneId: string } | null;
  closePane(projectId: OrchestrationProject["id"], paneId: string): void;
  closeTab(projectId: OrchestrationProject["id"], tabId: string): void;
  updateDraftPane(input: {
    paneId: string;
    updater: (setup: ConsolePaneSetup) => ConsolePaneSetup;
  }): void;
  completeDraftPane(input: {
    paneId: string;
    threadId: OrchestrationThread["id"];
  }): void;
  openThread(threadId: OrchestrationThread["id"]): OpenThreadResult | null;
  mountThreadInPane(input: {
    projectId: OrchestrationProject["id"];
    paneId: string;
    threadId: OrchestrationThread["id"];
  }): boolean;
  rememberProviderModel(provider: ProviderKind, model: string): void;
}

interface PersistedConsolePaneSetup {
  readonly type?: unknown;
  readonly selectedProvider?: unknown;
  readonly selectedModel?: unknown;
  readonly createdAt?: unknown;
  readonly interactionMode?: unknown;
  readonly branch?: unknown;
  readonly worktreePath?: unknown;
}

interface PersistedConsoleProjectPane {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly threadId?: unknown;
  readonly setup?: PersistedConsolePaneSetup;
}

interface PersistedConsoleProjectTab {
  readonly id?: unknown;
  readonly paneIds?: unknown;
  readonly activePaneId?: unknown;
  readonly createdAt?: unknown;
}

interface PersistedConsoleProjectLayout {
  readonly projectId?: unknown;
  readonly tabs?: unknown;
  readonly panesById?: unknown;
  readonly activeTabId?: unknown;
  readonly updatedAt?: unknown;
}

interface PersistedConsoleProjectLayoutsState {
  readonly projectOrder?: unknown;
  readonly collapsedProjectIds?: unknown;
  readonly activeProjectId?: unknown;
  readonly layoutsByProjectId?: unknown;
  readonly lastChosenProvider?: unknown;
  readonly lastChosenModelByProvider?: unknown;
}

function makeId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isProviderKind(value: unknown): value is ProviderKind {
  return value === "codex" || value == "copilot";
}

function isInteractionMode(value: unknown): value is ProviderInteractionMode {
  return value === "default" || value === "plan";
}

function createDefaultLastChosenModelByProvider(): Record<ProviderKind, string> {
  return {
    codex: DEFAULT_MODEL_BY_PROVIDER.codex,
    copilot: DEFAULT_MODEL_BY_PROVIDER.copilot,
  };
}

function resolveProviderModelSelection(
  provider: ProviderKind,
  candidateModel: unknown,
  fallbackModelsByProvider: Readonly<Record<ProviderKind, string>>,
) {
  if (typeof candidateModel == "string") {
    const trimmed = candidateModel.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallbackModelsByProvider[provider];
}

function resolveLastChosenModelByProvider(candidate: unknown): Record<ProviderKind, string> {
  const defaults = createDefaultLastChosenModelByProvider();
  if (!candidate || typeof candidate != "object") {
    return defaults;
  }
  const parsed = candidate as { readonly codex?: unknown; readonly copilot?: unknown };
  return {
    codex: resolveProviderModelSelection("codex", parsed.codex, defaults),
    copilot: resolveProviderModelSelection("copilot", parsed.copilot, defaults),
  };
}

function defaultPaneSetup(input?: {
  readonly selectedProvider?: ProviderKind;
  readonly selectedModel?: string;
  readonly fallbackModelsByProvider?: Readonly<Record<ProviderKind, string>>;
  readonly createdAt?: string;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}): ConsolePaneSetup {
  const selectedProvider = input?.selectedProvider ?? "codex";
  const fallbackModelsByProvider = input?.fallbackModelsByProvider ?? createDefaultLastChosenModelByProvider();
  return {
    type: "new-thread",
    selectedProvider,
    selectedModel: resolveProviderModelSelection(selectedProvider, input?.selectedModel, fallbackModelsByProvider),
    createdAt: input?.createdAt ?? nowIso(),
    interactionMode: input?.interactionMode ?? "default",
    branch: input?.branch ?? null,
    worktreePath: input?.worktreePath ?? null,
  };
}

function createDraftPane(input?: {
  readonly id?: string;
  readonly selectedProvider?: ProviderKind;
  readonly selectedModel?: string;
  readonly fallbackModelsByProvider?: Readonly<Record<ProviderKind, string>>;
  readonly createdAt?: string;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}): ConsoleDraftPane {
  return {
    id: input?.id ?? makeId("pane"),
    kind: "draft",
    setup: defaultPaneSetup(input),
  };
}

function createThreadPane(threadId: OrchestrationThread["id"], id?: string): ConsoleThreadPane {
  return {
    id: id ?? makeId("pane"),
    kind: "thread",
    threadId,
  };
}

function createDraftTabRef(input?: {
  readonly tabId?: string;
  readonly paneId?: string;
  readonly selectedProvider?: ProviderKind;
  readonly selectedModel?: string;
  readonly fallbackModelsByProvider?: Readonly<Record<ProviderKind, string>>;
  readonly createdAt?: string;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}): { tab: ConsoleProjectTab; pane: ConsoleDraftPane } {
  const pane = createDraftPane({
    ...(input?.paneId ? { id: input.paneId } : {}),
    ...(input?.selectedProvider ? { selectedProvider: input.selectedProvider } : {}),
    ...(input?.selectedModel ? { selectedModel: input.selectedModel } : {}),
    ...(input?.fallbackModelsByProvider ? { fallbackModelsByProvider: input.fallbackModelsByProvider } : {}),
    ...(input?.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input?.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input?.branch !== undefined ? { branch: input.branch ?? null } : {}),
    ...(input?.worktreePath !== undefined ? { worktreePath: input.worktreePath ?? null } : {}),
  });
  const createdAt = input?.createdAt ?? pane.setup.createdAt;
  return {
    tab: {
      id: input?.tabId ?? makeId("tab"),
      paneIds: [pane.id],
      activePaneId: pane.id,
      createdAt,
    },
    pane,
  };
}

function createProjectLayout(projectId: OrchestrationProject["id"], input?: {
  readonly selectedProvider?: ProviderKind;
  readonly selectedModel?: string;
  readonly fallbackModelsByProvider?: Readonly<Record<ProviderKind, string>>;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}): ConsoleProjectLayout {
  const { tab, pane } = createDraftTabRef({
    ...(input?.selectedProvider ? { selectedProvider: input.selectedProvider } : {}),
    ...(input?.selectedModel ? { selectedModel: input.selectedModel } : {}),
    ...(input?.fallbackModelsByProvider ? { fallbackModelsByProvider: input.fallbackModelsByProvider } : {}),
    ...(input?.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input?.branch !== undefined ? { branch: input.branch ?? null } : {}),
    ...(input?.worktreePath !== undefined ? { worktreePath: input.worktreePath ?? null } : {}),
  });
  const updatedAt = pane.setup.createdAt;
  return {
    projectId,
    tabs: [tab],
    panesById: {
      [pane.id]: pane,
    },
    activeTabId: tab.id,
    updatedAt,
  };
}

function normalizePaneSetup(
  candidate: PersistedConsolePaneSetup | undefined,
  fallbackProvider: ProviderKind,
  fallbackModelsByProvider: Readonly<Record<ProviderKind, string>>,
): ConsolePaneSetup {
  const selectedProvider = isProviderKind(candidate?.selectedProvider) ? candidate.selectedProvider : fallbackProvider;
  return {
    type: "new-thread",
    selectedProvider,
    selectedModel: resolveProviderModelSelection(selectedProvider, candidate?.selectedModel, fallbackModelsByProvider),
    createdAt: typeof candidate?.createdAt == "string" && candidate.createdAt.length > 0 ? candidate.createdAt : nowIso(),
    interactionMode: isInteractionMode(candidate?.interactionMode) ? candidate.interactionMode : "default",
    branch: typeof candidate?.branch == "string" && candidate.branch.length > 0 ? candidate.branch : null,
    worktreePath:
      typeof candidate?.worktreePath == "string" && candidate.worktreePath.length > 0
        ? candidate.worktreePath
        : null,
  };
}

function normalizePane(
  candidate: PersistedConsoleProjectPane,
  fallbackProvider: ProviderKind,
  fallbackModelsByProvider: Readonly<Record<ProviderKind, string>>,
): ConsoleProjectPane | null {
  if (typeof candidate?.id != "string" || candidate.id.length == 0) {
    return null;
  }
  if (candidate.kind == "thread" && typeof candidate.threadId == "string" && candidate.threadId.length > 0) {
    return {
      id: candidate.id,
      kind: "thread",
      threadId: candidate.threadId as OrchestrationThread["id"],
    };
  }
  return {
    id: candidate.id,
    kind: "draft",
    setup: normalizePaneSetup(candidate.setup, fallbackProvider, fallbackModelsByProvider),
  };
}

function normalizeTab(candidate: PersistedConsoleProjectTab): ConsoleProjectTab | null {
  if (
    typeof candidate?.id != "string"
    || candidate.id.length == 0
    || !Array.isArray(candidate.paneIds)
  ) {
    return null;
  }
  const paneIds = candidate.paneIds.filter((paneId): paneId is string => typeof paneId == "string" && paneId.length > 0);
  if (paneIds.length == 0) {
    return null;
  }
  const activePaneId =
    typeof candidate.activePaneId == "string" && paneIds.includes(candidate.activePaneId)
      ? candidate.activePaneId
      : paneIds[0]!;
  return {
    id: candidate.id,
    paneIds,
    activePaneId,
    createdAt:
      typeof candidate.createdAt == "string" && candidate.createdAt.length > 0
        ? candidate.createdAt
        : nowIso(),
  };
}

function readPersistedState(): ConsoleProjectLayoutsState {
  const defaultLastChosenModelByProvider = createDefaultLastChosenModelByProvider();
  if (typeof window == "undefined") {
    return {
      projectOrder: [],
      collapsedProjectIds: [],
      activeProjectId: null,
      layoutsByProjectId: {},
      lastChosenProvider: "codex",
      lastChosenModelByProvider: defaultLastChosenModelByProvider,
    };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        projectOrder: [],
        collapsedProjectIds: [],
        activeProjectId: null,
        layoutsByProjectId: {},
        lastChosenProvider: "codex",
        lastChosenModelByProvider: defaultLastChosenModelByProvider,
      };
    }
    const parsed = JSON.parse(raw) as PersistedConsoleProjectLayoutsState;
    const lastChosenProvider = isProviderKind(parsed.lastChosenProvider) ? parsed.lastChosenProvider : "codex";
    const lastChosenModelByProvider = resolveLastChosenModelByProvider(parsed.lastChosenModelByProvider);
    const layoutsByProjectId: Record<string, ConsoleProjectLayout> = {};
    if (parsed.layoutsByProjectId && typeof parsed.layoutsByProjectId == "object") {
      for (const [projectId, candidate] of Object.entries(parsed.layoutsByProjectId)) {
        const persistedLayout = candidate as PersistedConsoleProjectLayout;
        if (typeof projectId != "string" || projectId.length == 0) {
          continue;
        }
        if (!persistedLayout || persistedLayout.projectId != projectId) {
          continue;
        }
        const panesById: Record<string, ConsoleProjectPane> = {};
        if (persistedLayout.panesById && typeof persistedLayout.panesById == "object") {
          for (const candidatePane of Object.values(persistedLayout.panesById as Record<string, PersistedConsoleProjectPane>)) {
            const pane = normalizePane(candidatePane, lastChosenProvider, lastChosenModelByProvider);
            if (pane) {
              panesById[pane.id] = pane;
            }
          }
        }
        const tabs = Array.isArray(persistedLayout.tabs)
          ? persistedLayout.tabs
              .map((candidateTab) => normalizeTab(candidateTab as PersistedConsoleProjectTab))
              .filter((tab): tab is ConsoleProjectTab => tab !== null)
          : [];
        if (tabs.length == 0) {
          continue;
        }
        const activeTabId =
          typeof persistedLayout.activeTabId == "string" && tabs.some((tab) => tab.id == persistedLayout.activeTabId)
            ? persistedLayout.activeTabId
            : tabs[0]!.id;
        layoutsByProjectId[projectId] = {
          projectId: projectId as OrchestrationProject["id"],
          tabs,
          panesById,
          activeTabId,
          updatedAt:
            typeof persistedLayout.updatedAt == "string" && persistedLayout.updatedAt.length > 0
              ? persistedLayout.updatedAt
              : nowIso(),
        };
      }
    }

    const projectOrder = Array.isArray(parsed.projectOrder)
      ? parsed.projectOrder.filter((projectId): projectId is OrchestrationProject["id"] => typeof projectId == "string" && projectId.length > 0)
      : [];
    const collapsedProjectIds = Array.isArray(parsed.collapsedProjectIds)
      ? parsed.collapsedProjectIds.filter((projectId): projectId is OrchestrationProject["id"] => typeof projectId == "string" && projectId.length > 0)
      : [];

    return {
      projectOrder,
      collapsedProjectIds,
      activeProjectId:
        typeof parsed.activeProjectId == "string" && parsed.activeProjectId.length > 0
          ? parsed.activeProjectId as OrchestrationProject["id"]
          : null,
      layoutsByProjectId,
      lastChosenProvider,
      lastChosenModelByProvider,
    };
  } catch {
    return {
      projectOrder: [],
      collapsedProjectIds: [],
      activeProjectId: null,
      layoutsByProjectId: {},
      lastChosenProvider: "codex",
      lastChosenModelByProvider: defaultLastChosenModelByProvider,
    };
  }
}

function persistState(state: ConsoleProjectLayoutsState) {
  if (typeof window == "undefined") {
    return;
  }
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      projectOrder: state.projectOrder,
      collapsedProjectIds: state.collapsedProjectIds,
      activeProjectId: state.activeProjectId,
      layoutsByProjectId: state.layoutsByProjectId,
      lastChosenProvider: state.lastChosenProvider,
      lastChosenModelByProvider: state.lastChosenModelByProvider,
    }),
  );
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
  threadId: OrchestrationThread["id"] | null,
): OrchestrationThread | null {
  if (!threadId) {
    return null;
  }
  return threads.find((thread) => thread.id === threadId) ?? null;
}

function withUpdatedLayout(layout: ConsoleProjectLayout, input: Omit<ConsoleProjectLayout, "updatedAt">): ConsoleProjectLayout {
  return {
    ...input,
    updatedAt: nowIso(),
  };
}

function locatePane(layout: ConsoleProjectLayout, paneId: string): { tab: ConsoleProjectTab; pane: ConsoleProjectPane } | null {
  for (const tab of layout.tabs) {
    if (!tab.paneIds.includes(paneId)) {
      continue;
    }
    const pane = layout.panesById[paneId];
    if (!pane) {
      return null;
    }
    return { tab, pane };
  }
  return null;
}

function locateThreadPane(layout: ConsoleProjectLayout, threadId: OrchestrationThread["id"]): { tab: ConsoleProjectTab; pane: ConsoleThreadPane } | null {
  for (const tab of layout.tabs) {
    for (const paneId of tab.paneIds) {
      const pane = layout.panesById[paneId];
      if (pane?.kind == "thread" && pane.threadId === threadId) {
        return { tab, pane };
      }
    }
  }
  return null;
}

function ensureActiveLayoutState(
  layout: ConsoleProjectLayout,
  fallbackProvider: ProviderKind,
  fallbackModelsByProvider: Readonly<Record<ProviderKind, string>>,
): ConsoleProjectLayout {
  const seenThreadIds = new Set<string>();
  const panesById: Record<string, ConsoleProjectPane> = {};
  const tabs: ConsoleProjectTab[] = [];

  for (const tab of layout.tabs) {
    const nextPaneIds: string[] = [];
    for (const paneId of tab.paneIds.slice(0, 6)) {
      const pane = layout.panesById[paneId];
      if (!pane) {
        continue;
      }
      if (pane.kind === "thread") {
        if (seenThreadIds.has(pane.threadId)) {
          const draftPane = createDraftPane({
            id: pane.id,
            selectedProvider: fallbackProvider,
            selectedModel: fallbackModelsByProvider[fallbackProvider],
            fallbackModelsByProvider,
          });
          panesById[draftPane.id] = draftPane;
          nextPaneIds.push(draftPane.id);
          continue;
        }
        seenThreadIds.add(pane.threadId);
        panesById[pane.id] = pane;
        nextPaneIds.push(pane.id);
        continue;
      }
      const draftPane: ConsoleDraftPane = {
        ...pane,
        setup: normalizePaneSetup(pane.setup, fallbackProvider, fallbackModelsByProvider),
      };
      panesById[draftPane.id] = draftPane;
      nextPaneIds.push(draftPane.id);
    }
    const uniquePaneIds = nextPaneIds.filter((paneId, index) => nextPaneIds.indexOf(paneId) === index);
    if (uniquePaneIds.length == 0) {
      continue;
    }
    tabs.push({
      ...tab,
      paneIds: uniquePaneIds,
      activePaneId: uniquePaneIds.includes(tab.activePaneId) ? tab.activePaneId : uniquePaneIds[0]!,
    });
  }

  if (tabs.length == 0) {
    const fresh = createProjectLayout(layout.projectId, {
      selectedProvider: fallbackProvider,
      selectedModel: fallbackModelsByProvider[fallbackProvider],
      fallbackModelsByProvider,
    });
    return fresh;
  }

  const activeTabId = tabs.some((tab) => tab.id === layout.activeTabId) ? layout.activeTabId : tabs[0]!.id;
  return {
    projectId: layout.projectId,
    tabs,
    panesById,
    activeTabId,
    updatedAt: layout.updatedAt,
  };
}

export function reconcileProjectLayoutsState(input: {
  readonly state: ConsoleProjectLayoutsState;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly preferredThreadId: string | null;
  readonly pendingThreadIds?: ReadonlySet<OrchestrationThread["id"]>;
}): ConsoleProjectLayoutsState {
  const projects = input.projects.filter((project) => project.deletedAt === null);
  const projectsById = new Map(projects.map((project) => [project.id, project] as const));
  const threads = input.threads.filter((thread) => thread.deletedAt === null);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const pendingThreadIds = input.pendingThreadIds ?? new Set<OrchestrationThread["id"]>();
  const preferredThread = input.preferredThreadId ? (threadsById.get(input.preferredThreadId as OrchestrationThread["id"]) ?? null) : null;

  const projectOrder = input.state.projectOrder.filter((projectId) => projectsById.has(projectId));
  projects.forEach((project) => {
    if (!projectOrder.includes(project.id)) {
      projectOrder.push(project.id);
    }
  });

  const collapsedProjectIds = input.state.collapsedProjectIds.filter((projectId) => projectsById.has(projectId));
  const layoutsByProjectId: Record<string, ConsoleProjectLayout> = {};

  projectOrder.forEach((projectId) => {
      const existingLayout = input.state.layoutsByProjectId[projectId];
      const reconciled = ensureActiveLayoutState(
      existingLayout ?? createProjectLayout(projectId, {
        selectedProvider: input.state.lastChosenProvider,
        selectedModel: input.state.lastChosenModelByProvider[input.state.lastChosenProvider],
        fallbackModelsByProvider: input.state.lastChosenModelByProvider,
      }),
      input.state.lastChosenProvider,
      input.state.lastChosenModelByProvider,
      );
    const panesById: Record<string, ConsoleProjectPane> = {};
    const validTabs: ConsoleProjectTab[] = [];
    const seenThreadIds = new Set<string>();
    for (const tab of reconciled.tabs) {
      const nextPaneIds: string[] = [];
      for (const paneId of tab.paneIds.slice(0, 6)) {
        const pane = reconciled.panesById[paneId];
        if (!pane) {
          continue;
        }
        if (pane.kind === "thread") {
          const thread = threadsById.get(pane.threadId);
          if (!thread && pendingThreadIds.has(pane.threadId) && !seenThreadIds.has(pane.threadId)) {
            seenThreadIds.add(pane.threadId);
            panesById[pane.id] = pane;
            nextPaneIds.push(pane.id);
            continue;
          }
          if (!thread || thread.projectId !== projectId || seenThreadIds.has(pane.threadId)) {
            const draftPane = createDraftPane({
              id: pane.id,
              selectedProvider: input.state.lastChosenProvider,
              selectedModel: input.state.lastChosenModelByProvider[input.state.lastChosenProvider],
              fallbackModelsByProvider: input.state.lastChosenModelByProvider,
            });
            panesById[draftPane.id] = draftPane;
            nextPaneIds.push(draftPane.id);
            continue;
          }
          seenThreadIds.add(pane.threadId);
          panesById[pane.id] = pane;
          nextPaneIds.push(pane.id);
          continue;
        }
        panesById[pane.id] = pane;
        nextPaneIds.push(pane.id);
      }
      const uniquePaneIds = nextPaneIds.filter((paneId, index) => nextPaneIds.indexOf(paneId) == index);
      if (uniquePaneIds.length == 0) {
        continue;
      }
      validTabs.push({
        ...tab,
        paneIds: uniquePaneIds,
        activePaneId: uniquePaneIds.includes(tab.activePaneId) ? tab.activePaneId : uniquePaneIds[0]!,
      });
    }

    let layout: ConsoleProjectLayout = {
      projectId,
      tabs: validTabs,
      panesById,
      activeTabId: validTabs.some((tab) => tab.id === reconciled.activeTabId)
        ? reconciled.activeTabId
        : (validTabs[0]?.id ?? ""),
      updatedAt: reconciled.updatedAt,
    };

    if (layout.tabs.length == 0) {
      layout = createProjectLayout(projectId, {
        selectedProvider: input.state.lastChosenProvider,
        selectedModel: input.state.lastChosenModelByProvider[input.state.lastChosenProvider],
        fallbackModelsByProvider: input.state.lastChosenModelByProvider,
      });
    }

    layoutsByProjectId[projectId] = layout;
  });

  const nextActiveProjectId =
    input.state.activeProjectId && projectsById.has(input.state.activeProjectId)
      ? input.state.activeProjectId
      : (preferredThread?.projectId ?? projectOrder[0] ?? null);

  return {
    projectOrder,
    collapsedProjectIds,
    activeProjectId: nextActiveProjectId,
    layoutsByProjectId,
    lastChosenProvider: input.state.lastChosenProvider,
    lastChosenModelByProvider: input.state.lastChosenModelByProvider,
  };
}

export function reconcileProjectLayoutsStateWhenReady(input: {
  readonly state: ConsoleProjectLayoutsState;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly preferredThreadId: string | null;
  readonly pendingThreadIds?: ReadonlySet<OrchestrationThread["id"]>;
  readonly hydrated: boolean;
}): ConsoleProjectLayoutsState {
  if (!input.hydrated) {
    return input.state;
  }

  return reconcileProjectLayoutsState({
    state: input.state,
    projects: input.projects,
    threads: input.threads,
    preferredThreadId: input.preferredThreadId,
    ...(input.pendingThreadIds ? { pendingThreadIds: input.pendingThreadIds } : {}),
  });
}

function updateLayoutState(
  state: ConsoleProjectLayoutsState,
  projectId: OrchestrationProject["id"],
  updater: (layout: ConsoleProjectLayout) => ConsoleProjectLayout,
): ConsoleProjectLayoutsState {
  const currentLayout = state.layoutsByProjectId[projectId] ?? createProjectLayout(projectId, {
    selectedProvider: state.lastChosenProvider,
    selectedModel: state.lastChosenModelByProvider[state.lastChosenProvider],
    fallbackModelsByProvider: state.lastChosenModelByProvider,
  });
  const nextLayout = updater(currentLayout);
  if (nextLayout === currentLayout && state.activeProjectId === projectId) {
    return state;
  }
  return {
    ...state,
    activeProjectId: projectId,
    layoutsByProjectId: {
      ...state.layoutsByProjectId,
      [projectId]: nextLayout,
    },
  };
}

function createFreshDraftReplacement(state: ConsoleProjectLayoutsState, paneId: string): ConsoleDraftPane {
  return createDraftPane({
    id: paneId,
    selectedProvider: state.lastChosenProvider,
    selectedModel: state.lastChosenModelByProvider[state.lastChosenProvider],
    fallbackModelsByProvider: state.lastChosenModelByProvider,
  });
}

export function useConsoleProjectLayouts(input: {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly preferredThreadId: string | null;
  readonly pendingThreadIds?: ReadonlySet<OrchestrationThread["id"]>;
  readonly hydrated: boolean;
}): ConsoleProjectLayoutsModel {
  const [state, setState] = useState<ConsoleProjectLayoutsState>(() => readPersistedState());

  useEffect(() => {
    setState((existing) => reconcileProjectLayoutsStateWhenReady({
      state: existing,
      threads: input.threads,
      projects: input.projects,
      preferredThreadId: input.preferredThreadId,
      ...(input.pendingThreadIds ? { pendingThreadIds: input.pendingThreadIds } : {}),
      hydrated: input.hydrated,
    }));
  }, [input.hydrated, input.pendingThreadIds, input.preferredThreadId, input.projects, input.threads]);

  useEffect(() => {
    persistState(state);
  }, [state]);

  const orderedProjects = useMemo(() => {
    const projectsById = new Map(input.projects.map((project) => [project.id, project] as const));
    return state.projectOrder
      .map((projectId) => projectsById.get(projectId) ?? null)
      .filter((project): project is OrchestrationProject => project !== null);
  }, [input.projects, state.projectOrder]);

  const projectViews = useMemo(() => orderedProjects.map((project) => ({
    project,
    layout: state.layoutsByProjectId[project.id] ?? createProjectLayout(project.id, {
      selectedProvider: state.lastChosenProvider,
      selectedModel: state.lastChosenModelByProvider[state.lastChosenProvider],
      fallbackModelsByProvider: state.lastChosenModelByProvider,
    }),
    collapsed: state.collapsedProjectIds.includes(project.id),
  })), [orderedProjects, state.collapsedProjectIds, state.layoutsByProjectId, state.lastChosenModelByProvider, state.lastChosenProvider]);

  const activeProject = useMemo(
    () => (state.activeProjectId ? input.projects.find((project) => project.id === state.activeProjectId) ?? null : null),
    [input.projects, state.activeProjectId],
  );
  const activeLayout = useMemo(
    () => (activeProject ? state.layoutsByProjectId[activeProject.id] ?? null : null),
    [activeProject, state.layoutsByProjectId],
  );
  const activeTab = useMemo(
    () => (activeLayout ? activeLayout.tabs.find((tab) => tab.id === activeLayout.activeTabId) ?? activeLayout.tabs[0] ?? null : null),
    [activeLayout],
  );
  const activePane = useMemo(
    () => (activeLayout && activeTab ? activeLayout.panesById[activeTab.activePaneId] ?? null : null),
    [activeLayout, activeTab],
  );
  const activeThreadId = activePane?.kind === "thread" ? activePane.threadId : null;
  const activeThread = useMemo(
    () => findThreadById(input.threads, activeThreadId),
    [activeThreadId, input.threads],
  );
  const activePaneId = activePane?.id ?? null;

  const activateProject = useCallback((projectId: OrchestrationProject["id"]) => {
    setState((existing) => existing.activeProjectId === projectId ? existing : { ...existing, activeProjectId: projectId });
  }, []);

  const clearActiveProject = useCallback(() => {
    setState((existing) => existing.activeProjectId === null ? existing : { ...existing, activeProjectId: null });
  }, []);

  const toggleProjectCollapsed = useCallback((projectId: OrchestrationProject["id"]) => {
    setState((existing) => {
      const collapsed = existing.collapsedProjectIds.includes(projectId)
        ? existing.collapsedProjectIds.filter((id) => id !== projectId)
        : [...existing.collapsedProjectIds, projectId];
      return { ...existing, collapsedProjectIds: collapsed };
    });
  }, []);

  const reorderProjects = useCallback((projectIds: ReadonlyArray<OrchestrationProject["id"]>) => {
    setState((existing) => {
      const nextOrder = projectIds.filter((projectId, index) => projectIds.indexOf(projectId) === index);
      if (nextOrder.length === 0) {
        return existing;
      }
      return { ...existing, projectOrder: nextOrder };
    });
  }, []);

  const activateTab = useCallback((projectId: OrchestrationProject["id"], tabId: string) => {
    setState((existing) => updateLayoutState(existing, projectId, (layout) => {
      if (!layout.tabs.some((tab) => tab.id === tabId)) {
        return layout;
      }
      if (layout.activeTabId === tabId) {
        return layout;
      }
      return withUpdatedLayout(layout, {
        ...layout,
        activeTabId: tabId,
      });
    }));
  }, []);

  const activatePane = useCallback((projectId: OrchestrationProject["id"], tabId: string, paneId: string) => {
    setState((existing) => updateLayoutState(existing, projectId, (layout) => {
      const tab = layout.tabs.find((candidate) => candidate.id === tabId);
      if (!tab || !tab.paneIds.includes(paneId)) {
        return layout;
      }
      if (layout.activeTabId === tabId && tab.activePaneId === paneId) {
        return layout;
      }
      const tabs = layout.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, activePaneId: paneId } : candidate);
      return withUpdatedLayout(layout, {
        ...layout,
        activeTabId: tabId,
        tabs,
      });
    }));
  }, []);

  const createDraftTab = useCallback((inputValue: {
    projectId: OrchestrationProject["id"];
    interactionMode?: ProviderInteractionMode;
    branch?: string | null;
    worktreePath?: string | null;
  }) => {
    let created: { tabId: string; paneId: string } | null = null;
    setState((existing) => updateLayoutState(existing, inputValue.projectId, (layout) => {
      const next = createDraftTabRef({
        selectedProvider: existing.lastChosenProvider,
        selectedModel: existing.lastChosenModelByProvider[existing.lastChosenProvider],
        fallbackModelsByProvider: existing.lastChosenModelByProvider,
        ...(inputValue.interactionMode ? { interactionMode: inputValue.interactionMode } : {}),
        ...(inputValue.branch !== undefined ? { branch: inputValue.branch ?? null } : {}),
        ...(inputValue.worktreePath !== undefined ? { worktreePath: inputValue.worktreePath ?? null } : {}),
      });
      created = { tabId: next.tab.id, paneId: next.pane.id };
      return withUpdatedLayout(layout, {
        ...layout,
        tabs: [...layout.tabs, next.tab],
        panesById: {
          ...layout.panesById,
          [next.pane.id]: next.pane,
        },
        activeTabId: next.tab.id,
      });
    }));
    return created;
  }, []);

  const splitPane = useCallback((inputValue: { projectId: OrchestrationProject["id"]; paneId: string }) => {
    let created: { tabId: string; paneId: string } | null = null;
    setState((existing) => updateLayoutState(existing, inputValue.projectId, (layout) => {
      const located = locatePane(layout, inputValue.paneId);
      if (!located || located.tab.paneIds.length >= 6) {
        return layout;
      }
      const pane = createDraftPane({
        selectedProvider: existing.lastChosenProvider,
        selectedModel: existing.lastChosenModelByProvider[existing.lastChosenProvider],
        fallbackModelsByProvider: existing.lastChosenModelByProvider,
      });
      created = { tabId: located.tab.id, paneId: pane.id };
      const tabs = layout.tabs.map((tab) =>
        tab.id === located.tab.id
          ? { ...tab, paneIds: [...tab.paneIds, pane.id], activePaneId: pane.id }
          : tab,
      );
      return withUpdatedLayout(layout, {
        ...layout,
        activeTabId: located.tab.id,
        tabs,
        panesById: {
          ...layout.panesById,
          [pane.id]: pane,
        },
      });
    }));
    return created;
  }, []);

  const closeTab = useCallback((projectId: OrchestrationProject["id"], tabId: string) => {
    setState((existing) => updateLayoutState(existing, projectId, (layout) => {
      const closingIndex = layout.tabs.findIndex((tab) => tab.id === tabId);
      if (closingIndex === -1) {
        return layout;
      }
      const remainingTabs = layout.tabs.filter((tab) => tab.id !== tabId);
      const nextPanesById = { ...layout.panesById };
      layout.tabs[closingIndex]?.paneIds.forEach((paneId) => {
        delete nextPanesById[paneId];
      });

      if (remainingTabs.length === 0) {
        const fresh = createProjectLayout(projectId, {
          selectedProvider: existing.lastChosenProvider,
          selectedModel: existing.lastChosenModelByProvider[existing.lastChosenProvider],
          fallbackModelsByProvider: existing.lastChosenModelByProvider,
        });
        return fresh;
      }

      const nextActiveTab = remainingTabs[Math.max(0, closingIndex - 1)] ?? remainingTabs[0]!;
      return withUpdatedLayout(layout, {
        ...layout,
        tabs: remainingTabs,
        panesById: nextPanesById,
        activeTabId: nextActiveTab.id,
      });
    }));
  }, []);

  const closePane = useCallback((projectId: OrchestrationProject["id"], paneId: string) => {
    setState((existing) => updateLayoutState(existing, projectId, (layout) => {
      const located = locatePane(layout, paneId);
      if (!located) {
        return layout;
      }
      if (located.tab.paneIds.length <= 1) {
        const tabsExcluding = layout.tabs.filter((tab) => tab.id !== located.tab.id);
        if (tabsExcluding.length === 0) {
          return createProjectLayout(projectId, {
            selectedProvider: existing.lastChosenProvider,
            selectedModel: existing.lastChosenModelByProvider[existing.lastChosenProvider],
            fallbackModelsByProvider: existing.lastChosenModelByProvider,
          });
        }
        const nextPanesById = { ...layout.panesById };
        delete nextPanesById[paneId];
        const nextActiveTab = tabsExcluding[Math.max(0, layout.tabs.findIndex((tab) => tab.id === located.tab.id) - 1)] ?? tabsExcluding[0]!;
        return withUpdatedLayout(layout, {
          ...layout,
          tabs: tabsExcluding,
          panesById: nextPanesById,
          activeTabId: nextActiveTab.id,
        });
      }
      const nextPaneIds = located.tab.paneIds.filter((candidateId) => candidateId !== paneId);
      const removedIndex = located.tab.paneIds.indexOf(paneId);
      const nextActivePaneId =
        located.tab.activePaneId === paneId
          ? (nextPaneIds[Math.max(0, removedIndex - 1)] ?? nextPaneIds[0]!)
          : located.tab.activePaneId;
      const tabs = layout.tabs.map((tab) =>
        tab.id === located.tab.id
          ? { ...tab, paneIds: nextPaneIds, activePaneId: nextActivePaneId }
          : tab,
      );
      const nextPanesById = { ...layout.panesById };
      delete nextPanesById[paneId];
      return withUpdatedLayout(layout, {
        ...layout,
        tabs,
        panesById: nextPanesById,
      });
    }));
  }, []);

  const updateDraftPane = useCallback((inputValue: {
    paneId: string;
    updater: (setup: ConsolePaneSetup) => ConsolePaneSetup;
  }) => {
    setState((existing) => {
      let nextState = existing;
      for (const [projectId, layout] of Object.entries(existing.layoutsByProjectId)) {
        const located = locatePane(layout, inputValue.paneId);
        if (!located || located.pane.kind !== "draft") {
          continue;
        }
        const updatedSetup = inputValue.updater(located.pane.setup);
        const providerChanged = updatedSetup.selectedProvider !== located.pane.setup.selectedProvider;
        const nextSetup: ConsolePaneSetup = {
          ...updatedSetup,
          selectedModel:
            providerChanged && updatedSetup.selectedModel === located.pane.setup.selectedModel
              ? existing.lastChosenModelByProvider[updatedSetup.selectedProvider]
              : resolveProviderModelSelection(
                  updatedSetup.selectedProvider,
                  updatedSetup.selectedModel,
                  existing.lastChosenModelByProvider,
                ),
        };
        const nextPane: ConsoleDraftPane = {
          ...located.pane,
          setup: nextSetup,
        };
        const nextLayout = withUpdatedLayout(layout, {
          ...layout,
          panesById: {
            ...layout.panesById,
            [nextPane.id]: nextPane,
          },
        });
        nextState = {
          ...existing,
          activeProjectId: projectId as OrchestrationProject["id"],
          lastChosenProvider: nextSetup.selectedProvider,
          lastChosenModelByProvider: {
            ...existing.lastChosenModelByProvider,
            [nextSetup.selectedProvider]: nextSetup.selectedModel,
          },
          layoutsByProjectId: {
            ...existing.layoutsByProjectId,
            [projectId]: nextLayout,
          },
        };
        break;
      }
      return nextState;
    });
  }, []);

  const mountThreadInPane = useCallback((inputValue: {
    projectId: OrchestrationProject["id"];
    paneId: string;
    threadId: OrchestrationThread["id"];
  }) => {
    let didMount = false;
    setState((existing) => updateLayoutState(existing, inputValue.projectId, (layout) => {
      const target = locatePane(layout, inputValue.paneId);
      if (!target) {
        return layout;
      }
      const source = locateThreadPane(layout, inputValue.threadId);
      const nextPanesById = { ...layout.panesById };
      if (source && source.pane.id !== target.pane.id) {
        nextPanesById[source.pane.id] = createFreshDraftReplacement(existing, source.pane.id);
      }
      nextPanesById[target.pane.id] = createThreadPane(inputValue.threadId, target.pane.id);
      const tabs = layout.tabs.map((tab) => {
        if (tab.id === target.tab.id) {
          return { ...tab, activePaneId: target.pane.id };
        }
        return tab;
      });
      didMount = true;
      return withUpdatedLayout(layout, {
        ...layout,
        activeTabId: target.tab.id,
        tabs,
        panesById: nextPanesById,
      });
    }));
    return didMount;
  }, []);

  const completeDraftPane = useCallback((inputValue: { paneId: string; threadId: OrchestrationThread["id"] }) => {
    const thread = input.threads.find((candidate) => candidate.id === inputValue.threadId) ?? null;
    if (!thread) {
      return;
    }
    void mountThreadInPane({
      projectId: thread.projectId,
      paneId: inputValue.paneId,
      threadId: inputValue.threadId,
    });
  }, [input.threads, mountThreadInPane]);

  const openThread = useCallback((threadId: OrchestrationThread["id"]) => {
    const thread = input.threads.find((candidate) => candidate.id === threadId) ?? null;
    if (!thread) {
      return null;
    }
    let result: OpenThreadResult | null = null;
    setState((existing) => updateLayoutState(existing, thread.projectId, (layout) => {
      const existingPane = locateThreadPane(layout, threadId);
      if (existingPane) {
        const tabs = layout.tabs.map((tab) =>
          tab.id === existingPane.tab.id
            ? { ...tab, activePaneId: existingPane.pane.id }
            : tab,
        );
        result = {
          paneId: existingPane.pane.id,
          highlightPane: existingPane.tab.paneIds.length > 1,
        };
        return withUpdatedLayout(layout, {
          ...layout,
          activeTabId: existingPane.tab.id,
          tabs,
        });
      }
      const pane = createThreadPane(threadId);
      const tab: ConsoleProjectTab = {
        id: makeId("tab"),
        paneIds: [pane.id],
        activePaneId: pane.id,
        createdAt: nowIso(),
      };
      result = { paneId: pane.id, highlightPane: false };
      return withUpdatedLayout(layout, {
        ...layout,
        tabs: [...layout.tabs, tab],
        panesById: {
          ...layout.panesById,
          [pane.id]: pane,
        },
        activeTabId: tab.id,
      });
    }));
    return result;
  }, [input.threads]);

  const rememberProviderModel = useCallback((provider: ProviderKind, model: string) => {
    setState((existing) => {
      const normalizedModel = resolveProviderModelSelection(provider, model, existing.lastChosenModelByProvider);
      if (existing.lastChosenModelByProvider[provider] === normalizedModel) {
        return existing;
      }
      return {
        ...existing,
        lastChosenProvider: provider,
        lastChosenModelByProvider: {
          ...existing.lastChosenModelByProvider,
          [provider]: normalizedModel,
        },
      };
    });
  }, []);

  return {
    state,
    projectViews,
    activeProject,
    activeLayout,
    activeTab,
    activePane,
    activeThread,
    activeThreadId,
    activePaneId,
    lastChosenProvider: state.lastChosenProvider,
    lastChosenModelByProvider: state.lastChosenModelByProvider,
    activateProject,
    clearActiveProject,
    toggleProjectCollapsed,
    reorderProjects,
    activateTab,
    activatePane,
    createDraftTab,
    splitPane,
    closePane,
    closeTab,
    updateDraftPane,
    completeDraftPane,
    openThread,
    mountThreadInPane,
    rememberProviderModel,
  };
}
