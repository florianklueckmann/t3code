import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpCallerChanges from "../mcp/McpCallerChanges.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotStore from "./BotStore.ts";

export type BotExecutionConstraintValue = "standard" | "no-changes";

/** Direct tasks store allow_changes = 0 too; only a routine's saved choice restricts. */
export const isNoChangesTask = (row: { readonly origin: string; readonly allow_changes: number }) =>
  row.origin === "routine" && row.allow_changes === 0;

/**
 * What a thread may change, from the task row admitted for it. Routine edits, the thread's mode,
 * an archived Bot or a detached project never change an admitted task's answer.
 */
export class BotExecutionConstraint extends Context.Service<
  BotExecutionConstraint,
  {
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<BotExecutionConstraintValue, BotStore.BotStoreError>;
  }
>()("t3/bots/BotExecutionConstraint") {}

const make = Effect.gen(function* () {
  const sql = yield* BotDatabase.BotDatabase;
  return BotExecutionConstraint.of({
    forThread: Effect.fn("BotExecutionConstraint.forThread")(function* (threadId: ThreadId) {
      const rows = yield* sql<{ readonly origin: string; readonly allow_changes: number }>`
        SELECT origin, allow_changes FROM bot_tasks WHERE work_thread_id = ${threadId}
      `.pipe(
        Effect.mapError((cause) => new BotStore.BotStoreError({ operation: "read-task", cause })),
      );
      return rows.some(isNoChangesTask) ? "no-changes" : "standard";
    }),
  });
});

export const layer = Layer.effect(BotExecutionConstraint, make);

/**
 * T3 Code's tools refuse changes for a No changes thread and for one whose task can't be read. A
 * thread whose newest unfinished run is restricted answers with that run's restriction.
 */
export const layerMcpCallerChanges = Layer.effect(
  McpCallerChanges.McpCallerChanges,
  Effect.gen(function* () {
    const constraint = yield* BotExecutionConstraint;
    const main = yield* SqlClient.SqlClient;
    return McpCallerChanges.McpCallerChanges.of({
      forThread: Effect.fn("BotExecutionConstraint.mcpCallerChanges")(
        function* (threadId: ThreadId) {
          if ((yield* constraint.forThread(threadId)) === "no-changes") return "none" as const;
          const rows = yield* main<{ readonly restriction: unknown }>`
            SELECT json_extract(payload_json, '$.restriction') AS restriction
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND status IN ('preparing', 'starting', 'running', 'waiting')
            ORDER BY ordinal DESC LIMIT 1
          `;
          const restriction = rows[0]?.restriction;
          if (restriction === null || restriction === undefined) return "allowed" as const;
          return restriction === "botNote" || restriction === "botWaiting"
            ? restriction
            : ("none" as const);
        },
        (effect, threadId) =>
          effect.pipe(
            Effect.catchTags({
              BotStoreError: (cause) =>
                Effect.logWarning("Refusing T3 tool changes: the caller's task is unreadable.", {
                  threadId,
                  cause,
                }).pipe(Effect.as("none" as const)),
              SqlError: (cause) =>
                Effect.logWarning("Refusing T3 tool changes: the caller's run is unreadable.", {
                  threadId,
                  cause,
                }).pipe(Effect.as("none" as const)),
            }),
          ),
      ),
    });
  }),
).pipe(Layer.provide(layer));
