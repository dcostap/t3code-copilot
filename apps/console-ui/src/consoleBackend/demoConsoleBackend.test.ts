import { describe, expect, it } from "vitest";

import { buildDemoSnapshot } from "../consoleData/demoSnapshot";
import { DemoConsoleBackend } from "./demoConsoleBackend";
import { createManualScenarioScheduler } from "./scenarioScheduler";

function buildTurnStartCommand(
  thread: Awaited<ReturnType<DemoConsoleBackend["getSnapshot"]>>["threads"][number],
  text: string,
) {
  return {
    type: "thread.turn.start" as const,
    commandId: "command:test" as never,
    threadId: thread.id,
    message: {
      messageId: "message:test" as never,
      role: "user" as const,
      text,
      attachments: [],
    },
    model: thread.model,
    assistantDeliveryMode: "streaming" as const,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: "2026-03-11T09:00:00.000Z",
  };
}

function buildThreadCreateCommand(
  projectId: Awaited<ReturnType<DemoConsoleBackend["getSnapshot"]>>["projects"][number]["id"],
) {
  return {
    type: "thread.create" as const,
    commandId: "command:create-thread" as never,
    threadId: "thread:second" as never,
    projectId,
    title: "Second demo thread",
    model: "gpt-5",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdAt: "2026-03-11T09:00:00.000Z",
  };
}

describe("DemoConsoleBackend", () => {
  it("streams a direct turn deterministically", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({ scheduler });
    backend.connect();

    const initialSnapshot = await backend.getSnapshot();
    const thread = initialSnapshot.threads[0];
    expect(thread).toBeDefined();

    await backend.dispatchCommand(buildTurnStartCommand(thread!, "[direct] inspect transcript"));

    let runningSnapshot = await backend.getSnapshot();
    expect(runningSnapshot.threads[0]?.latestTurn?.state).toBe("running");

    scheduler.runAll();

    runningSnapshot = await backend.getSnapshot();
    const assistantMessage = runningSnapshot.threads[0]?.messages.at(-1);
    const userMessage = runningSnapshot.threads[0]?.messages.at(-2);
    expect(runningSnapshot.threads[0]?.latestTurn?.state).toBe("completed");
    expect(assistantMessage?.streaming).toBe(false);
    expect(userMessage?.role).toBe("user");
    expect(userMessage?.text).toBe("[direct] inspect transcript");
    expect(assistantMessage?.role).toBe("assistant");
    expect(assistantMessage?.text).toContain("Your prompt: inspect transcript");
  });

  it("emits snapshot update hints while assistant text is streaming", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({ scheduler });
    backend.connect();

    const initialSnapshot = await backend.getSnapshot();
    const thread = initialSnapshot.threads[0];
    expect(thread).toBeDefined();

    const eventTypes: string[] = [];
    backend.subscribe((event) => {
      eventTypes.push(event.type);
    });

    await backend.dispatchCommand(buildTurnStartCommand(thread!, "[direct] inspect transcript"));
    scheduler.advanceBy(400);

    expect(eventTypes).toContain("snapshot.updated");
  });

  it("supports two sequential plain prompts without swallowing the second", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({ scheduler });
    backend.connect();

    let snapshot = await backend.getSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    await backend.dispatchCommand(buildTurnStartCommand(thread!, "first"));
    scheduler.runAll();

    snapshot = await backend.getSnapshot();
    expect(snapshot.threads[0]?.messages.some((message) => message.role === "user" && message.text === "first")).toBe(true);

    await backend.dispatchCommand(buildTurnStartCommand(snapshot.threads[0]!, "second"));
    scheduler.runAll();

    snapshot = await backend.getSnapshot();
    const userTexts = snapshot.threads[0]?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text);
    const latestAssistantMessage = [...(snapshot.threads[0]?.messages ?? [])]
      .toReversed()
      .find((message) => message.role === "assistant");

    expect(userTexts).toContain("first");
    expect(userTexts).toContain("second");
    expect(latestAssistantMessage?.text).toContain("Your prompt: second");
  });

  it("keeps pending approval state across reconnect and resumes after approval", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({ scheduler });
    backend.connect();

    const initialSnapshot = await backend.getSnapshot();
    const thread = initialSnapshot.threads[0];
    expect(thread).toBeDefined();

    await backend.dispatchCommand(buildTurnStartCommand(thread!, "[approval] patch files"));
    scheduler.advanceBy(200);

    let snapshot = await backend.getSnapshot();
    expect(
      snapshot.threads[0]?.activities.some((activity) => activity.kind === "approval.requested"),
    ).toBe(true);

    backend.disconnect();
    scheduler.runAll();
    backend.connect();

    snapshot = await backend.getSnapshot();
    expect(
      snapshot.threads[0]?.activities.some((activity) => activity.kind === "approval.requested"),
    ).toBe(true);

    const approvalActivity = snapshot.threads[0]?.activities.findLast(
      (activity) => activity.kind === "approval.requested",
    );
    const requestId = (approvalActivity?.payload as { requestId?: string } | undefined)?.requestId;
    expect(requestId).toBeTruthy();

    await backend.dispatchCommand({
      type: "thread.approval.respond",
      commandId: "command:approval" as never,
      threadId: thread!.id,
      requestId: requestId as never,
      decision: "accept",
      createdAt: "2026-03-11T09:00:01.000Z",
    });

    scheduler.runAll();

    snapshot = await backend.getSnapshot();
    expect(snapshot.threads[0]?.latestTurn?.state).toBe("completed");
  });

  it("keeps pending user-input state across reconnect and resumes after response", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({ scheduler });
    backend.connect();

    const initialSnapshot = await backend.getSnapshot();
    const thread = initialSnapshot.threads[0];
    expect(thread).toBeDefined();

    await backend.dispatchCommand(buildTurnStartCommand(thread!, "[input] choose mode"));
    scheduler.advanceBy(500);

    let snapshot = await backend.getSnapshot();
    const inputActivity = snapshot.threads[0]?.activities.findLast(
      (activity) => activity.kind === "user-input.requested",
    );
    const requestId = (inputActivity?.payload as { requestId?: string } | undefined)?.requestId;
    expect(requestId).toBeTruthy();

    backend.disconnect();
    scheduler.runAll();
    backend.connect();

    snapshot = await backend.getSnapshot();
    expect(
      snapshot.threads[0]?.activities.some((activity) => activity.kind === "user-input.requested"),
    ).toBe(true);

    await backend.dispatchCommand({
      type: "thread.user-input.respond",
      commandId: "command:user-input" as never,
      threadId: thread!.id,
      requestId: requestId as never,
      answers: { demo_source: "Demo" },
      createdAt: "2026-03-11T09:00:01.000Z",
    });

    scheduler.runAll();

    snapshot = await backend.getSnapshot();
    expect(snapshot.threads[0]?.latestTurn?.state).toBe("completed");
    expect(snapshot.threads[0]?.messages.at(-1)?.text).toContain("- demo_source: Demo");
  });

  it("interrupts only the targeted thread", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({ scheduler });
    backend.connect();

    let snapshot = await backend.getSnapshot();
    const firstThread = snapshot.threads[0];
    const project = snapshot.projects[0];
    expect(firstThread).toBeDefined();
    expect(project).toBeDefined();

    await backend.dispatchCommand(buildThreadCreateCommand(project!.id));
    snapshot = await backend.getSnapshot();
    const secondThread = snapshot.threads.find((thread) => thread.id === ("thread:second" as never));
    expect(secondThread).toBeDefined();

    await backend.dispatchCommand(buildTurnStartCommand(firstThread!, "first thread"));
    await backend.dispatchCommand(buildTurnStartCommand(secondThread!, "second thread"));

    await backend.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: "command:interrupt" as never,
      threadId: firstThread!.id,
      createdAt: "2026-03-11T09:00:01.000Z",
    });

    scheduler.runAll();

    snapshot = await backend.getSnapshot();
    const interruptedThread = snapshot.threads.find((thread) => thread.id === firstThread!.id);
    const completedThread = snapshot.threads.find((thread) => thread.id === secondThread!.id);
    expect(interruptedThread?.latestTurn?.state).toBe("interrupted");
    expect(completedThread?.latestTurn?.state).toBe("completed");
  });

  it("fails stale approval responses without faking approval resolution", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({ scheduler });
    backend.connect();

    const snapshot = await backend.getSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    await backend.dispatchCommand({
      type: "thread.approval.respond",
      commandId: "command:approval-stale" as never,
      threadId: thread!.id,
      requestId: "approval:missing" as never,
      decision: "accept",
      createdAt: "2026-03-11T09:00:01.000Z",
    });

    const nextSnapshot = await backend.getSnapshot();
    expect(
      nextSnapshot.threads[0]?.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      ),
    ).toBe(true);
    expect(
      nextSnapshot.threads[0]?.activities.some(
        (activity) =>
          activity.kind === "approval.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as { requestId?: string }).requestId === "approval:missing",
      ),
    ).toBe(false);
  });

  it("fails stale user-input responses without faking user-input resolution", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({ scheduler });
    backend.connect();

    const snapshot = await backend.getSnapshot();
    const thread = snapshot.threads[0];
    expect(thread).toBeDefined();

    await backend.dispatchCommand({
      type: "thread.user-input.respond",
      commandId: "command:user-input-stale" as never,
      threadId: thread!.id,
      requestId: "input:missing" as never,
      answers: { demo_source: "Demo" },
      createdAt: "2026-03-11T09:00:01.000Z",
    });

    const nextSnapshot = await backend.getSnapshot();
    expect(
      nextSnapshot.threads[0]?.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      ),
    ).toBe(true);
    expect(
      nextSnapshot.threads[0]?.activities.some(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as { requestId?: string }).requestId === "input:missing",
      ),
    ).toBe(false);
  });

  it("creates deterministic snapshots from the demo fixture", async () => {
    const scheduler = createManualScenarioScheduler();
    const backend = new DemoConsoleBackend({
      scheduler,
      initialSnapshot: buildDemoSnapshot(),
    });
    backend.connect();

    const snapshot = await backend.getSnapshot();
    expect(snapshot.threads.length).toBeGreaterThan(0);
    expect(snapshot.projects.length).toBeGreaterThan(0);
  });
});
