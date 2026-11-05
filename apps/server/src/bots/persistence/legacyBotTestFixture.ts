import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import Bots from "./Migrations/001_Bots.ts";
import Appearance from "./Migrations/002_BotAppearance.ts";
import Tasks from "./Migrations/003_BotTasks.ts";
import Learning from "./Migrations/004_BotLearning.ts";
import RoutineChanges from "./fixtures/083_BotRoutineChanges.ts";

export const seedLegacy = Effect.fn("LegacyBotsTest.seed")(function* (head: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 77 });
  const migrations = [
    Bots,
    Appearance,
    Effect.gen(function* () {
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN bot_id TEXT`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN bot_session_at TEXT`;
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 0`;
      yield* Tasks;
    }),
    Learning,
    sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`,
    RoutineChanges,
  ];
  const names = [
    "Bots",
    "BotAppearance",
    "BotTasks",
    "BotLearning",
    "DropOrchestrationEventCorrelationIndex",
    "BotRoutineChanges",
  ];
  for (let id = 78; id <= head; id++) {
    yield* migrations[id - 78]!;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${names[id - 78]!})`;
  }
  yield* sql`INSERT INTO bots (bot_id, name, instructions, model_selection_json, learning_policy, created_at, updated_at, archived_at)
    VALUES ('bot', 'Companion', 'Standing instructions', '{"instanceId":"codex","model":"test"}', 'after_adoption', 'created', 'updated', 'archived')`;
  if (head >= 79) yield* sql`UPDATE bots SET appearance_json = '{"kind":"emoji","emoji":"🦉"}'`;
  yield* sql`INSERT INTO bot_project_contexts VALUES ('home', 'bot', 'project', 'Guidance', '[{"label":"Canon","path":"canon/"}]', 7, 'archive', 'attached', 'detached', 'updated')`;
  if (head >= 80) {
    yield* sql`INSERT INTO scheduled_tasks (
      task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json,
      model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at,
      updated_at, next_run_at, last_run_at, last_run_status, last_run_error, run_count, bot_id, bot_session_at, schedule_revision
    ) VALUES ('routine', 'Prepare', 'Read canon', 1, '{"type":"interval","everyMs":60000}', 'project', NULL, '{"type":"root"}', '{"instanceId":"codex","model":"test"}', 'full-access', 'default', 'user', 'web', 'created', 'updated', 'due', 'last', 'running', NULL, 3, 'bot', 'session', 9)`;
    yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, last_run_status, run_count, schedule_revision)
      SELECT 'converted', title, prompt, 0, schedule_json, project_id, thread_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, 'never', 0, 12 FROM scheduled_tasks WHERE task_id = 'routine'`;
    for (const [index, status] of [
      "completed",
      "interrupted",
      "cancel_requested",
      "skipped",
    ].entries()) {
      yield* sql`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, work_thread_id, origin, title, prompt, scheduled_task_id, occurrence_key, occurrence_due_at, session_at, runtime_mode, status, detail, dispatched_at, cancel_requested_at, result_run_id, completed_at, notified_at, created_at, updated_at)
        VALUES (${`task-${index}`}, 'bot', 'project', 'home', ${`work-${index}`}, 'routine', 'Prepare', 'Read canon', 'routine', ${`routine:9:${index}`}, 'due', 'session', 'full-access', ${status}, 'detail', 'dispatched', 'cancel', ${`run-${index}`}, ${index === 0 ? "completed" : null}, NULL, 'created', 'updated')`;
    }
  }
  if (head >= 83) {
    yield* sql`UPDATE scheduled_tasks SET bot_allow_changes = 1 WHERE task_id = 'routine'`;
    yield* sql`UPDATE bot_tasks SET allow_changes = 1 WHERE task_id IN ('task-0', 'task-2')`;
    yield* sql`UPDATE bot_tasks SET notified_at = 'notified' WHERE task_id = 'task-0'`;
  }
  if (head >= 81) {
    for (const [index, status] of [
      "active",
      "pending",
      "retired",
      "rejected",
      "diagnostic",
    ].entries()) {
      yield* sql`INSERT INTO bot_learning_revisions VALUES ('lesson', ${index + 1}, 'bot', 'project', 'memory', 'Recorded fact', 'recorded fact', 'rationale', 'evidence', 'task', '{"kind":"task","taskId":"task-0","threadId":"work-0"}', 'project', ${status}, ${index || null}, 1, 'created', 'decided')`;
    }
  }
});
