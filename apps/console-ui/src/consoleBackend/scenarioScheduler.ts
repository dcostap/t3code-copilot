export interface ScheduledScenarioTask {
  cancel(): void;
}

export interface ScenarioScheduler {
  nowMs(): number;
  schedule(delayMs: number, fn: () => void): ScheduledScenarioTask;
  cancelAll(): void;
}

interface ScheduledEntry {
  runAt: number;
  order: number;
  fn: () => void;
  cancelled: boolean;
}

export interface ManualScenarioScheduler extends ScenarioScheduler {
  advanceBy(delayMs: number): void;
  runAll(): void;
  pendingCount(): number;
}

function sortEntries(entries: ScheduledEntry[]) {
  entries.sort((left, right) => left.runAt - right.runAt || left.order - right.order);
}

export function createBrowserScenarioScheduler(now: () => number = () => Date.now()): ScenarioScheduler {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  return {
    nowMs: () => now(),
    schedule(delayMs, fn) {
      const timeout = setTimeout(() => {
        timers.delete(timeout);
        fn();
      }, delayMs);
      timers.add(timeout);
      return {
        cancel() {
          if (!timers.has(timeout)) return;
          timers.delete(timeout);
          clearTimeout(timeout);
        },
      };
    },
    cancelAll() {
      for (const timeout of timers) {
        clearTimeout(timeout);
      }
      timers.clear();
    },
  };
}

export function createManualScenarioScheduler(
  startMs = Date.parse("2026-03-11T09:00:00.000Z"),
): ManualScenarioScheduler {
  let currentMs = startMs;
  let nextOrder = 1;
  const queue: ScheduledEntry[] = [];

  const runDueEntries = (targetMs: number) => {
    sortEntries(queue);

    while (queue.length > 0) {
      const next = queue[0];
      if (!next || next.runAt > targetMs) {
        break;
      }

      queue.shift();
      if (next.cancelled) {
        continue;
      }

      currentMs = next.runAt;
      next.fn();
      sortEntries(queue);
    }

    currentMs = targetMs;
  };

  return {
    nowMs: () => currentMs,
    schedule(delayMs, fn) {
      const entry: ScheduledEntry = {
        runAt: currentMs + Math.max(0, delayMs),
        order: nextOrder++,
        fn,
        cancelled: false,
      };
      queue.push(entry);
      sortEntries(queue);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
    cancelAll() {
      queue.length = 0;
    },
    advanceBy(delayMs) {
      runDueEntries(currentMs + Math.max(0, delayMs));
    },
    runAll() {
      while (queue.length > 0) {
        const next = queue
          .filter((entry) => !entry.cancelled)
          .toSorted((left, right) => left.runAt - right.runAt || left.order - right.order)[0];
        if (!next) {
          queue.length = 0;
          break;
        }
        runDueEntries(next.runAt);
      }
    },
    pendingCount() {
      return queue.filter((entry) => !entry.cancelled).length;
    },
  };
}
