import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as BotDatabase from "../bots/persistence/BotDatabase.ts";
import * as BotMigrations from "../bots/persistence/Migrations.ts";
import * as BotRoutineStore from "../bots/persistence/BotRoutineStore.ts";
import * as ScheduledTaskProvenance from "../bots/persistence/transferScheduledTaskProvenance.ts";
import { transferLegacyBots } from "../bots/persistence/transferLegacyBots.ts";

import { hasPendingMigrations, runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";
import * as ServerOwnership from "../serverOwnership.ts";

const WAL_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;

export class ServerOwnsDatabaseError extends Schema.TaggedError<ServerOwnsDatabaseError>()(
  "ServerOwnsDatabaseError",
  { stateDir: Schema.String },
) {
  override get message(): string {
    return `Another T3 Code process, usually a running server, owns ${this.stateDir}, and this CLI would change its database schema. Use the \`t3\` that matches the running server, or stop that server, then retry. The database was not changed.`;
  }
}

// SQLITE_CORRUPT and SQLITE_NOTADB; node:sqlite reports extended codes whose low byte is the primary code.
const DAMAGED_SQLITE_CODES = new Set([11, 26]);

const isDamagedDatabase = (error: SqlError.SqlError): boolean => {
  const seen = new Set<unknown>();
  let cause: unknown = error.cause;
  while (Predicate.isObject(cause) && !seen.has(cause)) {
    seen.add(cause);
    if (typeof cause.errcode === "number" && DAMAGED_SQLITE_CODES.has(cause.errcode & 0xff)) {
      return true;
    }
    cause = cause.cause;
  }
  return false;
};

// Keeps the SqlError type so callers' error channels do not change; the original stays as the cause.
const damagedDatabaseError = (dbPath: string, cause: SqlError.SqlError) =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause,
      operation: "open",
      message: `The T3 Code database at ${dbPath} is damaged or is not a SQLite database, so T3 Code cannot start. To recover, quit T3 Code, then move that file and any -wal and -shm files next to it out of the folder, or replace them with a backup. T3 Code creates a new database on the next start.`,
    }),
  });

// CLI commands open the server's database from another process; migrating behind its owner changes the schema it runs on.
const runMigrationsAsOwner = Effect.fn("SqlitePersistence.runMigrationsAsOwner")(function* () {
  // With nothing pending, runMigrations only validates the recorded history and writes nothing.
  if (!(yield* hasPendingMigrations())) return yield* runMigrations();
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  yield* ServerOwnership.holdServerOwnershipLock(serverRuntimeStatePath).pipe(
    Effect.catchTags({
      ServerAlreadyRunningError: ({ stateDir }) =>
        Effect.fail(new ServerOwnsDatabaseError({ stateDir })),
    }),
  );
  yield* ScheduledTaskProvenance.prepareTransfer();
  yield* transferLegacyBots();
  yield* runMigrations();
}, Effect.scoped);

const makeLayerSetup = <E, R>(migrate: Effect.Effect<unknown, E, R>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      // Existing databases need doctor's offline VACUUM to add pointer maps for this mode.
      const tables = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
      if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      // Legacy Bot transfer must commit durably before either database accepts new writes.
      yield* sql`PRAGMA synchronous = FULL;`;
      // macOS fsync misses drive caches; F_FULLFSYNC flushes them at checkpoints and is ignored elsewhere.
      yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
      // Keep statement journals and sort spills off the disk.
      // Large statements and open savepoints can increase peak memory use.
      yield* sql`PRAGMA temp_store = MEMORY;`;
      // PASSIVE checkpoints retain peak WAL size until the last connection closes.
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      yield* migrate;
      yield* sql`PRAGMA synchronous = NORMAL;`;
      // Collecting stats scans every page, and stale small-table stats cause scans after growth; use indexes by default.
      // Connections cache stats; reload after deleting them.
      const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
      if (statTables.length > 0) {
        yield* sql`DELETE FROM sqlite_stat1;`;
        yield* sql`ANALYZE sqlite_schema;`;
      }
    }).pipe(Effect.withSpan("Sqlite.setup")),
  );

const layerSetup = makeLayerSetup(
  Effect.gen(function* () {
    yield* ScheduledTaskProvenance.prepareTransfer();
    yield* transferLegacyBots();
    yield* runMigrations();
  }),
);

const botLayer = (filename: string) =>
  Layer.effect(
    BotDatabase.BotDatabase,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 5000`;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`PRAGMA synchronous = FULL`;
      yield* BotMigrations.runMigrations();
      return sql;
    }),
  ).pipe(Layer.provide(NodeSqliteClient.layer({ filename })));

const makeLayerFromPath = <E, R>(makeSetup: (dbPath: string) => Layer.Layer<never, E, R>) =>
  Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    const databases = Layer.provideMerge(
      makeSetup(dbPath),
      Layer.merge(
        botLayer(path.join(path.dirname(dbPath), "bots.sqlite")),
        NodeSqliteClient.layer({
          filename: dbPath,
          readerWorker: true,
          // A slow disk then delays writes instead of freezing every client.
          writerWorker: true,
          spanAttributes: {
            "db.name": path.basename(dbPath),
            "service.name": "t3code-server",
          },
        }),
      ),
    );
    const recovered = BotRoutineStore.layer.pipe(Layer.provideMerge(databases));
    return Layer.effectDiscard(ScheduledTaskProvenance.finishTransfer()).pipe(
      Layer.provideMerge(recovered),
      Layer.catchTag("SqlError", (error) =>
        Layer.effectContext(
          Effect.fail(
            SqlError.isSqlError(error) && isDamagedDatabase(error)
              ? damagedDatabaseError(dbPath, error)
              : error,
          ),
        ),
      ),
    );
  }, Layer.unwrap);

export const layerFromPath = makeLayerFromPath(() => layerSetup);

export const layerMemory = BotRoutineStore.layer.pipe(
  Layer.provideMerge(
    Layer.provideMerge(
      layerSetup,
      Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), botLayer(":memory:")),
    ),
  ),
);

const makeLayerConfig = <E, R>(
  fromPath: (
    dbPath: string,
  ) => Layer.Layer<
    SqlClient.SqlClient | BotDatabase.BotDatabase | BotRoutineStore.BotRoutineStore,
    E,
    R
  >,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { dbPath } = yield* ServerConfig.ServerConfig;
      yield* initializeV2Database(dbPath);
      return fromPath(dbPath);
    }),
  );

export const layerConfig = makeLayerConfig(layerFromPath);

/** For CLI commands: pending migrations run only while no server owns the T3 home. */
export const layerCliConfig = makeLayerConfig(
  makeLayerFromPath(() => makeLayerSetup(runMigrationsAsOwner())),
);
