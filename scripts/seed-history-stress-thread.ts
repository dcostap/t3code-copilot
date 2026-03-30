#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_THREAD_ID = "thread:console-history-stress";
const DEFAULT_TITLE = "[dev] History stress test";
const DEFAULT_TURN_COUNT = 320;
const DEFAULT_ACTIVITIES_PER_TURN = 3;

type ProjectRow = {
  project_id: string;
  title: string;
  workspace_root: string;
  default_model: string | null;
  updated_at: string;
};

type ThreadDefaults = {
  provider: string;
  model: string;
  model_options_json: string | null;
  runtime_mode: string;
  interaction_mode: string;
  branch: string | null;
  worktree_path: string | null;
};

const args = parseArgs({
  options: {
    "state-dir": {
      type: "string",
    },
    "project-id": {
      type: "string",
    },
    "thread-id": {
      type: "string",
    },
    title: {
      type: "string",
    },
    turns: {
      type: "string",
    },
    "activities-per-turn": {
      type: "string",
    },
  },
});

const stateDir = path.resolve(args.values["state-dir"] ?? path.join(homedir(), ".t3", "dev"));
const dbPath = path.join(stateDir, "state.sqlite");
if (!existsSync(dbPath)) {
  throw new Error(`State database not found: ${dbPath}`);
}

const turnCount = parsePositiveInteger(args.values.turns, DEFAULT_TURN_COUNT);
const activitiesPerTurn = parsePositiveInteger(
  args.values["activities-per-turn"],
  DEFAULT_ACTIVITIES_PER_TURN,
);
const threadId = args.values["thread-id"] ?? DEFAULT_THREAD_ID;
const db = new DatabaseSync(dbPath);

const project = resolveTargetProject(db, args.values["project-id"]);
if (!project) {
  throw new Error(`Could not find a target project in ${dbPath}`);
}

const threadDefaults = resolveThreadDefaults(db, project.project_id, project);
const title = args.values.title ?? `${DEFAULT_TITLE} (${turnCount} turns)`;
const timestamps = createTimestampSequence(turnCount, activitiesPerTurn);
const latestTurnId = `${threadId}:turn:${String(turnCount).padStart(4, "0")}`;

db.exec("BEGIN IMMEDIATE");

try {
  deleteExistingStressThread(db, threadId);
  insertStressThread({
    db,
    project,
    threadDefaults,
    threadId,
    title,
    turnCount,
    activitiesPerTurn,
    timestamps,
    latestTurnId,
  });
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}

console.log(`Seeded stress thread ${threadId}`);
console.log(`Project: ${project.title} (${project.project_id})`);
console.log(`Database: ${dbPath}`);
console.log(`Turns: ${turnCount}`);
console.log(`Activities per turn: ${activitiesPerTurn}`);

function parsePositiveInteger(raw: string | undefined, fallback: number) {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${raw}`);
  }
  return parsed;
}

function resolveTargetProject(db: DatabaseSync, projectId: string | undefined): ProjectRow | null {
  if (projectId) {
    const exactProject = db
      .prepare(`
        SELECT project_id, title, workspace_root, default_model, updated_at
        FROM projection_projects
        WHERE project_id = ?
      `)
      .get(projectId) as ProjectRow | undefined;
    if (exactProject) {
      return exactProject;
    }
  }

  const currentWorkspaceProject = db
    .prepare(`
      SELECT project_id, title, workspace_root, default_model, updated_at
      FROM projection_projects
      WHERE workspace_root = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get(process.cwd()) as ProjectRow | undefined;
  if (currentWorkspaceProject) {
    return currentWorkspaceProject;
  }

  return (
    (db
      .prepare(`
        SELECT project_id, title, workspace_root, default_model, updated_at
        FROM projection_projects
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get() as ProjectRow | undefined)
    ?? null
  );
}

function resolveThreadDefaults(
  db: DatabaseSync,
  projectId: string,
  project: ProjectRow,
): ThreadDefaults {
  const recentThread = db
    .prepare(`
      SELECT
        provider,
        model,
        model_options_json,
        runtime_mode,
        interaction_mode,
        branch,
        worktree_path
      FROM projection_threads
      WHERE project_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get(projectId) as ThreadDefaults | undefined;

  return {
    provider: recentThread?.provider ?? "codex",
    model: recentThread?.model ?? project.default_model ?? "gpt-5.4",
    model_options_json: recentThread?.model_options_json ?? null,
    runtime_mode: recentThread?.runtime_mode ?? "full-access",
    interaction_mode: recentThread?.interaction_mode ?? "default",
    branch: recentThread?.branch ?? "main",
    worktree_path: recentThread?.worktree_path ?? project.workspace_root,
  };
}

function createTimestampSequence(turnCount: number, activitiesPerTurn: number) {
  const totalEntries = turnCount * (2 + activitiesPerTurn + 1);
  const startMs = Date.now() - (totalEntries * 90_000);
  let cursorMs = startMs;

  const nextIso = () => {
    const iso = new Date(cursorMs).toISOString();
    cursorMs += 90_000;
    return iso;
  };

  return { nextIso };
}

function deleteExistingStressThread(db: DatabaseSync, threadId: string) {
  for (const table of [
    "projection_thread_proposed_plans",
    "projection_thread_activities",
    "projection_thread_messages",
    "projection_thread_sessions",
    "projection_turns",
    "projection_threads",
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
  }
}

function insertStressThread(input: {
  db: DatabaseSync;
  project: ProjectRow;
  threadDefaults: ThreadDefaults;
  threadId: string;
  title: string;
  turnCount: number;
  activitiesPerTurn: number;
  timestamps: {
    nextIso(): string;
  };
  latestTurnId: string;
}) {
  const {
    db,
    project,
    threadDefaults,
    threadId,
    title,
    turnCount,
    activitiesPerTurn,
    timestamps,
    latestTurnId,
  } = input;

  const insertThread = db.prepare(`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      title,
      model,
      branch,
      worktree_path,
      latest_turn_id,
      created_at,
      updated_at,
      deleted_at,
      runtime_mode,
      interaction_mode,
      model_options_json,
      provider
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO projection_thread_messages (
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      attachments_json,
      is_streaming,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertActivity = db.prepare(`
    INSERT INTO projection_thread_activities (
      activity_id,
      thread_id,
      turn_id,
      tone,
      kind,
      summary,
      payload_json,
      created_at,
      sequence
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTurn = db.prepare(`
    INSERT INTO projection_turns (
      thread_id,
      turn_id,
      pending_message_id,
      assistant_message_id,
      state,
      requested_at,
      started_at,
      completed_at,
      checkpoint_turn_count,
      checkpoint_ref,
      checkpoint_status,
      checkpoint_files_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]')
  `);
  const insertSession = db.prepare(`
    INSERT INTO projection_thread_sessions (
      thread_id,
      status,
      provider_name,
      provider_session_id,
      provider_thread_id,
      active_turn_id,
      last_error,
      updated_at,
      runtime_mode
    )
    VALUES (?, 'ready', ?, NULL, NULL, NULL, NULL, ?, ?)
  `);
  const insertPlan = db.prepare(`
    INSERT INTO projection_thread_proposed_plans (
      plan_id,
      thread_id,
      turn_id,
      plan_markdown,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const createdAt = timestamps.nextIso();
  let updatedAt = createdAt;
  let activitySequence = 1;

  insertThread.run(
    threadId,
    project.project_id,
    title,
    threadDefaults.model,
    threadDefaults.branch,
    threadDefaults.worktree_path,
    latestTurnId,
    createdAt,
    createdAt,
    threadDefaults.runtime_mode,
    threadDefaults.interaction_mode,
    threadDefaults.model_options_json,
    threadDefaults.provider,
  );

  for (let turnNumber = 1; turnNumber <= turnCount; turnNumber += 1) {
    const turnId = `${threadId}:turn:${String(turnNumber).padStart(4, "0")}`;
    const userMessageId = `${threadId}:message:user:${String(turnNumber).padStart(4, "0")}`;
    const assistantMessageId = `${threadId}:message:assistant:${String(turnNumber).padStart(4, "0")}`;

    const requestedAt = timestamps.nextIso();
    const userCreatedAt = timestamps.nextIso();
    const startedAt = timestamps.nextIso();

    insertMessage.run(
      userMessageId,
      threadId,
      turnId,
      "user",
      buildUserPrompt(turnNumber),
      "[]",
      0,
      userCreatedAt,
      userCreatedAt,
    );

    for (let activityIndex = 1; activityIndex <= activitiesPerTurn; activityIndex += 1) {
      const activityCreatedAt = timestamps.nextIso();
      insertActivity.run(
        `${threadId}:activity:${String(activitySequence).padStart(6, "0")}`,
        threadId,
        turnId,
        activityIndex === activitiesPerTurn ? "tool" : "info",
        activityIndex === activitiesPerTurn ? "tool.completed" : "task.progress",
        buildActivitySummary(turnNumber, activityIndex, activitiesPerTurn),
        JSON.stringify(buildActivityPayload(turnNumber, activityIndex, activitiesPerTurn)),
        activityCreatedAt,
        activitySequence,
      );
      activitySequence += 1;
      updatedAt = activityCreatedAt;
    }

    if (turnNumber % 24 === 0) {
      const planCreatedAt = timestamps.nextIso();
      insertPlan.run(
        `${threadId}:plan:${String(turnNumber).padStart(4, "0")}`,
        threadId,
        turnId,
        buildPlanMarkdown(turnNumber),
        planCreatedAt,
        planCreatedAt,
      );
      updatedAt = planCreatedAt;
    }

    const assistantCreatedAt = timestamps.nextIso();
    insertMessage.run(
      assistantMessageId,
      threadId,
      turnId,
      "assistant",
      buildAssistantReply(turnNumber),
      "[]",
      0,
      assistantCreatedAt,
      assistantCreatedAt,
    );

    insertTurn.run(
      threadId,
      turnId,
      userMessageId,
      assistantMessageId,
      "completed",
      requestedAt,
      startedAt,
      assistantCreatedAt,
    );

    updatedAt = assistantCreatedAt;
  }

  db.prepare(`
    UPDATE projection_threads
    SET updated_at = ?, latest_turn_id = ?
    WHERE thread_id = ?
  `).run(updatedAt, latestTurnId, threadId);

  insertSession.run(threadId, threadDefaults.provider, updatedAt, threadDefaults.runtime_mode);
}

function buildUserPrompt(turnNumber: number) {
  const variant = turnNumber % 4;
  if (variant === 0) {
    return [
      `Turn ${turnNumber}: inspect the transcript virtualization behavior on very long histories.`,
      "",
      "Focus on scroll anchoring, perceived latency, and whether updates in the active tail destabilize earlier rows.",
    ].join("\n");
  }
  if (variant === 1) {
    return `Turn ${turnNumber}: summarize the latest scrolling diagnostics and suggest one follow-up measurement.`;
  }
  if (variant === 2) {
    return [
      `Turn ${turnNumber}: review the activity log and identify any rows that would benefit from smarter height estimation.`,
      "",
      "- pay attention to multiline responses",
      "- note any tool rows that should stay mounted in the live tail",
    ].join("\n");
  }
  return [
    `Turn ${turnNumber}: compare the visible transcript with the previous checkpoint and call out any UI jitter.`,
    "",
    "Please answer in a compact terminal-friendly format.",
  ].join("\n");
}

function buildAssistantReply(turnNumber: number) {
  const repeated = "This row intentionally varies in length to exercise measurement and virtualization caches.";
  const extraParagraph =
    turnNumber % 10 === 0
      ? `\n\n${repeated} ${repeated} ${repeated}`
      : turnNumber % 7 === 0
        ? `\n\n${repeated}`
        : "";

  return [
    `Reply ${turnNumber}: the stable prefix remains virtualized while the active tail stays mounted.`,
    "",
    "Observed behavior:",
    `- scroll offset preserved across append-heavy updates`,
    `- row measurements stayed deterministic for turn ${turnNumber}`,
    `- native scrollbar remained the single source of truth`,
  ].join("\n") + extraParagraph;
}

function buildActivitySummary(turnNumber: number, activityIndex: number, activitiesPerTurn: number) {
  if (activityIndex === activitiesPerTurn) {
    return `Tool run complete for turn ${turnNumber}`;
  }
  return `Reasoning update ${activityIndex} for turn ${turnNumber}`;
}

function buildActivityPayload(turnNumber: number, activityIndex: number, activitiesPerTurn: number) {
  if (activityIndex === activitiesPerTurn) {
    return {
      detail: `Measured row group ${turnNumber} and updated the cached size estimate after render.`,
      itemType: "command_execution",
      title: "Measure transcript rows",
      status: "completed",
      data: {
        item: {
          input: {
            command: ["bun", "typecheck"],
          },
          result: {
            exitCode: 0,
            content: `turn ${turnNumber} measurement pass complete`,
          },
        },
      },
    };
  }

  return {
    detail: `Streaming work item ${activityIndex} for turn ${turnNumber}: collecting enough history to stress scrolling, row estimation, and tail updates.`,
  };
}

function buildPlanMarkdown(turnNumber: number) {
  return [
    `## Stress slice ${turnNumber}`,
    "",
    "- Keep the stable prefix virtualized.",
    "- Leave the live tail mounted for animated rows.",
    "- Verify native-scroll stability while rows of mixed heights are appended.",
  ].join("\n");
}
