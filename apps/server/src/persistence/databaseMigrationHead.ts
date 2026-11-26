// @effect-diagnostics nodeBuiltinImport:off - read synchronously by the preflight subprocess and at startup.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { FORK_MIGRATIONS_TABLE, isLegacyForkMigration } from "./ForkMigrations.ts";
import { migrationManifest } from "./Migrations.ts";

export const BUILD_MIGRATION_HEAD = Math.max(...migrationManifest.map(([id]) => id));

type RecordedMigration = { readonly id: number; readonly name: string };

function readLedger(databasePath: string, table: string): ReadonlyArray<RecordedMigration> | null {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return NodeFS.existsSync(databasePath) ? null : [];
  }
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (hasTable === undefined) return [];
    return db
      .prepare(`SELECT migration_id, name FROM "${table}" ORDER BY migration_id`)
      .all()
      .map((row) => ({ id: Number(row.migration_id), name: String(row.name) }));
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // A read-only handle has nothing to flush; the result above already stands.
    }
  }
}

/** Upstream migrations the database records once startup has moved the fork's legacy rows out,
 * read-only. A missing or new database records none; one that exists but cannot be read is null,
 * since its history is unknown. */
export function recordedMigrations(databasePath: string): ReadonlyArray<RecordedMigration> | null {
  return (
    readLedger(databasePath, "effect_sql_migrations")?.filter(
      (row) => !isLegacyForkMigration(row),
    ) ?? null
  );
}

/** Fork migrations the database records, read-only, with the same null rule. */
export function recordedForkMigrations(
  databasePath: string,
): ReadonlyArray<RecordedMigration> | null {
  return readLedger(databasePath, FORK_MIGRATIONS_TABLE);
}

/** Highest migration the database holds once this build's startup migrations have run. A newer
 * build may have recorded more than this build knows. Undefined when the database is unreadable. */
export function databaseMigrationHead(databasePath: string): number | undefined {
  const recorded = recordedMigrations(databasePath);
  return recorded === null
    ? undefined
    : Math.max(BUILD_MIGRATION_HEAD, ...recorded.map(({ id }) => id));
}
