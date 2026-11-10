import {
  BOT_TASK_TERMINAL_STATUSES,
  type BotConfigureMaintenanceInput,
  type BotConfigureMaintenanceResult,
  type BotContinuationScope,
  BotError,
  type BotMaintenanceView,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotStore from "./BotStore.ts";

/** Why maintenance cannot generate here; null only where a real tool-free generator is wired. */
interface Generation {
  readonly unavailableReason: string | null;
}

interface StateRow {
  readonly settings_revision: number;
  readonly enabled: number;
  readonly started_at: string | null;
}

export class BotMaintenance extends Context.Service<
  BotMaintenance,
  {
    readonly get: (scope: BotContinuationScope) => Effect.Effect<BotMaintenanceView, BotError>;
    readonly configure: (
      input: BotConfigureMaintenanceInput,
    ) => Effect.Effect<BotConfigureMaintenanceResult, BotError>;
  }
>()("t3/bots/BotMaintenance") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const terminalTaskStatuses = encodeJson([...BOT_TASK_TERMINAL_STATUSES]);
const invalid = (message: string) => new BotError({ message });
const isBotError = Schema.is(BotError);
const failure = (cause: unknown) =>
  isBotError(cause)
    ? cause
    : new BotError({ message: "Could not read or change Bot maintenance.", cause });

export const make = Effect.fn("BotMaintenance.make")(function* (generation: Generation) {
  const main = yield* SqlClient.SqlClient;
  const sql = yield* BotDatabase.BotDatabase;
  const store = yield* BotStore.BotStore;
  const events = yield* EventStore.EventStoreV2;
  const homeCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

  const scopeOf = Effect.fn("BotMaintenance.scope")(function* (scope: BotContinuationScope) {
    const context = yield* store.getContext(scope.botId, scope.projectId);
    const bot = yield* store.getBot(scope.botId);
    if (context === undefined || bot === undefined)
      return yield* invalid("This Bot project context does not exist.");
    return {
      home: ThreadId.make(context.home_thread_id),
      active: bot.archived_at === null && context.detached_at === null,
    };
  });
  const stateRow = (home: ThreadId) =>
    sql<StateRow>`SELECT settings_revision, enabled, started_at FROM bot_maintenance WHERE home_thread_id = ${home}`.pipe(
      Effect.map((rows) => rows[0]),
    );

  // Bot metadata only: an off or paused Bot never reads its Home transcript here.
  const get = Effect.fn("BotMaintenance.get")(function* (scope: BotContinuationScope) {
    const { home, active } = yield* scopeOf(scope);
    const row = yield* stateRow(home);
    return {
      botId: scope.botId,
      projectId: scope.projectId,
      homeThreadId: home,
      revision: row?.settings_revision ?? 0,
      enabled: row?.enabled === 1,
      startedAt: row?.started_at ?? null,
      unavailableReason: generation.unavailableReason,
      writable: active,
    } satisfies BotMaintenanceView;
  }, Effect.mapError(failure));

  const configure = Effect.fn("BotMaintenance.configure")(function* (
    input: BotConfigureMaintenanceInput,
  ) {
    const scope = { botId: input.botId, projectId: input.projectId };
    const { home, active } = yield* scopeOf(scope);
    if (input.enabled && generation.unavailableReason !== null)
      return yield* invalid(
        "Bot maintenance is not available on this server yet. It needs a tool-free model profile, so it stays off.",
      );
    const current = yield* stateRow(home);
    if ((current?.settings_revision ?? 0) !== input.baseRevision)
      return { _tag: "conflict", current: yield* get(scope) } as const;
    if (input.enabled === (current?.enabled === 1))
      return { _tag: "saved", view: yield* get(scope) } as const;
    if (input.enabled && !active)
      return yield* invalid("This Bot is archived or detached, so maintenance stays off.");
    const now = DateTime.formatIso(yield* DateTime.now);

    const commit = (
      baseline: { readonly sequence: number; readonly messageIds: readonly string[] } | null,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (input.enabled && !(yield* scopeOf(scope)).active)
            return yield* invalid("This Bot is archived or detached, so maintenance stays off.");
          const latest = yield* stateRow(home);
          if ((latest?.settings_revision ?? 0) !== input.baseRevision) return false;
          if (baseline === null) {
            // Pause and resume keep the floors and receipts; nothing is reset or backfilled.
            yield* sql`UPDATE bot_maintenance SET enabled = ${input.enabled ? 1 : 0}, settings_revision = settings_revision + 1, updated_at = ${now} WHERE home_thread_id = ${home}`;
            return true;
          }
          yield* sql`INSERT INTO bot_maintenance (home_thread_id, settings_revision, enabled, started_at, scan_through_sequence, processed_through_sequence, updated_at)
              VALUES (${home}, 1, 1, ${now}, ${baseline.sequence}, ${baseline.sequence}, ${now})`;
          yield* sql`INSERT INTO bot_maintenance_sources (home_thread_id, kind, source_id, state, recorded_at)
              SELECT ${home}, 'home-input', value, 'baseline', ${now} FROM json_each(${encodeJson(baseline.messageIds)})`;
          yield* sql`INSERT INTO bot_maintenance_sources (home_thread_id, kind, source_id, state, recorded_at)
              SELECT home_thread_id, 'task-result', task_id, 'baseline', ${now} FROM bot_tasks
              WHERE home_thread_id = ${home} AND status IN (SELECT value FROM json_each(${terminalTaskStatuses}))`;
          return true;
        }),
      );

    // First enable fixes the baseline: every Home input admitted so far, queued or failed
    // ones included, and every finished task. Main reads finish before the Bot transaction.
    const committed =
      current === undefined
        ? yield* homeCommands.withLock(
            home,
            Effect.gen(function* () {
              // Sequence first: an input committed after it is either in the list or above it.
              const sequence = yield* events.latestSequence({ threadId: home });
              const messages = yield* main<{
                readonly message_id: string;
              }>`SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id = ${home} AND role = 'user'`;
              return yield* commit({
                sequence,
                messageIds: messages.map((row) => row.message_id),
              });
            }),
          )
        : yield* commit(null);
    if (!committed) return { _tag: "conflict", current: yield* get(scope) } as const;
    return { _tag: "saved", view: yield* get(scope) } as const;
  }, Effect.mapError(failure));

  return BotMaintenance.of({ get, configure });
});

// Generation needs the sealed tool-free Codex operation, which is not wired yet, so enabling is refused.
export const layer = Layer.effect(
  BotMaintenance,
  make({ unavailableReason: "no_tool_profile_unavailable" }),
).pipe(Layer.provide(BotStore.layer));
