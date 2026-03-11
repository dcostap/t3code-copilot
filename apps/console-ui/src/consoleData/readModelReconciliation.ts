import type { OrchestrationEvent, OrchestrationReadModel, OrchestrationThread } from "@t3tools/contracts";

function updateThread(
  snapshot: OrchestrationReadModel,
  threadId: string,
  updater: (thread: OrchestrationThread) => OrchestrationThread,
): OrchestrationReadModel {
  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.id !== threadId) {
      return thread;
    }
    changed = true;
    return updater(thread);
  });

  return changed ? { ...snapshot, threads } : snapshot;
}

export function reconcileReadModelWithEvents(
  snapshot: OrchestrationReadModel | null,
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationReadModel | null {
  if (!snapshot || events.length === 0) {
    return snapshot;
  }

  const pendingEvents = events
    .filter((event) => event.sequence > snapshot.snapshotSequence)
    .toSorted((left, right) => left.sequence - right.sequence);

  if (pendingEvents.length === 0) {
    return snapshot;
  }

  let nextSnapshot = snapshot;
  let latestAppliedSequence = snapshot.snapshotSequence;
  let latestUpdatedAt = snapshot.updatedAt;

  for (const event of pendingEvents) {
    switch (event.type) {
      case "thread.meta-updated": {
        nextSnapshot = updateThread(nextSnapshot, event.payload.threadId, (thread) => ({
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        }));
        latestAppliedSequence = event.sequence;
        latestUpdatedAt = event.payload.updatedAt;
        break;
      }

      case "thread.runtime-mode-set": {
        nextSnapshot = updateThread(nextSnapshot, event.payload.threadId, (thread) => ({
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
          session: thread.session
            ? {
                ...thread.session,
                runtimeMode: event.payload.runtimeMode,
                updatedAt: event.payload.updatedAt,
              }
            : null,
        }));
        latestAppliedSequence = event.sequence;
        latestUpdatedAt = event.payload.updatedAt;
        break;
      }

      case "thread.interaction-mode-set": {
        nextSnapshot = updateThread(nextSnapshot, event.payload.threadId, (thread) => ({
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        }));
        latestAppliedSequence = event.sequence;
        latestUpdatedAt = event.payload.updatedAt;
        break;
      }

      default:
        break;
    }
  }

  if (latestAppliedSequence === snapshot.snapshotSequence) {
    return snapshot;
  }

  return {
    ...nextSnapshot,
    snapshotSequence: latestAppliedSequence,
    updatedAt: latestUpdatedAt,
  };
}
