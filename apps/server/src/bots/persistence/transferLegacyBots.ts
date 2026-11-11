import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { legacyBotMigrationHead } from "./legacyBotHistory.ts";
import * as BotDatabase from "./BotDatabase.ts";

const fail = (reason: string) =>
  new Migrator.MigrationError({
    kind: "BadState",
    message: `Cannot transfer legacy Bots: ${reason}. Both databases have been retained. Stop other builds using this T3 home and report the migration history/schema before retrying.`,
  });

export const transferLegacyBots = Effect.fn("BotDatabase.transferLegacyBots")(function* () {
  const main = yield* SqlClient.SqlClient;
  const bots = yield* BotDatabase.BotDatabase;
  // Only the source is locked across the copy. The target commit survives source rollback.
  yield* main.withTransaction(
    Effect.gen(function* () {
      const tables = yield* main<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
      if (!tables.some((row) => row.name === "effect_sql_migrations")) {
        if (tables.some((row) => row.name === "bots"))
          return yield* fail("Bot schema exists without a migration ledger");
        return;
      }
      const history = yield* main<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      const legacy = history.find((row) => row.migration_id === 78 && row.name === "Bots");
      const botTables = tables.filter((row) =>
        ["bots", "bot_project_contexts", "bot_tasks", "bot_learning_revisions"].includes(row.name),
      );
      if (legacy === undefined) {
        const columns = tables.some((row) => row.name === "scheduled_tasks")
          ? yield* main<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`
          : [];
        if (
          botTables.length > 0 ||
          columns.some((row) =>
            ["bot_id", "bot_session_at", "schedule_revision", "bot_allow_changes"].includes(
              row.name,
            ),
          )
        )
          return yield* fail("Bot schema exists without the known 078_Bots history");
        return;
      }
      const head = legacyBotMigrationHead(
        history.map(({ migration_id: id, name }) => ({ id, name })),
      );
      if (head === undefined)
        return yield* fail("unknown fork suffix or divergent upstream V2 history before 078");
      const expectedTables = [
        "bots",
        "bot_project_contexts",
        ...(head >= 80 ? ["bot_tasks"] : []),
        ...(head >= 81 ? ["bot_learning_revisions"] : []),
      ];
      if (
        botTables.length !== expectedTables.length ||
        expectedTables.some((name) => !botTables.some((row) => row.name === name))
      )
        return yield* fail("legacy Bot tables do not match their recorded migrations");
      const schedules = yield* main<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly pk: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(scheduled_tasks)`;
      const extensions = schedules.filter((row) =>
        ["bot_id", "bot_session_at", "schedule_revision", "bot_allow_changes"].includes(row.name),
      );
      const expectedExtensions =
        head < 80
          ? []
          : [
              { name: "bot_id", type: "TEXT", notnull: 0, pk: 0, dflt_value: null },
              { name: "bot_session_at", type: "TEXT", notnull: 0, pk: 0, dflt_value: null },
              { name: "schedule_revision", type: "INTEGER", notnull: 1, pk: 0, dflt_value: "0" },
              ...(head >= 83
                ? [
                    {
                      name: "bot_allow_changes",
                      type: "INTEGER",
                      notnull: 1,
                      pk: 0,
                      dflt_value: "0",
                    },
                  ]
                : []),
            ];
      if (
        extensions.length !== expectedExtensions.length ||
        extensions.some((column, index) => {
          const expected = expectedExtensions[index];
          return (
            !expected ||
            column.name !== expected.name ||
            column.type !== expected.type ||
            column.notnull !== expected.notnull ||
            column.pk !== expected.pk ||
            column.dflt_value !== expected.dflt_value
          );
        })
      )
        return yield* fail("scheduled_tasks extensions do not match their recorded migrations");
      yield* bots.withTransaction(
        Effect.gen(function* () {
          for (const table of expectedTables) {
            const targetColumns = yield* bots<{
              readonly name: string;
              readonly type: string;
              readonly notnull: number;
              readonly pk: number;
              readonly dflt_value: string | null;
            }>`PRAGMA table_info(${bots(table)})`;
            const sourceColumns = yield* main<{
              readonly name: string;
              readonly type: string;
              readonly notnull: number;
              readonly pk: number;
              readonly dflt_value: string | null;
            }>`PRAGMA table_info(${main(table)})`;
            const expected = targetColumns.filter(
              (row) =>
                !(table === "bots" && head < 79 && row.name === "appearance_json") &&
                // Legacy Bots had no MCP grants.
                !(table === "bots" && row.name === "mcp_grant_revision") &&
                !(table === "bot_tasks" && head < 83 && row.name === "allow_changes") &&
                !(
                  table === "bot_tasks" &&
                  [
                    "return_home_run_id",
                    "return_home_message_id",
                    "return_finished_at",
                    "model_selection_json",
                  ].includes(row.name)
                ),
            );
            if (
              sourceColumns.length !== expected.length ||
              sourceColumns.some((column, index) => {
                const target = expected[index];
                return (
                  target === undefined ||
                  column.name !== target.name ||
                  column.type !== target.type ||
                  column.notnull !== target.notnull ||
                  column.pk !== target.pk ||
                  column.dflt_value !== target.dflt_value
                );
              })
            )
              return yield* fail(`unexpected ${table} schema`);
            if (table === "bot_tasks" && head >= 83) {
              const invalid = yield* main`SELECT task_id FROM bot_tasks
                WHERE typeof(allow_changes) <> 'integer' OR allow_changes NOT IN (0, 1) LIMIT 1`;
              if (invalid.length > 0)
                return yield* fail("invalid 083 task change permission values");
            }
            const rows = yield* main.unsafe<Record<string, string | number | null>>(
              `SELECT ${expected.map((row) => `"${row.name}"`).join(", ")} FROM "${table}"`,
            );
            for (const source of rows) {
              const row = { ...source };
              if (table === "bots" && head < 79) row.appearance_json = null;
              if (table === "bots") row.mcp_grant_revision = 0;
              if (table === "bot_tasks" && head < 83) row.allow_changes = 0;
              if (table === "bot_tasks") {
                row.return_home_run_id = null;
                row.return_home_message_id = null;
                row.return_finished_at = null;
                row.model_selection_json = null;
              }
              const keys = targetColumns
                .filter((column) => column.pk > 0)
                .map((column) => column.name);
              const where = keys.map((key) => `"${key}" = ?`).join(" AND ");
              const existing = yield* bots.unsafe<Record<string, string | number | null>>(
                `SELECT * FROM "${table}" WHERE ${where}`,
                keys.map((key) => row[key]),
              );
              if (existing.length === 0)
                yield* bots`INSERT INTO ${bots(table)} ${bots.insert(row)}`;
              const [copied] = yield* bots.unsafe<Record<string, string | number | null>>(
                `SELECT * FROM "${table}" WHERE ${where}`,
                keys.map((key) => row[key]),
              );
              if (!copied || targetColumns.some(({ name }) => copied[name] !== row[name]))
                return yield* fail(`conflicting target data in ${table}`);
            }
            const [count] = yield* bots<{
              readonly count: number;
            }>`SELECT COUNT(*) AS count FROM ${bots(table)}`;
            if (count?.count !== rows.length)
              return yield* fail(`unrelated target data in ${table}`);
          }
          for (const table of ["bot_tasks", "bot_learning_revisions"].filter(
            (name) => !expectedTables.includes(name),
          )) {
            const rows = yield* bots`SELECT 1 FROM ${bots(table)} LIMIT 1`;
            if (rows.length > 0) return yield* fail(`unrelated target data in ${table}`);
          }
          const pending = yield* bots`SELECT singleton FROM bot_routine_intent`;
          if (pending.length > 0) return yield* fail("target has an unfinished routine change");
          if (head < 80) {
            const rows = yield* bots`SELECT 1 FROM bot_routines LIMIT 1`;
            if (rows.length > 0) return yield* fail("unrelated target routine metadata");
          }
          if (head >= 80) {
            if (head >= 83) {
              const invalid = yield* main`SELECT task_id FROM scheduled_tasks
                WHERE typeof(bot_allow_changes) <> 'integer' OR bot_allow_changes NOT IN (0, 1) LIMIT 1`;
              if (invalid.length > 0)
                return yield* fail("invalid 083 routine change permission values");
            }
            const rows = yield* main<{
              readonly task_id: string;
              readonly bot_id: string | null;
              readonly bot_session_at: string | null;
              readonly schedule_revision: number;
              readonly bot_allow_changes: number;
            }>`SELECT task_id, bot_id, bot_session_at, schedule_revision,
              ${head >= 83 ? main("bot_allow_changes") : main.literal("0")} AS bot_allow_changes
              FROM scheduled_tasks WHERE bot_id IS NOT NULL OR bot_session_at IS NOT NULL OR schedule_revision <> 0
                OR ${head >= 83 ? main("bot_allow_changes") : main.literal("0")} <> 0`;
            for (const row of rows) {
              yield* bots`INSERT INTO bot_routines ${bots.insert(row)} ON CONFLICT(task_id) DO NOTHING`;
              const [copied] = yield* bots<
                typeof row
              >`SELECT * FROM bot_routines WHERE task_id = ${row.task_id}`;
              if (
                !copied ||
                copied.bot_id !== row.bot_id ||
                copied.bot_session_at !== row.bot_session_at ||
                copied.schedule_revision !== row.schedule_revision ||
                copied.bot_allow_changes !== row.bot_allow_changes
              )
                return yield* fail("conflicting target routine metadata");
            }
            const [count] = yield* bots<{
              readonly count: number;
            }>`SELECT COUNT(*) AS count FROM bot_routines`;
            if (count?.count !== rows.length)
              return yield* fail("unrelated target routine metadata");
          }
        }),
      );
      for (const table of expectedTables.toReversed()) yield* main`DROP TABLE ${main(table)}`;
      for (const { name } of extensions)
        yield* main`ALTER TABLE scheduled_tasks DROP COLUMN ${main(name)}`;
      // Remove only the validated fork suffix; upstream 078 must actually execute afterwards.
      yield* main`DELETE FROM effect_sql_migrations WHERE migration_id >= 78`;
    }),
  );
});
