import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as BotDatabase from "./BotDatabase.ts";
import * as BotRoutineStore from "./BotRoutineStore.ts";

it.effect.each(["before-main", "after-main"])(
  "recovers a routine mutation interrupted %s without incrementing its revision twice",
  (stage) =>
    Effect.gen(function* () {
      const main = yield* SqlClient.SqlClient;
      const bots = yield* BotDatabase.BotDatabase;
      const store = yield* BotRoutineStore.BotRoutineStore;
      yield* main`CREATE TABLE routine_probe (task_id TEXT PRIMARY KEY, enabled INTEGER)`;
      yield* main`INSERT INTO routine_probe VALUES ('routine', 1)`;
      yield* bots`INSERT INTO bot_routines (task_id, bot_id, bot_session_at, schedule_revision) VALUES ('routine', 'bot', 'session', 9)`;
      if (stage === "before-main")
        yield* main`CREATE TRIGGER stop_update BEFORE UPDATE ON routine_probe BEGIN SELECT RAISE(ABORT, 'injected interruption'); END`;
      else
        yield* bots`CREATE TRIGGER stop_metadata BEFORE UPDATE ON bot_routines BEGIN SELECT RAISE(ABORT, 'injected interruption'); END`;
      const failed = yield* store
        .mutate(
          main`UPDATE routine_probe SET enabled = 0 WHERE task_id = 'routine' RETURNING task_id`,
          {
            taskId: "routine",
            target: { botId: "bot", sessionAt: "session", allowChanges: true },
            bump: true,
          },
        )
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.deepStrictEqual(yield* main`SELECT enabled FROM routine_probe`, [
        { enabled: stage === "before-main" ? 1 : 0 },
      ]);
      assert.deepStrictEqual(yield* bots`SELECT schedule_revision FROM bot_routines`, [
        { schedule_revision: 9 },
      ]);
      assert.deepStrictEqual(yield* bots`SELECT bot_allow_changes FROM bot_routine_intent`, [
        { bot_allow_changes: 1 },
      ]);
      assert.equal((yield* store.get("routine").pipe(Effect.result))._tag, "Failure");
      if (stage === "before-main") yield* main`DROP TRIGGER stop_update`;
      else yield* bots`DROP TRIGGER stop_metadata`;
      for (let restart = 0; restart < 2; restart++) {
        yield* Effect.gen(function* () {
          const recovered = yield* BotRoutineStore.BotRoutineStore;
          assert.equal((yield* recovered.get("routine"))?.schedule_revision, 10);
          assert.equal((yield* recovered.get("routine"))?.bot_allow_changes, 1);
          assert.deepStrictEqual(yield* main`SELECT enabled FROM routine_probe`, [{ enabled: 0 }]);
          assert.lengthOf(yield* bots`SELECT * FROM bot_routine_intent`, 0);
        }).pipe(Effect.provide(Layer.fresh(BotRoutineStore.layer)));
      }
      yield* store.mutate(main`UPDATE routine_probe SET enabled = 1 RETURNING task_id`, {
        taskId: "routine",
        bump: true,
      });
      assert.equal((yield* store.get("routine"))?.bot_id, null);
      assert.equal((yield* store.get("routine"))?.bot_allow_changes, 0);
      assert.equal((yield* store.get("routine"))?.schedule_revision, 11);
      yield* store.mutate(main`UPDATE routine_probe SET enabled = 0 RETURNING task_id`, {
        taskId: "routine",
        target: { botId: "bot" },
        bump: true,
      });
      assert.equal((yield* store.get("routine"))?.schedule_revision, 12);
      yield* store.mutate(main`DELETE FROM routine_probe WHERE task_id = 'routine'`, {
        taskId: "routine",
        bump: false,
        removing: true,
      });
      assert.isUndefined(yield* store.get("routine"));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
