import {
  DEFAULT_MODEL_BY_PROVIDER,
  type CodexReasoningEffort,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCorners,
  pointerWithin,
  type CollisionDetection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { AnimatedLoadingText } from "./AnimatedLoadingText";
import { deriveRunningThreadIntentLabel } from "./agentIntent";
import { CommandPalette } from "./CommandPalette";
import {
  filterCommandPaletteCommands,
  type CommandPaletteCommand,
} from "./commandPaletteCommands";
import {
  flattenPaletteThreadPickerGroups,
  formatPaletteProjectLabel,
  formatPaletteThreadLabel,
  hasThreadPickerSearchQuery,
  isThreadPickerQuery,
  stripThreadPickerQueryPrefix,
  THREAD_PICKER_QUERY_PREFIX,
} from "./commandPaletteThreads";
import {
  findAppCommandShortcutByActionId,
  findMatchingAppCommandShortcut,
  formatAppCommandShortcutLabel,
  type AppCommandActionId,
} from "./commandShortcuts";
import {
  IMAGE_ATTACHMENT_SIZE_LIMIT_LABEL,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  composerImageDedupKey,
  createComposerImageAttachment,
  revokeComposerImageAttachmentPreview,
  toUploadImageAttachment,
  type ComposerImageAttachment,
} from "./composerAttachments";
import {
  formatPendingUserInputAnswersAsPrompt,
  resolvePendingUserInputAnswer,
  resolvePendingUserInputShortcut,
} from "./pendingUserInput";
import { readClientPlatform, resolveDesktopWindowControlsInsetPx } from "./windowControls";
import {
  hasNonCollapsedSelectionInsideElement,
  TranscriptRenderer,
  type TranscriptRendererHandle,
  threadToTranscriptBlocks,
} from "./transcript";
import { useConsoleData, type PendingConsoleThread } from "./consoleData/useConsoleData";
import { formatProviderModelSelectionLabel } from "./providerModelLabels";
import {
  type ConsoleProjectLayout,
  resolveThreadCwd,
  useConsoleProjectLayouts,
  type ConsolePaneSetup,
  type ConsoleProjectPane,
} from "./consoleSessions";
import { resolveWsHttpOrigin } from "./wsTransport";

const DRAFT_STORAGE_KEY = "t3code:console-pane-drafts:v1";
const ARCHIVED_PROJECT_IDS_STORAGE_KEY = "t3code:archived-project-ids:v1";
const UNREAD_THREAD_IDS_STORAGE_KEY = "t3code:unread-thread-ids:v1";
const EMPTY_PROJECTS: ReadonlyArray<OrchestrationProject> = [];
const SIDEBAR_THREAD_LIMIT = 7;
const SIDEBAR_IDLE_HIDE_MS = 10 * 60 * 60 * 1000;
const SIDEBAR_THREAD_STALE_MS = 5 * 24 * 60 * 60 * 1000;
const MAX_TAB_PANES = 6;
const PROJECT_CONTEXT_MENU_WIDTH = 360;
const PROJECT_CONTEXT_MENU_HEIGHT = 256;
const THREAD_DRAG_DATA_TYPE = "application/x-t3tools-console-thread";
interface AppPaletteCommand extends CommandPaletteCommand {
  readonly actionId?: AppCommandActionId;
  run(): Promise<void> | void;
}

const PALETTE_PROVIDER_SWITCH_DEFAULT_MODEL = "gpt-5.4" as const;
const HIGH_PRIORITY_COMMAND = 100;
const CURATED_REASONING_EFFORTS = ["high", "medium"] as const satisfies ReadonlyArray<CodexReasoningEffort>;
interface ManualModelCommandDefinition {
  readonly slug: string;
  readonly label: string;
  readonly reasoningEfforts?: ReadonlyArray<CodexReasoningEffort>;
}
const MANUAL_MODEL_COMMANDS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<ManualModelCommandDefinition>> = {
  codex: [
    { slug: "gpt-5.4", label: "Codex: GPT-5.4", reasoningEfforts: CURATED_REASONING_EFFORTS },
    { slug: "gpt-5.4-mini", label: "Codex: GPT-5.4 Mini", reasoningEfforts: CURATED_REASONING_EFFORTS },
  ],
  copilot: [
    { slug: "gpt-5.4", label: "Copilot CLI: GPT-5.4", reasoningEfforts: CURATED_REASONING_EFFORTS },
    { slug: "gpt-5.4-mini", label: "Copilot CLI: GPT-5.4 Mini", reasoningEfforts: CURATED_REASONING_EFFORTS },
    { slug: "claude-opus-4.6", label: "Copilot CLI: Claude Opus 4.6", reasoningEfforts: CURATED_REASONING_EFFORTS },
    { slug: "gemini-3-pro-preview", label: "Copilot CLI: Gemini 3 Pro (Preview)" },
    { slug: "gpt-5-mini", label: "Copilot CLI: GPT-5 Mini", reasoningEfforts: CURATED_REASONING_EFFORTS },
  ],
};
const SPLIT_PANE_COMMAND_LABEL = "New thread in new split pane";
const NEW_THREAD_IN_CURRENT_PANE_COMMAND_LABEL = "New thread in current pane";
const CLOSE_PANE_COMMAND_LABEL = "Close current pane";
const CREATE_TAB_COMMAND_LABEL = "Add new tab";
const ADD_PROJECT_COMMAND_LABEL = "Add new project";

export function buildProviderReasoningEffortModelOptions(
  provider: ProviderKind,
  reasoningEffort: CodexReasoningEffort,
): ProviderModelOptions {
  return provider === "codex"
    ? { codex: { reasoningEffort } }
    : { copilot: { reasoningEffort } };
}

export function getSupportedCuratedReasoningEfforts(input: {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly reasoningEfforts: ReadonlyArray<CodexReasoningEffort> | undefined;
  readonly copilotModelById: ReadonlyMap<string, ServerProviderModel>;
}): ReadonlyArray<CodexReasoningEffort> {
  if (!input.reasoningEfforts || input.reasoningEfforts.length === 0) {
    return [];
  }

  if (input.provider !== "copilot") {
    return input.reasoningEfforts;
  }

  const modelMetadata = input.copilotModelById.get(input.model);
  if (!modelMetadata?.supportsReasoningEffort) {
    return [];
  }

  if (!modelMetadata.supportedReasoningEfforts || modelMetadata.supportedReasoningEfforts.length === 0) {
    return input.reasoningEfforts;
  }

  return input.reasoningEfforts.filter((effort) => modelMetadata.supportedReasoningEfforts?.includes(effort));
}

export function getDefaultManualModelOptions(input: {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly reasoningEfforts: ReadonlyArray<CodexReasoningEffort> | undefined;
  readonly copilotModelById: ReadonlyMap<string, ServerProviderModel>;
}): ProviderModelOptions | undefined {
  const reasoningEffort = getSupportedCuratedReasoningEfforts(input)[0];
  return reasoningEffort ? buildProviderReasoningEffortModelOptions(input.provider, reasoningEffort) : undefined;
}

function SidebarChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function SidebarFolderIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.172a2 2 0 0 1 1.414.586l1.828 1.828A2 2 0 0 0 13.828 9H18a2 2 0 0 1 2 2z" />
      <path d="M4 11h16" />
    </svg>
  );
}

function SidebarNewThreadIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SidebarRearrangeIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 7h10" />
      <path d="M7 12h10" />
      <path d="M7 17h10" />
    </svg>
  );
}

type SidebarProjectDragHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function SortableSidebarProjectSection({
  projectId,
  isActive,
  children,
}: {
  projectId: OrchestrationProject["id"];
  isActive: boolean;
  children: (handleProps: SidebarProjectDragHandleProps) => React.ReactNode;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: projectId });

  return (
    <section
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
      }}
      className={getSidebarProjectSectionClassName({
        isActive,
        isDragging,
        isDragOver: isOver && !isDragging,
      })}
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </section>
  );
}

interface PaneView {
  readonly project: OrchestrationProject;
  readonly tabId: string;
  readonly pane: ConsoleProjectPane;
  readonly isActive: boolean;
  readonly threadId: OrchestrationThread["id"] | null;
  readonly thread: OrchestrationThread | null;
  readonly pendingThread: PendingConsoleThread | null;
  readonly setup: ConsolePaneSetup | null;
  readonly blocks: ReturnType<typeof threadToTranscriptBlocks>;
  readonly attachments: ReadonlyArray<ComposerImageAttachment>;
  readonly pendingPromptSendStartedAt: string | null;
  readonly pendingUserInput: ReturnType<ReturnType<typeof useConsoleData>["getPendingUserInputs"]>[number] | null;
  readonly pendingQuestionIndex: number;
  readonly pendingQuestion: ReturnType<ReturnType<typeof useConsoleData>["getPendingUserInputs"]>[number]["questions"][number] | null;
  readonly pendingQuestionOptionIndex: number | null;
  readonly draftAnswers: Record<string, string>;
  readonly cwd: string | null;
  readonly interactionMode: "default" | "plan";
  readonly provider: ProviderKind;
  readonly model: string;
  readonly modelOptions: ProviderModelOptions | undefined;
}

interface PaneScrollState {
  readonly offsetFromBottom: number;
}

interface ThreadStatusDescriptor {
  readonly tone: "working" | "waiting" | "idle" | "error";
  readonly label: string;
  readonly animatedLabel?: string;
  readonly timingLabel?: string;
}

interface SidebarThreadEntry {
  readonly thread: OrchestrationThread;
  readonly status: ThreadStatusDescriptor;
  readonly tooltip: string;
  readonly sidebarLabel: string | null;
  readonly ageMs: number;
}

interface ProjectContextMenuState {
  readonly projectId: OrchestrationProject["id"];
  readonly x: number;
  readonly y: number;
}

interface ThreadContextMenuState {
  readonly threadId: OrchestrationThread["id"];
  readonly x: number;
  readonly y: number;
}

interface DuplicateProjectMatch {
  readonly projectId: OrchestrationProject["id"];
  readonly title: string;
  readonly workspaceRoot: string;
  readonly isArchived: boolean;
}

interface ThreadUnreadSnapshot<ThreadId extends string = string> {
  readonly threadId: ThreadId;
  readonly isRunning: boolean;
  readonly isDeleted: boolean;
}

interface ThreadSelectionSummary {
  readonly totalCount: number;
  readonly selectedCount: number;
  readonly allSelected: boolean;
  readonly partiallySelected: boolean;
}

interface ManagedThreadRowSelectionResult<ThreadId extends string> {
  readonly selectedRowIds: ReadonlySet<ThreadId>;
  readonly activeRowId: ThreadId;
  readonly nextAnchorThreadId: ThreadId;
}

function isDesktopBridgeAvailable() {
  if (typeof window === "undefined") {
    return false;
  }
  return typeof window.desktopBridge !== "undefined";
}

function truncateTitle(text: string, maxLength = 50) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

function normalizeProjectPathInput(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length > 1) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeProjectWorkspaceRootForComparison(value: string) {
  const normalized = normalizeProjectPathInput(value).replace(/\//g, "\\").replace(/[\\]+$/, "");
  return normalized.toLowerCase();
}

export function findDuplicateProjectForWorkspaceRoot(input: {
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly archivedProjectIds: ReadonlySet<OrchestrationProject["id"]>;
  readonly workspaceRoot: string;
}): DuplicateProjectMatch | null {
  const comparisonKey = normalizeProjectWorkspaceRootForComparison(input.workspaceRoot);
  if (comparisonKey.length === 0) {
    return null;
  }
  const matches = input.projects.filter(
    (project) =>
      project.deletedAt === null
      && normalizeProjectWorkspaceRootForComparison(project.workspaceRoot) === comparisonKey,
  );
  if (matches.length === 0) {
    return null;
  }
  const preferredMatch = matches.find((project) => !input.archivedProjectIds.has(project.id)) ?? matches[0]!;
  return {
    projectId: preferredMatch.id,
    title: preferredMatch.title,
    workspaceRoot: preferredMatch.workspaceRoot,
    isArchived: input.archivedProjectIds.has(preferredMatch.id),
  };
}

function deriveProjectTitleFromPath(workspaceRoot: string) {
  const normalized = workspaceRoot.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? normalized;
}

export function shouldSuppressTabFocusNavigation(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
) {
  return event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isPaletteToggleShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">,
) {
  return event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "a";
}

export function isPaletteThreadShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">,
) {
  return event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "e";
}

export function resolvePaletteShortcutTransition(input: {
  readonly shortcut: "toggle" | "thread";
  readonly paletteOpen: boolean;
  readonly paletteQuery: string;
}) {
  if (input.shortcut === "toggle") {
    if (!input.paletteOpen) {
      return { open: true, query: "" };
    }

    return isThreadPickerQuery(input.paletteQuery)
      ? { open: true, query: "" }
      : { open: false, query: "" };
  }

  return {
    open: true,
    query: THREAD_PICKER_QUERY_PREFIX,
  };
}

export function shouldOpenPaneSearchShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
) {
  return !event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f";
}

export function shouldActivateNextTabShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">,
) {
  return event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey && event.key === "Tab";
}

export function getNextProjectTabId(
  layout: Pick<ConsoleProjectLayout, "tabs" | "activeTabId"> | null,
) {
  if (!layout || layout.tabs.length <= 1) {
    return null;
  }
  const activeIndex = layout.tabs.findIndex((tab) => tab.id === layout.activeTabId);
  if (activeIndex === -1) {
    return layout.tabs[0]?.id ?? null;
  }
  return layout.tabs[(activeIndex + 1) % layout.tabs.length]?.id ?? null;
}

export function shouldBlockGlobalPromptTypingForSelection(input: {
  readonly hasSelectionInDocument: boolean;
  readonly hasSelectionInActiveHistory: boolean;
}) {
  return input.hasSelectionInDocument && !input.hasSelectionInActiveHistory;
}

export function shouldScopeGlobalSelectAllToHistory(input: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly historyActive: boolean;
}) {
  return input.historyActive
    && (input.ctrlKey || input.metaKey)
    && !input.altKey
    && input.key.toLowerCase() === "a";
}

export function summarizeThreadSelection(
  threadIds: ReadonlyArray<string>,
  selectedThreadIds: ReadonlySet<string>,
): ThreadSelectionSummary {
  const totalCount = threadIds.length;
  const selectedCount = threadIds.filter((threadId) => selectedThreadIds.has(threadId)).length;
  return {
    totalCount,
    selectedCount,
    allSelected: totalCount > 0 && selectedCount === totalCount,
    partiallySelected: selectedCount > 0 && selectedCount < totalCount,
  };
}

function getManagedThreadIdRange<ThreadId extends string>(
  orderedThreadIds: ReadonlyArray<ThreadId>,
  fromThreadId: ThreadId,
  toThreadId: ThreadId,
) {
  const fromIndex = orderedThreadIds.indexOf(fromThreadId);
  const toIndex = orderedThreadIds.indexOf(toThreadId);
  if (fromIndex < 0 || toIndex < 0) {
    return [toThreadId];
  }
  const [startIndex, endIndex] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  return orderedThreadIds.slice(startIndex, endIndex + 1);
}

export function resolveManagedThreadRowSelection<ThreadId extends string>(input: {
  readonly orderedThreadIds: ReadonlyArray<ThreadId>;
  readonly currentSelectedRowIds: ReadonlySet<ThreadId>;
  readonly clickedThreadId: ThreadId;
  readonly anchorThreadId: ThreadId | null;
  readonly additive: boolean;
  readonly range: boolean;
}): ManagedThreadRowSelectionResult<ThreadId> {
  const {
    orderedThreadIds,
    currentSelectedRowIds,
    clickedThreadId,
    anchorThreadId,
    additive,
    range,
  } = input;

  if (range && anchorThreadId) {
    return {
      selectedRowIds: new Set(getManagedThreadIdRange(orderedThreadIds, anchorThreadId, clickedThreadId)),
      activeRowId: clickedThreadId,
      nextAnchorThreadId: clickedThreadId,
    };
  }

  if (additive) {
    const nextSelectedRowIds = new Set(currentSelectedRowIds);
    if (nextSelectedRowIds.has(clickedThreadId)) {
      nextSelectedRowIds.delete(clickedThreadId);
    } else {
      nextSelectedRowIds.add(clickedThreadId);
    }
    return {
      selectedRowIds: nextSelectedRowIds,
      activeRowId: clickedThreadId,
      nextAnchorThreadId: clickedThreadId,
    };
  }

  return {
    selectedRowIds: new Set([clickedThreadId]),
    activeRowId: clickedThreadId,
    nextAnchorThreadId: clickedThreadId,
  };
}

export function toggleManagedThreadChecksForRows<ThreadId extends string>(
  checkedThreadIds: ReadonlySet<ThreadId>,
  rowSelectionIds: ReadonlySet<ThreadId>,
  fallbackThreadId: ThreadId | null,
) {
  const targetThreadIds = rowSelectionIds.size > 0
    ? [...rowSelectionIds]
    : fallbackThreadId
      ? [fallbackThreadId]
      : [];
  if (targetThreadIds.length === 0) {
    return checkedThreadIds;
  }

  const shouldCheck = targetThreadIds.some((threadId) => !checkedThreadIds.has(threadId));
  const nextCheckedThreadIds = new Set(checkedThreadIds);
  for (const threadId of targetThreadIds) {
    if (shouldCheck) {
      nextCheckedThreadIds.add(threadId);
    } else {
      nextCheckedThreadIds.delete(threadId);
    }
  }
  return nextCheckedThreadIds;
}

export function findReusableDraftPaneForThreadOpen(input: {
  readonly layout: Pick<ConsoleProjectLayout, "tabs" | "panesById"> | null;
  readonly draftsByPaneId: Record<string, string>;
  readonly attachmentsByPaneId: Record<string, ReadonlyArray<ComposerImageAttachment>>;
  readonly pendingDraftPaneIds: ReadonlySet<string>;
}) {
  if (!input.layout) {
    return null;
  }
  for (const tab of input.layout.tabs) {
    if (tab.paneIds.length !== 1) {
      continue;
    }
    const paneId = tab.paneIds[0]!;
    const pane = input.layout.panesById[paneId];
    if (!pane || pane.kind !== "draft") {
      continue;
    }
    if (input.pendingDraftPaneIds.has(paneId)) {
      continue;
    }
    if ((input.draftsByPaneId[paneId] ?? "").trim().length > 0) {
      continue;
    }
    if ((input.attachmentsByPaneId[paneId] ?? []).length > 0) {
      continue;
    }
    return { tabId: tab.id, paneId };
  }
  return null;
}

export function getSidebarThreadGroups<ThreadEntry extends { readonly thread: Pick<OrchestrationThread, "id"> }>(input: {
  readonly layout: Pick<ConsoleProjectLayout, "tabs" | "panesById">;
  readonly threadEntries: ReadonlyArray<ThreadEntry>;
}) {
  if (input.layout.tabs.length <= 1) {
    return [{
      key: "all",
      label: null,
      entries: input.threadEntries,
    }] as const;
  }

  const tabIdByThreadId = new Map<OrchestrationThread["id"], string>();
  for (const tab of input.layout.tabs) {
    for (const paneId of tab.paneIds) {
      const pane = input.layout.panesById[paneId];
      if (pane?.kind === "thread" && !tabIdByThreadId.has(pane.threadId)) {
        tabIdByThreadId.set(pane.threadId, tab.id);
      }
    }
  }

  const groupedEntries: Array<{
    readonly key: string;
    readonly label: string | null;
    readonly entries: ReadonlyArray<ThreadEntry>;
  }> = input.layout.tabs
    .map((tab, index) => ({
      key: tab.id,
      label: `Tab ${index + 1}`,
      entries: input.threadEntries.filter((entry) => tabIdByThreadId.get(entry.thread.id) === tab.id),
    }))
    .filter((group) => group.entries.length > 0);

  const ungroupedEntries = input.threadEntries.filter((entry) => !tabIdByThreadId.has(entry.thread.id));
  if (ungroupedEntries.length > 0) {
    groupedEntries.push({
      key: "ungrouped",
      label: null,
      entries: ungroupedEntries,
    });
  }

  return groupedEntries.length > 0
    ? groupedEntries
    : [{
      key: "all",
      label: null,
      entries: input.threadEntries,
    }];
}

function resolveProjectContextMenuPosition(clientX: number, clientY: number) {
  const viewportWidth = typeof window === "undefined" ? PROJECT_CONTEXT_MENU_WIDTH : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? PROJECT_CONTEXT_MENU_HEIGHT : window.innerHeight;
  return {
    x: Math.max(12, Math.min(clientX, viewportWidth - PROJECT_CONTEXT_MENU_WIDTH - 12)),
    y: Math.max(12, Math.min(clientY, viewportHeight - PROJECT_CONTEXT_MENU_HEIGHT - 12)),
  };
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function formatElapsedCompact(durationMs: number) {
  return formatSidebarAge(durationMs);
}

function formatSidebarAge(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0s";
  }
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours}h`;
  }
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays} day${totalDays === 1 ? "" : "s"}`;
}

export function formatManageThreadTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toISOString().slice(0, 10);
}

function getThreadFirstPrompt(thread: OrchestrationThread) {
  return thread.messages.find((message) => message.role === "user" && message.text.trim().length > 0)?.text.trim()
    ?? thread.title;
}

function getThreadSortValue(thread: OrchestrationThread) {
  const candidates = [
    thread.updatedAt,
    thread.createdAt,
    thread.latestTurn?.completedAt ?? null,
    thread.latestTurn?.startedAt ?? null,
    thread.latestTurn?.requestedAt ?? null,
    thread.session?.updatedAt ?? null,
  ];
  return Math.max(
    ...candidates
      .map(parseTimestampMs)
      .filter((value) => Number.isFinite(value)),
    0,
  );
}

export function getThreadStatus(
  thread: OrchestrationThread,
  nowIso: string,
  isThreadTurnRunning: boolean,
  pendingUserInputStartedAt: string | null = null,
): ThreadStatusDescriptor {
  if (thread.session?.lastError) {
    return { tone: "error", label: "error" };
  }

  const nowMs = parseTimestampMs(nowIso);
  if (pendingUserInputStartedAt) {
    const waitingStartedAt = parseTimestampMs(pendingUserInputStartedAt);
    const label = deriveRunningThreadIntentLabel(thread) ?? "Waiting for input";
    const timingLabel = formatElapsedCompact(nowMs - waitingStartedAt);
    return {
      tone: "waiting",
      label: `${label} ${timingLabel}`,
      timingLabel,
    };
  }

  if (isThreadTurnRunning || thread.latestTurn?.state === "running") {
    const startedAt = parseTimestampMs(
      thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? thread.updatedAt,
    );
    const label = deriveRunningThreadIntentLabel(thread) ?? "Working";
    const timingLabel = formatElapsedCompact(nowMs - startedAt);
    return {
      tone: "working",
      label: `${label} ${timingLabel}`,
      animatedLabel: label,
      timingLabel,
    };
  }

  const waitingFrom = parseTimestampMs(
    thread.latestTurn?.completedAt ?? thread.latestTurn?.startedAt ?? thread.updatedAt,
  );
  if (Number.isFinite(waitingFrom)) {
    const timingLabel = formatElapsedCompact(nowMs - waitingFrom);
    return {
      tone: "waiting",
      label: `idling ${timingLabel}`,
      timingLabel,
    };
  }

  return { tone: "idle", label: "idle" };
}

export function getSidebarThreadTitleClassName(input: {
  readonly statusTone: ThreadStatusDescriptor["tone"];
  readonly isActive: boolean;
}) {
  return [
    "project-thread__title",
    input.statusTone === "working" ? "project-thread__title--loading" : null,
    input.statusTone === "working" && input.isActive ? "project-thread__title--loadingActive" : null,
  ].filter((className): className is string => className !== null).join(" ");
}

export function getSidebarThreadStatusClassName(input: {
  readonly statusTone: ThreadStatusDescriptor["tone"];
  readonly isActive: boolean;
}) {
  return [
    "project-thread__status",
    `project-thread__status--${input.statusTone}`,
    input.statusTone === "working" ? "project-thread__status--loading" : null,
    input.statusTone === "working" && input.isActive ? "project-thread__status--loadingActive" : null,
  ].filter((className): className is string => className !== null).join(" ");
}

export function getSidebarThreadClassName(input: {
  readonly ageMs: number;
  readonly hasUnreadMarker: boolean;
  readonly isActive: boolean;
}) {
  return [
    "project-thread",
    input.isActive ? "project-thread--active" : null,
    input.hasUnreadMarker ? "project-thread--unread" : null,
    input.ageMs >= SIDEBAR_THREAD_STALE_MS ? "project-thread--stale" : null,
  ].filter((className): className is string => className !== null).join(" ");
}

export function getSidebarProjectSectionClassName(input: {
  readonly isActive: boolean;
  readonly isDragging: boolean;
  readonly isDragOver: boolean;
}) {
  return [
    "project-tree__section",
    input.isActive ? "project-tree__section--active" : null,
    input.isDragging ? "project-tree__section--dragging" : null,
    input.isDragOver ? "project-tree__section--dragOver" : null,
  ].filter((className): className is string => className !== null).join(" ");
}

export function reorderProjectIds<ProjectId extends string>(
  projectIds: ReadonlyArray<ProjectId>,
  draggedProjectId: ProjectId,
  targetProjectId: ProjectId,
) {
  if (draggedProjectId === targetProjectId) {
    return [...projectIds];
  }

  const draggedIndex = projectIds.indexOf(draggedProjectId);
  const targetIndex = projectIds.indexOf(targetProjectId);
  if (draggedIndex === -1 || targetIndex === -1) {
    return [...projectIds];
  }

  const nextProjectIds = [...projectIds];
  const [draggedProject] = nextProjectIds.splice(draggedIndex, 1);
  if (!draggedProject) {
    return [...projectIds];
  }
  nextProjectIds.splice(targetIndex, 0, draggedProject);
  return nextProjectIds;
}

export function canDropDraggedThreadIntoProject<
  ThreadId extends string,
  ProjectId extends string,
>(input: {
  readonly draggedThreadId: ThreadId | null;
  readonly targetProjectId: ProjectId | null;
  readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly projectId: ProjectId }>;
}) {
  if (!input.draggedThreadId || !input.targetProjectId) {
    return false;
  }
  return input.threads.some(
    (thread) => thread.id === input.draggedThreadId && thread.projectId === input.targetProjectId,
  );
}

export function canDropDraggedThreadIntoSplitZone<
  ThreadId extends string,
  ProjectId extends string,
>(input: {
  readonly draggedThreadId: ThreadId | null;
  readonly targetProjectId: ProjectId | null;
  readonly activeTabPaneCount: number | null;
  readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly projectId: ProjectId }>;
}) {
  return canDropDraggedThreadIntoProject({
    draggedThreadId: input.draggedThreadId,
    targetProjectId: input.targetProjectId,
    threads: input.threads,
  }) && input.activeTabPaneCount !== null
    && input.activeTabPaneCount > 0
    && input.activeTabPaneCount < MAX_TAB_PANES;
}

export function isDraggedThreadSplitZoneLimitReached<
  ThreadId extends string,
  ProjectId extends string,
>(input: {
  readonly draggedThreadId: ThreadId | null;
  readonly targetProjectId: ProjectId | null;
  readonly activeTabPaneCount: number | null;
  readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly projectId: ProjectId }>;
}) {
  return canDropDraggedThreadIntoProject({
    draggedThreadId: input.draggedThreadId,
    targetProjectId: input.targetProjectId,
    threads: input.threads,
  }) && input.activeTabPaneCount !== null
    && input.activeTabPaneCount >= MAX_TAB_PANES;
}

export function getConversationPaneClassName(input: {
  readonly isActive: boolean;
  readonly isDropEligible: boolean;
  readonly isDragOver: boolean;
  readonly isHighlighted: boolean;
}) {
  return [
    "conversation-pane",
    input.isActive ? "conversation-pane--active" : null,
    input.isDropEligible ? "conversation-pane--drop-target" : null,
    input.isDragOver ? "conversation-pane--drag-over" : null,
    input.isHighlighted ? "conversation-pane--highlight" : null,
  ].filter((className): className is string => className !== null).join(" ");
}

export function getThreadSplitDropZoneClassName(input: {
  readonly isDragActive: boolean;
  readonly isDropEligible: boolean;
  readonly isDragOver: boolean;
  readonly isLimitReached: boolean;
}) {
  return [
    "project-split-dropzone",
    input.isDragActive ? "project-split-dropzone--drag-active" : null,
    input.isDropEligible ? "project-split-dropzone--eligible" : null,
    input.isDragOver ? "project-split-dropzone--drag-over" : null,
    input.isLimitReached ? "project-split-dropzone--limit-reached" : null,
  ].filter((className): className is string => className !== null).join(" ");
}

export function shouldShowThreadSplitDropZone(draggedThreadId: string | null) {
  return draggedThreadId !== null;
}

function getThreadAgeMs(thread: OrchestrationThread, nowIso: string) {
  const nowMs = parseTimestampMs(nowIso);
  const threadMs = getThreadSortValue(thread);
  return Math.max(0, nowMs - threadMs);
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function readPersistedPaneDrafts() {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function persistPaneDrafts(draftsByPaneId: Record<string, string>) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draftsByPaneId));
}

function areSetsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

export function parsePersistedArchivedProjectIds<ProjectId extends string = string>(raw: string | null) {
  try {
    if (!raw) {
      return new Set<ProjectId>();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set<ProjectId>();
    }
    return new Set(parsed.filter((value): value is ProjectId => typeof value === "string" && value.length > 0));
  } catch {
    return new Set<ProjectId>();
  }
}

export function readPersistedArchivedProjectIds<ProjectId extends string = string>() {
  if (typeof window === "undefined") {
    return new Set<ProjectId>();
  }
  return parsePersistedArchivedProjectIds<ProjectId>(
    window.localStorage.getItem(ARCHIVED_PROJECT_IDS_STORAGE_KEY),
  );
}

function persistArchivedProjectIds(projectIds: ReadonlySet<string>) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(ARCHIVED_PROJECT_IDS_STORAGE_KEY, JSON.stringify([...projectIds]));
}

export function resolveProjectSelectionAfterArchive<ProjectId extends string>(input: {
  readonly activeProjectId: ProjectId | null;
  readonly archivedProjectId: ProjectId;
  readonly visibleProjectIds: ReadonlyArray<ProjectId>;
}) {
  if (input.activeProjectId !== input.archivedProjectId) {
    return input.activeProjectId;
  }
  return input.visibleProjectIds.find((projectId) => projectId !== input.archivedProjectId) ?? null;
}

export function parsePersistedUnreadThreadIds<ThreadId extends string = string>(raw: string | null) {
  try {
    if (!raw) {
      return new Set<ThreadId>();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set<ThreadId>();
    }
    return new Set(parsed.filter((value): value is ThreadId => typeof value === "string" && value.length > 0));
  } catch {
    return new Set<ThreadId>();
  }
}

function readPersistedUnreadThreadIds<ThreadId extends string = string>() {
  if (typeof window === "undefined") {
    return new Set<ThreadId>();
  }
  return parsePersistedUnreadThreadIds<ThreadId>(
    window.localStorage.getItem(UNREAD_THREAD_IDS_STORAGE_KEY),
  );
}

function persistUnreadThreadIds(threadIds: ReadonlySet<string>) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(UNREAD_THREAD_IDS_STORAGE_KEY, JSON.stringify([...threadIds]));
}

export function reconcileUnreadThreadIds<ThreadId extends string = string>(input: {
  readonly currentUnreadThreadIds: ReadonlySet<ThreadId>;
  readonly previousRunningByThreadId: ReadonlyMap<ThreadId, boolean>;
  readonly threadSnapshots: ReadonlyArray<ThreadUnreadSnapshot<ThreadId>>;
  readonly activeThreadId: ThreadId | null;
}) {
  const visibleThreadIds = new Set<ThreadId>();
  const nextRunningByThreadId = new Map<ThreadId, boolean>();
  const nextUnreadThreadIds = new Set(input.currentUnreadThreadIds);

  for (const snapshot of input.threadSnapshots) {
    if (snapshot.isDeleted) {
      continue;
    }
    visibleThreadIds.add(snapshot.threadId);
    nextRunningByThreadId.set(snapshot.threadId, snapshot.isRunning);
    const wasRunning = input.previousRunningByThreadId.get(snapshot.threadId) ?? false;
    if (wasRunning && !snapshot.isRunning && input.activeThreadId !== snapshot.threadId) {
      nextUnreadThreadIds.add(snapshot.threadId);
    }
  }

  for (const threadId of nextUnreadThreadIds) {
    if (!visibleThreadIds.has(threadId) || threadId === input.activeThreadId) {
      nextUnreadThreadIds.delete(threadId);
    }
  }

  return {
    unreadThreadIds: nextUnreadThreadIds,
    runningByThreadId: nextRunningByThreadId,
  };
}

function EmptyWorkspaceSurface(props: {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly disabled?: boolean;
  onAction?(): void;
}) {
  return (
    <div className="empty-workspace" role="status" aria-live="polite">
      <div className="empty-workspace__content">
        <div className="empty-workspace__row">
          <span className="thread-setup__line">{props.title}</span>
        </div>
        <div className="empty-workspace__row">
          <span className="thread-setup__line thread-setup__line--muted">{props.detail}</span>
        </div>
        {props.onAction && props.actionLabel ? (
          <div className="empty-workspace__row">
            <button
              type="button"
              className="thread-setup__option thread-setup__option--active empty-workspace__action"
              onClick={props.onAction}
              disabled={props.disabled}
            >
              <span className="thread-setup__text">{props.actionLabel}</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function shouldRetainPendingPromptSend(input: {
  readonly thread: OrchestrationThread | null;
  readonly startedAt: string;
  readonly hasPendingThreadHistory: boolean;
  readonly isThreadTurnRunning: boolean;
}) {
  if (!input.thread) {
    return input.hasPendingThreadHistory;
  }

  if (input.isThreadTurnRunning) {
    return false;
  }

  return !input.thread.activities.some((activity) =>
    activity.kind === "provider.turn.start.failed" && activity.createdAt >= input.startedAt
  );
}

export function App() {
  const isDesktop = useMemo(isDesktopBridgeAvailable, []);
  const consoleData = useConsoleData();
  const copilotModelById = useMemo<ReadonlyMap<string, ServerProviderModel>>(() => {
    const copilotProviderStatus =
      consoleData.serverConfig?.providers.find((entry) => entry.provider === "copilot") ?? null;
    return new Map(copilotProviderStatus?.models?.map((entry) => [entry.id, entry] as const) ?? []);
  }, [consoleData.serverConfig]);
  const [pendingThreadByPaneId, setPendingThreadByPaneId] = useState<
    Record<string, { readonly threadId: OrchestrationThread["id"]; readonly pendingThread: PendingConsoleThread }>
  >({});
  const projects = useMemo(
    () => consoleData.snapshot?.projects ?? EMPTY_PROJECTS,
    [consoleData.snapshot?.projects],
  );
  const pendingThreadIds = useMemo(
    () => new Set(Object.values(pendingThreadByPaneId).map((entry) => entry.threadId)),
    [pendingThreadByPaneId],
  );
  const workspace = useConsoleProjectLayouts({
    threads: consoleData.threads,
    projects,
    preferredThreadId: consoleData.activeThreadId,
    pendingThreadIds,
    hydrated: consoleData.snapshot !== null,
  });

  const getPendingUserInputs = consoleData.getPendingUserInputs;
  const getThreadEvents = consoleData.getThreadEvents;
  const getTurnDiff = consoleData.getTurnDiff;
  const isThreadTurnRunning = consoleData.isThreadTurnRunning;
  const canSubmitPromptForThread = consoleData.canSubmitPromptForThread;
  const createThread = consoleData.createThread;
  const createProject = consoleData.createProject;
  const submitPrompt = consoleData.submitPrompt;
  const respondToUserInput = consoleData.respondToUserInput;
  const setThreadModel = consoleData.setThreadModel;
  const deleteThread = consoleData.deleteThread;

  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const [animationNowIso, setAnimationNowIso] = useState(() => new Date().toISOString());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [paletteContextPaneId, setPaletteContextPaneId] = useState<string | null>(null);
  const [pendingPromptSendStartedAtByThreadId, setPendingPromptSendStartedAtByThreadId] = useState<Record<string, string>>({});
  const [composerAttachmentsByPaneId, setComposerAttachmentsByPaneId] = useState<Record<string, ReadonlyArray<ComposerImageAttachment>>>({});
  const [composerDraftByPaneId, setComposerDraftByPaneId] = useState<Record<string, string>>(() => readPersistedPaneDrafts());
  const [paneScrollStateByPaneId, setPaneScrollStateByPaneId] = useState<Record<string, PaneScrollState>>({});
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<Record<string, Record<string, string>>>({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] = useState<Record<string, number>>({});
  const [pendingDraftPaneIds, setPendingDraftPaneIds] = useState<ReadonlySet<string>>(() => new Set());
  const [draggedThreadId, setDraggedThreadId] = useState<string | null>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);
  const [dragOverSplitZone, setDragOverSplitZone] = useState(false);
  const [highlightedPaneId, setHighlightedPaneId] = useState<string | null>(null);
  const [expandedSidebarProjectIds, setExpandedSidebarProjectIds] = useState<ReadonlySet<string>>(() => new Set());
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [threadContextMenu, setThreadContextMenu] = useState<ThreadContextMenuState | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectPathDraft, setProjectPathDraft] = useState("");
  const [projectModalError, setProjectModalError] = useState<string | null>(null);
  const [duplicateProjectConfirm, setDuplicateProjectConfirm] = useState<DuplicateProjectMatch | null>(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [pendingProjectActivationId, setPendingProjectActivationId] = useState<OrchestrationProject["id"] | null>(null);
  const [archivedProjectIds, setArchivedProjectIds] = useState<ReadonlySet<OrchestrationProject["id"]>>(
    () => readPersistedArchivedProjectIds<OrchestrationProject["id"]>(),
  );
  const [managedProjectId, setManagedProjectId] = useState<OrchestrationProject["id"] | null>(null);
  const [selectedManagedThreadIds, setSelectedManagedThreadIds] = useState<ReadonlySet<OrchestrationThread["id"]>>(() => new Set());
  const [activeManagedTableRowId, setActiveManagedTableRowId] = useState<OrchestrationThread["id"] | null>(null);
  const [manageProjectError, setManageProjectError] = useState<string | null>(null);
  const [isDeletingManagedThreads, setIsDeletingManagedThreads] = useState(false);
  const [projectArchiveConfirmId, setProjectArchiveConfirmId] = useState<OrchestrationProject["id"] | null>(null);
  const [threadDeleteConfirmId, setThreadDeleteConfirmId] = useState<OrchestrationThread["id"] | null>(null);
  const [threadDeleteError, setThreadDeleteError] = useState<string | null>(null);
  const [isDeletingThread, setIsDeletingThread] = useState(false);
  const [unreadThreadIds, setUnreadThreadIds] = useState<ReadonlySet<OrchestrationThread["id"]>>(
    () => readPersistedUnreadThreadIds<OrchestrationThread["id"]>(),
  );
  const paneRefs = useRef<Record<string, TranscriptRendererHandle | null>>({});
  const paneElementRefs = useRef<Record<string, HTMLElement | null>>({});
  const initializedPaneIdsRef = useRef<Record<string, true>>({});
  const hasInitiallyFocusedPromptRef = useRef(false);
  const composerAttachmentsRef = useRef(composerAttachmentsByPaneId);
  const projectPathInputRef = useRef<HTMLInputElement | null>(null);
  const duplicateProjectConfirmPrimaryActionRef = useRef<HTMLButtonElement | null>(null);
  const manageProjectSelectAllRef = useRef<HTMLInputElement | null>(null);
  const manageProjectTableShellRef = useRef<HTMLDivElement | null>(null);
  const manageProjectCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastManagedThreadRowSelectionIdRef = useRef<OrchestrationThread["id"] | null>(null);
  const pointerManagedThreadSelectionAnchorIdRef = useRef<OrchestrationThread["id"] | null>(null);
  const previousRunningByThreadIdRef = useRef<ReadonlyMap<OrchestrationThread["id"], boolean>>(new Map());
  composerAttachmentsRef.current = composerAttachmentsByPaneId;
  const hasAnimatedTranscript = useMemo(
    () =>
      Object.keys(pendingPromptSendStartedAtByThreadId).length > 0
      || consoleData.threads.some((thread) => isThreadTurnRunning(thread.id)),
    [consoleData.threads, isThreadTurnRunning, pendingPromptSendStartedAtByThreadId],
  );

  useEffect(() => {
    const handle = window.setInterval(() => {
      setNowIso(new Date().toISOString());
    }, 1000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    if (!hasAnimatedTranscript) {
      setAnimationNowIso(new Date().toISOString());
      return;
    }
    const handle = window.setInterval(() => {
      setAnimationNowIso(new Date().toISOString());
    }, 120);
    return () => window.clearInterval(handle);
  }, [hasAnimatedTranscript]);

  useEffect(() => {
    persistPaneDrafts(composerDraftByPaneId);
  }, [composerDraftByPaneId]);

  useEffect(() => {
    persistArchivedProjectIds(archivedProjectIds);
  }, [archivedProjectIds]);

  useEffect(() => {
    persistUnreadThreadIds(unreadThreadIds);
  }, [unreadThreadIds]);

  useEffect(() => {
    if (!projectModalOpen) {
      return;
    }
    const focusInput = () => {
      projectPathInputRef.current?.focus();
      projectPathInputRef.current?.select();
    };
    focusInput();
    requestAnimationFrame(focusInput);
  }, [projectModalOpen]);

  useEffect(() => {
    if (!duplicateProjectConfirm) {
      return;
    }
    const focusAction = () => duplicateProjectConfirmPrimaryActionRef.current?.focus();
    focusAction();
    requestAnimationFrame(focusAction);
  }, [duplicateProjectConfirm]);

  const orderedThreadsByProjectId = useMemo(() => {
    const map = new Map<string, OrchestrationThread[]>();
    for (const project of projects.filter((project) => project.deletedAt === null)) {
      map.set(project.id, []);
    }
    for (const thread of consoleData.threads.filter((thread) => thread.deletedAt === null)) {
      const bucket = map.get(thread.projectId);
      if (bucket) {
        bucket.push(thread);
      }
    }
    for (const bucket of map.values()) {
      bucket.sort((left, right) => getThreadSortValue(right) - getThreadSortValue(left));
    }
    return map;
  }, [consoleData.threads, projects]);
  const threadUnreadSnapshots = useMemo(
    () =>
      consoleData.threads.map((thread) => ({
        threadId: thread.id,
        isRunning: isThreadTurnRunning(thread.id),
        isDeleted: thread.deletedAt !== null,
      })),
    [consoleData.threads, isThreadTurnRunning],
  );

  useEffect(() => {
    const nextState = reconcileUnreadThreadIds({
      currentUnreadThreadIds: unreadThreadIds,
      previousRunningByThreadId: previousRunningByThreadIdRef.current,
      threadSnapshots: threadUnreadSnapshots,
      activeThreadId: workspace.activeThreadId,
    });
    previousRunningByThreadIdRef.current = nextState.runningByThreadId;
    if (!areSetsEqual(unreadThreadIds, nextState.unreadThreadIds)) {
      setUnreadThreadIds(nextState.unreadThreadIds);
    }
  }, [threadUnreadSnapshots, unreadThreadIds, workspace.activeThreadId]);

  const managedProject = useMemo(
    () => (managedProjectId ? projects.find((project) => project.id === managedProjectId) ?? null : null),
    [managedProjectId, projects],
  );
  const managedProjectThreads = useMemo(
    () => (managedProject ? orderedThreadsByProjectId.get(managedProject.id) ?? [] : []),
    [managedProject, orderedThreadsByProjectId],
  );
  const visibleSidebarProjectViews = useMemo(
    () => workspace.projectViews.filter((projectView) => !archivedProjectIds.has(projectView.project.id)),
    [archivedProjectIds, workspace.projectViews],
  );
  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }
    return closestCorners(args);
  }, []);
  const handleSidebarProjectDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = typeof event.active.id === "string" ? event.active.id : null;
    const overId = typeof event.over?.id === "string" ? event.over.id : null;
    if (!activeId || !overId || activeId === overId) {
      return;
    }
    const projectIds = workspace.projectViews.map((projectView) => projectView.project.id);
    const activeProjectId = projectIds.find((projectId) => projectId === activeId);
    const overProjectId = projectIds.find((projectId) => projectId === overId);
    if (!activeProjectId || !overProjectId) {
      return;
    }
    workspace.reorderProjects(reorderProjectIds(projectIds, activeProjectId, overProjectId));
  }, [workspace]);
  const managedThreadSelection = useMemo(
    () => summarizeThreadSelection(managedProjectThreads.map((thread) => thread.id), selectedManagedThreadIds),
    [managedProjectThreads, selectedManagedThreadIds],
  );

  const livePaneIds = useMemo(() => {
    const ids: string[] = [];
    for (const projectView of workspace.projectViews) {
      for (const tab of projectView.layout.tabs) {
        ids.push(...tab.paneIds);
      }
    }
    return ids;
  }, [workspace.projectViews]);

  const liveDraftPaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const projectView of workspace.projectViews) {
      for (const pane of Object.values(projectView.layout.panesById)) {
        if (pane.kind === "draft") {
          ids.add(pane.id);
        }
      }
    }
    return ids;
  }, [workspace.projectViews]);

  useEffect(() => {
    const livePaneIdSet = new Set(livePaneIds);

    setComposerAttachmentsByPaneId((existing) => {
      const next = Object.fromEntries(Object.entries(existing).filter(([paneId]) => livePaneIdSet.has(paneId)));
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });
    setPendingThreadByPaneId((existing) => {
      const next = Object.fromEntries(Object.entries(existing).filter(([paneId]) => livePaneIdSet.has(paneId)));
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });
    setPaneScrollStateByPaneId((existing) => {
      const next = Object.fromEntries(Object.entries(existing).filter(([paneId]) => livePaneIdSet.has(paneId)));
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });
    setComposerDraftByPaneId((existing) => {
      const next = Object.fromEntries(
        Object.entries(existing).filter(([paneId, value]) => liveDraftPaneIds.has(paneId) && value.length > 0),
      );
      return Object.keys(next).length === Object.keys(existing).length ? existing : next;
    });

    for (const paneId of Object.keys(initializedPaneIdsRef.current)) {
      if (!livePaneIdSet.has(paneId)) {
        delete initializedPaneIdsRef.current[paneId];
        delete paneRefs.current[paneId];
      }
    }
  }, [liveDraftPaneIds, livePaneIds]);

  useEffect(() => {
    if (draggedThreadId) {
      return;
    }
    setDragOverPaneId(null);
    setDragOverSplitZone(false);
  }, [draggedThreadId]);

  useEffect(() => {
    if (!projectContextMenu) {
      return;
    }
    const handleDismiss = () => {
      setProjectContextMenu(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setProjectContextMenu(null);
    };
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [projectContextMenu]);

  useEffect(() => {
    if (!threadContextMenu) {
      return;
    }
    const handleDismiss = () => {
      setThreadContextMenu(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setThreadContextMenu(null);
    };
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [threadContextMenu]);

  useEffect(() => {
    if (!workspace.activeThreadId || consoleData.activeThreadId === workspace.activeThreadId) {
      return;
    }
    consoleData.setActiveThreadId(workspace.activeThreadId);
  }, [consoleData, workspace.activeThreadId]);

  useEffect(() => {
    setPendingThreadByPaneId((existing) => {
      let changed = false;
      const next: Record<string, { readonly threadId: OrchestrationThread["id"]; readonly pendingThread: PendingConsoleThread }> = {};
      for (const [paneId, pendingThread] of Object.entries(existing)) {
        const paneStillPending = workspace.projectViews.some((projectView) =>
          Object.values(projectView.layout.panesById).some(
            (pane) => pane.id === paneId
              && pane.kind === "thread"
              && pane.threadId === pendingThread.threadId
              && !consoleData.threads.some((thread) => thread.id === pane.threadId),
          ),
        );
        if (paneStillPending) {
          next[paneId] = pendingThread;
        } else {
          changed = true;
        }
      }
      return changed ? next : existing;
    });
  }, [consoleData.threads, workspace.projectViews]);

  useEffect(() => {
    const liveProjectIdSet = new Set(projects.filter((project) => project.deletedAt === null).map((project) => project.id));
    setArchivedProjectIds((existing) => {
      const next = new Set([...existing].filter((projectId) => liveProjectIdSet.has(projectId)));
      const unchanged = next.size === existing.size && [...next].every((projectId) => existing.has(projectId));
      return unchanged ? existing : next;
    });
  }, [projects]);

  useEffect(() => {
    if (!managedProjectId) {
      setSelectedManagedThreadIds((current) => current.size === 0 ? current : new Set());
      setActiveManagedTableRowId(null);
      setManageProjectError(null);
      lastManagedThreadRowSelectionIdRef.current = null;
      pointerManagedThreadSelectionAnchorIdRef.current = null;
      return;
    }
    const liveThreadIdSet = new Set(managedProjectThreads.map((thread) => thread.id));
    setSelectedManagedThreadIds((existing) => {
      const next = new Set([...existing].filter((threadId) => liveThreadIdSet.has(threadId)));
      const unchanged = next.size === existing.size && [...next].every((threadId) => existing.has(threadId));
      return unchanged ? existing : next;
    });
    setActiveManagedTableRowId((current) => (
      current && liveThreadIdSet.has(current)
        ? current
        : managedProjectThreads[0]?.id ?? null
    ));
    if (lastManagedThreadRowSelectionIdRef.current && !liveThreadIdSet.has(lastManagedThreadRowSelectionIdRef.current)) {
      lastManagedThreadRowSelectionIdRef.current = managedProjectThreads[0]?.id ?? null;
    }
    if (
      pointerManagedThreadSelectionAnchorIdRef.current
      && !liveThreadIdSet.has(pointerManagedThreadSelectionAnchorIdRef.current)
    ) {
      pointerManagedThreadSelectionAnchorIdRef.current = null;
    }
    if (!projects.some((project) => project.id === managedProjectId && project.deletedAt === null)) {
      setManagedProjectId(null);
      setManageProjectError(null);
    }
  }, [managedProjectId, managedProjectThreads, projects]);

  useEffect(() => {
    const handleMouseUp = () => {
      pointerManagedThreadSelectionAnchorIdRef.current = null;
    };
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const hasBlockingModal = projectModalOpen
    || managedProjectId !== null
    || duplicateProjectConfirm !== null
    || projectArchiveConfirmId !== null
    || threadDeleteConfirmId !== null;

  useEffect(() => {
    if (!hasBlockingModal) {
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest(".transcript-prompt__inputShell")) {
      activeElement.blur();
    }
  }, [hasBlockingModal]);

  useEffect(() => {
    if (!managedProjectId) {
      return;
    }
    const checkbox = manageProjectSelectAllRef.current;
    if (!checkbox) {
      return;
    }
    checkbox.indeterminate = managedThreadSelection.partiallySelected;
  }, [managedProjectId, managedThreadSelection]);

  useEffect(() => {
    setPendingPromptSendStartedAtByThreadId((existing) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [threadId, startedAt] of Object.entries(existing)) {
        const thread = consoleData.threads.find((candidate) => candidate.id === threadId) ?? null;
        const keep = shouldRetainPendingPromptSend({
          thread,
          startedAt,
          hasPendingThreadHistory: Object.values(pendingThreadByPaneId).some((candidate) => candidate.threadId === threadId),
          isThreadTurnRunning: thread ? isThreadTurnRunning(thread.id) : false,
        });
        if (keep) {
          next[threadId] = startedAt;
        } else {
          changed = true;
        }
      }
      return changed ? next : existing;
    });
  }, [consoleData.threads, isThreadTurnRunning, pendingThreadByPaneId]);

  const focusPanePrompt = useCallback((paneId: string | null) => {
    if (!paneId || paletteOpen) {
      return;
    }
    requestAnimationFrame(() => {
      paneRefs.current[paneId]?.focusPrompt({ reveal: true });
    });
  }, [paletteOpen]);

  useEffect(() => {
    if (!pendingProjectActivationId) {
      return;
    }
    const projectView = workspace.projectViews.find((candidate) => candidate.project.id === pendingProjectActivationId);
    if (!projectView) {
      return;
    }
    workspace.activateProject(projectView.project.id);
    focusPanePrompt(projectView.layout.tabs.find((tab) => tab.id === projectView.layout.activeTabId)?.activePaneId ?? null);
    setPendingProjectActivationId(null);
  }, [focusPanePrompt, pendingProjectActivationId, workspace]);

  useEffect(() => {
    if (!workspace.activePaneId || paletteOpen) {
      return;
    }
    if (!hasInitiallyFocusedPromptRef.current) {
      hasInitiallyFocusedPromptRef.current = true;
    }
    focusPanePrompt(workspace.activePaneId);
  }, [focusPanePrompt, paletteOpen, workspace.activePaneId]);

  const setComposerDraftForPane = useCallback((paneId: string, value: string) => {
    setComposerDraftByPaneId((existing) => (existing[paneId] === value ? existing : { ...existing, [paneId]: value }));
  }, []);

  const handleAddImageFilesForPane = useCallback((paneId: string, files: ReadonlyArray<File>) => {
    if (files.length === 0) {
      return;
    }

    const existingAttachments = [...(composerAttachmentsRef.current[paneId] ?? [])];
    const accepted: ComposerImageAttachment[] = [];
    let nextCount = existingAttachments.length;
    const dedupKeys = new Set(existingAttachments.map((attachment) => composerImageDedupKey(attachment)));
    let nextError: string | null = null;

    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        nextError = `Unsupported file type for '${file.name}'. Attach image files only.`;
        continue;
      }
      if (file.size === 0 || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        nextError = `'${file.name}' exceeds the ${IMAGE_ATTACHMENT_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        nextError = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const attachment = createComposerImageAttachment(file);
      const dedupKey = composerImageDedupKey(attachment);
      if (dedupKeys.has(dedupKey)) {
        revokeComposerImageAttachmentPreview(attachment);
        continue;
      }

      accepted.push(attachment);
      dedupKeys.add(dedupKey);
      nextCount += 1;
    }

    if (accepted.length > 0) {
      setComposerAttachmentsByPaneId((existing) => ({
        ...existing,
        [paneId]: [...(existing[paneId] ?? []), ...accepted],
      }));
    }
    if (nextError || accepted.length > 0) {
      setSubmitError(nextError);
    }
  }, []);

  const handleRemoveImageForPane = useCallback((paneId: string, attachmentId: string) => {
    setComposerAttachmentsByPaneId((existing) => {
      const current = existing[paneId] ?? [];
      const removed = current.find((attachment) => attachment.id === attachmentId);
      if (removed) {
        revokeComposerImageAttachmentPreview(removed);
      }
      return {
        ...existing,
        [paneId]: current.filter((attachment) => attachment.id !== attachmentId),
      };
    });
  }, []);

  const activeLayout = workspace.activeLayout;
  const activeTab = workspace.activeTab;
  const attachmentPreviewBaseUrl = useMemo(resolveWsHttpOrigin, []);

  const paneViews = useMemo<ReadonlyArray<PaneView>>(() => {
    const activeProject = workspace.activeProject;
    if (!activeProject || !activeLayout || !activeTab) {
      return [];
    }

    return activeTab.paneIds
      .flatMap((paneId) => {
        const pane = activeLayout.panesById[paneId];
        if (!pane) {
          return [];
        }
        const thread = pane.kind === "thread"
          ? consoleData.threads.find((candidate) => candidate.id === pane.threadId) ?? null
          : null;
        const pendingThreadEntry = pendingThreadByPaneId[pane.id] ?? null;
        const pendingThread = pendingThreadEntry?.pendingThread ?? null;
        const pendingUserInput = pane.kind === "thread" ? (getPendingUserInputs(pane.threadId)[0] ?? null) : null;
        const pendingQuestionIndex = pendingUserInput
          ? pendingUserInputQuestionIndexByRequestId[pendingUserInput.requestId] ?? 0
          : 0;
        const pendingQuestion = pendingUserInput?.questions[pendingQuestionIndex] ?? null;
        const pendingQuestionDraftAnswer = pendingQuestion
          ? (
              pendingUserInputAnswersByRequestId[pendingUserInput?.requestId ?? ""]?.[pendingQuestion.id]
                ?? null
            )
          : null;
        const pendingQuestionDraft = composerDraftByPaneId[pane.id] ?? "";
        const pendingQuestionOptionShortcut = pendingQuestion
          ? resolvePendingUserInputShortcut(pendingQuestionDraft, pendingQuestion.options)
          : null;
        const pendingQuestionAnsweredOptionIndex = pendingQuestion && pendingQuestionDraftAnswer
          ? pendingQuestion.options.findIndex((option) => option.label === pendingQuestionDraftAnswer)
          : -1;
        const pendingQuestionOptionIndex = pendingQuestionOptionShortcut?.optionIndex
          ?? (pendingQuestionAnsweredOptionIndex >= 0 ? pendingQuestionAnsweredOptionIndex : null);
        const provider: ProviderKind = thread?.provider
          ?? pendingThread?.provider
          ?? (pane.kind === "draft" ? pane.setup.selectedProvider : "codex");
        const model = thread?.model
          ?? pendingThread?.model
          ?? (pane.kind === "draft" ? pane.setup.selectedModel : DEFAULT_MODEL_BY_PROVIDER[provider]);
        const modelOptions = thread?.modelOptions
          ?? pendingThread?.modelOptions
          ?? (pane.kind === "draft" ? pane.setup.selectedModelOptions : undefined);
        const effectiveNow = thread && (isThreadTurnRunning(thread.id) || pendingPromptSendStartedAtByThreadId[thread.id])
          ? animationNowIso
          : undefined;
        const blocks = thread
          ? threadToTranscriptBlocks(thread, {
              resolveAttachmentPreviewUrl: (attachmentId) =>
                `${attachmentPreviewBaseUrl}/attachments/${encodeURIComponent(attachmentId)}`,
              orchestrationEvents: getThreadEvents(thread.id),
              ...(effectiveNow ? { now: effectiveNow } : {}),
            })
          : [];
        const pendingPromptSendStartedAt = pane.kind === "thread"
          ? pendingPromptSendStartedAtByThreadId[pane.threadId] ?? null
          : null;

        return [{
          project: activeProject,
          tabId: activeTab.id,
          pane,
          isActive: activeTab.activePaneId === pane.id,
          threadId: pane.kind === "thread" ? pane.threadId : null,
          thread,
          pendingThread,
          setup: pane.kind === "draft" ? pane.setup : null,
          blocks: thread && pendingPromptSendStartedAt && effectiveNow && !isThreadTurnRunning(thread.id)
            ? [
                ...blocks,
                {
                  type: "sending-state" as const,
                  startedAt: pendingPromptSendStartedAt,
                  now: effectiveNow,
                },
              ]
            : blocks,
          attachments: composerAttachmentsByPaneId[pane.id] ?? [],
          pendingPromptSendStartedAt,
          pendingUserInput,
          pendingQuestionIndex,
          pendingQuestion,
          pendingQuestionOptionIndex,
          draftAnswers: pendingUserInput ? (pendingUserInputAnswersByRequestId[pendingUserInput.requestId] ?? {}) : {},
          cwd: thread
            ? resolveThreadCwd(thread, projects)
            : (pendingThread?.worktreePath ?? (pane.kind === "draft" ? pane.setup.worktreePath : null) ?? activeProject.workspaceRoot),
          interactionMode: thread?.interactionMode ?? pendingThread?.interactionMode ?? (pane.kind === "draft" ? pane.setup.interactionMode : "default"),
          provider,
          model,
          modelOptions,
        } satisfies PaneView];
      });
  }, [
    activeLayout,
    activeTab,
    attachmentPreviewBaseUrl,
    composerAttachmentsByPaneId,
    composerDraftByPaneId,
    consoleData.threads,
    getPendingUserInputs,
    getThreadEvents,
    isThreadTurnRunning,
    animationNowIso,
    pendingPromptSendStartedAtByThreadId,
    pendingThreadByPaneId,
    pendingUserInputAnswersByRequestId,
    pendingUserInputQuestionIndexByRequestId,
    projects,
    workspace.activeProject,
  ]);

  const activePaneView = useMemo(
    () => paneViews.find((paneView) => paneView.isActive) ?? null,
    [paneViews],
  );
  const palettePaneView = useMemo(
    () => (paletteContextPaneId ? paneViews.find((paneView) => paneView.pane.id === paletteContextPaneId) ?? null : activePaneView),
    [activePaneView, paletteContextPaneId, paneViews],
  );

  const openPalette = useCallback((initialQuery = "") => {
    setPaletteContextPaneId(activePaneView?.pane.id ?? null);
    setPaletteOpen(true);
    setPaletteQuery(initialQuery);
    setSelectedCommandIndex(0);
  }, [activePaneView]);

  const closePalette = useCallback(() => {
    const restorePaneId = paletteContextPaneId ?? workspace.activePaneId;
    setPaletteOpen(false);
    setPaletteQuery("");
    setSelectedCommandIndex(0);
    setPaletteContextPaneId(null);
    focusPanePrompt(restorePaneId);
  }, [focusPanePrompt, paletteContextPaneId, workspace.activePaneId]);

  const highlightPane = useCallback((paneId: string) => {
    setHighlightedPaneId(paneId);
    window.setTimeout(() => {
      setHighlightedPaneId((current) => (current === paneId ? null : current));
    }, 1400);
  }, []);

  const handleCreateDraftTabForProject = useCallback((projectId: OrchestrationProject["id"]) => {
    workspace.activateProject(projectId);
    const created = workspace.createDraftTab({ projectId });
    if (!created) {
      return null;
    }
    setSubmitError(null);
    focusPanePrompt(created.paneId);
    return created;
  }, [focusPanePrompt, workspace]);

  const handleCreateNewThreadInCurrentPane = useCallback((paneView: Pick<
    PaneView,
    "attachments" | "model" | "modelOptions" | "pane" | "project" | "provider"
  >) => {
    for (const attachment of paneView.attachments) {
      revokeComposerImageAttachmentPreview(attachment);
    }
    setComposerAttachmentsByPaneId((existing) => {
      if (!(paneView.pane.id in existing)) {
        return existing;
      }
      const next = { ...existing };
      delete next[paneView.pane.id];
      return next;
    });
    setComposerDraftByPaneId((existing) => {
      if (!(paneView.pane.id in existing)) {
        return existing;
      }
      const next = { ...existing };
      delete next[paneView.pane.id];
      return next;
    });
    setPendingDraftPaneIds((existing) => {
      if (!existing.has(paneView.pane.id)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(paneView.pane.id);
      return next;
    });
    const pendingThreadEntry = pendingThreadByPaneId[paneView.pane.id] ?? null;
    setPendingThreadByPaneId((existing) => {
      if (!(paneView.pane.id in existing)) {
        return existing;
      }
      const next = { ...existing };
      delete next[paneView.pane.id];
      return next;
    });
    if (pendingThreadEntry) {
      setPendingPromptSendStartedAtByThreadId((existing) => {
        if (!(pendingThreadEntry.threadId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[pendingThreadEntry.threadId];
        return next;
      });
    }
    workspace.replacePaneWithFreshDraft(paneView.project.id, paneView.pane.id, {
      selectedProvider: paneView.provider,
      selectedModel: paneView.model,
      selectedModelOptions: paneView.modelOptions,
    });
    setSubmitError(null);
    focusPanePrompt(paneView.pane.id);
  }, [focusPanePrompt, pendingThreadByPaneId, workspace]);

  const handleCreateDraftTab = useCallback(() => {
    const projectId = workspace.activeProject?.id ?? workspace.projectViews[0]?.project.id ?? null;
    if (!projectId) {
      setSubmitError("No project is available.");
      return;
    }
    void handleCreateDraftTabForProject(projectId);
  }, [handleCreateDraftTabForProject, workspace.activeProject, workspace.projectViews]);

  const handleSidebarThreadDragStart = useCallback((event: ReactDragEvent<HTMLButtonElement>, threadId: ThreadId) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(THREAD_DRAG_DATA_TYPE, threadId);
    event.dataTransfer.setData("text/plain", threadId);
    setDragOverPaneId(null);
    setDragOverSplitZone(false);
    setDraggedThreadId(threadId);
  }, []);

  const handleSidebarThreadDragEnd = useCallback(() => {
    setDraggedThreadId(null);
    setDragOverPaneId(null);
    setDragOverSplitZone(false);
  }, []);

  const handleDropThreadIntoSplitZone = useCallback(() => {
    if (!workspace.activeProject || !workspace.activePaneId || !draggedThreadId) {
      return;
    }
    const thread = consoleData.threads.find((candidate) => candidate.id === draggedThreadId) ?? null;
    if (!thread || thread.projectId !== workspace.activeProject.id) {
      return;
    }
    const created = workspace.splitPane({
      projectId: workspace.activeProject.id,
      paneId: workspace.activePaneId,
    });
    if (!created) {
      return;
    }
    const didMount = workspace.mountThreadInPane({
      projectId: workspace.activeProject.id,
      paneId: created.paneId,
      threadId: draggedThreadId as ThreadId,
    });
    if (didMount) {
      focusPanePrompt(created.paneId);
      highlightPane(created.paneId);
    }
  }, [consoleData.threads, draggedThreadId, focusPanePrompt, highlightPane, workspace]);

  const handleOpenThread = useCallback((threadId: ThreadId) => {
    const thread = consoleData.threads.find((candidate) => candidate.id === threadId) ?? null;
    if (!thread) {
      return;
    }
    const projectView = workspace.projectViews.find((candidate) => candidate.project.id === thread.projectId) ?? null;
    const reusableDraftPane = findReusableDraftPaneForThreadOpen({
      layout: projectView?.layout ?? null,
      draftsByPaneId: composerDraftByPaneId,
      attachmentsByPaneId: composerAttachmentsByPaneId,
      pendingDraftPaneIds,
    });
    if (reusableDraftPane) {
      const didMount = workspace.mountThreadInPane({
        projectId: thread.projectId,
        paneId: reusableDraftPane.paneId,
        threadId,
      });
      if (didMount) {
        focusPanePrompt(reusableDraftPane.paneId);
        return;
      }
    }
    const result = workspace.openThread(threadId);
    if (!result) {
      return;
    }
    focusPanePrompt(result.paneId);
    if (result.highlightPane) {
      highlightPane(result.paneId);
    }
  }, [
    composerAttachmentsByPaneId,
    composerDraftByPaneId,
    consoleData.threads,
    focusPanePrompt,
    highlightPane,
    pendingDraftPaneIds,
    workspace,
  ]);

  const handleActivatePaneView = useCallback((paneView: Pick<PaneView, "project" | "tabId" | "pane">) => {
    if (workspace.activePaneId === paneView.pane.id) {
      return;
    }
    workspace.activatePane(paneView.project.id, paneView.tabId, paneView.pane.id);
  }, [workspace]);

  const resetExpandedSidebarProject = useCallback((projectId: OrchestrationProject["id"]) => {
    setExpandedSidebarProjectIds((existing) => {
      if (!existing.has(projectId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(projectId);
      return next;
    });
  }, []);

  const handleToggleSidebarProject = useCallback((
    projectId: OrchestrationProject["id"],
    collapsed: boolean,
  ) => {
    if (!collapsed) {
      resetExpandedSidebarProject(projectId);
    }
    workspace.toggleProjectCollapsed(projectId);
  }, [resetExpandedSidebarProject, workspace]);

  const handleSelectSidebarProject = useCallback((
    projectId: OrchestrationProject["id"],
    collapsed: boolean,
    paneId: string | null,
  ) => {
    workspace.activateProject(projectId);
    if (collapsed) {
      workspace.toggleProjectCollapsed(projectId);
    }
    focusPanePrompt(paneId);
  }, [focusPanePrompt, workspace]);

  const handleOpenProjectContextMenu = useCallback((
    event: ReactMouseEvent<HTMLElement>,
    projectId: OrchestrationProject["id"],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const position = resolveProjectContextMenuPosition(event.clientX, event.clientY);
    setProjectContextMenu({
      projectId,
      x: position.x,
      y: position.y,
    });
    setThreadContextMenu(null);
  }, []);

  const handleCloseProjectContextMenu = useCallback(() => {
    setProjectContextMenu(null);
  }, []);

  const handleOpenThreadContextMenu = useCallback((
    event: ReactMouseEvent<HTMLElement>,
    threadId: OrchestrationThread["id"],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const position = resolveProjectContextMenuPosition(event.clientX, event.clientY);
    setThreadContextMenu({
      threadId,
      x: position.x,
      y: position.y,
    });
    setProjectContextMenu(null);
  }, []);

  const handleCloseThreadContextMenu = useCallback(() => {
    setThreadContextMenu(null);
  }, []);

  const handleOpenManageProjectModal = useCallback((projectId: OrchestrationProject["id"]) => {
    setManagedProjectId(projectId);
    setSelectedManagedThreadIds(new Set());
    setActiveManagedTableRowId(null);
    setManageProjectError(null);
    setProjectContextMenu(null);
    lastManagedThreadRowSelectionIdRef.current = null;
    pointerManagedThreadSelectionAnchorIdRef.current = null;
  }, []);

  const handleRequestProjectArchive = useCallback((projectId: OrchestrationProject["id"]) => {
    setProjectContextMenu(null);
    setProjectArchiveConfirmId(projectId);
  }, []);

  const handleCreateProjectThreadFromContextMenu = useCallback((projectId: OrchestrationProject["id"]) => {
    setProjectContextMenu(null);
    void handleCreateDraftTabForProject(projectId);
  }, [handleCreateDraftTabForProject]);

  const handleCloseProjectArchiveConfirm = useCallback(() => {
    setProjectArchiveConfirmId(null);
  }, []);

  const handleConfirmProjectArchive = useCallback(() => {
    if (!projectArchiveConfirmId) {
      return;
    }
    const nextActiveProjectId = resolveProjectSelectionAfterArchive({
      activeProjectId: workspace.activeProject?.id ?? null,
      archivedProjectId: projectArchiveConfirmId,
      visibleProjectIds: workspace.projectViews
        .map((projectView) => projectView.project.id)
        .filter((projectId) => !archivedProjectIds.has(projectId)),
    });
    setArchivedProjectIds((existing) => new Set(existing).add(projectArchiveConfirmId));
    if (managedProjectId === projectArchiveConfirmId) {
      setManagedProjectId(null);
    }
    if (workspace.activeProject?.id === projectArchiveConfirmId) {
      if (nextActiveProjectId) {
        workspace.activateProject(nextActiveProjectId);
      } else {
        workspace.clearActiveProject();
      }
    }
    setProjectArchiveConfirmId(null);
  }, [archivedProjectIds, managedProjectId, projectArchiveConfirmId, workspace]);

  const handleCloseManageProjectModal = useCallback(() => {
    if (isDeletingManagedThreads) {
      return;
    }
    setManagedProjectId(null);
    setSelectedManagedThreadIds(new Set());
    setActiveManagedTableRowId(null);
    setManageProjectError(null);
    lastManagedThreadRowSelectionIdRef.current = null;
    pointerManagedThreadSelectionAnchorIdRef.current = null;
  }, [isDeletingManagedThreads]);

  const handleSelectManagedThreadRow = useCallback((
    threadId: OrchestrationThread["id"],
    input: {
      readonly shiftKey: boolean;
      readonly toggleKey: boolean;
    },
  ) => {
    const selection = resolveManagedThreadRowSelection({
      orderedThreadIds: managedProjectThreads.map((thread) => thread.id),
      currentSelectedRowIds: selectedManagedThreadIds,
      clickedThreadId: threadId,
      anchorThreadId: lastManagedThreadRowSelectionIdRef.current,
      additive: input.toggleKey,
      range: input.shiftKey,
    });
    setSelectedManagedThreadIds(selection.selectedRowIds);
    setActiveManagedTableRowId(selection.activeRowId);
    lastManagedThreadRowSelectionIdRef.current = selection.nextAnchorThreadId;
    manageProjectTableShellRef.current?.focus({ preventScroll: true });
  }, [managedProjectThreads, selectedManagedThreadIds]);

  const handleToggleAllManagedThreads = useCallback(() => {
    setSelectedManagedThreadIds(() => {
      if (managedThreadSelection.allSelected) {
        return new Set();
      }
      return new Set(managedProjectThreads.map((thread) => thread.id));
    });
  }, [managedProjectThreads, managedThreadSelection.allSelected]);

  const handleManagedTableKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (managedProjectThreads.length === 0) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const currentIndex = activeManagedTableRowId
        ? managedProjectThreads.findIndex((thread) => thread.id === activeManagedTableRowId)
        : -1;
      const fallbackIndex = currentIndex >= 0 ? currentIndex : 0;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(managedProjectThreads.length - 1, fallbackIndex + delta));
      const nextThreadId = managedProjectThreads[nextIndex]?.id;
      if (!nextThreadId) {
        return;
      }
      setActiveManagedTableRowId(nextThreadId);
      setSelectedManagedThreadIds(new Set([nextThreadId]));
      lastManagedThreadRowSelectionIdRef.current = nextThreadId;
      return;
    }

    if (event.key === " ") {
      event.preventDefault();
      setSelectedManagedThreadIds((existing) =>
        toggleManagedThreadChecksForRows(existing, existing, activeManagedTableRowId),
      );
    }
  }, [activeManagedTableRowId, managedProjectThreads]);

  const handleManagedThreadRowMouseDown = useCallback((
    event: ReactMouseEvent<HTMLTableRowElement>,
    threadId: OrchestrationThread["id"],
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const toggleKey = event.ctrlKey || event.metaKey;
    handleSelectManagedThreadRow(threadId, {
      shiftKey: event.shiftKey,
      toggleKey,
    });
    pointerManagedThreadSelectionAnchorIdRef.current = toggleKey || event.shiftKey ? null : threadId;
  }, [handleSelectManagedThreadRow]);

  const handleManagedThreadRowMouseEnter = useCallback((threadId: OrchestrationThread["id"]) => {
    const anchorThreadId = pointerManagedThreadSelectionAnchorIdRef.current;
    if (!anchorThreadId) {
      return;
    }
    const selection = resolveManagedThreadRowSelection({
      orderedThreadIds: managedProjectThreads.map((thread) => thread.id),
      currentSelectedRowIds: selectedManagedThreadIds,
      clickedThreadId: threadId,
      anchorThreadId,
      additive: false,
      range: true,
    });
    setSelectedManagedThreadIds(selection.selectedRowIds);
    setActiveManagedTableRowId(selection.activeRowId);
    lastManagedThreadRowSelectionIdRef.current = selection.nextAnchorThreadId;
  }, [managedProjectThreads, selectedManagedThreadIds]);

  const handleDeleteManagedThreads = useCallback(async () => {
    const selectedThreadIds = managedProjectThreads
      .map((thread) => thread.id)
      .filter((threadId) => selectedManagedThreadIds.has(threadId));
    if (selectedThreadIds.length === 0) {
      return;
    }

    setIsDeletingManagedThreads(true);
    setManageProjectError(null);
    try {
      await Promise.all(selectedThreadIds.map((threadId) => deleteThread(threadId)));
      setSelectedManagedThreadIds(new Set());
    } catch (error) {
      setManageProjectError(error instanceof Error ? error.message : "Failed to delete selected threads.");
    } finally {
      setIsDeletingManagedThreads(false);
    }
  }, [deleteThread, managedProjectThreads, selectedManagedThreadIds]);

  const handleRequestThreadDelete = useCallback((threadId: OrchestrationThread["id"]) => {
    setThreadContextMenu(null);
    setThreadDeleteConfirmId(threadId);
    setThreadDeleteError(null);
  }, []);

  const handleCloseThreadDeleteConfirm = useCallback(() => {
    if (isDeletingThread) {
      return;
    }
    setThreadDeleteConfirmId(null);
    setThreadDeleteError(null);
  }, [isDeletingThread]);

  const handleConfirmThreadDelete = useCallback(async () => {
    if (!threadDeleteConfirmId) {
      return;
    }
    setIsDeletingThread(true);
    setThreadDeleteError(null);
    try {
      await deleteThread(threadDeleteConfirmId);
      setThreadDeleteConfirmId(null);
    } catch (error) {
      setThreadDeleteError(error instanceof Error ? error.message : "Failed to delete thread.");
    } finally {
      setIsDeletingThread(false);
    }
  }, [deleteThread, threadDeleteConfirmId]);

  useEffect(() => {
    if (!managedProjectId) {
      return;
    }
    const focusTarget = () => {
      if (managedProjectThreads.length > 0) {
        manageProjectTableShellRef.current?.focus({ preventScroll: true });
        return;
      }
      manageProjectCloseButtonRef.current?.focus({ preventScroll: true });
    };
    focusTarget();
    requestAnimationFrame(focusTarget);
  }, [managedProjectId, managedProjectThreads.length]);

  useEffect(() => {
    if (!managedProjectId) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      handleCloseManageProjectModal();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [handleCloseManageProjectModal, managedProjectId]);

  useEffect(() => {
    if (!threadDeleteConfirmId) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      handleCloseThreadDeleteConfirm();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [handleCloseThreadDeleteConfirm, threadDeleteConfirmId]);

  useEffect(() => {
    if (!projectArchiveConfirmId) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      handleCloseProjectArchiveConfirm();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [handleCloseProjectArchiveConfirm, projectArchiveConfirmId]);

  const handleOpenProjectModal = useCallback(() => {
    setProjectModalError(null);
    setProjectPathDraft("");
    setDuplicateProjectConfirm(null);
    setProjectModalOpen(true);
  }, []);

  const handleCloseProjectModal = useCallback(() => {
    if (isCreatingProject) {
      return;
    }
    setProjectModalOpen(false);
    setProjectModalError(null);
    setDuplicateProjectConfirm(null);
  }, [isCreatingProject]);

  const handleBrowseProjectFolder = useCallback(async () => {
    const pickedPath = await window.desktopBridge?.pickFolder?.();
    if (!pickedPath) {
      return;
    }
    setProjectPathDraft(pickedPath);
    setProjectModalError(null);
  }, []);

  const handleCloseDuplicateProjectConfirm = useCallback(() => {
    if (isCreatingProject) {
      return;
    }
    setDuplicateProjectConfirm(null);
  }, [isCreatingProject]);

  const createProjectFromWorkspaceRoot = useCallback(async (workspaceRoot: string) => {
    const title = deriveProjectTitleFromPath(workspaceRoot);
    if (title.length === 0) {
      setDuplicateProjectConfirm(null);
      setProjectModalError("Enter a valid project path.");
      return;
    }

    setIsCreatingProject(true);
    try {
      const created = await createProject({ workspaceRoot, title });
      setPendingProjectActivationId(created.projectId);
      setProjectModalOpen(false);
      setProjectModalError(null);
      setDuplicateProjectConfirm(null);
      setProjectPathDraft("");
    } catch (error) {
      setDuplicateProjectConfirm(null);
      setProjectModalError(error instanceof Error ? error.message : "Failed to add project.");
    } finally {
      setIsCreatingProject(false);
    }
  }, [createProject]);

  const handleCreateProject = useCallback(async () => {
    const workspaceRoot = normalizeProjectPathInput(projectPathDraft);
    if (workspaceRoot.length === 0) {
      setProjectModalError("Enter a project path.");
      return;
    }
    const duplicateProject = findDuplicateProjectForWorkspaceRoot({
      projects,
      archivedProjectIds,
      workspaceRoot,
    });
    if (duplicateProject) {
      setProjectModalError(null);
      setDuplicateProjectConfirm(duplicateProject);
      return;
    }
    await createProjectFromWorkspaceRoot(workspaceRoot);
  }, [archivedProjectIds, createProjectFromWorkspaceRoot, projectPathDraft, projects]);

  const handleSelectDuplicateProject = useCallback(() => {
    if (!duplicateProjectConfirm) {
      return;
    }
    if (duplicateProjectConfirm.isArchived) {
      setArchivedProjectIds((existing) => {
        const next = new Set(existing);
        next.delete(duplicateProjectConfirm.projectId);
        return next;
      });
    }
    setPendingProjectActivationId(duplicateProjectConfirm.projectId);
    setDuplicateProjectConfirm(null);
    setProjectModalOpen(false);
    setProjectModalError(null);
    setProjectPathDraft("");
  }, [duplicateProjectConfirm]);

  const handleCreateDuplicateProject = useCallback(async () => {
    if (!duplicateProjectConfirm) {
      return;
    }
    await createProjectFromWorkspaceRoot(normalizeProjectPathInput(projectPathDraft));
  }, [createProjectFromWorkspaceRoot, duplicateProjectConfirm, projectPathDraft]);

  const handleSubmit = useCallback(async (paneView: PaneView, value: string) => {
    const attachmentSnapshot = [...(composerAttachmentsRef.current[paneView.pane.id] ?? [])];

    try {
      if (paneView.pendingUserInput) {
        if (attachmentSnapshot.length > 0) {
          throw new Error("Image attachments are not supported while a user-input request is pending.");
        }
        if (!paneView.pendingQuestion || !paneView.threadId) {
          throw new Error("Pending user input is missing an active question.");
        }

        const answer = resolvePendingUserInputAnswer(value, paneView.pendingQuestion);
        if (!answer) {
          throw new Error("Type an answer or enter an option number for the active user-input question.");
        }

        const nextAnswers = {
          ...paneView.draftAnswers,
          [paneView.pendingQuestion.id]: answer,
        };

        if (paneView.pendingQuestionIndex < paneView.pendingUserInput.questions.length - 1) {
          setPendingUserInputAnswersByRequestId((existing) => ({
            ...existing,
            [paneView.pendingUserInput!.requestId]: nextAnswers,
          }));
          setPendingUserInputQuestionIndexByRequestId((existing) => ({
            ...existing,
            [paneView.pendingUserInput!.requestId]: paneView.pendingQuestionIndex + 1,
          }));
          setSubmitError(null);
          return;
        }

        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [paneView.pendingUserInput!.requestId]: nextAnswers,
        }));
        await respondToUserInput(
          paneView.threadId,
          paneView.pendingUserInput.requestId,
          nextAnswers,
          formatPendingUserInputAnswersAsPrompt(paneView.pendingUserInput.questions, nextAnswers) ?? undefined,
        );
        setSubmitError(null);
        return;
      }

      if (paneView.pane.kind === "draft") {
        const prompt = value.trim();
        if (prompt.length === 0 && attachmentSnapshot.length === 0) {
          return;
        }

        setPendingDraftPaneIds((existing) => new Set(existing).add(paneView.pane.id));
        const created = await createThread({
          projectId: paneView.project.id,
          provider: paneView.pane.setup.selectedProvider,
          model: paneView.pane.setup.selectedModel,
          ...(paneView.pane.setup.selectedModelOptions !== undefined
            ? { modelOptions: paneView.pane.setup.selectedModelOptions }
            : {}),
          title: truncateTitle(prompt || "New thread"),
          interactionMode: paneView.pane.setup.interactionMode,
          branch: paneView.pane.setup.branch,
          worktreePath: paneView.pane.setup.worktreePath,
          createdAt: paneView.pane.setup.createdAt,
        });

        workspace.mountThreadInPane({
          projectId: paneView.project.id,
          paneId: paneView.pane.id,
          threadId: created.threadId,
        });
        setPendingThreadByPaneId((existing) => ({
          ...existing,
          [paneView.pane.id]: {
            threadId: created.threadId,
            pendingThread: created.pendingThread,
          },
        }));
        setPendingPromptSendStartedAtByThreadId((existing) => ({
          ...existing,
          [created.threadId]: new Date().toISOString(),
        }));

        try {
          await submitPrompt({
            threadId: created.threadId,
            pendingThread: created.pendingThread,
            prompt: value,
            attachments: await Promise.all(attachmentSnapshot.map(toUploadImageAttachment)),
          });
        } catch (submitError) {
          setPendingPromptSendStartedAtByThreadId((existing) => {
            const next = { ...existing };
            delete next[created.threadId];
            return next;
          });
          throw submitError;
        }

        for (const attachment of attachmentSnapshot) {
          revokeComposerImageAttachmentPreview(attachment);
        }
        setComposerAttachmentsByPaneId((existing) => ({
          ...existing,
          [paneView.pane.id]: [],
        }));
        setComposerDraftByPaneId((existing) => {
          const next = { ...existing };
          delete next[paneView.pane.id];
          return next;
        });
        setSubmitError(null);
        return;
      }

      if (!paneView.threadId) {
        throw new Error("No orchestration thread is available.");
      }

      const sendingStartedAt = new Date().toISOString();
      setPendingPromptSendStartedAtByThreadId((existing) => ({
        ...existing,
        [paneView.threadId!]: sendingStartedAt,
      }));
      try {
        await submitPrompt({
          threadId: paneView.threadId,
          pendingThread: paneView.pendingThread,
          prompt: value,
          attachments: await Promise.all(attachmentSnapshot.map(toUploadImageAttachment)),
        });
      } catch (submitError) {
        setPendingPromptSendStartedAtByThreadId((existing) => {
          const next = { ...existing };
          delete next[paneView.threadId!];
          return next;
        });
        throw submitError;
      }

      for (const attachment of attachmentSnapshot) {
        revokeComposerImageAttachmentPreview(attachment);
      }
      setComposerAttachmentsByPaneId((existing) => ({
        ...existing,
        [paneView.pane.id]: [],
      }));
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to submit prompt.");
    } finally {
      if (paneView.pane.kind === "draft") {
        setPendingDraftPaneIds((existing) => {
          const next = new Set(existing);
          next.delete(paneView.pane.id);
          return next;
        });
      }
    }
  }, [createThread, respondToUserInput, submitPrompt, workspace]);

  const paletteThreadPickerGroups = useMemo<ReadonlyArray<{
    readonly projectCommand: AppPaletteCommand;
    readonly threadCommands: ReadonlyArray<AppPaletteCommand>;
  }>>(() => {
    if (!palettePaneView) {
      return [];
    }

    return visibleSidebarProjectViews.map((projectView) => {
      const threads = orderedThreadsByProjectId.get(projectView.project.id) ?? [];
      let workingThreadCount = 0;
      let unreadThreadCount = 0;
      const threadCommands = threads.map((thread) => {
        const pendingUserInput = getPendingUserInputs(thread.id)[0] ?? null;
        const status = getThreadStatus(
          thread,
          nowIso,
          isThreadTurnRunning(thread.id),
          pendingUserInput?.createdAt ?? null,
        );
        const isWorking = status.tone === "working";
        const hasUnreadMarker = !isWorking && unreadThreadIds.has(thread.id);
        if (isWorking) {
          workingThreadCount += 1;
        } else if (hasUnreadMarker) {
          unreadThreadCount += 1;
        }
        return {
          id: `thread:${palettePaneView.pane.id}:${thread.id}`,
          label: formatPaletteThreadLabel({
            projectTitle: projectView.project.title,
            threadTitle: thread.title,
            indicatorTone: isWorking ? "working" : hasUnreadMarker ? "unread" : "idle",
            workingLabel: isWorking ? (deriveRunningThreadIntentLabel(thread) ?? "Working") : null,
          }),
          keywords: [
            projectView.project.title,
            thread.title,
            thread.provider,
            thread.model,
            getThreadFirstPrompt(thread),
            isWorking ? "working" : hasUnreadMarker ? "unread" : "idle",
          ],
          run: () => {
            if (thread.projectId === palettePaneView.project.id) {
              const mounted = workspace.mountThreadInPane({
                projectId: thread.projectId,
                paneId: palettePaneView.pane.id,
                threadId: thread.id,
              });
              if (mounted) {
                return;
              }
            }
            workspace.openThread(thread.id);
          },
        } satisfies AppPaletteCommand;
      });
      return {
        projectCommand: {
          id: `thread-project:${palettePaneView.pane.id}:${projectView.project.id}`,
          label: formatPaletteProjectLabel({
            projectTitle: projectView.project.title,
            workingThreadCount,
            unreadThreadCount,
          }),
          trailingLabel: projectView.project.workspaceRoot,
          keywords: [
            projectView.project.title,
            projectView.project.workspaceRoot,
          ],
          run: () => {
            workspace.activateProject(projectView.project.id);
          },
        } satisfies AppPaletteCommand,
        threadCommands,
      };
    });
  }, [
    getPendingUserInputs,
    isThreadTurnRunning,
    nowIso,
    orderedThreadsByProjectId,
    palettePaneView,
    unreadThreadIds,
    visibleSidebarProjectViews,
    workspace,
  ]);
  const paletteProjectCommands = useMemo(
    () => paletteThreadPickerGroups.map((group) => group.projectCommand),
    [paletteThreadPickerGroups],
  );
  const paletteAddProjectCommand = useMemo<AppPaletteCommand>(() => ({
    id: "project:add",
    label: ADD_PROJECT_COMMAND_LABEL,
    keywords: ["add project", "new project", "open project", "create project", "workspace"],
    priority: HIGH_PRIORITY_COMMAND,
    run: () => {
      handleOpenProjectModal();
    },
  }), [handleOpenProjectModal]);

  const paletteThreadPickerMode = useMemo(() => isThreadPickerQuery(paletteQuery), [paletteQuery]);
  const paletteThreadSearchQuery = useMemo(() => stripThreadPickerQueryPrefix(paletteQuery), [paletteQuery]);
  const paletteThreadSearchMode = useMemo(() => hasThreadPickerSearchQuery(paletteQuery), [paletteQuery]);

  const resolveCommandsForPane = useCallback((targetPaneView: PaneView | null): ReadonlyArray<AppPaletteCommand> => {
    const addProjectCommands: ReadonlyArray<AppPaletteCommand> = [paletteAddProjectCommand];
    if (!targetPaneView) {
      return addProjectCommands;
    }

    const targetProjectView =
      workspace.projectViews.find((projectView) => projectView.project.id === targetPaneView.project.id) ?? null;
    const targetTab =
      targetProjectView?.layout.tabs.find((tab) => tab.id === targetPaneView.tabId) ?? null;
    const splitPaneShortcut = findAppCommandShortcutByActionId("pane.split");
    const closePaneShortcut = findAppCommandShortcutByActionId("pane.close");
    const createTabShortcut = findAppCommandShortcutByActionId("tab.create");
    const createTabCommands: ReadonlyArray<AppPaletteCommand> = [{
      id: `tab:create:${targetPaneView.project.id}`,
      actionId: "tab.create",
      label: CREATE_TAB_COMMAND_LABEL,
      keywords: ["new tab", "add new tab", "create tab"],
      priority: HIGH_PRIORITY_COMMAND,
      ...(createTabShortcut ? { shortcutLabel: formatAppCommandShortcutLabel(createTabShortcut) } : {}),
      run: () => {
        void handleCreateDraftTabForProject(targetPaneView.project.id);
      },
    }];
    const splitPaneCommands: ReadonlyArray<AppPaletteCommand> =
      targetTab && targetTab.paneIds.length < MAX_TAB_PANES
        ? [{
            id: `pane:split:${targetPaneView.pane.id}`,
            actionId: "pane.split",
            label: SPLIT_PANE_COMMAND_LABEL,
            keywords: ["split pane", "new pane", "split into new pane"],
            priority: HIGH_PRIORITY_COMMAND,
            ...(splitPaneShortcut ? { shortcutLabel: formatAppCommandShortcutLabel(splitPaneShortcut) } : {}),
            run: () => {
              workspace.splitPane({
                projectId: targetPaneView.project.id,
                paneId: targetPaneView.pane.id,
              });
            },
          }]
        : [];
    const newThreadInCurrentPaneCommands: ReadonlyArray<AppPaletteCommand> = [{
      id: `pane:new-thread:${targetPaneView.pane.id}`,
      label: NEW_THREAD_IN_CURRENT_PANE_COMMAND_LABEL,
      keywords: ["new thread", "current pane", "replace pane", "reset pane"],
      priority: HIGH_PRIORITY_COMMAND,
      run: () => {
        handleCreateNewThreadInCurrentPane(targetPaneView);
      },
    }];
    const closePaneCommands: ReadonlyArray<AppPaletteCommand> = [{
      id: `pane:close:${targetPaneView.pane.id}`,
      actionId: "pane.close",
      label: CLOSE_PANE_COMMAND_LABEL,
      keywords: ["close pane", "close current pane", "remove pane"],
      priority: HIGH_PRIORITY_COMMAND,
      ...(closePaneShortcut ? { shortcutLabel: formatAppCommandShortcutLabel(closePaneShortcut) } : {}),
      run: () => {
        workspace.closePane(targetPaneView.project.id, targetPaneView.pane.id);
      },
    }];

    const providerCommands: ReadonlyArray<{
      readonly provider: ProviderKind;
      readonly label: string;
      readonly keywords: ReadonlyArray<string>;
      readonly priority: number;
    }> = targetPaneView.setup ? [
      {
        provider: "codex",
        label: "Switch thread to provider: Codex",
        keywords: ["switch provider", "provider codex", "codex"],
        priority: HIGH_PRIORITY_COMMAND,
      },
      {
        provider: "copilot",
        label: "Switch thread to provider: Copilot CLI",
        keywords: ["switch provider", "provider copilot cli", "copilot cli", "copilot-cli", "copilot"],
        priority: HIGH_PRIORITY_COMMAND,
      },
    ] : [];

    const modelProviders: ReadonlyArray<ProviderKind> = targetPaneView.setup
      ? ["codex", "copilot"]
      : targetPaneView.thread
        ? [targetPaneView.thread.provider]
        : [];
    const modelCommands = modelProviders.flatMap((provider) =>
      MANUAL_MODEL_COMMANDS_BY_PROVIDER[provider].flatMap(({ slug, label, reasoningEfforts }) => {
        const supportedReasoningEfforts = getSupportedCuratedReasoningEfforts({
          provider,
          model: slug,
          reasoningEfforts,
          copilotModelById,
        });
        const commandVariants = supportedReasoningEfforts.length > 0
          ? supportedReasoningEfforts.map((reasoningEffort) => ({
              idSuffix: reasoningEffort,
              modelOptions: buildProviderReasoningEffortModelOptions(provider, reasoningEffort),
              keywords: [reasoningEffort, `${reasoningEffort} reasoning`, "reasoning"],
            }))
          : [{
              idSuffix: "default",
              modelOptions: undefined,
              keywords: [] as string[],
            }];

        return commandVariants.map(({ idSuffix, modelOptions, keywords }) => ({
          id: `model:${targetPaneView.pane.id}:${provider}:${slug}:${idSuffix}`,
          label: formatProviderModelSelectionLabel({
            provider,
            model: slug,
            modelOptions,
            baseLabel: label,
            copilotModelById,
          }),
          keywords: [provider === "copilot" ? "copilot cli" : provider, slug, ...keywords],
          run: async () => {
            if (targetPaneView.setup) {
              workspace.updateDraftPane({
                paneId: targetPaneView.pane.id,
                updater: (setup) => ({
                  ...setup,
                  selectedProvider: provider,
                  selectedModel: slug,
                  selectedModelOptions: modelOptions,
                }),
              });
              workspace.rememberProviderModel(provider, slug, modelOptions);
              return;
            }

            if (!targetPaneView.thread) {
              return;
            }

            await setThreadModel(targetPaneView.thread.id, provider, slug, modelOptions);
            workspace.rememberProviderModel(provider, slug, modelOptions);
          },
        } satisfies AppPaletteCommand));
      }),
    );

    return [
      ...addProjectCommands,
      ...createTabCommands,
      ...newThreadInCurrentPaneCommands,
      ...closePaneCommands,
      ...splitPaneCommands,
      ...providerCommands.map(({ provider, label, keywords, priority }) => ({
        id: `draft-provider:${targetPaneView.pane.id}:${provider}`,
        label,
        keywords,
        priority,
        run: () => {
          const selectedModelOptions = getDefaultManualModelOptions({
            provider,
            model: PALETTE_PROVIDER_SWITCH_DEFAULT_MODEL,
            reasoningEfforts: MANUAL_MODEL_COMMANDS_BY_PROVIDER[provider]
              .find((entry) => entry.slug === PALETTE_PROVIDER_SWITCH_DEFAULT_MODEL)
              ?.reasoningEfforts,
            copilotModelById,
          });
          workspace.updateDraftPane({
            paneId: targetPaneView.pane.id,
            updater: (setup) => ({
              ...setup,
              selectedProvider: provider,
              selectedModel: PALETTE_PROVIDER_SWITCH_DEFAULT_MODEL,
              selectedModelOptions,
            }),
          });
          workspace.rememberProviderModel(provider, PALETTE_PROVIDER_SWITCH_DEFAULT_MODEL, selectedModelOptions);
        },
      })),
      ...modelCommands,
    ];
  }, [
    copilotModelById,
    handleCreateDraftTabForProject,
    handleCreateNewThreadInCurrentPane,
    paletteAddProjectCommand,
    setThreadModel,
    workspace,
  ]);

  const paletteCommands = useMemo(
    () => resolveCommandsForPane(palettePaneView),
    [palettePaneView, resolveCommandsForPane],
  );
  const activeProjectForShortcuts = workspace.activeProject;
  const activePaneId = workspace.activePaneId;
  const activateProjectTab = workspace.activateTab;

  const filteredCommands = useMemo(
    () =>
      paletteThreadPickerMode
        ? paletteThreadSearchMode
          ? flattenPaletteThreadPickerGroups(
              paletteThreadPickerGroups.map((group) => ({
                projectCommand: group.projectCommand,
                threadCommands: filterCommandPaletteCommands(group.threadCommands, paletteThreadSearchQuery),
              })),
            )
          : [...paletteProjectCommands, paletteAddProjectCommand]
        : filterCommandPaletteCommands(paletteCommands, paletteQuery),
    [
      paletteAddProjectCommand,
      paletteCommands,
      paletteProjectCommands,
      paletteQuery,
      paletteThreadPickerGroups,
      paletteThreadPickerMode,
      paletteThreadSearchMode,
      paletteThreadSearchQuery,
    ],
  );

  useEffect(() => {
    setSelectedCommandIndex((current) => Math.min(current, Math.max(filteredCommands.length - 1, 0)));
  }, [filteredCommands.length]);

  const runPaletteCommand = useCallback(async (command: AppPaletteCommand) => {
    closePalette();
    await command.run();
  }, [closePalette]);

  useEffect(() => {
    const handleTabFocusKeyDown = (event: KeyboardEvent) => {
      if (!shouldSuppressTabFocusNavigation(event)) {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener("keydown", handleTabFocusKeyDown, true);
    return () => window.removeEventListener("keydown", handleTabFocusKeyDown, true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isPaletteToggleShortcut(event)) {
        event.preventDefault();
        const nextPaletteState = resolvePaletteShortcutTransition({
          shortcut: "toggle",
          paletteOpen,
          paletteQuery,
        });
        if (nextPaletteState.open) {
          openPalette(nextPaletteState.query);
        } else {
          closePalette();
        }
        return;
      }

      if (isPaletteThreadShortcut(event)) {
        event.preventDefault();
        const nextPaletteState = resolvePaletteShortcutTransition({
          shortcut: "thread",
          paletteOpen,
          paletteQuery,
        });
        openPalette(nextPaletteState.query);
        return;
      }

      if (paletteOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePalette();
        }
        return;
      }

      const activePaneHandle = activePaneId ? paneRefs.current[activePaneId] : null;
      if (hasBlockingModal) {
        return;
      }

      if (shouldActivateNextTabShortcut(event)) {
        const nextTabId = getNextProjectTabId(activeLayout);
        if (!nextTabId || !activeProjectForShortcuts) {
          return;
        }
        event.preventDefault();
        activateProjectTab(activeProjectForShortcuts.id, nextTabId);
        return;
      }

      const matchedCommandShortcut = findMatchingAppCommandShortcut(event);
      if (matchedCommandShortcut) {
        if (isEditableTarget(event.target) && !activePaneHandle?.hasFocusWithinPane()) {
          return;
        }
        const directCommand = resolveCommandsForPane(activePaneView)
          .find((command) => command.actionId === matchedCommandShortcut.actionId);
        if (!directCommand) {
          return;
        }
        event.preventDefault();
        void directCommand.run();
        return;
      }

      if (activePaneId && shouldOpenPaneSearchShortcut(event)) {
        if (isEditableTarget(event.target) && !activePaneHandle?.hasFocusWithinPane()) {
          return;
        }
        event.preventDefault();
        activePaneHandle?.openSearch();
        return;
      }

      if (!activePaneId || isEditableTarget(event.target)) {
        return;
      }

      const hasSelectionInDocument =
        typeof window !== "undefined"
        && typeof document !== "undefined"
        && hasNonCollapsedSelectionInsideElement(window.getSelection(), document.body);
      const hasSelectionInActiveHistory = paneRefs.current[activePaneId]?.hasHistorySelection() ?? false;
      if (shouldBlockGlobalPromptTypingForSelection({ hasSelectionInDocument, hasSelectionInActiveHistory })) {
        return;
      }

      if (shouldScopeGlobalSelectAllToHistory({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        historyActive: activePaneHandle?.isHistoryActive() ?? false,
      })) {
        event.preventDefault();
        activePaneHandle?.selectAllHistory();
        return;
      }

      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
        event.preventDefault();
        activePaneHandle?.insertPromptText(event.key);
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        activePaneHandle?.deletePromptBackward();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activateProjectTab,
    activePaneView,
    activeLayout,
    activePaneId,
    activeProjectForShortcuts,
      closePalette,
      hasBlockingModal,
      openPalette,
      paletteOpen,
      paletteQuery,
      resolveCommandsForPane,
    ]);

  const getPaneFooterText = useCallback((paneView: PaneView) => {
    if (paneView.isActive && submitError) {
      return submitError;
    }

    if (paneView.setup) {
      return `Draft · ${paneView.setup.selectedProvider} · ${formatProviderModelSelectionLabel({
        provider: paneView.setup.selectedProvider,
        model: paneView.setup.selectedModel,
        modelOptions: paneView.setup.selectedModelOptions,
        copilotModelById,
      })} · ${paneView.cwd ?? paneView.project.workspaceRoot}`;
    }

    if (paneView.thread) {
      return `${paneView.thread.title} · ${paneView.thread.provider} · ${formatProviderModelSelectionLabel({
        provider: paneView.thread.provider,
        model: paneView.model,
        modelOptions: paneView.modelOptions,
        copilotModelById,
      })} · ${paneView.cwd ?? paneView.project.workspaceRoot}`;
    }

    return `${paneView.project.title} · ${paneView.project.workspaceRoot}`;
  }, [copilotModelById, submitError]);

  const renderPaneFooter = useCallback((paneView: PaneView) => {
    if (paneView.isActive && submitError) {
      return <span className="status-line__segment status-line__segment--detail">{submitError}</span>;
    }

    if (paneView.setup) {
      const modelLabel = formatProviderModelSelectionLabel({
        provider: paneView.setup.selectedProvider,
        model: paneView.setup.selectedModel,
        modelOptions: paneView.setup.selectedModelOptions,
        copilotModelById,
      });
      return (
        <>
          <span className="status-line__segment">Draft</span>
          <span className="status-line__separator">·</span>
          <span className="status-line__segment">{paneView.setup.selectedProvider}</span>
          <span className="status-line__separator">·</span>
          <span className="status-line__segment">{modelLabel}</span>
          <span className="status-line__separator">·</span>
          <span className="status-line__segment status-line__segment--detail">
            {paneView.cwd ?? paneView.project.workspaceRoot}
          </span>
        </>
      );
    }

    if (paneView.thread) {
      const modelLabel = formatProviderModelSelectionLabel({
        provider: paneView.thread.provider,
        model: paneView.model,
        modelOptions: paneView.modelOptions,
        copilotModelById,
      });
      return (
        <>
          <span
            className="status-line__segment status-line__segment--title"
            title={paneView.thread.title}
          >
            {paneView.thread.title}
          </span>
          <span className="status-line__separator">·</span>
          <span className="status-line__segment">{paneView.thread.provider}</span>
          <span className="status-line__separator">·</span>
          <span className="status-line__segment">{modelLabel}</span>
          <span className="status-line__separator">·</span>
          <span
            className="status-line__segment status-line__segment--detail"
            title={paneView.cwd ?? paneView.project.workspaceRoot}
          >
            {paneView.cwd ?? paneView.project.workspaceRoot}
          </span>
        </>
      );
    }

    return <span className="status-line__segment status-line__segment--detail">{paneView.project.title} · {paneView.project.workspaceRoot}</span>;
  }, [copilotModelById, submitError]);

  const shellClassName = `console-shell${isDesktop ? " console-shell--desktop" : ""}`;
  const desktopWindowControlsInsetPx = useMemo(
    () => resolveDesktopWindowControlsInsetPx(isDesktop, readClientPlatform()),
    [isDesktop],
  );
  const topbarStyle = useMemo(
    () => ({
      "--project-topbar-window-controls-inset": `${desktopWindowControlsInsetPx}px`,
    }) as CSSProperties,
    [desktopWindowControlsInsetPx],
  );
  const splitZoneDropAllowed = canDropDraggedThreadIntoSplitZone({
    draggedThreadId,
    targetProjectId: workspace.activeProject?.id ?? null,
    activeTabPaneCount: activeTab?.paneIds.length ?? null,
    threads: consoleData.threads,
  });
  const splitZoneLimitReached = isDraggedThreadSplitZoneLimitReached({
    draggedThreadId,
    targetProjectId: workspace.activeProject?.id ?? null,
    activeTabPaneCount: activeTab?.paneIds.length ?? null,
    threads: consoleData.threads,
  });
  const splitZoneClassName = getThreadSplitDropZoneClassName({
    isDragActive: draggedThreadId !== null,
    isDropEligible: splitZoneDropAllowed,
    isDragOver: dragOverSplitZone && splitZoneDropAllowed,
    isLimitReached: splitZoneLimitReached,
  });
  const showSplitZone = shouldShowThreadSplitDropZone(draggedThreadId);
  const activePaneGridClassName = activeTab
    ? `project-pane-grid project-pane-grid--${Math.min(Math.max(activeTab.paneIds.length, 1), MAX_TAB_PANES)}`
    : "project-pane-grid project-pane-grid--1";
  const projectContextMenuProject = projectContextMenu
    ? projects.find((project) => project.id === projectContextMenu.projectId) ?? null
    : null;
  const threadContextMenuThread = threadContextMenu
    ? consoleData.threads.find((thread) => thread.id === threadContextMenu.threadId && thread.deletedAt === null) ?? null
    : null;
  const projectArchiveConfirmProject = projectArchiveConfirmId
    ? projects.find((project) => project.id === projectArchiveConfirmId && project.deletedAt === null) ?? null
    : null;
  const threadDeleteConfirmThread = threadDeleteConfirmId
    ? consoleData.threads.find((thread) => thread.id === threadDeleteConfirmId && thread.deletedAt === null) ?? null
    : null;
  const showTopbarTabStrip = !!(workspace.activeProject && activeLayout && activeLayout.tabs.length > 1);
  const topbar = (
    <div className="project-topbar" style={topbarStyle}>
      <div className="project-topbar__sidebarSpacer" />
      {workspace.activeProject && activeLayout ? (
        <div className="project-tabs">
          {showTopbarTabStrip ? (
            <div className="project-tabs__list" role="tablist" aria-label="Project tabs">
              {activeLayout.tabs.map((tab, index) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeLayout.activeTabId}
                  className={`project-tab${tab.id === activeLayout.activeTabId ? " project-tab--active" : ""}`}
                  onClick={() => {
                    workspace.activateTab(workspace.activeProject!.id, tab.id);
                    focusPanePrompt(tab.activePaneId);
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 1) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    workspace.closeTab(workspace.activeProject!.id, tab.id);
                  }}
                >
                  <span className="project-tab__title">Tab {index + 1}</span>
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="project-tab project-tab--create" onClick={handleCreateDraftTab} aria-label="New tab">
            +
          </button>
        </div>
      ) : (
        <div className="project-tabs project-tabs--empty" />
      )}
      <div className="project-topbar__windowControlsSpacer" aria-hidden="true" />
    </div>
  );

  if (!consoleData.snapshot && !consoleData.error) {
    return (
      <>
        <div className="bg-image" aria-hidden="true" />
        <div className="bg-gradient" aria-hidden="true" />
        <div className={shellClassName}>
          {topbar}
          <div className="loading-screen loading-screen--shell">
            <AnimatedLoadingText text="connecting to orchestration" className="loading-screen__text" />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bg-image" aria-hidden="true" />
      <div className="bg-gradient" aria-hidden="true" />
      <div className={shellClassName}>
        {topbar}
        <div className="project-workspace">
          <aside className="project-sidebar">
            <div className="project-sidebar__topAction">
              <span className="project-sidebar__topActionLabel">Projects</span>
              <button
                type="button"
                className="project-sidebar__addProject"
                onClick={handleOpenProjectModal}
                aria-label="Add project"
                title="Add project"
              >
                <span className="project-sidebar__addProjectGlyph" aria-hidden="true">+</span>
              </button>
            </div>
            <div className="project-tree" role="tree" aria-label="Projects">
              <DndContext
                sensors={projectDnDSensors}
                collisionDetection={projectCollisionDetection}
                modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                onDragEnd={handleSidebarProjectDragEnd}
              >
                <SortableContext
                  items={visibleSidebarProjectViews.map((projectView) => projectView.project.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {visibleSidebarProjectViews.map((projectView) => {
                const threads = orderedThreadsByProjectId.get(projectView.project.id) ?? [];
                const isActiveProject = projectView.project.id === workspace.activeProject?.id;
                const expandedSidebarThreads = expandedSidebarProjectIds.has(projectView.project.id);
                const threadEntries: SidebarThreadEntry[] = threads.map((thread) => {
                  const pendingUserInput = getPendingUserInputs(thread.id)[0] ?? null;
                  const status = getThreadStatus(
                    thread,
                    nowIso,
                    isThreadTurnRunning(thread.id),
                    pendingUserInput?.createdAt ?? null,
                  );
                  const ageMs = getThreadAgeMs(thread, nowIso);
                    return {
                      thread,
                      status,
                      tooltip: getThreadFirstPrompt(thread),
                      sidebarLabel: status.tone === "working" || status.tone === "error"
                        ? (status.animatedLabel ?? status.label)
                        : null,
                      ageMs,
                    };
                  });
                const visibleThreadEntries = expandedSidebarThreads
                  ? threadEntries
                  : threadEntries
                      .filter((entry) => !(entry.status.tone === "idle" && entry.ageMs > SIDEBAR_IDLE_HIDE_MS))
                      .slice(0, SIDEBAR_THREAD_LIMIT);
                const visibleThreadGroups = getSidebarThreadGroups({
                  layout: projectView.layout,
                  threadEntries: visibleThreadEntries,
                });
                  const hiddenThreadCount = threadEntries.length - visibleThreadEntries.length;

                return (
                  <SortableSidebarProjectSection
                    key={projectView.project.id}
                    projectId={projectView.project.id}
                    isActive={isActiveProject}
                  >
                    {({ attributes, listeners, setActivatorNodeRef }) => (
                      <>
                    <div
                      className="project-tree__header"
                      onContextMenu={(event) => handleOpenProjectContextMenu(event, projectView.project.id)}
                    >
                      <button
                        type="button"
                        className={`project-tree__toggle${projectView.collapsed ? "" : " project-tree__toggle--expanded"}`}
                        onClick={() => handleToggleSidebarProject(projectView.project.id, projectView.collapsed)}
                        aria-label={projectView.collapsed ? "Expand project" : "Collapse project"}
                      >
                        <SidebarChevronIcon className="project-tree__toggleGlyph" />
                      </button>
                      <button
                        type="button"
                        className="project-tree__projectButton"
                        onClick={() => {
                          handleSelectSidebarProject(
                            projectView.project.id,
                            projectView.collapsed,
                            projectView.layout.tabs.find((tab) => tab.id === projectView.layout.activeTabId)?.activePaneId ?? null,
                          );
                        }}
                      >
                        <SidebarFolderIcon className="project-tree__projectIcon" />
                        <span className="project-tree__projectTitle">{projectView.project.title}</span>
                      </button>
                      <div className="project-tree__actions">
                        <button
                          type="button"
                          ref={setActivatorNodeRef}
                          className="project-tree__action project-tree__action--drag"
                          aria-label={`Rearrange ${projectView.project.title}`}
                          title="Rearrange project"
                          {...attributes}
                          {...listeners}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                        >
                          <SidebarRearrangeIcon className="project-tree__actionIcon" />
                        </button>
                        <button
                          type="button"
                          className="project-tree__action"
                          aria-label={`Create new thread in ${projectView.project.title}`}
                          title="New thread"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleCreateDraftTabForProject(projectView.project.id);
                          }}
                        >
                          <SidebarNewThreadIcon className="project-tree__actionIcon" />
                        </button>
                      </div>
                    </div>
                    {!projectView.collapsed ? (
                      <div className="project-tree__threads">
                        {threads.length === 0 ? (
                          <div className="project-tree__empty">No threads yet.</div>
                        ) : visibleThreadGroups.map((group) => (
                          <div key={group.key} className="project-thread-group">
                            {group.label ? (
                              <div className="project-thread-group__label" aria-hidden="true">
                                <span>{group.label}</span>
                              </div>
                            ) : null}
                            {group.entries.map(({ thread, status, tooltip, sidebarLabel, ageMs }) => {
                              const isActiveThread = thread.id === workspace.activeThreadId;
                              const hasUnreadMarker = unreadThreadIds.has(thread.id);
                              const threadClassName = getSidebarThreadClassName({
                                ageMs,
                                hasUnreadMarker,
                                isActive: isActiveThread,
                              });
                              const titleClassName = getSidebarThreadTitleClassName({
                                statusTone: status.tone,
                                isActive: isActiveThread,
                              });
                              const statusClassName = getSidebarThreadStatusClassName({
                                statusTone: status.tone,
                                isActive: isActiveThread,
                              });
                              return (
                                <button
                                  key={thread.id}
                                  type="button"
                                  className={threadClassName}
                                  title={tooltip}
                                  draggable
                                  onContextMenu={(event) => handleOpenThreadContextMenu(event, thread.id)}
                                  onDragStart={(event) => handleSidebarThreadDragStart(event, thread.id)}
                                  onDragEnd={handleSidebarThreadDragEnd}
                                  onClick={() => handleOpenThread(thread.id)}
                                >
                                  <span className="project-thread__body">
                                    <span className="project-thread__leading">
                                      {hasUnreadMarker ? (
                                        <span className="project-thread__unreadDot" aria-hidden="true" />
                                      ) : null}
                                      {status.tone === "working" ? (
                                        <span className="project-thread__workingSpinner" aria-hidden="true" />
                                      ) : null}
                                      {status.tone === "working" && sidebarLabel ? (
                                        <span className={statusClassName}>
                                          <AnimatedLoadingText text={sidebarLabel} className="project-thread__statusAnimatedLabel" />
                                        </span>
                                      ) : sidebarLabel ? (
                                        <span className={statusClassName}>
                                          {sidebarLabel}
                                        </span>
                                      ) : null}
                                    </span>
                                    {status.tone === "working" ? (
                                      <AnimatedLoadingText text={thread.title} className={titleClassName} />
                                    ) : (
                                      <span className={titleClassName}>{thread.title}</span>
                                    )}
                                  </span>
                                  {status.timingLabel ? (
                                    <span className="project-thread__meta">
                                      <span className="project-thread__statusTiming">{status.timingLabel}</span>
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        ))
                        }
                        {!expandedSidebarThreads && hiddenThreadCount > 0 ? (
                          <button
                            type="button"
                            className="project-tree__showMore"
                            onClick={() => {
                              setExpandedSidebarProjectIds((existing) => new Set(existing).add(projectView.project.id));
                            }}
                          >
                            Show more...
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                      </>
                    )}
                  </SortableSidebarProjectSection>
                );
                  })}
                </SortableContext>
              </DndContext>
            </div>
          </aside>
          <main className="project-main">
            {workspace.activeProject && activeLayout && activeTab ? (
              <div className="project-main__content">
                <div className={activePaneGridClassName}>
                  {paneViews.map((paneView) => {
                    const dropAllowed = canDropDraggedThreadIntoProject({
                      draggedThreadId,
                      targetProjectId: paneView.project.id,
                      threads: consoleData.threads,
                    });

                    return (
                      <section
                        key={paneView.pane.id}
                        ref={(element) => {
                          if (!element) {
                            delete paneElementRefs.current[paneView.pane.id];
                            return;
                          }
                          paneElementRefs.current[paneView.pane.id] = element;
                        }}
                        className={getConversationPaneClassName({
                          isActive: paneView.isActive,
                          isDropEligible: dropAllowed,
                          isDragOver: dragOverPaneId === paneView.pane.id,
                          isHighlighted: highlightedPaneId === paneView.pane.id,
                        })}
                        onMouseDownCapture={(event) => {
                          if (event.button !== 0) {
                            return;
                          }
                          handleActivatePaneView(paneView);
                        }}
                        onFocusCapture={() => {
                          handleActivatePaneView(paneView);
                        }}
                        onClick={() => handleActivatePaneView(paneView)}
                        onDragOver={(event: ReactDragEvent<HTMLElement>) => {
                          if (!dropAllowed) {
                            return;
                          }
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setDragOverSplitZone(false);
                          setDragOverPaneId(paneView.pane.id);
                        }}
                        onDragLeave={(event: ReactDragEvent<HTMLElement>) => {
                          const nextTarget = event.relatedTarget;
                          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                            return;
                          }
                          setDragOverPaneId((current) => (current === paneView.pane.id ? null : current));
                        }}
                        onDrop={(event: ReactDragEvent<HTMLElement>) => {
                          event.preventDefault();
                          setDragOverPaneId(null);
                          setDragOverSplitZone(false);
                          if (!draggedThreadId) {
                            return;
                          }
                          const thread = consoleData.threads.find((candidate) => candidate.id === draggedThreadId) ?? null;
                          if (!thread || thread.projectId !== paneView.project.id) {
                            return;
                          }
                          const didMount = workspace.mountThreadInPane({
                            projectId: paneView.project.id,
                            paneId: paneView.pane.id,
                            threadId: draggedThreadId as ThreadId,
                          });
                          if (didMount) {
                            focusPanePrompt(paneView.pane.id);
                            highlightPane(paneView.pane.id);
                          }
                          setDraggedThreadId(null);
                        }}
                      >
                          {dropAllowed ? (
                            <div className="conversation-pane__dropOverlay" aria-hidden="true" />
                          ) : null}
                          <div className="transcript-shell">
                          <TranscriptRenderer
                            ref={(handle) => {
                              if (!handle) {
                                delete paneRefs.current[paneView.pane.id];
                                return;
                              }
                              paneRefs.current[paneView.pane.id] = handle;
                              if (!initializedPaneIdsRef.current[paneView.pane.id]) {
                                initializedPaneIdsRef.current[paneView.pane.id] = true;
                                const persistedDraft = composerDraftByPaneId[paneView.pane.id];
                                if (persistedDraft) {
                                  handle.insertPromptText(persistedDraft);
                                }
                              }
                            }}
                            blocks={paneView.blocks}
                            composerAttachments={paneView.attachments}
                            cwd={paneView.cwd}
                            projectRoot={paneView.project.workspaceRoot}
                            paneActive={paneView.isActive}
                            interactionMode={paneView.interactionMode}
                            promptFocusDisabled={paletteOpen || hasBlockingModal}
                            promptInputDisabled={hasBlockingModal}
                            {...(paneView.pendingUserInput && paneView.pendingQuestion
                                ? {
                                    pendingUserInputHighlight: {
                                      requestId: paneView.pendingUserInput.requestId,
                                      questionIndex: paneView.pendingQuestionIndex,
                                      ...(paneView.pendingQuestionOptionIndex !== null
                                        ? { optionIndex: paneView.pendingQuestionOptionIndex }
                                        : {}),
                                    },
                                  }
                                : {})}
                            onAddImageFiles={(files) => handleAddImageFilesForPane(paneView.pane.id, files)}
                            onDraftChange={(value) => setComposerDraftForPane(paneView.pane.id, value)}
                            onRemoveImage={(attachmentId) => handleRemoveImageForPane(paneView.pane.id, attachmentId)}
                            initialScrollOffsetFromBottom={paneScrollStateByPaneId[paneView.pane.id]?.offsetFromBottom ?? null}
                            onScrollOffsetFromBottomChange={(offsetFromBottom) =>
                              setPaneScrollStateByPaneId((existing) => {
                                const current = existing[paneView.pane.id];
                                if (current?.offsetFromBottom === offsetFromBottom) {
                                  return existing;
                                }
                                return {
                                  ...existing,
                                  [paneView.pane.id]: { offsetFromBottom },
                                };
                              })}
                            resolveInlineDiff={(lookup) =>
                              getTurnDiff({
                                threadId: lookup.threadId as ThreadId,
                                fromTurnCount: lookup.fromTurnCount,
                                toTurnCount: lookup.toTurnCount,
                              })}
                            onSubmit={(value) => handleSubmit(paneView, value)}
                            submitDisabled={
                              pendingDraftPaneIds.has(paneView.pane.id)
                              || paneView.pendingPromptSendStartedAt !== null
                              || (paneView.threadId
                                ? !canSubmitPromptForThread(paneView.threadId, paneView.pendingThread)
                                : false)
                            }
                          />
                          </div>
                          <footer className="status-line" title={getPaneFooterText(paneView)}>
                            {renderPaneFooter(paneView)}
                          </footer>
                      </section>
                    );
                  })}
                </div>
                <aside
                  className={splitZoneClassName}
                  aria-label="Drop thread here to add a split pane"
                  aria-hidden={!showSplitZone}
                  onDragOver={(event: ReactDragEvent<HTMLElement>) => {
                    setDragOverPaneId(null);
                    setDragOverSplitZone(true);
                    if (!splitZoneDropAllowed) {
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDragLeave={(event: ReactDragEvent<HTMLElement>) => {
                    const nextTarget = event.relatedTarget;
                    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                      return;
                    }
                    setDragOverSplitZone(false);
                  }}
                  onDrop={(event: ReactDragEvent<HTMLElement>) => {
                    event.preventDefault();
                    setDragOverSplitZone(false);
                    setDragOverPaneId(null);
                    if (!splitZoneDropAllowed) {
                      return;
                    }
                    handleDropThreadIntoSplitZone();
                    setDraggedThreadId(null);
                  }}
                >
                  <div className="project-split-dropzone__rail">
                    <span className="project-split-dropzone__glyph" aria-hidden="true">+</span>
                  </div>
                </aside>
              </div>
            ) : projects.length === 0 ? (
              <EmptyWorkspaceSurface title="No project loaded." detail="Create or sync a project first." />
            ) : (
              <EmptyWorkspaceSurface
                title="No tab is active."
                detail="Open a draft tab to start a new thread."
                actionLabel="Open draft tab"
                onAction={handleCreateDraftTab}
              />
            )}
          </main>
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        query={paletteQuery}
        commands={filteredCommands}
        selectedIndex={selectedCommandIndex}
        onClose={closePalette}
        onQueryChange={setPaletteQuery}
        onSelectedIndexChange={setSelectedCommandIndex}
        onRun={(command) => void runPaletteCommand(command as AppPaletteCommand)}
      />
      {projectContextMenu && projectContextMenuProject ? (
        <div
          className="project-context-menu-layer"
          role="presentation"
          onMouseDown={handleCloseProjectContextMenu}
          onContextMenu={(event) => {
            event.preventDefault();
            handleCloseProjectContextMenu();
          }}
        >
          <section
            className="project-context-menu"
            role="menu"
            style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="project-context-menu__info">
              <div className="project-context-menu__title">{projectContextMenuProject.title}</div>
              <div className="project-context-menu__path" title={projectContextMenuProject.workspaceRoot}>
                {projectContextMenuProject.workspaceRoot}
              </div>
            </div>
            <div className="project-context-menu__actions">
              <button
                type="button"
                className="project-context-menu__action"
                onClick={() => handleCreateProjectThreadFromContextMenu(projectContextMenuProject.id)}
              >
                New thread
              </button>
              <button
                type="button"
                className="project-context-menu__action"
                onClick={() => handleOpenManageProjectModal(projectContextMenuProject.id)}
              >
                Manage threads
              </button>
              <button
                type="button"
                className="project-context-menu__action"
                onClick={() => handleRequestProjectArchive(projectContextMenuProject.id)}
              >
                Archive project
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {threadContextMenu && threadContextMenuThread ? (
        <div
          className="project-context-menu-layer"
          role="presentation"
          onMouseDown={handleCloseThreadContextMenu}
          onContextMenu={(event) => {
            event.preventDefault();
            handleCloseThreadContextMenu();
          }}
        >
          <section
            className="project-context-menu"
            role="menu"
            style={{ left: threadContextMenu.x, top: threadContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="project-context-menu__actions">
              <button
                type="button"
                className="project-context-menu__action"
                disabled
                title="Thread archive is not wired through orchestration yet."
              >
                Archive thread
              </button>
              <button
                type="button"
                className="project-context-menu__action project-context-menu__action--danger"
                onClick={() => handleRequestThreadDelete(threadContextMenuThread.id)}
              >
                Delete thread
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {managedProject ? (
        <div
          className="project-modal-overlay project-modal-overlay--strong"
          role="presentation"
          onMouseDown={handleCloseManageProjectModal}
        >
          <section
            className="project-modal project-manage-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Manage threads for ${managedProject.title}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-manage-modal__header">
              <div className="project-manage-modal__heading">
                <div className="project-modal__title">{managedProject.title}</div>
                <div className="project-manage-modal__path" title={managedProject.workspaceRoot}>
                  {managedProject.workspaceRoot}
                </div>
              </div>
              <button
                ref={manageProjectCloseButtonRef}
                type="button"
                className="project-manage-modal__close"
                onClick={handleCloseManageProjectModal}
                disabled={isDeletingManagedThreads}
                aria-label="Close manage threads"
              >
                ×
              </button>
            </div>
            <div
              ref={manageProjectTableShellRef}
              className="project-manage-modal__tableShell"
              tabIndex={0}
              role="grid"
              aria-label={`${managedProject.title} threads`}
              onKeyDown={handleManagedTableKeyDown}
            >
              <table className="project-manage-table">
                <thead>
                  <tr>
                    <th className="project-manage-table__checkboxColumn">
                      <input
                        ref={manageProjectSelectAllRef}
                        className="project-manage-table__checkbox"
                        type="checkbox"
                        checked={managedThreadSelection.allSelected}
                        disabled={managedThreadSelection.totalCount === 0}
                        onChange={handleToggleAllManagedThreads}
                        aria-label={managedThreadSelection.allSelected ? "Deselect all threads" : "Select all threads"}
                      />
                    </th>
                    <th>Thread</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Updated</th>
                    <th>Provider</th>
                  </tr>
                </thead>
                <tbody>
                  {managedProjectThreads.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="project-manage-table__empty">
                        No threads in this project yet.
                      </td>
                    </tr>
                  ) : managedProjectThreads.map((thread) => {
                    const status = getThreadStatus(
                      thread,
                      nowIso,
                      isThreadTurnRunning(thread.id),
                      getPendingUserInputs(thread.id)[0]?.createdAt ?? null,
                    );
                    const ageMs = getThreadAgeMs(thread, nowIso);
                    const createdAtMs = Math.max(0, parseTimestampMs(nowIso) - parseTimestampMs(thread.createdAt));
                    const isSelected = selectedManagedThreadIds.has(thread.id);
                    return (
                      <tr
                        key={thread.id}
                        className={`project-manage-table__row${isSelected ? " project-manage-table__row--selected" : ""}`}
                        aria-selected={isSelected}
                        onMouseDown={(event) => handleManagedThreadRowMouseDown(event, thread.id)}
                        onMouseEnter={() => handleManagedThreadRowMouseEnter(thread.id)}
                      >
                        <td className="project-manage-table__checkboxCell">
                          <input
                            className="project-manage-table__checkbox project-manage-table__checkbox--marker"
                            type="checkbox"
                            checked={isSelected}
                            readOnly
                            tabIndex={-1}
                            aria-hidden="true"
                            aria-label={`Select ${thread.title}`}
                          />
                        </td>
                        <td>
                          <div className="project-manage-table__title">{thread.title}</div>
                          <div className="project-manage-table__detail" title={getThreadFirstPrompt(thread)}>
                            {truncateTitle(getThreadFirstPrompt(thread), 88)}
                          </div>
                        </td>
                        <td>
                          <span className={`project-manage-table__status project-manage-table__status--${status.tone}`}>
                            {status.label}
                          </span>
                        </td>
                        <td>
                          <div className="project-manage-table__updatedPrimary">{formatSidebarAge(createdAtMs)}</div>
                          <div className="project-manage-table__updatedSecondary" title={thread.createdAt}>
                            {formatManageThreadTimestamp(thread.createdAt)}
                          </div>
                        </td>
                        <td>
                          <div className="project-manage-table__updatedPrimary">{formatSidebarAge(ageMs)}</div>
                          <div className="project-manage-table__updatedSecondary" title={thread.updatedAt}>
                            {formatManageThreadTimestamp(thread.updatedAt)}
                          </div>
                        </td>
                        <td>
                          <span className="project-manage-table__provider">{thread.provider}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {manageProjectError ? <div className="project-modal__error">{manageProjectError}</div> : null}
            <div className="project-manage-modal__footer">
              <div className="project-manage-modal__footerInfo">
                {managedThreadSelection.selectedCount > 0
                  ? `${managedThreadSelection.selectedCount} of ${managedThreadSelection.totalCount} selected`
                  : `${managedThreadSelection.totalCount} threads`}
              </div>
              <div className="project-manage-modal__footerActions">
                <button
                  type="button"
                  className="project-modal__action project-modal__action--secondary"
                  onClick={handleCloseManageProjectModal}
                  disabled={isDeletingManagedThreads}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="project-modal__action project-modal__action--secondary"
                  disabled
                  title="Thread archive is not wired through orchestration yet."
                >
                  Archive selected
                </button>
                <button
                  type="button"
                  className="project-modal__action project-modal__action--danger"
                  onClick={() => void handleDeleteManagedThreads()}
                  disabled={managedThreadSelection.selectedCount === 0 || isDeletingManagedThreads}
                >
                  {isDeletingManagedThreads
                    ? "Deleting..."
                    : managedThreadSelection.selectedCount > 0
                      ? `Delete ${managedThreadSelection.selectedCount} selected`
                      : "Delete selected"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {projectArchiveConfirmProject ? (
        <div
          className="project-modal-overlay project-modal-overlay--strong"
          role="presentation"
          onMouseDown={handleCloseProjectArchiveConfirm}
        >
          <section
            className="project-modal project-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Archive ${projectArchiveConfirmProject.title}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-manage-modal__eyebrow">Archive project</div>
            <div className="project-modal__title">{projectArchiveConfirmProject.title}</div>
            <div className="project-confirm-modal__body">
              This hides the project from the left sidebar in this console UI. Its threads and history stay intact.
            </div>
            <div className="project-modal__actions">
              <button
                type="button"
                className="project-modal__action project-modal__action--secondary"
                onClick={handleCloseProjectArchiveConfirm}
              >
                Cancel
              </button>
              <button
                type="button"
                className="project-modal__action project-modal__action--danger"
                onClick={handleConfirmProjectArchive}
              >
                Archive project
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {threadDeleteConfirmThread ? (
        <div
          className="project-modal-overlay project-modal-overlay--strong"
          role="presentation"
          onMouseDown={handleCloseThreadDeleteConfirm}
        >
          <section
            className="project-modal project-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Delete ${threadDeleteConfirmThread.title}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-manage-modal__eyebrow">Delete thread</div>
            <div className="project-modal__title">{threadDeleteConfirmThread.title}</div>
            <div className="project-confirm-modal__body">
              This will remove the thread from the project history view.
            </div>
            {threadDeleteError ? <div className="project-modal__error">{threadDeleteError}</div> : null}
            <div className="project-modal__actions">
              <button
                type="button"
                className="project-modal__action project-modal__action--secondary"
                onClick={handleCloseThreadDeleteConfirm}
                disabled={isDeletingThread}
              >
                Cancel
              </button>
              <button
                type="button"
                className="project-modal__action project-modal__action--danger"
                onClick={() => void handleConfirmThreadDelete()}
                disabled={isDeletingThread}
              >
                {isDeletingThread ? "Deleting..." : "Delete thread"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {projectModalOpen ? (
        <div className="project-modal-overlay" role="presentation" onMouseDown={handleCloseProjectModal}>
          <section
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Add project"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-modal__title">Add project</div>
            <div className="project-modal__body">
              <label className="project-modal__label" htmlFor="project-path-input">Project path</label>
              <div className="project-modal__pathRow">
                <input
                  ref={projectPathInputRef}
                  id="project-path-input"
                  className="project-modal__input"
                  type="text"
                  spellCheck={false}
                  value={projectPathDraft}
                  onChange={(event) => {
                    setProjectPathDraft(event.target.value);
                    if (duplicateProjectConfirm) {
                      setDuplicateProjectConfirm(null);
                    }
                    if (projectModalError) {
                      setProjectModalError(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleCreateProject();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      handleCloseProjectModal();
                    }
                  }}
                />
                <button
                  type="button"
                  className="project-modal__browseButton"
                  onClick={() => void handleBrowseProjectFolder()}
                  disabled={!window.desktopBridge?.pickFolder || isCreatingProject}
                >
                  Browse...
                </button>
              </div>
              {projectModalError ? <div className="project-modal__error">{projectModalError}</div> : null}
            </div>
            <div className="project-modal__actions">
              <button type="button" className="project-modal__action project-modal__action--secondary" onClick={handleCloseProjectModal} disabled={isCreatingProject}>
                Cancel
              </button>
              <button type="button" className="project-modal__action project-modal__action--primary" onClick={() => void handleCreateProject()} disabled={isCreatingProject}>
                {isCreatingProject ? "Adding..." : "OK"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {duplicateProjectConfirm ? (
        <div className="project-modal-overlay" role="presentation" onMouseDown={handleCloseDuplicateProjectConfirm}>
          <section
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Project already exists"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="project-modal__title">Project path already exists</div>
            <div className="project-modal__body project-modal__body--stacked">
              <div className="project-modal__message">
                {duplicateProjectConfirm.isArchived
                  ? "This path already belongs to an archived project in the app."
                  : "This path already belongs to a project in the app."}
              </div>
              <div className="project-modal__pathPreview" title={duplicateProjectConfirm.workspaceRoot}>
                {duplicateProjectConfirm.workspaceRoot}
              </div>
              <div className="project-modal__message project-modal__message--muted">
                {duplicateProjectConfirm.isArchived
                  ? `Selecting "${duplicateProjectConfirm.title}" will undraft it and bring it back into the sidebar.`
                  : `Selecting "${duplicateProjectConfirm.title}" will focus that existing project instead of creating another one.`}
              </div>
            </div>
            <div className="project-modal__actions">
              <button
                ref={duplicateProjectConfirmPrimaryActionRef}
                type="button"
                className="project-modal__action project-modal__action--primary"
                onClick={handleSelectDuplicateProject}
                disabled={isCreatingProject}
              >
                {duplicateProjectConfirm.isArchived ? "Undraft and select existing project" : "Select existing project"}
              </button>
              <button
                type="button"
                className="project-modal__action"
                onClick={() => void handleCreateDuplicateProject()}
                disabled={isCreatingProject}
              >
                {isCreatingProject ? "Adding..." : "Create new project with this path"}
              </button>
              <button
                type="button"
                className="project-modal__action project-modal__action--secondary"
                onClick={handleCloseDuplicateProjectConfirm}
                disabled={isCreatingProject}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
