import {
  BOT_FAILURE_DIAGNOSIS_DEFAULT_BRIEF,
  type BotConfigureFailureDiagnosisInput,
  type BotConfigureFailureDiagnosisResult,
  type BotContinuationScope,
  BotError,
  type BotFailureDiagnosisView,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { turnItemText } from "../mcp/OrchestratorMcpService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotRuntimePolicy from "./BotRuntimePolicy.ts";
import * as BotStore from "./BotStore.ts";

export interface FailureDiagnosisRule {
  readonly settings_revision: number;
  readonly enabled: number;
  readonly brief: string;
  readonly enabled_at: string | null;
}

export const readRule = (sql: SqlClient.SqlClient, homeThreadId: string) =>
  sql<FailureDiagnosisRule>`
    SELECT settings_revision, enabled, brief, enabled_at FROM bot_failure_diagnosis
    WHERE home_thread_id = ${homeThreadId}
  `.pipe(Effect.map((rows) => rows[0]));

const RECORD_ITEM_MAX_CHARS = 2_000;
const RECORD_MAX_CHARS = 12_000;

/**
 * The failed run's items, newest kept when they do not all fit. The diagnosis gets them here
 * because a No changes thread cannot call t3_thread_read.
 */
const runRecord = (items: ReadonlyArray<OrchestrationV2TurnItem>) => {
  const lines: Array<string> = [];
  let size = 0;
  for (const item of items.toSorted((left, right) => right.ordinal - left.ordinal)) {
    const text = (turnItemText(item) ?? "").trim();
    const line = `- ${item.type} (${item.status}): ${
      text.length > RECORD_ITEM_MAX_CHARS ? `${text.slice(0, RECORD_ITEM_MAX_CHARS)} […]` : text
    }`;
    if (size + line.length > RECORD_MAX_CHARS) {
      lines.unshift("- […earlier items omitted]");
      break;
    }
    lines.unshift(line);
    size += line.length;
  }
  return lines;
};

/** The first message of a diagnostic task: the user's brief, then the run it is about. */
export const diagnosisPrompt = (input: {
  readonly brief: string;
  readonly failedTaskId: string;
  readonly failedTitle: string;
  readonly workThreadId: string;
  readonly runId: string;
  readonly record: ReadonlyArray<OrchestrationV2TurnItem>;
}) =>
  [
    input.brief,
    "",
    `Failed routine task: ${input.failedTitle} (${input.failedTaskId})`,
    `Its work thread: ${input.workThreadId}`,
    `Failed run: ${input.runId}`,
    "",
    "The failed run's record, oldest first:",
    ...runRecord(input.record),
  ].join("\n");

export class BotFailureDiagnosis extends Context.Service<
  BotFailureDiagnosis,
  {
    readonly get: (scope: BotContinuationScope) => Effect.Effect<BotFailureDiagnosisView, BotError>;
    readonly configure: (
      input: BotConfigureFailureDiagnosisInput,
    ) => Effect.Effect<BotConfigureFailureDiagnosisResult, BotError>;
  }
>()("t3/bots/BotFailureDiagnosis") {}

const invalid = (message: string) => new BotError({ message });
const isBotError = Schema.is(BotError);
const failure = (cause: unknown) =>
  isBotError(cause)
    ? cause
    : new BotError({ message: "Could not read or change failure diagnosis.", cause });

const make = Effect.gen(function* () {
  const sql = yield* BotDatabase.BotDatabase;
  const store = yield* BotStore.BotStore;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const scopeOf = Effect.fn("BotFailureDiagnosis.scope")(function* (scope: BotContinuationScope) {
    const context = yield* store.getContext(scope.botId, scope.projectId);
    const bot = yield* store.getBot(scope.botId);
    if (context === undefined || bot === undefined)
      return yield* invalid("This Bot project context does not exist.");
    // A diagnosis runs on the Bot's model, as the routines it diagnoses do.
    const { instanceId } = yield* BotStore.decodeModelSelection(bot.model_selection_json);
    return {
      home: ThreadId.make(context.home_thread_id),
      active: bot.archived_at === null && context.detached_at === null,
      unavailableReason:
        (yield* BotRuntimePolicy.restrictionUnenforceable(providers, instanceId)) ?? null,
    };
  });

  const get = Effect.fn("BotFailureDiagnosis.get")(function* (scope: BotContinuationScope) {
    const { home, active, unavailableReason } = yield* scopeOf(scope);
    const row = yield* readRule(sql, home);
    return {
      botId: scope.botId,
      projectId: scope.projectId,
      homeThreadId: home,
      revision: row?.settings_revision ?? 0,
      enabled: row?.enabled === 1,
      brief: row?.brief ?? BOT_FAILURE_DIAGNOSIS_DEFAULT_BRIEF,
      unavailableReason,
      writable: active,
    } satisfies BotFailureDiagnosisView;
  }, Effect.mapError(failure));

  const configure = Effect.fn("BotFailureDiagnosis.configure")(function* (
    input: BotConfigureFailureDiagnosisInput,
  ) {
    const scope = { botId: input.botId, projectId: input.projectId };
    const { home, active, unavailableReason } = yield* scopeOf(scope);
    const current = yield* readRule(sql, home);
    if ((current?.settings_revision ?? 0) !== input.baseRevision)
      return { _tag: "conflict", current: yield* get(scope) } as const;
    const currentBrief = current?.brief ?? BOT_FAILURE_DIAGNOSIS_DEFAULT_BRIEF;
    const brief = input.brief ?? currentBrief;
    const wasEnabled = current?.enabled === 1;
    if (input.enabled === wasEnabled && brief === currentBrief)
      return { _tag: "saved", view: yield* get(scope) } as const;
    if (input.enabled && !active)
      return yield* invalid("This Bot is archived or detached, so failure diagnosis stays off.");
    if (input.enabled && !wasEnabled && unavailableReason !== null)
      return yield* invalid(
        "A diagnosis runs No changes, which needs this Bot on Codex with T3 Code running on a Mac, so failure diagnosis stays off.",
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    const committed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const latest = yield* readRule(sql, home);
        if ((latest?.settings_revision ?? 0) !== input.baseRevision) return false;
        // Turning the rule on starts it now; runs that failed while it was off stay undiagnosed.
        yield* sql`INSERT INTO bot_failure_diagnosis (home_thread_id, settings_revision, enabled, brief, enabled_at, updated_at)
          VALUES (${home}, 1, ${input.enabled ? 1 : 0}, ${brief}, ${input.enabled ? now : null}, ${now})
          ON CONFLICT (home_thread_id) DO UPDATE SET settings_revision = settings_revision + 1,
            enabled = excluded.enabled, brief = excluded.brief,
            enabled_at = CASE WHEN excluded.enabled = 0 THEN NULL
              WHEN enabled = 1 THEN enabled_at ELSE excluded.enabled_at END,
            updated_at = excluded.updated_at`;
        return true;
      }),
    );
    if (!committed) return { _tag: "conflict", current: yield* get(scope) } as const;
    return { _tag: "saved", view: yield* get(scope) } as const;
  }, Effect.mapError(failure));

  return BotFailureDiagnosis.of({ get, configure });
});

export const layer = Layer.effect(BotFailureDiagnosis, make).pipe(Layer.provide(BotStore.layer));
