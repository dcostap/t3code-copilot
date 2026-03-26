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
