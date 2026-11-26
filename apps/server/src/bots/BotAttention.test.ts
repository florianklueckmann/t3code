import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BotConfigureAttentionInput, BotId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as BotAttention from "./BotAttention.ts";
import * as BotStore from "./BotStore.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";

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

const alert = (
  n: number,
  phase: "completed" | "failed" = "completed",
  endedAt: string | null = null,
) => ({
  botId,
  taskId: `bot-task:${n}`,
  runId: `run-${n}`,
  workThreadId: `bot-work:${n}`,
  homeThreadId: "bot-home:bot:project",
  phase,
  endedAt: endedAt === null ? null : DateTime.makeUnsafe(endedAt),
});

/** Decoded as the RPC decodes it, so the contract's bounds apply. */
const decodeConfigureInput = Schema.decodeEffect(BotConfigureAttentionInput);

const configure = Effect.fn("fixture.configure")(function* (
  attention: BotAttention.BotAttention["Service"],
  change: {
    readonly dailyLimit?: number;
    readonly quietHours?: { start: string; end: string } | null;
  },
) {
  const view = yield* attention.get(botId);
  const input = yield* decodeConfigureInput({
    botId,
    baseRevision: view.revision,
    dailyLimit: change.dailyLimit ?? view.dailyLimit,
    quietHours: change.quietHours === undefined ? view.quietHours : change.quietHours,
    remit: view.remit,
  });
  const result = yield* attention.configure(input);
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
    assert.deepInclude(yield* restarted.status(botId), {
      ...view,
      quietNow: false,
      limitReached: true,
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

    // A limit above ten is saved and caps the same day: ten more go out, the 13th is held.
    yield* configure(restarted, { dailyLimit: 12 });
    const raised = [];
    for (let n = 8; n <= 18; n++) raised.push(yield* restarted.admit(alert(n)));
    assert.deepEqual(raised, [...Array<string>(10).fill("send"), "hold"]);
    assert.deepInclude(yield* restarted.get(botId), {
      dailyLimit: 12,
      sentToday: 12,
      held: 1,
    });
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
    assert.deepInclude(yield* attention.status(botId), { quietNow: false, timeZone: "+00:00" });
    assert.equal(yield* attention.admit(alert(1)), "send");
    yield* at("2026-11-02T22:00:00.000Z");
    assert.deepInclude(yield* attention.status(botId), { quietNow: true, limitReached: false });
    assert.equal(yield* attention.admit(alert(2, "failed")), "hold");
    yield* at("2026-11-03T06:59:00.000Z");
    assert.equal(yield* attention.admit(alert(3)), "hold");
    assert.lengthOf(yield* attention.claimDigests, 0);
    assert.equal((yield* attention.get(botId)).digestAt, "2026-11-03T07:00:00.000Z");

    yield* at("2026-11-03T07:00:00.000Z");
    const due = yield* attention.claimDigests;
    assert.lengthOf(due, 1);
    assert.deepInclude(due[0]!, { held: 2, allFailed: false });
    assert.isTrue(yield* attention.canSendDigest(due[0]!));
    // Quiet hours saved while the digest waits to go out hold it again.
    yield* configure(attention, { quietHours: { start: "06:00", end: "08:00" } });
    assert.isFalse(yield* attention.canSendDigest(due[0]!));
    yield* configure(attention, { quietHours: { start: "22:00", end: "07:00" } });
    // Too close to the relay's freshness limit to land in time.
    yield* at("2026-11-03T07:01:30.000Z");
    assert.isFalse(yield* attention.canSendDigest(due[0]!));
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
      assert.isFalse(yield* attention.canSendDigest(digest!));
      assert.isTrue(yield* attention.canSendDigest(reclaimed!));
      yield* attention.markDigestSent(reclaimed!);
      assert.deepInclude(yield* attention.get(botId), {
        held: 1,
        digestAt: "2026-11-05T07:00:00.000Z",
      });
    }).pipe(Effect.provide(services)),
);

it.effect(
  "prunes decisions nothing reads any more and keeps a held alert until its digest went out",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const bots = yield* BotDatabase.BotDatabase;
      const keys = bots<{ readonly alert_key: string }>`SELECT alert_key FROM bot_alerts
        ORDER BY alert_key`.pipe(Effect.map((rows) => rows.map((row) => row.alert_key)));
      yield* at("2026-11-02T12:00:00.000Z");
      const attention = yield* startService;
      yield* configure(attention, { dailyLimit: 1, quietHours: null });
      assert.equal(
        yield* attention.admit(alert(1, "completed", "2026-11-02T11:59:00.000Z")),
        "send",
      );
      assert.equal(
        yield* attention.admit(alert(2, "completed", "2026-11-02T11:59:00.000Z")),
        "hold",
      );
      yield* at("2026-11-03T00:00:00.000Z");
      const [digest] = yield* attention.claimDigests;
      yield* attention.markDigestSent(digest!);
      yield* at("2026-11-03T12:00:00.000Z");
      assert.equal(
        yield* attention.admit(alert(3, "completed", "2026-11-03T11:59:00.000Z")),
        "send",
      );
      assert.equal(yield* attention.admit(alert(4, "failed", "2026-11-03T11:59:00.000Z")), "hold");

      // Publishing was off for ten days, so the second digest never went out.
      yield* at("2026-11-13T12:00:00.000Z");
      assert.equal(
        yield* attention.admit(alert(5, "completed", "2026-11-13T11:59:00.000Z")),
        "send",
      );
      assert.deepEqual(yield* keys, ["bot-task:4:run-4", "bot-task:5:run-5"]);
      assert.deepInclude(yield* attention.get(botId), { sentToday: 1, held: 1 });

      // A repeated publish of a pruned run decides nothing anew: no count, no second digest.
      assert.equal(
        yield* attention.admit(alert(1, "completed", "2026-11-02T11:59:00.000Z")),
        "send",
      );
      assert.equal(
        yield* attention.admit(alert(2, "completed", "2026-11-02T11:59:00.000Z")),
        "send",
      );
      // A kept decision still wins over the run's age.
      assert.equal(yield* attention.admit(alert(4, "failed", "2026-11-03T11:59:00.000Z")), "hold");
      assert.deepEqual(yield* keys, ["bot-task:4:run-4", "bot-task:5:run-5"]);
      assert.deepInclude(yield* attention.get(botId), { sentToday: 1, held: 1 });
      const [held] = yield* attention.claimDigests;
      assert.deepInclude(held!, { held: 1, allFailed: true });
    }).pipe(Effect.provide(services)),
);
