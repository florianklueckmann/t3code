import {
  type BotId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2RunJson,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { isUserHomeInput } from "../bots/homeReturn.ts";
import * as BotDatabase from "../bots/persistence/BotDatabase.ts";

const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeMessages = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.fromJsonString(OrchestrationV2ConversationMessageJson)),
  ),
);
const MAX_WRITES = 3;

interface ReceiptKey {
  readonly runId: RunId;
  readonly fingerprint: string;
}

type Reservation =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly result: string | null }
  | { readonly kind: "limit" };

export class CalendarWriteStore extends Context.Service<
  CalendarWriteStore,
  {
    readonly currentTurn: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly budgetRunId: RunId; readonly startedByUser: boolean } | undefined,
      SqlError.SqlError
    >;
    readonly reserve: (
      input: ReceiptKey & { readonly botId: BotId; readonly calendarId: string },
    ) => Effect.Effect<Reservation, SqlError.SqlError>;
    readonly ownerMarker: (
      botId: BotId,
      calendarId: string,
      reference: string,
    ) => Effect.Effect<string | undefined, SqlError.SqlError>;
    readonly complete: (
      key: ReceiptKey,
      result: string,
      ownership: { readonly reference: string; readonly marker: string } | undefined,
      rejected?: boolean,
    ) => Effect.Effect<void, SqlError.SqlError>;
  }
>()("t3/calendar/CalendarWriteStore") {}

const make = Effect.gen(function* () {
  const main = yield* SqlClient.SqlClient;
  const bots = yield* BotDatabase.BotDatabase;

  const currentTurn = Effect.fn("CalendarWriteStore.currentTurn")(function* (threadId: ThreadId) {
    const [current] = yield* main<{ readonly run: string; readonly messages: string }>`
      SELECT r.payload_json AS run, (
        SELECT json_group_array(m.payload_json) FROM orchestration_v2_projection_messages m
        WHERE m.run_id = r.run_id AND m.thread_id = r.thread_id AND m.role = 'user'
      ) AS messages
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      WHERE r.thread_id = ${threadId} AND r.status IN ('starting', 'running', 'waiting')
        AND t.archived_at IS NULL AND t.deleted_at IS NULL
      ORDER BY r.ordinal DESC LIMIT 1
    `;
    if (current === undefined) return undefined;
    const run = Option.getOrUndefined(decodeRun(current.run));
    if (run === undefined || run.restriction !== undefined || run.delegatedTaskId !== undefined) {
      return undefined;
    }
    let budgetRun = run;
    for (let depth = 0; depth < 16; depth++) {
      const predecessor =
        budgetRun.restartContinuationOfRunId ??
        budgetRun.usageLimitContinuationOfRunId ??
        budgetRun.manualContinuationOfRunId;
      if (predecessor === undefined) break;
      if (depth === 15) return undefined;
      const [row] = yield* main<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE run_id = ${predecessor} AND thread_id = ${threadId}
      `;
      const parent =
        row === undefined ? undefined : Option.getOrUndefined(decodeRun(row.payload_json));
      if (
        parent === undefined ||
        parent.ordinal >= budgetRun.ordinal ||
        parent.restriction !== undefined
      ) {
        return undefined;
      }
      budgetRun = parent;
    }

    const messages = Option.getOrUndefined(decodeMessages(current.messages));
    return {
      budgetRunId: budgetRun.id,
      startedByUser:
        run.id === budgetRun.id &&
        messages?.some((message) => message.id === run.userMessageId) === true &&
        messages.every(
          (message) => isUserHomeInput(message) && message.context?.guest === undefined,
        ),
    };
  });

  const reserve = Effect.fn("CalendarWriteStore.reserve")(function* (
    input: ReceiptKey & { readonly botId: BotId; readonly calendarId: string },
  ) {
    return yield* bots.withTransaction(
      Effect.gen(function* () {
        const [row] = yield* bots<{ readonly result_json: string | null }>`
        SELECT result_json FROM bot_calendar_writes
        WHERE run_id = ${input.runId} AND fingerprint = ${input.fingerprint}
      `;
        if (row !== undefined) return { kind: "existing", result: row.result_json } as const;
        const [count] = yield* bots<{ readonly value: number }>`
        SELECT COUNT(*) AS value FROM bot_calendar_writes
        WHERE run_id = ${input.runId} AND rejected = 0
      `;
        if (count === undefined || count.value >= MAX_WRITES) return { kind: "limit" } as const;
        yield* bots`
        INSERT INTO bot_calendar_writes (run_id, fingerprint, bot_id, calendar_id)
        VALUES (${input.runId}, ${input.fingerprint}, ${input.botId}, ${input.calendarId})
      `;
        return { kind: "new" } as const;
      }),
    );
  });

  const ownerMarker = Effect.fn("CalendarWriteStore.ownerMarker")(function* (
    botId: BotId,
    calendarId: string,
    reference: string,
  ) {
    const [row] = yield* bots<{ readonly ownership_marker: string }>`
      SELECT ownership_marker FROM bot_calendar_writes
      WHERE bot_id = ${botId} AND calendar_id = ${calendarId} AND owned_reference = ${reference}
        AND ownership_marker IS NOT NULL LIMIT 1
    `;
    return row?.ownership_marker;
  });

  const complete = Effect.fn("CalendarWriteStore.complete")(function* (
    key: ReceiptKey,
    result: string,
    ownership: { readonly reference: string; readonly marker: string } | undefined,
    rejected = false,
  ) {
    yield* bots`
      UPDATE bot_calendar_writes
      SET result_json = ${result}, owned_reference = ${ownership?.reference ?? null},
          ownership_marker = ${ownership?.marker ?? null}, rejected = ${rejected ? 1 : 0}
      WHERE run_id = ${key.runId} AND fingerprint = ${key.fingerprint}
    `;
  });

  return CalendarWriteStore.of({ currentTurn, reserve, ownerMarker, complete });
});

export const layer = Layer.effect(CalendarWriteStore, make);
