import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BotDatabase from "./persistence/BotDatabase.ts";

/** Which threads are Bot Homes, whose activity starts serialize with maintenance on the Home lock. */
export class BotHomes extends Context.Service<
  BotHomes,
  { readonly isHome: (threadId: ThreadId) => Effect.Effect<boolean> }
>()("t3/bots/BotHomes") {}

export const layer = Layer.effect(
  BotHomes,
  Effect.gen(function* () {
    const sql = yield* BotDatabase.BotDatabase;
    return BotHomes.of({
      isHome: Effect.fn("BotHomes.isHome")(function* (threadId: ThreadId) {
        const rows =
          yield* sql`SELECT 1 FROM bot_project_contexts WHERE home_thread_id = ${threadId} LIMIT 1`.pipe(
            // Serializing a thread that is not a Home only waits; skipping a Home's lock is unsafe.
            Effect.orElseSucceed(() => [{}]),
          );
        return rows.length > 0;
      }),
    });
  }),
);
