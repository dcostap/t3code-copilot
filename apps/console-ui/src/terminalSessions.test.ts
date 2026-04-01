import { describe, expect, it } from "vitest";

import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";

import {
  applyConsoleTerminalEvent,
  getConsoleTerminalSessionKey,
  removeConsoleTerminalSession,
  upsertConsoleTerminalSessionSnapshot,
} from "./terminalSessions";

const snapshot: TerminalSessionSnapshot = {
  threadId: "thread:1",
  terminalId: "default",
  cwd: "C:\\Projects\\demo",
  status: "running",
  pid: 123,
  history: "PS C:\\Projects\\demo>",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-03-31T18:00:00.000Z",
};

describe("terminalSessions", () => {
  it("stores snapshots by thread and terminal id", () => {
    const state = upsertConsoleTerminalSessionSnapshot({}, snapshot);

    expect(state[getConsoleTerminalSessionKey(snapshot.threadId, snapshot.terminalId)]).toEqual({
      snapshot,
      hasRunningSubprocess: false,
    });
  });

  it("marks subprocess activity without rewriting the snapshot", () => {
    const initial = upsertConsoleTerminalSessionSnapshot({}, snapshot);
    const next = applyConsoleTerminalEvent(initial, {
      type: "activity",
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      createdAt: "2026-03-31T18:00:01.000Z",
      hasRunningSubprocess: true,
    });

    expect(next[getConsoleTerminalSessionKey(snapshot.threadId, snapshot.terminalId)]).toEqual({
      snapshot,
      hasRunningSubprocess: true,
    });
  });

  it("updates exit metadata from terminal exit events", () => {
    const initial = upsertConsoleTerminalSessionSnapshot({}, snapshot);
    const next = applyConsoleTerminalEvent(initial, {
      type: "exited",
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      createdAt: "2026-03-31T18:00:03.000Z",
      exitCode: 1,
      exitSignal: null,
    });

    expect(next[getConsoleTerminalSessionKey(snapshot.threadId, snapshot.terminalId)]).toEqual({
      snapshot: {
        ...snapshot,
        status: "exited",
        exitCode: 1,
        exitSignal: null,
        updatedAt: "2026-03-31T18:00:03.000Z",
      },
      hasRunningSubprocess: false,
    });
  });

  it("removes tracked sessions when a pane closes them", () => {
    const initial = upsertConsoleTerminalSessionSnapshot({}, snapshot);
    const next = removeConsoleTerminalSession(initial, {
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
    });

    expect(next).toEqual({});
  });

  it("replaces snapshots on started and restarted events", () => {
    const nextSnapshot: TerminalSessionSnapshot = {
      ...snapshot,
      status: "running",
      pid: 456,
      updatedAt: "2026-03-31T18:00:05.000Z",
    };
    const startedEvent: TerminalEvent = {
      type: "started",
      threadId: nextSnapshot.threadId,
      terminalId: nextSnapshot.terminalId,
      createdAt: nextSnapshot.updatedAt,
      snapshot: nextSnapshot,
    };

    const next = applyConsoleTerminalEvent({}, startedEvent);

    expect(next[getConsoleTerminalSessionKey(snapshot.threadId, snapshot.terminalId)]).toEqual({
      snapshot: nextSnapshot,
      hasRunningSubprocess: false,
    });
  });
});
