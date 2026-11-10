import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Bots from "./Migrations/001_Bots.ts";
import Appearance from "./Migrations/002_BotAppearance.ts";
import Tasks from "./Migrations/003_BotTasks.ts";
import Learning from "./Migrations/004_BotLearning.ts";
import RoutineChanges from "./Migrations/006_BotRoutineChanges.ts";
import Continuation from "./Migrations/009_BotContinuation.ts";
import HomeInput from "./Migrations/008_BotTaskHomeInput.ts";
import HomeReturn from "./Migrations/007_BotTaskHomeReturn.ts";
import TaskModelSelection from "./Migrations/010_BotTaskModelSelection.ts";
import Maintenance from "./Migrations/011_BotMaintenance.ts";
import MaintenanceReceipts from "./Migrations/012_BotMaintenanceReceipts.ts";
import MaintenanceNightly from "./Migrations/013_BotMaintenanceNightly.ts";
import HomeCheck from "./Migrations/014_BotHomeCheck.ts";

const routines = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE bot_routines (
    task_id TEXT PRIMARY KEY,
    bot_id TEXT,
    bot_session_at TEXT,
    schedule_revision INTEGER NOT NULL
  )`;
  // Write ahead of T3 mutations; replay before any scheduler or client can observe either DB.
  yield* sql`CREATE TABLE bot_routine_intent (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    task_id TEXT NOT NULL,
    query TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    bot_id TEXT,
    bot_session_at TEXT,
    schedule_revision INTEGER NOT NULL,
    removing INTEGER NOT NULL
  )`;
});

const entries = [
  [1, "Bots", Bots],
  [2, "BotAppearance", Appearance],
  [3, "BotTasks", Tasks],
  [4, "BotLearning", Learning],
  [5, "BotRoutines", routines],
  [6, "BotRoutineChanges", RoutineChanges],
  [7, "BotTaskHomeReturn", HomeReturn],
  [8, "BotTaskHomeInput", HomeInput],
  [9, "BotContinuation", Continuation],
  [10, "BotTaskModelSelection", TaskModelSelection],
  [11, "BotMaintenance", Maintenance],
  [12, "BotMaintenanceReceipts", MaintenanceReceipts],
  [13, "BotMaintenanceNightly", MaintenanceNightly],
  [14, "BotHomeCheck", HomeCheck],
] as const;
const run = Migrator.make({});
export const runMigrations = Effect.fn("BotDatabase.runMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`;
  if (tables.length > 0) {
    const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    if (
      history.some(
        (row, index) =>
          row.migration_id !== entries[index]?.[0] || row.name !== entries[index]?.[1],
      )
    ) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          "Unknown bots.sqlite migration history. Use the build that wrote it or report its history before upgrading.",
      });
    }
  }
  return yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(entries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
    ),
  });
});
