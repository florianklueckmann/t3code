import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "../../persistence/Migrations.ts";
import * as BotDatabase from "./BotDatabase.ts";

export const prepareTransfer = Effect.fn("BotDatabase.prepareScheduledTaskProvenance")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const bots = yield* BotDatabase.BotDatabase;
    const tables = yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`;
    if (tables.length === 0) return;
    const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
    const forkIndex = history.findIndex(
      ({ migration_id, name }) => migration_id === 81 && name === "ScheduledTaskCreationProvenance",
    );
    if (forkIndex === -1) return;
    if (
      history.length !== 81 ||
      forkIndex !== 80 ||
      history
        .slice(0, 80)
        .some(
          (row, index) =>
            row.migration_id !== migrationManifest[index]?.[0] ||
            row.name !== migrationManifest[index]?.[1],
        )
    ) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          "Unknown history after the fork's scheduled task provenance migration. Both databases have been retained.",
      });
    }
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
    if (!columns.some(({ name }) => name === "created_by_thread_id")) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          "The fork's scheduled task provenance column is missing. Both databases have been retained.",
      });
    }
    // The marker survives a crash between relinquishing the fork id and copying the column.
    yield* bots`INSERT OR IGNORE INTO bot_provenance_transfer VALUES (1)`;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 81`;
  },
);

export const finishTransfer = Effect.fn("BotDatabase.finishScheduledTaskProvenance")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bots = yield* BotDatabase.BotDatabase;
  const pending = yield* bots`SELECT singleton FROM bot_provenance_transfer`;
  if (pending.length === 0) return;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some(({ name }) => name === "created_by_thread_id")) {
    // Journal recovery runs first, so a pre-upgrade save contributes its final creator too.
    const rows = yield* sql<{ readonly task_id: string; readonly created_by_thread_id: string }>`
      SELECT task_id, created_by_thread_id FROM scheduled_tasks WHERE created_by_thread_id IS NOT NULL
    `;
    for (const row of rows) {
      const [current] = yield* bots<{
        readonly created_by_thread_id: string | null;
      }>`SELECT created_by_thread_id FROM bot_routines WHERE task_id = ${row.task_id}`;
      if (
        current?.created_by_thread_id != null &&
        current.created_by_thread_id !== row.created_by_thread_id
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Contradictory scheduled task provenance. Both databases have been retained.",
        });
      }
    }
    yield* bots.withTransaction(
      Effect.forEach(
        rows,
        (row) =>
          bots`INSERT INTO bot_routines (task_id, bot_id, bot_session_at, schedule_revision, bot_allow_changes, created_by_thread_id)
        VALUES (${row.task_id}, NULL, NULL, 0, 0, ${row.created_by_thread_id})
        ON CONFLICT(task_id) DO UPDATE SET created_by_thread_id = excluded.created_by_thread_id`,
        { discard: true },
      ),
    );
    yield* sql`PRAGMA synchronous = FULL`;
    yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN created_by_thread_id`;
    yield* sql`PRAGMA synchronous = NORMAL`;
  }
  yield* bots`DELETE FROM bot_provenance_transfer`;
});
