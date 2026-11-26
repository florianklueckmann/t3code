import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ProjectionProjectsArea from "./ForkMigrations/001_ProjectionProjectsArea.ts";

// Fork-only schema changes keep their own ledger, so upstream migration ids stay free for upstream.
export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

const forkMigrationEntries = [[1, "ProjectionProjectsArea", ProjectionProjectsArea]] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const latestForkMigrationId = Math.max(...forkMigrationEntries.map(([id]) => id));

// Fork builds before the fork ledger recorded 001_ProjectionProjectsArea in the upstream ledger.
const LEGACY_UPSTREAM_ROW = { id: 97, name: "ProjectionProjectsArea" } as const;

export const isLegacyForkMigration = (row: { readonly id: number; readonly name: string }) =>
  row.id === LEGACY_UPSTREAM_ROW.id && row.name === LEGACY_UPSTREAM_ROW.name;

/** Recorded fork migrations this build does not know, or that differ from its manifest. */
export function unknownForkMigrations(
  recorded: ReadonlyArray<{ readonly id: number; readonly name: string }>,
): string[] {
  return recorded
    .toSorted((a, b) => a.id - b.id)
    .flatMap((row, index) => {
      const expected = forkMigrationManifest[index];
      return expected?.[0] === row.id && expected[1] === row.name ? [] : [`${row.id}_${row.name}`];
    });
}

const tableExists = Effect.fn("ForkMigrations.tableExists")(function* (name: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
  return rows.length > 0;
});

const hasLegacyUpstreamRow = Effect.fn("ForkMigrations.hasLegacyUpstreamRow")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists("effect_sql_migrations"))) return false;
  const rows = yield* sql`
    SELECT 1 FROM effect_sql_migrations
    WHERE migration_id = ${LEGACY_UPSTREAM_ROW.id} AND name = ${LEGACY_UPSTREAM_ROW.name}
  `;
  return rows.length > 0;
});

const isForkLedgerBehind = Effect.fn("ForkMigrations.isLedgerBehind")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(FORK_MIGRATIONS_TABLE))) return true;
  const [row] = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  return (row?.latestId ?? 0) < latestForkMigrationId;
});

export const hasPendingForkMigrations = Effect.fn("ForkMigrations.hasPending")(function* () {
  return (yield* hasLegacyUpstreamRow()) || (yield* isForkLedgerBehind());
});

/** Frees the upstream id an earlier fork build took. Must run before upstream history checks. */
export const releaseLegacyUpstreamIds = Effect.fn("ForkMigrations.releaseLegacyUpstreamIds")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* hasLegacyUpstreamRow())) return;
    // A crash before the fork ledger records 001 is safe: 001 keeps the existing column.
    yield* sql`
      DELETE FROM effect_sql_migrations
      WHERE migration_id = ${LEGACY_UPSTREAM_ROW.id} AND name = ${LEGACY_UPSTREAM_ROW.name}
    `;
  },
);

export const assertForkMigrationsCanRun = Effect.fn("ForkMigrations.assertCanRun")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(FORK_MIGRATIONS_TABLE))) return;
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  const unknown = unknownForkMigrations(
    recorded.map((row) => ({ id: row.migration_id, name: row.name })),
  );
  if (unknown.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database has fork migrations this build does not know: ${unknown.join(", ")}. A newer or different fork build probably wrote them. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

const run = Migrator.make({});

/** Runs after the upstream migrations and `assertForkMigrationsCanRun`. */
export const runForkMigrations = Effect.fn("ForkMigrations.run")(function* () {
  // The migrator takes the write lock even with nothing to run.
  if (!(yield* isForkLedgerBehind())) return [];
  return yield* run({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});
