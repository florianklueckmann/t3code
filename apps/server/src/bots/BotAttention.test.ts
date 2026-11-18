import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BotId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as BotAttention from "./BotAttention.ts";
import * as BotStore from "./BotStore.ts";

const botId = BotId.make("bot");
const created = "2026-11-01T06:00:00.000Z";
const database = Sqlite.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-attention-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const services = BotStore.layer.pipe(Layer.provideMerge(database));
const at = (iso: string) => TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));

const seed = Effect.gen(function* () {
  const store = yield* BotStore.BotStore;
  yield* store.insertBot({
    bot_id: botId,
    name: "Companion",
    instructions: "",
    model_selection_json: '{"instanceId":"codex","model":"gpt-6-luna"}',
    learning_policy: "after_adoption",
    appearance_json: null,
    created_at: created,
    updated_at: created,
    archived_at: null,
  });
});

/** A fresh service over the same database, as a server restart builds it, in UTC. */
const startService = BotAttention.make.pipe(Effect.provide(DateTime.layerCurrentZoneOffset(0)));

const alert = (n: number, phase: "completed" | "failed" = "completed") => ({
  botId,
  taskId: `bot-task:${n}`,
  runId: `run-${n}`,
  workThreadId: `bot-work:${n}`,
  homeThreadId: "bot-home:bot:project",
  phase,
});

const configure = Effect.fn("fixture.configure")(function* (
  attention: BotAttention.BotAttention["Service"],
  change: {
    readonly dailyLimit?: number;
    readonly quietHours?: { start: string; end: string } | null;
  },
) {
  const view = yield* attention.get(botId);
  const result = yield* attention.configure({
    botId,
    baseRevision: view.revision,
    dailyLimit: change.dailyLimit ?? view.dailyLimit,
    quietHours: change.quietHours === undefined ? view.quietHours : change.quietHours,
    remit: view.remit,
  });
  if (result._tag !== "saved") return yield* Effect.die(result);
});

it.effect("caps proactive alerts per local day, deciding each run once across a restart", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* at("2026-11-02T12:00:00.000Z");
    const attention = yield* startService;
    yield* configure(attention, { quietHours: null });
    const decisions = [];
    for (const n of [1, 2, 3, 4]) decisions.push(yield* attention.admit(alert(n)));
    assert.deepEqual(decisions, ["send", "send", "send", "hold"]);
    // A repeated publish of the same run decides nothing new.
    assert.equal(yield* attention.admit(alert(3)), "send");

    const restarted = yield* startService;
    assert.equal(yield* restarted.admit(alert(4)), "hold");
    assert.equal(yield* restarted.admit(alert(5)), "hold");
    const view = yield* restarted.get(botId);
    assert.deepInclude(view, {
      sentToday: 3,
      held: 2,
      digestAt: "2026-11-03T00:00:00.000Z",
    });

    // Without quiet hours the held alerts go out as the next local day starts, outside the cap.
    yield* at("2026-11-02T23:59:59.000Z");
    assert.lengthOf(yield* restarted.claimDigests, 0);
    yield* at("2026-11-03T00:00:00.000Z");
    const [digest] = yield* restarted.claimDigests;
    assert.deepInclude(digest!, {
      held: 2,
      allFailed: false,
      homeThreadId: ThreadId.make("bot-home:bot:project"),
      digestAt: "2026-11-03T00:00:00.000Z",
    });
    // An unsent claim keeps its identity for a retry.
    yield* at("2026-11-03T00:00:05.000Z");
    assert.deepEqual(yield* restarted.claimDigests, [digest!]);
    yield* restarted.markDigestSent(digest!);
    assert.lengthOf(yield* restarted.claimDigests, 0);
    assert.deepEqual(
      [yield* restarted.admit(alert(6)), yield* restarted.admit(alert(7))],
      ["send", "send"],
    );
    assert.deepInclude(yield* restarted.get(botId), { sentToday: 2, held: 0, digestAt: null });
  }).pipe(Effect.provide(services)),
);

it.effect("holds alerts through quiet hours across midnight and sends one digest as they end", () =>
  Effect.gen(function* () {
    yield* seed;
    const attention = yield* startService;
    // Defaults: three a day, quiet from 22:00 to 07:00.
    assert.deepInclude(yield* attention.get(botId), {
      dailyLimit: 3,
      quietHours: { start: "22:00", end: "07:00" },
    });
    yield* at("2026-11-02T21:59:00.000Z");
    assert.equal(yield* attention.admit(alert(1)), "send");
    yield* at("2026-11-02T22:00:00.000Z");
    assert.equal(yield* attention.admit(alert(2, "failed")), "hold");
    yield* at("2026-11-03T06:59:00.000Z");
    assert.equal(yield* attention.admit(alert(3)), "hold");
    assert.lengthOf(yield* attention.claimDigests, 0);
    assert.equal((yield* attention.get(botId)).digestAt, "2026-11-03T07:00:00.000Z");

    yield* at("2026-11-03T07:00:00.000Z");
    const due = yield* attention.claimDigests;
    assert.lengthOf(due, 1);
    assert.deepInclude(due[0]!, { held: 2, allFailed: false });
    yield* attention.markDigestSent(due[0]!);
    assert.lengthOf(yield* attention.claimDigests, 0);
    // The digest counted against nothing: the new day still has its whole cap.
    assert.equal(yield* attention.admit(alert(4)), "send");
    assert.deepInclude(yield* attention.get(botId), { sentToday: 1, held: 0 });
  }).pipe(Effect.provide(services)),
);

it.effect(
  "an overdue digest waits out quiet hours and takes only alerts whose release passed",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* at("2026-11-02T12:00:00.000Z");
      const attention = yield* startService;
      yield* configure(attention, { dailyLimit: 0 });
      assert.equal(yield* attention.admit(alert(1, "failed")), "hold");
      // The server was off through the release at 07:00 and is back during the next quiet hours.
      yield* at("2026-11-03T23:00:00.000Z");
      assert.lengthOf(yield* attention.claimDigests, 0);
      yield* at("2026-11-04T07:00:00.000Z");
      assert.equal(yield* attention.admit(alert(2)), "hold");
      yield* at("2026-11-04T07:00:04.000Z");
      const [digest] = yield* attention.claimDigests;
      assert.deepInclude(digest!, { held: 1, allFailed: true });
      // A claim the relay never confirmed gets a new identity once it is too old to alert.
      yield* at("2026-11-04T07:02:04.000Z");
      const [reclaimed] = yield* attention.claimDigests;
      assert.deepInclude(reclaimed!, { held: 1, digestAt: "2026-11-04T07:02:04.000Z" });
      assert.isFalse(yield* attention.isDigestPending(digest!));
      yield* attention.markDigestSent(reclaimed!);
      assert.deepInclude(yield* attention.get(botId), {
        held: 1,
        digestAt: "2026-11-05T07:00:00.000Z",
      });
    }).pipe(Effect.provide(services)),
);
