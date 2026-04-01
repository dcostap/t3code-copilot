import type {
  TerminalEvent,
  TerminalSessionSnapshot,
} from "@t3tools/contracts";

export interface ConsoleTerminalSessionState {
  readonly snapshot: TerminalSessionSnapshot | null;
  readonly hasRunningSubprocess: boolean;
}

export function getConsoleTerminalSessionKey(threadId: string, terminalId: string) {
  return `${threadId}::${terminalId}`;
}

export function upsertConsoleTerminalSessionSnapshot(
  existing: Readonly<Record<string, ConsoleTerminalSessionState>>,
  snapshot: TerminalSessionSnapshot,
): Readonly<Record<string, ConsoleTerminalSessionState>> {
  const key = getConsoleTerminalSessionKey(snapshot.threadId, snapshot.terminalId);
  const previous = existing[key];
  const nextEntry: ConsoleTerminalSessionState = {
    snapshot,
    hasRunningSubprocess:
      previous?.hasRunningSubprocess
      ?? false,
  };
  if (
    previous?.snapshot === snapshot
    && previous.hasRunningSubprocess === nextEntry.hasRunningSubprocess
  ) {
    return existing;
  }
  return {
    ...existing,
    [key]: nextEntry,
  };
}

export function removeConsoleTerminalSession(
  existing: Readonly<Record<string, ConsoleTerminalSessionState>>,
  input: {
    readonly threadId: string;
    readonly terminalId: string;
  },
): Readonly<Record<string, ConsoleTerminalSessionState>> {
  const key = getConsoleTerminalSessionKey(input.threadId, input.terminalId);
  if (!(key in existing)) {
    return existing;
  }
  const next = { ...existing };
  delete next[key];
  return next;
}

export function applyConsoleTerminalEvent(
  existing: Readonly<Record<string, ConsoleTerminalSessionState>>,
  event: TerminalEvent,
): Readonly<Record<string, ConsoleTerminalSessionState>> {
  const key = getConsoleTerminalSessionKey(event.threadId, event.terminalId);
  const previous = existing[key];

  if (event.type === "started" || event.type === "restarted") {
    return upsertConsoleTerminalSessionSnapshot(existing, event.snapshot);
  }

  if (event.type === "activity") {
    if (!previous || previous.hasRunningSubprocess === event.hasRunningSubprocess) {
      return existing;
    }
    return {
      ...existing,
      [key]: {
        ...previous,
        hasRunningSubprocess: event.hasRunningSubprocess,
      },
    };
  }

  if (!previous?.snapshot) {
    return existing;
  }

  if (event.type === "output") {
    return existing;
  }

  if (event.type === "cleared") {
    return {
      ...existing,
      [key]: {
        ...previous,
        snapshot: {
          ...previous.snapshot,
          history: "",
          updatedAt: event.createdAt,
        },
      },
    };
  }

  if (event.type === "error") {
    return {
      ...existing,
      [key]: {
        ...previous,
        hasRunningSubprocess: false,
        snapshot: {
          ...previous.snapshot,
          status: "error",
          updatedAt: event.createdAt,
        },
      },
    };
  }

  return {
    ...existing,
    [key]: {
      ...previous,
      hasRunningSubprocess: false,
      snapshot: {
        ...previous.snapshot,
        status: "exited",
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
        updatedAt: event.createdAt,
      },
    },
  };
}
