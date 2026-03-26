export const THREAD_PICKER_QUERY_PREFIX = "@";

type PaletteThreadIndicatorTone = "idle" | "unread" | "working";

export function isThreadPickerQuery(query: string): boolean {
  return query.trimStart().startsWith(THREAD_PICKER_QUERY_PREFIX);
}

export function stripThreadPickerQueryPrefix(query: string): string {
  const trimmedStart = query.trimStart();
  return trimmedStart.startsWith(THREAD_PICKER_QUERY_PREFIX)
    ? trimmedStart.slice(THREAD_PICKER_QUERY_PREFIX.length)
    : query;
}

export function hasThreadPickerSearchQuery(query: string): boolean {
  return stripThreadPickerQueryPrefix(query).trim().length > 0;
}

export function getPaletteThreadIndicator(tone: PaletteThreadIndicatorTone): string {
  switch (tone) {
    case "working":
      return "🔵";
    case "unread":
      return "🟢";
    default:
      return "⚪";
  }
}

export function formatPaletteThreadLabel(input: {
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly indicatorTone: PaletteThreadIndicatorTone;
  readonly workingLabel?: string | null;
}): string {
  if (input.indicatorTone === "idle") {
    return `${input.projectTitle} - ${input.threadTitle}`;
  }

  const indicator = getPaletteThreadIndicator(input.indicatorTone);
  return input.indicatorTone === "working" && input.workingLabel
    ? `${input.projectTitle} - ${input.threadTitle} - ${indicator} ${input.workingLabel}`
    : `${input.projectTitle} - ${input.threadTitle} - ${indicator}`;
}

export function formatPaletteProjectLabel(input: {
  readonly projectTitle: string;
  readonly unreadThreadCount: number;
  readonly workingThreadCount: number;
}): string {
  const parts = [input.projectTitle];
  if (input.workingThreadCount > 0) {
    parts.push(`${getPaletteThreadIndicator("working")} ${input.workingThreadCount}`);
  }
  if (input.unreadThreadCount > 0) {
    parts.push(`${getPaletteThreadIndicator("unread")} ${input.unreadThreadCount}`);
  }
  return parts.join(" - ");
}

export interface PaletteThreadPickerGroup<TCommand> {
  readonly projectCommand: TCommand;
  readonly threadCommands: ReadonlyArray<TCommand>;
}

export function flattenPaletteThreadPickerGroups<TCommand>(
  groups: ReadonlyArray<PaletteThreadPickerGroup<TCommand>>,
): ReadonlyArray<TCommand> {
  return groups.flatMap((group) => group.threadCommands.length > 0
    ? [group.projectCommand, ...group.threadCommands]
    : []);
}
