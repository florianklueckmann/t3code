import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import * as Migrator from "effect/sql/Migrator";
import type { SqlError } from "effect/sql/SqlError";

import * as BotDatabase from "./BotDatabase.ts";

interface Routine {
  readonly task_id: string;
  readonly bot_id: string | null;
  readonly bot_session_at: string | null;
  readonly bot_allow_changes: number;
  readonly schedule_revision: number;
}
interface Intent {
  readonly task_id: string;
  readonly query: string;
  readonly parameters_json: string;
  readonly bot_id: string | null;
  readonly bot_session_at: string | null;
  readonly bot_allow_changes: number;
  readonly schedule_revision: number;
  readonly removing: number;
}
const parameterList = Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]));
const parameters = Schema.fromJsonString(parameterList);
const decodeParameters = Schema.decodeEffect(parameters);
const encodeParameters = Schema.encodeEffect(parameters);
const validateParameters = Schema.decodeUnknownEffect(parameterList);
export class BotRoutineStore extends Context.Service<
  BotRoutineStore,
  {
    readonly get: (
      id: string,
    ) => Effect.Effect<Routine | undefined, SqlError | Migrator.MigrationError>;
    readonly mutate: <A extends object>(
      statement: Statement.Statement<A>,
      input: {
        readonly taskId: string;
        readonly target?:
          | {
              readonly botId: string;
              readonly sessionAt?: string | null | undefined;
              readonly allowChanges?: boolean | undefined;
            }
          | undefined;
        readonly bump: boolean;
        readonly removing?: boolean;
      },
    ) => Effect.Effect<ReadonlyArray<A>, SqlError | Migrator.MigrationError>;
  }
>()("t3/bots/persistence/BotRoutineStore") {}

export const layer = Layer.effect(
  BotRoutineStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bots = yield* BotDatabase.BotDatabase;
    const lock = yield* Semaphore.make(1);
    const read = Effect.fn("BotRoutineStore.read")(function* (id: string) {
      const [row] = yield* bots<Routine>`SELECT * FROM bot_routines WHERE task_id = ${id}`;
      return row;
    });
    const apply = Effect.fn("BotRoutineStore.apply")(function* <A extends object>(intent: Intent) {
      const params = yield* decodeParameters(intent.parameters_json).pipe(
        Effect.mapError(
          () =>
            new Migrator.MigrationError({
              kind: "BadState",
              message:
                "Invalid Bot routine journal parameters. Retain both databases and report this history before retrying.",
            }),
        ),
      );
      const rows = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (intent.removing === 1)
            yield* sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${intent.task_id}`;
          const rows = yield* sql.unsafe<A>(intent.query, params);
          if (intent.removing !== 1 && intent.bot_id !== null) {
            yield* sql`UPDATE scheduled_tasks SET thread_id = NULL, thread_mode = 'new_thread'
              WHERE task_id = ${intent.task_id}`;
          } else if (intent.removing !== 1 && !/\bthread_mode\b/i.test(intent.query)) {
            // Pre-Main80 inserts rely on the new default even when their old binding continues.
            yield* sql`UPDATE scheduled_tasks SET thread_mode = 'continue'
              WHERE task_id = ${intent.task_id} AND thread_id IS NOT NULL AND thread_mode = 'new_thread'`;
          }
          return rows;
        }),
      );
      const [checkpoint] = yield* sql<{ readonly busy: number }>`PRAGMA wal_checkpoint(FULL)`;
      if (checkpoint?.busy !== 0)
        return yield* new Migrator.MigrationError({
          kind: "Locked",
          message:
            "Bot routine changes are pending a T3 database checkpoint. Stop other builds using this T3 home, then retry.",
        });
      yield* bots.withTransaction(
        Effect.gen(function* () {
          if (intent.removing === 1) {
            yield* bots`DELETE FROM bot_routines WHERE task_id = ${intent.task_id}`;
          } else if (rows.length > 0) {
            yield* bots`INSERT INTO bot_routines (task_id, bot_id, bot_session_at, schedule_revision, bot_allow_changes)
          VALUES (${intent.task_id}, ${intent.bot_id}, ${intent.bot_session_at}, ${intent.schedule_revision}, ${intent.bot_allow_changes})
          ON CONFLICT(task_id) DO UPDATE SET bot_id = excluded.bot_id,
            bot_session_at = excluded.bot_session_at, schedule_revision = excluded.schedule_revision,
            bot_allow_changes = excluded.bot_allow_changes`;
          }
          yield* bots`DELETE FROM bot_routine_intent WHERE singleton = 1`;
        }),
      );
      return rows;
    });
    const recover = Effect.fn("BotRoutineStore.recover")(function* () {
      const [pending] = yield* bots<Intent>`SELECT * FROM bot_routine_intent`;
      if (pending) yield* apply(pending);
    });
    // Layer acquisition precedes scheduler recovery and registration.
    yield* recover();
    const mutate: BotRoutineStore["Service"]["mutate"] = <A extends object>(
      statement: Statement.Statement<A>,
      input: Parameters<BotRoutineStore["Service"]["mutate"]>[1],
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* recover();
          const current = yield* read(input.taskId);
          if (!current && !input.target) {
            if (!input.removing) return yield* statement;
            return yield* sql.withTransaction(
              sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${input.taskId}`.pipe(
                Effect.andThen(statement),
              ),
            );
          }
          const [query, params] = statement.compile();
          const intent: Intent = {
            task_id: input.taskId,
            query,
            parameters_json: yield* validateParameters(params).pipe(
              Effect.flatMap(encodeParameters),
              Effect.mapError(
                () =>
                  new Migrator.MigrationError({
                    kind: "BadState",
                    message: "Cannot encode Bot routine journal parameters.",
                  }),
              ),
            ),
            bot_id: input.target?.botId ?? null,
            bot_session_at: input.target?.sessionAt ?? null,
            bot_allow_changes: input.target?.allowChanges ? 1 : 0,
            schedule_revision: (current?.schedule_revision ?? 0) + (current && input.bump ? 1 : 0),
            removing: input.removing ? 1 : 0,
          };
          yield* bots`INSERT INTO bot_routine_intent ${bots.insert({ singleton: 1, ...intent })}`;
          return yield* apply<A>(intent);
        }),
      );
    const get = Effect.fn("BotRoutineStore.get")(function* (id: string) {
      return yield* bots.withTransaction(
        Effect.gen(function* () {
          const pending = yield* bots`SELECT singleton FROM bot_routine_intent`;
          if (pending.length > 0)
            return yield* new Migrator.MigrationError({
              kind: "Locked",
              message: "A Bot routine change is pending. Restart the server to finish recovery.",
            });
          return yield* read(id);
        }),
      );
    });
    return BotRoutineStore.of({ get, mutate });
  }),
);
