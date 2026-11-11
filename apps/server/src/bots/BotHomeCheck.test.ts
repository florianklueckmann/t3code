import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  BotError,
  RunId,
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as OrchestratorV2 from "../orchestration-v2/Orchestrator.ts";
import * as BotTaskService from "./BotTaskService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as BotContinuation from "./BotContinuation.ts";
import * as BotHomeCheck from "./BotHomeCheck.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotStore from "./BotStore.ts";

const scope = { botId: BotId.make("bot"), projectId: ProjectId.make("project") };
const home = ThreadId.make("bot-home:bot:project");
const created = "2026-11-01T06:00:00.000Z";
const database = Sqlite.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-home-check-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const services = Layer.merge(BotStore.layer, BotContinuation.layer).pipe(
  Layer.provideMerge(database),
);
const at = (iso: string) => TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));
const onMac = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(HostProcess.Platform, "darwin"));

/** A Bot with a Codex Home that already has a conversation, as a check needs. */
const seed = Effect.fn("fixture.seed")(function* (
  lifecycle: { readonly archivedAt?: string; readonly snoozedUntil?: string } = {},
) {
  const store = yield* BotStore.BotStore;
  yield* store.insertBot({
    bot_id: "bot",
    name: "Companion",
    instructions: "",
    model_selection_json: '{"instanceId":"codex","model":"gpt-6-luna"}',
    learning_policy: "after_adoption",
    appearance_json: null,
    created_at: created,
    updated_at: created,
    archived_at: null,
  });
  yield* store.upsertContext({
    home_thread_id: home,
    bot_id: "bot",
    project_id: "project",
    guidance: "",
    sources_json: "[]",
    revision: 1,
    thread_sync: null,
    attached_at: created,
    detached_at: null,
    updated_at: created,
  });
  const main = yield* SqlClient.SqlClient;
  yield* main`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES (${home}, 'project', 'Home', 'codex', 'full-access', 'default', ${created}, ${created}, ${lifecycle.archivedAt ?? null}, NULL,
      ${JSON.stringify({ snoozedUntil: lifecycle.snoozedUntil ?? null })})`;
  yield* main`UPDATE orchestration_v2_projection_threads SET provider_instance_id = 'codex' WHERE thread_id = ${home}`;
});

/** A Home event committed at the test clock's current time. */
const homeEvent = Effect.gen(function* () {
  const main = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const [row] = yield* main<{ readonly sequence: number }>`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
    VALUES ('event-' || lower(hex(randomblob(8))), 'thread', ${home},
      (SELECT COALESCE(MAX(stream_version), -1) + 1 FROM orchestration_events WHERE stream_id = ${home}),
      'thread.updated', ${now}, 'server', '{}', '{}', 2)
    RETURNING sequence`;
  return row!.sequence;
});

/** The user's own Home message, which a check may quote. */
const userMessage = Effect.fn("fixture.userMessage")(function* (id: string, text: string) {
  const main = yield* SqlClient.SqlClient;
  const run = `run-${id}`;
  yield* main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
    VALUES (${run}, ${home}, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${home}), 'codex', 'completed', ${created}, '{}')`;
  yield* main`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${id}, ${home}, ${run}, 'user', 0, ${created}, ${created}, ${JSON.stringify({ id, threadId: home, runId: run, nodeId: null, role: "user", text, attachments: [], streaming: false, createdAt: created, updatedAt: created, createdBy: "user", creationSource: "web" })})`;
  yield* main`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
    VALUES (${`item-${id}`}, ${home}, ${run}, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_turn_items WHERE thread_id = ${home}), 'user_message', 'completed', ${created}, ${JSON.stringify({ messageId: id })})`;
});

/**
 * The orchestrator as a check sees it: a command id already received replays, and a scoped run
 * starts only when nothing holds the Home and no event committed after the captured sequence.
 */
const orchestrator = Effect.gen(function* () {
  const main = yield* SqlClient.SqlClient;
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const receipts = yield* Ref.make<ReadonlySet<string>>(new Set());
  const busy = yield* Ref.make(false);
  /** Fails the next dispatch after it committed, as a crash before the caller's own write. */
  const crashAfter = yield* Ref.make<OrchestrationV2ServerCommand["type"] | null>(null);
  const dispatch: ThreadManagementService.ThreadManagementService["Service"]["dispatch"] = (
    command,
  ) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (all) => [...all, command]);
      if (!(yield* Ref.get(receipts)).has(command.commandId)) {
        if (command.type === "restricted_run.start") {
          const [latest] = yield* main<{
            readonly sequence: number | null;
          }>`SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE stream_id = ${home}`;
          if ((yield* Ref.get(busy)) || command.ifIdleAtSequence !== (latest?.sequence ?? 0))
            return { sequence: latest?.sequence ?? 0, storedEvents: [], deferred: true } as const;
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
            VALUES (${`check-run-${command.messageId}`}, ${home}, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${home}), 'codex', 'running', ${now},
              ${JSON.stringify({ userMessageId: command.messageId, restriction: command.restriction })})`;
          yield* homeEvent;
        }
        yield* Ref.update(receipts, (all) => new Set([...all, command.commandId]));
      }
      if ((yield* Ref.getAndSet(crashAfter, null)) === command.type)
        return yield* Effect.die("crashed after the command committed");
      return { sequence: 0, storedEvents: [] } as const;
    }).pipe(Effect.provideService(SqlClient.SqlClient, main), Effect.orDie);
  const sent = (type: OrchestrationV2ServerCommand["type"]) =>
    Ref.get(commands).pipe(
      Effect.map((all) => all.filter((command) => command.type === type).map((c) => c.commandId)),
    );
  const runs = main<{
    readonly run_id: string;
    readonly status: string;
  }>`SELECT run_id, status FROM orchestration_v2_projection_runs WHERE run_id LIKE 'check-run-%' ORDER BY ordinal`;
  return { dispatch, commands, busy, crashAfter, sent, runs, receipts };
});
type Orchestrator = Effect.Success<typeof orchestrator>;

/** A fresh service over the same databases, as a server restart builds it, in UTC. */
const startService = Effect.fn("fixture.startService")(function* (
  homeTurns: Pick<Orchestrator, "dispatch" | "receipts">,
  results: BotTaskService.BotTaskService["Service"]["getResult"] = () =>
    Effect.die("unexpected result read"),
) {
  const scheduled = yield* Ref.make<Effect.Effect<void> | null>(null);
  const check = yield* BotHomeCheck.make.pipe(
    Effect.provideService(ThreadManagementService.ThreadManagementService, {
      dispatch: homeTurns.dispatch,
      hasReceipt: (id) => Ref.get(homeTurns.receipts).pipe(Effect.map((all) => all.has(id))),
    } as ThreadManagementService.ThreadManagementService["Service"]),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(BotTaskService.BotTaskService)({ getResult: results }),
        Layer.mock(Scheduler.Scheduler)({
          register: <E, R>(_: string, run: Effect.Effect<void, E, R>) =>
            Effect.context<R>().pipe(
              Effect.flatMap((context) =>
                Ref.set(scheduled, run.pipe(Effect.provideContext(context), Effect.orDie)),
              ),
            ),
        }),
        DateTime.layerCurrentZoneOffset(0),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed({
              driverKind: ProviderDriverKind.make(id),
            } as unknown as ProviderInstance),
        }),
      ),
    ),
  );
  const tick = (platform: NodeJS.Platform = "darwin") =>
    Ref.get(scheduled).pipe(
      Effect.flatMap((run) => run ?? Effect.die("no scheduled source")),
      Effect.provideService(HostProcess.Platform, platform),
    );
  return { check, tick };
});

const enable = Effect.fn("fixture.enable")(function* (
  check: BotHomeCheck.BotHomeCheck["Service"],
  input: { readonly enabled?: boolean; readonly timeOfDay?: string } = {},
) {
  const view = yield* onMac(check.get(scope));
  const result = yield* onMac(
    check.configure({
      ...scope,
      baseRevision: view.revision,
      enabled: input.enabled ?? true,
      ...(input.timeOfDay === undefined ? {} : { timeOfDay: input.timeOfDay }),
    }),
  );
  if (result._tag !== "saved") return yield* Effect.die(result);
  return result.view;
});

const outcomeOf = (check: BotHomeCheck.BotHomeCheck["Service"]) =>
  onMac(check.get(scope)).pipe(Effect.map((view) => view.lastCheck));

const endCheck = Effect.fn("fixture.endCheck")(function* (status: string) {
  const main = yield* SqlClient.SqlClient;
  yield* main`UPDATE orchestration_v2_projection_runs SET status = ${status} WHERE run_id LIKE 'check-run-%' AND status = 'running'`;
});

/** What the check's model saves through t3_bot in its Waiting-only run. */
const appendWaiting = Effect.fn("fixture.appendWaiting")(function* (text: string, quote: string) {
  const notes = yield* BotContinuation.BotContinuation;
  const view = yield* notes.get(scope);
  const saved = yield* notes.save(
    {
      ...scope,
      updateId: `check-${text}`,
      baseRevision: view.revision,
      note: {
        requests: [],
        waiting: [...view.note.waiting.map((item) => ({ text: item.text })), { text, quote }],
        decided: [],
        context: [],
      },
      basis: view.basis!,
    },
    { kind: "bot", threadId: home },
  );
  assert.equal(saved._tag, "saved");
});

it.effect("stays off at 08:00 by default and configures by compare-and-set", () =>
  Effect.gen(function* () {
    yield* seed();
    const { check } = yield* startService(yield* orchestrator);
    assert.deepInclude(yield* onMac(check.get(scope)), {
      revision: 0,
      enabled: false,
      timeOfDay: "08:00",
      unavailableReason: null,
      writable: true,
      lastCheck: null,
    });
    const stale = yield* onMac(check.configure({ ...scope, baseRevision: 3, enabled: true }));
    assert.equal(stale._tag, "conflict");
    const saved = yield* enable(check, { timeOfDay: "07:30" });
    assert.deepInclude(saved, { revision: 1, enabled: true, timeOfDay: "07:30" });
    const lost = yield* onMac(check.configure({ ...scope, baseRevision: 0, enabled: false }));
    assert.deepEqual(lost._tag === "conflict" && lost.current.revision, 1);
    assert.deepInclude(yield* enable(check, { enabled: false }), { revision: 2, enabled: false });
    // A Home that cannot scope the turn never turns on.
    const linux = yield* check
      .configure({ ...scope, baseRevision: 2, enabled: true })
      .pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.flip);
    assert.include(linux.message, "Mac");
    assert.equal(
      (yield* check.get(scope).pipe(Effect.provideService(HostProcess.Platform, "linux")))
        .unavailableReason,
      "platform",
    );
  }).pipe(Effect.provide(services)),
);

it.effect(
  "checks once at the configured time, even with a task waiting, and not again until the next day",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const bots = yield* BotDatabase.BotDatabase;
      yield* bots`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, origin, title, prompt, runtime_mode, status, created_at, updated_at)
        VALUES ('waiting-task', 'bot', 'project', ${home}, 'direct', 'Pick a venue', 'Ask', 'full-access', 'waiting', ${created}, ${created})`;
      yield* userMessage("venue", "Let me know which venue the task finds.");
      const homeTurns = yield* orchestrator;
      const { check, tick } = yield* startService(homeTurns);
      yield* at("2026-11-09T07:00:00.000Z");
      yield* enable(check);
      yield* at("2026-11-09T07:59:00.000Z");
      yield* tick();
      assert.deepEqual(yield* homeTurns.sent("restricted_run.start"), []);

      yield* at("2026-11-09T08:00:00.000Z");
      yield* tick();
      const [command] = yield* Ref.get(homeTurns.commands);
      const messageId = `bot-home-check:${home}:2026-11-09T07:00:00.000Z`;
      assert.deepEqual(command as unknown, {
        type: "restricted_run.start",
        commandId: messageId,
        messageId,
        threadId: home,
        text: `${BotHomeCheck.HOME_CHECK_PROMPT}\nNow: 2026-11-09T08:00:00.000+00:00. Next check: 2026-11-10T08:00:00.000+00:00.`,
        restriction: "botWaiting",
        ifIdleAtSequence: 0,
      });
      assert.deepEqual(yield* outcomeOf(check), {
        at: "2026-11-09T08:00:00.000Z",
        outcome: "running",
      });

      // The check's own work and save never start another check in the same slot.
      yield* appendWaiting("Choose a venue for the party", "venue");
      yield* endCheck("completed");
      for (const time of ["2026-11-09T09:00:00.000Z", "2026-11-10T07:59:00.000Z"]) {
        yield* at(time);
        yield* tick();
      }
      assert.lengthOf(yield* homeTurns.sent("restricted_run.start"), 1);
      yield* at("2026-11-10T08:00:00.000Z");
      yield* tick();
      assert.deepEqual(yield* homeTurns.sent("restricted_run.start"), [
        messageId,
        `bot-home-check:${home}:2026-11-09T08:00:00.000Z`,
      ]);
    }).pipe(Effect.provide(services)),
);

it.effect.each([
  {
    name: "three missed days",
    arrange: () => Effect.void,
    from: "2026-11-12T13:00:00.000Z",
    expected: 1,
  },
  {
    name: "a pause and resume",
    arrange: (check: BotHomeCheck.BotHomeCheck["Service"]) =>
      Effect.gen(function* () {
        yield* enable(check, { enabled: false });
        yield* at("2026-11-12T13:00:00.000Z");
        yield* enable(check);
      }),
    from: "2026-11-12T13:00:00.000Z",
    expected: 0,
  },
  {
    name: "a time change",
    arrange: (check: BotHomeCheck.BotHomeCheck["Service"]) =>
      Effect.gen(function* () {
        yield* at("2026-11-12T13:00:00.000Z");
        yield* enable(check, { timeOfDay: "12:00" });
      }),
    from: "2026-11-12T13:00:00.000Z",
    expected: 0,
  },
])("owes at most one check after $name", ({ arrange, from, expected }) =>
  Effect.gen(function* () {
    yield* seed();
    const homeTurns = yield* orchestrator;
    const { check, tick } = yield* startService(homeTurns);
    yield* at("2026-11-09T07:00:00.000Z");
    yield* enable(check);
    yield* arrange(check);
    yield* at(from);
    yield* tick();
    yield* at("2026-11-12T13:30:00.000Z");
    yield* tick();
    assert.lengthOf(yield* homeTurns.sent("restricted_run.start"), expected);
    // Whatever happened before, the next slot is owed once.
    yield* endCheck("completed");
    yield* at("2026-11-13T12:30:00.000Z");
    yield* tick();
    assert.lengthOf(yield* homeTurns.sent("restricted_run.start"), expected + 1);
  }).pipe(Effect.provide(services)),
);

it.effect("waits for a quiet Home and retries a refused start without a Bot write", () =>
  Effect.gen(function* () {
    yield* seed();
    const homeTurns = yield* orchestrator;
    const { check, tick } = yield* startService(homeTurns);
    yield* at("2026-11-09T07:00:00.000Z");
    yield* enable(check);
    yield* at("2026-11-09T08:55:00.000Z");
    yield* homeEvent;
    yield* at("2026-11-09T09:00:00.000Z");
    yield* tick();
    assert.deepEqual(yield* homeTurns.sent("restricted_run.start"), []);

    // Quiet, but the orchestrator refuses: an active run holds the Home.
    yield* at("2026-11-09T09:05:00.000Z");
    yield* Ref.set(homeTurns.busy, true);
    yield* tick();
    assert.lengthOf(yield* homeTurns.sent("restricted_run.start"), 1);
    const bots = yield* BotDatabase.BotDatabase;
    const row = bots`SELECT done_through, check_message_id, last_outcome_json FROM bot_home_checks`;
    assert.deepEqual(yield* row, [
      {
        done_through: "2026-11-09T07:00:00.000Z",
        check_message_id: null,
        last_outcome_json: null,
      },
    ]);
    yield* Ref.set(homeTurns.busy, false);
    yield* at("2026-11-09T09:09:00.000Z");
    yield* tick();
    assert.lengthOf(yield* homeTurns.sent("restricted_run.start"), 1);

    yield* at("2026-11-09T09:10:00.000Z");
    yield* tick();
    const sent = yield* homeTurns.sent("restricted_run.start");
    assert.deepEqual(sent, [sent[0], sent[0]]);
    assert.lengthOf(yield* homeTurns.runs, 1);
    assert.equal((yield* outcomeOf(check))?.outcome, "running");
  }).pipe(Effect.provide(services)),
);

it.effect("replays the same start after a crash before its Bot write", () =>
  Effect.gen(function* () {
    yield* seed();
    const homeTurns = yield* orchestrator;
    const first = yield* startService(homeTurns);
    yield* at("2026-11-09T07:00:00.000Z");
    yield* enable(first.check);
    yield* at("2026-11-09T08:00:00.000Z");
    yield* Ref.set(homeTurns.crashAfter, "restricted_run.start");
    assert.isTrue(Exit.hasDies(yield* Effect.exit(first.tick())));
    assert.equal(yield* outcomeOf(first.check), null);

    const restarted = yield* startService(homeTurns);
    // The started run is Home activity; the retry waits for the quiet period like any other.
    yield* at("2026-11-09T08:10:00.000Z");
    yield* restarted.tick();
    const sent = yield* homeTurns.sent("restricted_run.start");
    assert.deepEqual(sent, [`bot-home-check:${home}:2026-11-09T07:00:00.000Z`, sent[0]]);
    assert.lengthOf(yield* homeTurns.runs, 1);
    assert.equal((yield* outcomeOf(restarted.check))?.outcome, "running");
  }).pipe(Effect.provide(services)),
);

it.effect.each([
  { name: "snoozed", lifecycle: { snoozedUntil: "2026-11-10T00:00:00.000Z" } },
  { name: "archived", lifecycle: { archivedAt: created } },
  { name: "detached", lifecycle: {} },
])("never starts while the Home is $name", ({ name, lifecycle }) =>
  Effect.gen(function* () {
    yield* seed(lifecycle);
    const homeTurns = yield* orchestrator;
    const { check, tick } = yield* startService(homeTurns);
    yield* at("2026-11-09T07:00:00.000Z");
    yield* enable(check);
    if (name === "detached") {
      const store = yield* BotStore.BotStore;
      const context = yield* store.getContext(scope.botId, scope.projectId);
      yield* store.upsertContext({ ...context!, detached_at: created });
    }
    yield* at("2026-11-09T09:00:00.000Z");
    yield* tick();
    assert.deepEqual(yield* Ref.get(homeTurns.commands), []);
    assert.equal(yield* outcomeOf(check), null);
  }).pipe(Effect.provide(services)),
);

it.effect.each([
  { name: "a Home on another provider", provider: "claudeAgent", platform: "darwin" },
  { name: "a Linux host", provider: "codex", platform: "linux" },
] as const)("records $name as unsupported once a slot", ({ provider, platform }) =>
  Effect.gen(function* () {
    yield* seed();
    const homeTurns = yield* orchestrator;
    const { check, tick } = yield* startService(homeTurns);
    yield* at("2026-11-09T07:00:00.000Z");
    yield* enable(check);
    const main = yield* SqlClient.SqlClient;
    yield* main`UPDATE orchestration_v2_projection_threads SET provider_instance_id = ${provider} WHERE thread_id = ${home}`;
    yield* at("2026-11-09T09:00:00.000Z");
    yield* tick(platform);
    yield* at("2026-11-09T12:00:00.000Z");
    yield* tick(platform);
    assert.deepEqual(yield* Ref.get(homeTurns.commands), []);
    const bots = yield* BotDatabase.BotDatabase;
    assert.deepEqual(
      (yield* bots<{
        readonly last_outcome_json: string;
      }>`SELECT last_outcome_json FROM bot_home_checks`).map((row) =>
        JSON.parse(row.last_outcome_json),
      ),
      [
        {
          kind: "unsupported",
          at: "2026-11-09T09:00:00.000Z",
          reason: provider === "codex" ? "platform" : "provider",
        },
      ],
    );
  }).pipe(Effect.provide(services)),
);

it.effect.each([
  { ending: "completed", saves: true, outcome: "proposed", unread: true },
  { ending: "completed", saves: false, outcome: "noop", unread: false },
  { ending: "failed", saves: false, outcome: "failed", unread: false },
  { ending: "interrupted", saves: false, outcome: "interrupted", unread: false },
  { ending: "cancelled", saves: false, outcome: "stopped", unread: false },
] as const)(
  "reports a check that ended $ending (saved: $saves) as $outcome",
  ({ ending, saves, outcome, unread }) =>
    Effect.gen(function* () {
      yield* seed();
      yield* userMessage("dentist", "I have the dentist tomorrow at 10, bring the referral.");
      const homeTurns = yield* orchestrator;
      const first = yield* startService(homeTurns);
      yield* at("2026-11-09T07:00:00.000Z");
      yield* enable(first.check);
      yield* at("2026-11-09T08:00:00.000Z");
      yield* first.tick();
      if (saves) yield* appendWaiting("Bring the referral to the dentist", "bring the referral");
      yield* endCheck(ending);

      // A crash right after the unread mark replays the same mark after restart.
      if (unread) yield* Ref.set(homeTurns.crashAfter, "thread.mark-unread");
      yield* at("2026-11-09T08:01:00.000Z");
      if (unread) {
        assert.isTrue(Exit.hasDies(yield* Effect.exit(first.tick())));
        assert.equal((yield* outcomeOf(first.check))?.outcome, "running");
      }
      const restarted = yield* startService(homeTurns);
      yield* restarted.tick();
      yield* at("2026-11-09T08:02:00.000Z");
      yield* restarted.tick();
      const messageId = `bot-home-check:${home}:2026-11-09T07:00:00.000Z`;
      assert.deepEqual(
        yield* homeTurns.sent("thread.mark-unread"),
        unread ? [`bot-home-check:unread:${messageId}`, `bot-home-check:unread:${messageId}`] : [],
      );
      assert.deepEqual(yield* outcomeOf(restarted.check), {
        at: "2026-11-09T08:01:00.000Z",
        outcome,
        ...(outcome === "proposed" ? { added: 1 } : {}),
      });
      assert.lengthOf(yield* homeTurns.sent("restricted_run.start"), 1);
    }).pipe(Effect.provide(services)),
);

it.effect("counts only the Waiting items the check's own run appended", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* userMessage("dentist", "I have the dentist tomorrow at 10, bring the referral.");
    const notes = yield* BotContinuation.BotContinuation;
    yield* notes.save(
      {
        ...scope,
        updateId: "user-note",
        baseRevision: null,
        note: { requests: [], waiting: [{ text: "Earlier item" }], decided: [], context: [] },
      },
      { kind: "user" },
    );
    const homeTurns = yield* orchestrator;
    const { check, tick } = yield* startService(homeTurns);
    yield* at("2026-11-09T07:00:00.000Z");
    yield* enable(check);
    yield* at("2026-11-09T08:00:00.000Z");
    yield* tick();
    yield* appendWaiting("Bring the referral to the dentist", "bring the referral");
    yield* appendWaiting("Confirm the 10:00 slot", "tomorrow at 10");
    yield* endCheck("completed");
    yield* tick();
    assert.deepInclude(yield* outcomeOf(check), { outcome: "proposed", added: 2 });
  }).pipe(Effect.provide(services)),
);

it.effect.each([
  { name: "temporary provider refusal", kind: "disabled", receipt: false, retry: true },
  { name: "mode above the managed limit", kind: "ceiling", receipt: false, retry: true },
  { name: "receipted provider refusal", kind: "disabled", receipt: true, retry: false },
  { name: "permanent dispatch refusal", kind: "permanent", receipt: false, retry: false },
  { name: "replayed rejection", kind: "replayed", receipt: true, retry: false },
] as const)(
  "handles $name without losing or repeatedly retrying the slot",
  ({ kind, receipt, retry }) =>
    Effect.gen(function* () {
      yield* seed();
      const turns = yield* orchestrator;
      const refused = yield* Ref.make(true);
      const attempts = yield* Ref.make(0);
      const dispatch: Orchestrator["dispatch"] = (command) =>
        Effect.gen(function* () {
          if (command.type === "restricted_run.start") {
            yield* Ref.update(attempts, (count) => count + 1);
            if (yield* Ref.get(refused)) {
              if (receipt)
                yield* Ref.update(turns.receipts, (all) => new Set([...all, command.commandId]));
              if (kind === "disabled")
                return yield* new ThreadManagementService.ThreadManagementProviderInstanceDisabledError(
                  { projectId: scope.projectId, instanceId: ProviderInstanceId.make("codex") },
                );
              if (kind === "ceiling")
                return yield* new OrchestratorV2.OrchestratorRuntimeModeAboveCeilingError({
                  commandId: command.commandId,
                  threadId: home,
                  refused: "turn",
                  runtimeMode: "full-access",
                  maxRuntimeMode: "auto-accept-edits",
                  organization: "Example",
                });
              if (kind === "replayed")
                return yield* new OrchestratorV2.OrchestratorCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: "permanent rejection",
                });
              return yield* new OrchestratorV2.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
              });
            }
          }
          return yield* turns.dispatch(command);
        });
      const { check, tick } = yield* startService({ ...turns, dispatch });
      yield* at("2026-11-09T07:00:00.000Z");
      yield* enable(check);
      yield* at("2026-11-09T08:00:00.000Z");
      yield* tick();
      const bots = yield* BotDatabase.BotDatabase;
      assert.equal(
        (yield* bots<{
          readonly done_through: string;
        }>`SELECT done_through FROM bot_home_checks`)[0]?.done_through,
        retry ? "2026-11-09T07:00:00.000Z" : "2026-11-09T08:00:00.000Z",
      );
      assert.equal((yield* outcomeOf(check))?.outcome ?? null, retry ? null : "failed");
      yield* Ref.set(refused, false);
      yield* at("2026-11-09T08:04:59.000Z");
      yield* tick();
      assert.equal(yield* Ref.get(attempts), 1);
      yield* at("2026-11-09T08:05:00.000Z");
      yield* tick();
      assert.equal(yield* Ref.get(attempts), retry ? 2 : 1);
      assert.deepEqual(
        yield* turns.sent("restricted_run.start"),
        retry ? [`bot-home-check:${home}:2026-11-09T07:00:00.000Z`] : [],
      );
    }).pipe(Effect.provide(services)),
);

it.effect("provides bounded finished-task results only from this Home", () =>
  Effect.gen(function* () {
    yield* seed();
    const bots = yield* BotDatabase.BotDatabase;
    for (let index = 0; index < 13; index += 1) {
      yield* bots`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, origin, title, prompt, runtime_mode, status, created_at, updated_at)
        VALUES (${`result-${String(index).padStart(2, "0")}`}, 'bot', 'project', ${index === 12 ? "another-home" : home}, 'direct', 'Compare venues', 'Compare', 'full-access', ${index === 11 ? "running" : "completed"}, ${created}, ${created})`;
    }
    const reads: string[] = [];
    const turns = yield* orchestrator;
    const { check, tick } = yield* startService(turns, (input) => {
      reads.push(input.taskId);
      if (input.taskId === "result-09")
        return Effect.fail(new BotError({ message: "result unavailable" }));
      return Effect.succeed({
        task: {
          id: input.taskId,
          ...scope,
          homeThreadId: home,
          workThreadId: ThreadId.make("work"),
          origin: "direct",
          title: "Compare venues",
          scheduledTaskId: null,
          occurrenceDueAt: null,
          sessionAt: null,
          runtimeMode: "full-access",
          status: "completed",
          detail: null,
          createdAt: created,
          updatedAt: created,
          completedAt: created,
        },
        result:
          input.taskId === "result-08"
            ? { state: "unavailable" }
            : {
                state: "available",
                runId: RunId.make("result-run"),
                text: "Choose Harbor Hall or Lantern Loft?" + "x".repeat(3000) + "hidden-tail",
              },
      });
    });
    yield* at("2026-11-09T07:00:00.000Z");
    yield* enable(check);
    yield* at("2026-11-09T08:00:00.000Z");
    yield* tick();
    const command = (yield* Ref.get(turns.commands)).find(
      (item) => item.type === "restricted_run.start",
    );
    assert.isDefined(command);
    if (command?.type !== "restricted_run.start") return assert.fail();
    assert.include(command.text, "Choose Harbor Hall or Lantern Loft?");
    assert.include(command.text, '"taskId":"result-10"');
    assert.notInclude(command.text, '"taskId":"result-09"');
    assert.notInclude(command.text, '"taskId":"result-08"');
    assert.notInclude(command.text, "hidden-tail");
    assert.include(
      command.text,
      JSON.stringify({
        taskId: "result-10",
        text: ("Choose Harbor Hall or Lantern Loft?" + "x".repeat(3000)).slice(0, 2000),
      }),
    );
    assert.notInclude(command.text, '"taskId":"result-00"');
    assert.lengthOf(reads, 10);
    assert.notInclude(reads, "result-12");
    assert.notInclude(reads, "result-11");
    assert.notInclude(reads, "result-00");
    assert.isBelow(command.text.length, BotHomeCheck.HOME_CHECK_PROMPT.length + 22_000);
  }).pipe(Effect.provide(services)),
);
