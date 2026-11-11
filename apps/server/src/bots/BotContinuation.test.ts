import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  BotTaskId,
  MessageId,
  ProjectId,
  ThreadId,
  type BotSaveContinuationInput,
  type BotContinuationNoteInput,
  type BotContinuationView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotStore from "./BotStore.ts";
import * as BotContinuation from "./BotContinuation.ts";

const scope = { botId: BotId.make("bot"), projectId: ProjectId.make("project") };
const home = ThreadId.make("bot-home:bot:project");
const now = "2026-11-05T10:00:00.000Z";
const empty = (): BotContinuationNoteInput => ({
  requests: [],
  waiting: [],
  decided: [],
  context: [],
});
const database = Sqlite.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-continuation-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const services = Layer.merge(BotContinuation.layer, BotStore.layer);
const seed = Effect.gen(function* () {
  const store = yield* BotStore.BotStore;
  yield* store.insertBot({
    bot_id: "bot",
    name: "Companion",
    instructions: "",
    model_selection_json: '{"instanceId":"codex","model":"gpt-6-luna"}',
    learning_policy: "after_adoption",
    appearance_json: null,
    created_at: now,
    updated_at: now,
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
    attached_at: now,
    detached_at: null,
    updated_at: now,
  });
});
const input = Effect.fn("fixture.input")(function* (
  ordinal: number,
  text: string,
  options: {
    readonly run?: string;
    readonly directUser?: boolean;
    readonly guest?: boolean;
    readonly automatic?: boolean;
    readonly status?: string;
    readonly withoutTurnItem?: boolean;
  } = {},
) {
  const main = yield* SqlClient.SqlClient;
  const run = options.run ?? "run-1";
  const messageId = `message-${ordinal}`;
  const payload = JSON.stringify({
    id: messageId,
    threadId: home,
    runId: run,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: options.directUser ? "user" : "agent",
    creationSource: options.directUser ? "web" : options.automatic ? "server" : "mcp",
    context: options.guest
      ? {
          version: 1,
          records: [],
          guest: {
            guestMessageId: "guest-message",
            name: "Guest",
            text: "I approve blue packaging",
          },
        }
      : undefined,
  });
  yield* main`INSERT OR IGNORE INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${run}, ${home}, ${run === "run-1" ? 1 : 2}, 'codex', ${options.status ?? "running"}, ${now}, '{}')`;
  yield* main`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES (${messageId}, ${home}, ${run}, 'user', 0, ${now}, ${now}, ${payload})`;
  if (!options.withoutTurnItem)
    yield* main`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${`item-${ordinal}`}, ${home}, ${run}, ${ordinal}, 'user_message', 'completed', ${now}, ${JSON.stringify({ messageId })})`;
});
const task = Effect.fn("fixture.task")(function* (
  index: number,
  status: string,
  cancelled = false,
) {
  const bots = yield* BotDatabase.BotDatabase;
  yield* bots`INSERT INTO bot_tasks (task_id, bot_id, project_id, home_thread_id, origin, title, prompt, runtime_mode, status, cancel_requested_at, created_at, updated_at) VALUES (${`task-${index}`}, 'bot', 'project', ${home}, 'direct', 'Checklist', 'Read', 'full-access', ${status}, ${cancelled ? now : null}, ${now}, ${now})`;
});
const userSave = (
  updateId: string,
  baseRevision: number | null,
  note = empty(),
): BotSaveContinuationInput => ({ ...scope, updateId, baseRevision, note });

it.effect(
  "serializes concurrent edits, preserves lost-response identity across service reopen and retains bounded history",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* BotContinuation.BotContinuation;
      const raced = yield* Effect.all(
        [
          notes.save(userSave("first", null, { ...empty(), requests: [{ text: "First" }] }), {
            kind: "user",
          }),
          notes.save(userSave("second", null, { ...empty(), requests: [{ text: "Second" }] }), {
            kind: "user",
          }),
        ],
        { concurrency: 2 },
      );
      const winner = raced.find((result) => result._tag === "saved");
      assert.isDefined(winner);
      assert.equal(raced.filter((result) => result._tag === "conflict").length, 1);
      const firstInput =
        winner!.view.note.requests[0]!.text === "First"
          ? userSave("first", null, { ...empty(), requests: [{ text: "First" }] })
          : userSave("second", null, { ...empty(), requests: [{ text: "Second" }] });
      yield* notes.save(
        userSave("user-edit", 1, { ...empty(), context: [{ text: "Newer user edit" }] }),
        { kind: "user" },
      );
      const retried = yield* Effect.gen(function* () {
        const reopened = yield* BotContinuation.BotContinuation;
        return yield* reopened.save(firstInput, { kind: "user" });
      }).pipe(Effect.provide(BotContinuation.layer));
      assert.equal(retried._tag, "saved");
      if (retried._tag === "saved") {
        assert.equal(retried.acceptedRevision, 1);
        assert.isTrue(retried.duplicate);
        assert.equal(retried.view.revision, 2);
      }
      const different = yield* notes.save({ ...firstInput, note: empty() }, { kind: "user" });
      assert.equal(different._tag, "conflict");
      if (different._tag === "conflict") assert.equal(different.reason, "update_id");
      const revision1 = (yield* notes.history(scope)).revisions.find(
        (revision) => revision.revision === 1,
      )!;
      const restore = yield* notes.save(
        {
          ...userSave("restore", 2, {
            ...empty(),
            requests: revision1.note.requests.map((item) => ({ text: item.text })),
          }),
          restoredFrom: 1,
        },
        { kind: "user" },
      );
      assert.equal(restore._tag, "saved");
      for (let revision = 4; revision <= 23; revision += 1)
        yield* notes.save(userSave(`revision-${revision}`, revision - 1), { kind: "user" });
      const history = yield* notes.history(scope);
      assert.lengthOf(history.revisions, 20);
      assert.equal(history.revisions[0]!.revision, 23);
      assert.equal((yield* notes.save(firstInput, { kind: "user" }))._tag, "conflict");
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "saves only the supplied boundary and never acknowledges steering, queued input or an omitted save through successful completion",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* input(1, "Draft Lantern after I provide its date.");
      const notes = yield* BotContinuation.BotContinuation;
      const initial = yield* notes.get(scope);
      assert.equal(initial.newerInputs.count, 1);
      assert.isAtMost(initial.basis!.token.length, 64);
      assert.isTrue(
        yield* notes
          .save(
            {
              ...userSave("altered-token", null),
              basis: { ...initial.basis!, token: `${initial.basis!.token}x` },
            },
            { kind: "bot", threadId: home },
          )
          .pipe(Effect.isFailure),
      );
      yield* input(2, "Also keep a Harbor checklist.");
      yield* input(3, "New queued request", {
        run: "run-2",
        status: "queued",
        withoutTurnItem: true,
      });
      const saved = yield* notes.save(
        {
          ...userSave("capture", null, { ...empty(), requests: [{ text: "Lantern checklist" }] }),
          basis: initial.basis!,
        },
        { kind: "bot", threadId: home },
      );
      assert.equal(saved._tag, "saved");
      if (saved._tag === "saved") {
        assert.equal(saved.view.coverage?.throughOrdinal, 1);
        assert.equal(saved.view.newerInputs.count, 2);
      }
      const visibilityMain = yield* SqlClient.SqlClient;
      yield* visibilityMain`UPDATE orchestration_v2_projection_turn_items SET payload_json = json_set(payload_json, '$.inputIntent', 'queued_turn') WHERE turn_item_id = 'item-3'`;
      yield* visibilityMain`UPDATE orchestration_v2_projection_runs SET status = 'cancelled' WHERE run_id = 'run-2'`;
      assert.equal((yield* notes.get(scope)).newerInputs.count, 1);
      yield* visibilityMain`UPDATE orchestration_v2_projection_runs SET status = 'queued' WHERE run_id = 'run-2'`;
      const laterBasis = (yield* notes.get(scope)).basis!;
      const differentEvidence = yield* notes.save(
        {
          ...userSave("capture", 1, { ...empty(), requests: [{ text: "Lantern checklist" }] }),
          basis: laterBasis,
        },
        { kind: "bot", threadId: home },
      );
      assert.equal(differentEvidence._tag, "conflict");
      if (differentEvidence._tag === "conflict")
        assert.equal(differentEvidence.reason, "update_id");
      const main = yield* SqlClient.SqlClient;
      yield* main`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', 'Changed earlier source') WHERE message_id = 'message-1'`;
      const changedEarlier = yield* notes.save(
        {
          ...userSave("changed-earlier", 1, {
            ...empty(),
            requests: [{ text: "Lantern checklist" }],
          }),
          basis: laterBasis,
        },
        { kind: "bot", threadId: home },
      );
      assert.equal(changedEarlier._tag, "conflict");
      if (changedEarlier._tag === "conflict") assert.equal(changedEarlier.reason, "basis");
      yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-1'`;
      const reopened = yield* Effect.gen(function* () {
        const service = yield* BotContinuation.BotContinuation;
        return yield* service.get(scope);
      }).pipe(Effect.provide(BotContinuation.layer));
      assert.equal(reopened.newerInputs.count, 2);
      assert.equal(reopened.note.requests[0]!.text, "Lantern checklist");
      const corrected = yield* notes.save(userSave("correction", 1), { kind: "user" });
      if (corrected._tag !== "saved") return assert.fail();
      assert.equal(corrected.view.newerInputs.count, 2);
      const restored = yield* notes.save(
        {
          ...userSave("restore-old", 2, { ...empty(), requests: [{ text: "Lantern checklist" }] }),
          restoredFrom: 1,
        },
        { kind: "user" },
      );
      if (restored._tag !== "saved") return assert.fail();
      assert.equal(restored.view.newerInputs.count, 2);
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "requires genuine direct user quotation for section promotion and retains changed or missing sources as historical",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* input(1, "Proposal: blue packaging is not approved.");
      const notes = yield* BotContinuation.BotContinuation;
      const view = yield* notes.get(scope);
      yield* notes.save(
        {
          ...userSave("proposal", null, { ...empty(), waiting: [{ text: "Blue packaging" }] }),
          basis: view.basis!,
        },
        { kind: "bot", threadId: home },
      );
      const sourceMain = yield* SqlClient.SqlClient;
      yield* sourceMain`UPDATE orchestration_v2_projection_runs SET status = 'rolled_back' WHERE run_id = 'run-1'`;
      const rolledBack = yield* notes.get(scope);
      assert.equal(rolledBack.newerInputs.count, 0);
      assert.equal(rolledBack.note.waiting[0]!.text, "Blue packaging");
      const rolledRef = rolledBack.note.waiting[0]!.refs[0]!;
      if (rolledRef.kind !== "message") return assert.fail();
      assert.equal(rolledRef.availability, "historical_unverified");
      yield* sourceMain`UPDATE orchestration_v2_projection_runs SET status = 'running' WHERE run_id = 'run-1'`;
      const promote = {
        ...userSave("promote", 1, { ...empty(), decided: [{ text: "Blue packaging" }] }),
        basis: view.basis!,
      };
      assert.isTrue(
        yield* notes.save(promote, { kind: "bot", threadId: home }).pipe(Effect.isFailure),
      );
      assert.isTrue(
        yield* notes
          .save(
            {
              ...promote,
              note: { ...empty(), decided: [{ text: "Blue packaging", quote: "blue packaging" }] },
            },
            { kind: "bot", threadId: home },
          )
          .pipe(Effect.isFailure),
      );
      yield* input(2, "I approve blue packaging", { automatic: true });
      const automaticBasis = yield* notes.get(scope);
      assert.isTrue(
        yield* notes
          .save(
            {
              ...promote,
              basis: automaticBasis.basis!,
              note: {
                ...empty(),
                decided: [{ text: "Blue packaging", quote: "I approve blue packaging" }],
              },
            },
            { kind: "bot", threadId: home },
          )
          .pipe(Effect.isFailure),
      );
      yield* input(3, "Message from guest Guest, sent by the owner:\n\nI approve blue packaging", {
        directUser: true,
        guest: true,
      });
      const guestBasis = yield* notes.get(scope);
      assert.equal(guestBasis.newerInputs.count, 0);
      assert.isFalse(guestBasis.sources.some((source) => source.messageId === "message-3"));
      assert.isTrue(
        yield* notes
          .save(
            {
              ...promote,
              basis: guestBasis.basis!,
              note: {
                ...empty(),
                decided: [{ text: "Blue packaging", quote: "I approve blue packaging" }],
              },
            },
            { kind: "bot", threadId: home },
          )
          .pipe(Effect.isFailure),
      );
      yield* input(4, "I approve blue packaging", { directUser: true });
      const approved = yield* notes.get(scope);
      const decided = yield* notes.save(
        {
          ...promote,
          basis: approved.basis!,
          note: {
            ...empty(),
            decided: [{ text: "Blue packaging", quote: "I approve blue packaging" }],
          },
        },
        { kind: "bot", threadId: home },
      );
      assert.equal(decided._tag, "saved");
      const main = yield* SqlClient.SqlClient;
      yield* main`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.context', json_extract((SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id = 'message-3'), '$.context')) WHERE message_id = 'message-4'`;
      const attributed = yield* notes.get(scope);
      const attributedRef = attributed.note.decided[0]!.refs[0]!;
      if (attributedRef.kind !== "message") return assert.fail();
      assert.equal(attributedRef.availability, "historical_unverified");
      const attributedHistory = yield* notes.history(scope);
      const historyRef = attributedHistory.revisions[0]!.note.decided[0]!.refs[0]!;
      if (historyRef.kind !== "message") return assert.fail();
      assert.equal(historyRef.availability, "historical_unverified");
      yield* main`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-4'`;
      const missing = yield* notes.get(scope);
      assert.equal(missing.note.decided[0]!.text, "Blue packaging");
      const ref = missing.note.decided[0]!.refs[0]!;
      assert.equal(ref.kind, "message");
      if (ref.kind === "message") assert.equal(ref.availability, "historical_unverified");
      assert.include(BotContinuation.continuationInjection(missing), "historical/unverified");
      const staleBasis = yield* notes.save(
        {
          ...userSave("stale-basis", 2, { ...empty(), decided: [{ text: "Blue packaging" }] }),
          basis: approved.basis!,
        },
        { kind: "bot", threadId: home },
      );
      assert.equal(staleBasis._tag, "conflict");
      if (staleBasis._tag === "conflict") assert.equal(staleBasis.reason, "basis");
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "derives active work beyond fifty tasks and excludes terminal and cancellation-intent rows",
  () =>
    Effect.gen(function* () {
      yield* seed;
      for (let index = 0; index < 9; index += 1) yield* task(index, "running");
      for (let index = 9; index <= 63; index += 1) yield* task(index, "completed");
      yield* task(64, "waiting", true);
      for (const [index, status] of ["failed", "interrupted", "cancelled", "skipped"].entries())
        yield* task(65 + index, status);
      const notes = yield* BotContinuation.BotContinuation;
      const view = yield* notes.get(scope);
      assert.lengthOf(view.activeTasks, 8);
      assert.equal(view.moreActiveTasks, 1);
      const afterInput = { ...scope, afterTaskId: view.activeTasks.at(-1)!.taskId };
      const next = yield* notes.get(afterInput);
      assert.deepEqual(
        [...view.activeTasks, ...next.activeTasks].map((row) => row.taskId),
        Array.from({ length: 9 }, (_, index) => `task-${index}`),
      );
      assert.equal(next.moreActiveTasks, 0);
      assert.equal(view.nextActiveTaskId, "task-7");
      assert.isNull(next.nextActiveTaskId);
      const foreignPage = { ...scope, afterTaskId: BotTaskId.make("foreign-task") };
      assert.isTrue(yield* notes.get(foreignPage).pipe(Effect.isFailure));
      yield* notes.save(
        userSave("task-request", null, {
          ...empty(),
          requests: [
            {
              text: "Checklist remains unfinished until the missing date arrives",
              taskIds: [BotTaskId.make("task-0")],
            },
          ],
        }),
        { kind: "user" },
      );
      const bots = yield* BotDatabase.BotDatabase;
      yield* bots`UPDATE bot_tasks SET status = 'completed', result_run_id = 'saved-result', cancel_requested_at = ${now} WHERE task_id = 'task-0'`;
      const completed = yield* notes.get(scope);
      assert.lengthOf(completed.activeTasks, 8);
      assert.notInclude(
        completed.activeTasks.map((row) => row.taskId),
        BotTaskId.make("task-0"),
      );
      assert.lengthOf(completed.note.requests, 1);
      const taskRef = completed.note.requests[0]!.refs.find((ref) => ref.kind === "task")!;
      if (taskRef.kind !== "task") return assert.fail();
      assert.equal(taskRef.status, "completed");
      assert.equal(taskRef.resultRunId, "saved-result");
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "isolates scope, refuses inactive writes and cascades project cleanup without changing retained inactive notes",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* input(1, "Unfinished checklist");
      const notes = yield* BotContinuation.BotContinuation;
      const view = yield* notes.get(scope);
      assert.isTrue(
        yield* notes
          .save(
            { ...userSave("forged", null), basis: view.basis! },
            { kind: "bot", threadId: ThreadId.make("bot-work:other") },
          )
          .pipe(Effect.isFailure),
      );
      assert.isTrue(
        yield* notes.get({ ...scope, projectId: ProjectId.make("other") }).pipe(Effect.isFailure),
      );
      yield* notes.save(
        userSave("saved", null, { ...empty(), requests: [{ text: "Unfinished checklist" }] }),
        { kind: "user" },
      );
      const bots = yield* BotDatabase.BotDatabase;
      yield* bots`UPDATE bot_project_contexts SET detached_at = ${now}`;
      assert.equal((yield* notes.history(scope)).revisions.length, 1);
      const detached = yield* notes.get(scope);
      assert.isFalse(detached.writable);
      assert.equal(detached.note.requests[0]!.text, "Unfinished checklist");
      assert.equal(BotContinuation.continuationInjection(detached), "");
      assert.isTrue(
        yield* notes.save(userSave("detached", 1), { kind: "user" }).pipe(Effect.isFailure),
      );
      assert.isTrue(
        yield* notes
          .save(
            {
              ...userSave("detached-restore", 1, {
                ...empty(),
                requests: [{ text: "Unfinished checklist" }],
              }),
              restoredFrom: 1,
            },
            { kind: "user" },
          )
          .pipe(Effect.isFailure),
      );
      yield* bots`UPDATE bot_project_contexts SET detached_at = NULL`;
      yield* bots`UPDATE bots SET archived_at = ${now}`;
      assert.isTrue(
        yield* notes.save(userSave("archived", 1), { kind: "user" }).pipe(Effect.isFailure),
      );
      const store = yield* BotStore.BotStore;
      yield* store.deleteContextsForProject(scope.projectId);
      assert.equal(
        (yield* bots<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM bot_continuation_revisions`)[0]!.count,
        0,
      );
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "rejects oversized semantic notes and measures the total injection including long ids and task previews",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const notes = yield* BotContinuation.BotContinuation;
      assert.isTrue(
        yield* notes
          .save(userSave("too-long", null, { ...empty(), requests: [{ text: "x".repeat(401) }] }), {
            kind: "user",
          })
          .pipe(Effect.isFailure),
      );
      assert.isTrue(
        yield* notes
          .save(
            userSave("multiline", null, {
              ...empty(),
              requests: [{ text: "First request\nSecond request" }],
            }),
            { kind: "user" },
          )
          .pipe(Effect.isFailure),
      );
      assert.isEmpty((yield* notes.history(scope)).revisions);
      const result = yield* notes.save(
        userSave("too-long", null, {
          ...empty(),
          requests: Array.from({ length: 10 }, () => ({ text: "x".repeat(400) })),
        }),
        { kind: "user" },
      );
      if (result._tag !== "saved") return assert.fail();
      const extreme = {
        ...result.view,
        basis: { token: "x".repeat(4096), fromOrdinal: 1, throughOrdinal: 1 },
        activeTasks: Array.from({ length: 8 }, () => ({
          taskId: "x".repeat(16000) as never,
          title: "x".repeat(160),
          status: "running" as const,
          workThreadId: null,
        })),
      };
      const injection = BotContinuation.continuationInjection(extreme);
      assert.isAtMost(injection.length, 8000);
      assert.equal(injection.split("x".repeat(400)).length - 1, 10);
      assert.include(injection, "omitted");
      const historical = {
        ...extreme,
        note: {
          ...result.view.note,
          requests: Array.from({ length: 20 }, () => ({
            text: "x".repeat(200),
            refs: [
              {
                kind: "task" as const,
                taskId: BotTaskId.make("missing"),
                status: null,
                resultRunId: null,
                availability: "historical_unverified" as const,
              },
            ],
          })),
        },
      };
      assert.isAtMost(BotContinuation.continuationInjection(historical).length, 8000);
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "reopens both on-disk fixture databases with omitted-input coverage and durable retry identity intact",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = Option.getOrUndefined(yield* Config.option(Config.String("T3B21_FIXTURE_ROOT")));
      if (root !== undefined) yield* fs.makeDirectory(root, { recursive: true });
      const directory =
        root === undefined
          ? yield* fs.makeTempDirectoryScoped({ prefix: "bot-continuation-reopen-" })
          : yield* fs.makeTempDirectory({ directory: root, prefix: "bot-continuation-reopen-" });
      const db = Sqlite.layerFromPath(`${directory}/statev2.sqlite`).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "bot-continuation-disk-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(NodeCrypto.layer),
      );
      const connection = services.pipe(Layer.provideMerge(db));
      const savedInput = yield* Effect.gen(function* () {
        yield* seed;
        yield* input(202, "Draft Lantern after the date is supplied.");
        const notes = yield* BotContinuation.BotContinuation;
        const initial = yield* notes.get(scope);
        const saveInput = {
          ...userSave("disk-capture", null, {
            ...empty(),
            requests: [{ text: "Lantern checklist" }],
          }),
          basis: initial.basis!,
        };
        yield* notes.save(saveInput, { kind: "bot", threadId: home });
        const main = yield* SqlClient.SqlClient;
        yield* input(201, "A queued input promoted into the same running turn.");
        yield* main`UPDATE orchestration_v2_projection_turn_items SET payload_json = json_set(payload_json, '$.inputIntent', 'promoted_queued_to_steer') WHERE turn_item_id = 'item-201'`;
        assert.equal((yield* notes.get(scope)).newerInputs.count, 1);
        yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-1'`;
        yield* input(200, "Harbor also remains unfinished.", { run: "run-2" });
        const queuedStart = yield* notes.get(scope);
        assert.equal(queuedStart.newerInputs.count, 2);
        const sourceChecked = yield* notes.save(
          { ...userSave("queued-source-check", 999), basis: queuedStart.basis! },
          { kind: "bot", threadId: home },
        );
        if (sourceChecked._tag !== "conflict") return assert.fail();
        assert.equal(sourceChecked.reason, "revision");
        yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
        return saveInput;
      }).pipe(Effect.provide(connection), Effect.scoped);
      yield* Effect.gen(function* () {
        const notes = yield* BotContinuation.BotContinuation;
        const view = yield* notes.get(scope);
        assert.equal(view.note.requests[0]!.text, "Lantern checklist");
        assert.equal(view.newerInputs.count, 2);
        const retry = yield* notes.save(savedInput, { kind: "bot", threadId: home });
        if (retry._tag !== "saved") return assert.fail();
        assert.isTrue(retry.duplicate);
        assert.equal(retry.acceptedRevision, 1);
        const bots = yield* BotDatabase.BotDatabase;
        const history = yield* bots<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepEqual(history.at(-1), { migration_id: 15, name: "BotMcpGrants" });
      }).pipe(Effect.provide(connection), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a Waiting-only run appends Waiting items and changes nothing else", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* task(1, "running");
    yield* input(1, "Draft Lantern after I provide its date.", { directUser: true });
    const notes = yield* BotContinuation.BotContinuation;
    const main = yield* SqlClient.SqlClient;
    const bot = { kind: "bot", threadId: home } as const;
    const base = {
      ...empty(),
      requests: [{ text: "Lantern draft" }],
      waiting: [{ text: "Lantern date from the user" }],
    };
    const first = yield* notes.save(
      { ...userSave("ordinary", null, base), basis: (yield* notes.get(scope)).basis! },
      bot,
    );
    assert.equal(first._tag, "saved");
    yield* main`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.restriction', 'botWaiting') WHERE run_id = 'run-1'`;
    const basis = (yield* notes.get(scope)).basis!;
    const save = (updateId: string, note: BotContinuationNoteInput) =>
      notes.save({ ...userSave(updateId, 1, note), basis }, bot);
    const appended = {
      ...base,
      waiting: [...base.waiting, { text: "Remind the user of the Lantern date", quote: "Lantern" }],
    };
    for (const [name, note] of [
      [
        "unsourced append",
        { ...base, waiting: [...base.waiting, { text: "Harbor owner's reply" }] },
      ],
      [
        "duplicate append",
        {
          ...base,
          waiting: [...base.waiting, { text: "lantern DATE from the user", quote: "Lantern" }],
        },
      ],
      ["edit", { ...base, waiting: [{ text: "Lantern date from the client" }] }],
      ["removal", { ...base, waiting: [] }],
      ["reorder", { ...appended, waiting: [...appended.waiting].reverse() }],
      ["other section", { ...appended, requests: [...base.requests, { text: "Harbor list" }] }],
      [
        "carried reference",
        {
          ...base,
          waiting: [{ text: "Lantern date from the user", taskIds: [BotTaskId.make("task-1")] }],
        },
      ],
    ] as const) {
      assert.isTrue(yield* save(name, note).pipe(Effect.isFailure), name);
    }
    const saved = yield* save("append", appended);
    if (saved._tag !== "saved") return assert.fail();
    assert.deepEqual(
      saved.view.note.waiting.map((item) => item.text),
      ["Lantern date from the user", "Remind the user of the Lantern date"],
    );
    // Authority belongs to the run: once it ended, the same basis saves nothing.
    yield* main`UPDATE orchestration_v2_projection_runs SET status = 'interrupted' WHERE run_id = 'run-1'`;
    assert.isTrue(
      yield* notes
        .save({ ...userSave("after-stop", 2, appended), basis }, bot)
        .pipe(Effect.isFailure),
    );
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "task-only Waiting items need no Home message and still enforce task ownership and user decisions",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* task(1, "completed");
      yield* task(2, "completed");
      const main = yield* SqlClient.SqlClient;
      const bots = yield* BotDatabase.BotDatabase;
      yield* bots`UPDATE bot_tasks SET home_thread_id = 'another-home' WHERE task_id = 'task-2'`;
      yield* main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('run-1', ${home}, 1, 'codex', 'running', ${now}, '{"restriction":"botWaiting"}')`;
      const notes = yield* BotContinuation.BotContinuation;
      const view = yield* notes.get(scope);
      const saved = yield* notes.save(
        {
          ...userSave("task-only", null, {
            ...empty(),
            waiting: [{ text: "Choose a venue", taskIds: [BotTaskId.make("task-1")] }],
          }),
          basis: view.basis!,
        },
        { kind: "bot", threadId: home },
      );
      if (saved._tag !== "saved") return assert.fail();
      const save = (id: string, note: BotContinuationNoteInput) =>
        notes.save(
          { ...userSave(id, saved.view.revision, note), basis: view.basis! },
          { kind: "bot", threadId: home },
        );
      for (const taskId of ["task-2", "missing-task"]) {
        const error = yield* save(taskId, {
          ...empty(),
          waiting: [{ text: "Choose a venue", taskIds: [BotTaskId.make(taskId)] }],
        }).pipe(Effect.flip);
        assert.include(error.message, "belong to this Home");
      }
      yield* main`UPDATE orchestration_v2_projection_runs SET payload_json = '{}' WHERE run_id = 'run-1'`;
      const decided = yield* save("decision", {
        ...empty(),
        decided: [{ text: "Choose a venue", taskIds: [BotTaskId.make("task-1")] }],
      }).pipe(Effect.flip);
      assert.include(decided.message, "direct user input");
      assert.deepEqual(saved.view.note.waiting[0]?.refs, [
        {
          kind: "task",
          taskId: BotTaskId.make("task-1"),
          status: "completed",
          resultRunId: null,
          availability: "available",
        },
      ]);
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

const homeRun = Effect.fn("fixture.homeRun")(function* (id: string, ordinal: number) {
  const main = yield* SqlClient.SqlClient;
  yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = ${home}`;
  yield* main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${id}, ${home}, ${ordinal}, 'codex', 'running', ${now}, '{}')`;
});

/** A task result the server returned into the Home, which starts its own run. */
const returnedResult = Effect.fn("fixture.returnedResult")(function* (
  run: string,
  ordinal: number,
) {
  const main = yield* SqlClient.SqlClient;
  const messageId = `result-${ordinal}`;
  const payload = JSON.stringify({
    id: messageId,
    threadId: home,
    runId: run,
    nodeId: null,
    role: "user",
    text: "Bot work run completed. The vendor needs a decision on the second quote.",
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: "agent",
    creationSource: "server",
    notification: { source: { kind: "system" }, outcome: "completed", summary: "Bot work result" },
  });
  yield* main`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES (${messageId}, ${home}, ${run}, 'user', 0, ${now}, ${now}, ${payload})`;
  yield* main`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${`item-${ordinal}`}, ${home}, ${run}, ${ordinal}, 'user_message', 'completed', ${now}, ${JSON.stringify({ messageId })})`;
});

const bot = { kind: "bot", threadId: home } as const;
/** What the running Home turn, as the scoped note refresh, reads with read_continuation. */
const refreshRead = Effect.fn("fixture.refreshRead")(function* () {
  const main = yield* SqlClient.SqlClient;
  yield* main`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.restriction', 'botNote') WHERE thread_id = ${home} AND status = 'running'`;
  return yield* (yield* BotContinuation.BotContinuation).get(scope, { page: true });
});
type PageSource = NonNullable<BotContinuationView["uncovered"]>["sources"][number];
const shownText = (source: PageSource | undefined) =>
  source?.parts.map((part) => part.text).join("");
/** The acknowledgements of a page read whole. */
const acksOf = (read: BotContinuationView) =>
  read.uncovered?.sources.flatMap((source) =>
    source.parts.flatMap((part) => ("ack" in part ? [part.ack] : [])),
  ) ?? [];
/** Saves the current note with the basis of the refresh read that showed the unsaved page. */
const saveShown = Effect.fn("fixture.saveShown")(function* (updateId: string) {
  const notes = yield* BotContinuation.BotContinuation;
  const read = yield* refreshRead();
  return yield* notes.save(
    { ...userSave(updateId, read.revision, empty()), basis: read.basis!, acks: acksOf(read) },
    bot,
  );
});

it.effect("certifies only the Home input a read actually showed to the saving run", () =>
  Effect.gen(function* () {
    yield* seed;
    const harbor = `Keep the unresolved Harbor date request. ${"Its qualification matters. ".repeat(40)}`;
    for (let ordinal = 1; ordinal <= 9; ordinal += 1)
      yield* input(ordinal, ordinal === 1 ? harbor : `Answered question ${ordinal}`, {
        directUser: true,
      });
    const main = yield* SqlClient.SqlClient;
    yield* main`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.restriction', 'botNote') WHERE run_id = 'run-1'`;
    const notes = yield* BotContinuation.BotContinuation;
    // The Home instructions' basis carries no source text, so its save certifies nothing.
    const instructions = yield* notes.get(scope);
    assert.isFalse(instructions.sources.some((source) => source.messageId === "message-1"));
    const unshown = yield* notes.save(
      { ...userSave("review-window", null), basis: instructions.basis! },
      bot,
    );
    assert.equal(unshown._tag, "saved");
    assert.deepEqual(yield* notes.coverage(scope), { _tag: "behind", inputs: 9, results: 0 });

    const read = yield* notes.get(scope, { page: true });
    assert.deepEqual(
      read.uncovered?.sources.map((source) => [source.messageId, source.kind]),
      Array.from({ length: 9 }, (_, index) => [`message-${index + 1}`, "input"]),
    );
    assert.equal(shownText(read.uncovered?.sources[0]), harbor);
    assert.equal((yield* saveShown("shown"))._tag, "saved");
    assert.deepEqual(yield* notes.coverage(scope), { _tag: "current" });
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect("catches a long Home up oldest-first, one shown window a night", () =>
  Effect.gen(function* () {
    yield* seed;
    const items = 40;
    const inputs = items * 2 + 15;
    for (let ordinal = 1; ordinal <= inputs; ordinal += 1)
      yield* input(ordinal, `Request ${ordinal}`, { directUser: true });
    yield* returnedResult("run-1", inputs + 1);
    // A revision from before the frontier claims the newest boundary; it proves nothing earlier.
    const bots = yield* BotDatabase.BotDatabase;
    const legacy = JSON.stringify({
      revision: 1,
      note: { ...empty(), requests: [{ text: "Request 1", refs: [] }] },
      coverage: { fromOrdinal: 1, throughOrdinal: inputs },
      updatedBy: { kind: "bot", threadId: home, runId: "run-1" },
      updatedAt: now,
      restoredFrom: null,
      sourcePosition: { runOrdinal: 1, ordinal: inputs + 1 },
      sourceIds: [],
      inspected: { runOrdinal: 1, complete: true },
    });
    yield* bots`INSERT INTO bot_continuation_revisions (home_thread_id, revision, update_id, request_hash, revision_json) VALUES (${home}, 1, 'legacy', 'legacy', ${legacy})`;
    const notes = yield* BotContinuation.BotContinuation;
    assert.equal((yield* notes.get(scope)).newerInputs.count, 0);
    assert.deepEqual(yield* notes.coverage(scope), { _tag: "behind", inputs, results: 1 });

    const nights = [];
    for (let night = 1; night <= 3; night += 1) {
      yield* homeRun(`night-${night}`, night + 1);
      const read = yield* refreshRead();
      nights.push(read.uncovered!.sources.map((source) => source.ordinal));
      assert.equal((yield* saveShown(`night-${night}`))._tag, "saved");
      nights.push(yield* notes.coverage(scope));
    }
    const ordinals = (from: number, through: number) =>
      Array.from({ length: through - from + 1 }, (_, index) => from + index);
    assert.deepEqual(nights, [
      ordinals(1, items),
      { _tag: "behind", inputs: inputs - items, results: 1 },
      ordinals(items + 1, items * 2),
      { _tag: "behind", inputs: inputs - items * 2, results: 1 },
      ordinals(items * 2 + 1, inputs + 1),
      { _tag: "current" },
    ]);
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
/** Codex shows a code-mode model 10,000 approximate tokens of 4 bytes; the read keeps a margin. */
const refreshResponseBytes = 32_000;
const toolResultBytes = (view: BotContinuationView) =>
  utf8Bytes(JSON.stringify({ continuation: view }));

it.effect.each([
  {
    name: "pasted JSON",
    input: (ordinal: number) =>
      `Keep request ${ordinal} open. ${'{"project":"Harbor","status":"waiting","date":null}\n'.repeat(30)}`.slice(
        0,
        600,
      ),
    item: (ordinal: number) =>
      `Unresolved request ${ordinal}: ${"Keep its date and vendor confirmation open. ".repeat(8)}`.slice(
        0,
        200,
      ),
  },
  {
    name: "multilingual text",
    input: (ordinal: number) =>
      `请求${ordinal}：${"请保留尚未完成的任务并等待明确的确认。".repeat(30)}`.slice(0, 400),
    item: (ordinal: number) =>
      `任务${ordinal}：${"请继续保留此项尚未完成的请求直到用户确认已经解决。".repeat(12)}`.slice(
        0,
        200,
      ),
  },
])("delivers a refresh page whole beside a full note of $name", (fixture) =>
  Effect.gen(function* () {
    yield* seed;
    for (let ordinal = 1; ordinal <= 40; ordinal += 1)
      yield* input(ordinal, fixture.input(ordinal), { directUser: true });
    const notes = yield* BotContinuation.BotContinuation;
    const requests = Array.from({ length: 20 }, (_, index) => ({
      text: fixture.item(index + 1),
      quote: fixture.input(index + 1).slice(0, 400),
    }));
    const ordinary = yield* notes.get(scope);
    assert.equal(
      (yield* notes.save(
        { ...userSave("full-note", null, { ...empty(), requests }), basis: ordinary.basis! },
        bot,
      ))._tag,
      "saved",
    );

    const read = yield* refreshRead();
    // Codex keeps the head and tail of a longer result and cuts its middle, basis included.
    assert.isAtMost(toolResultBytes(read), refreshResponseBytes);
    assert.deepEqual(read.sources, []);
    const shown = read.uncovered!.sources;
    assert.isAbove(shown.length, 0);
    assert.isBelow(shown.length, 40);
    assert.deepEqual(
      shown.map((source) => [shownText(source), source.tooLarge]),
      shown.map((_, index) => [fixture.input(index + 1), undefined]),
    );
    assert.equal(read.uncovered!.remaining, 40 - shown.length);
    const saved = yield* notes.save(
      {
        ...userSave("page", read.revision, { ...empty(), requests }),
        basis: read.basis!,
        acks: acksOf(read),
      },
      bot,
    );
    assert.equal(saved._tag, "saved");
    assert.deepEqual(yield* notes.coverage(scope), {
      _tag: "behind",
      inputs: 40 - shown.length,
      results: 0,
    });
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect("saves an old approval shown on a catch-up page as a decision", () =>
  Effect.gen(function* () {
    yield* seed;
    const quote = "Approved: ship Harbor on Friday.";
    yield* input(1, quote, { directUser: true });
    for (let ordinal = 2; ordinal <= 201; ordinal += 1)
      yield* input(ordinal, `Unrelated Home input ${ordinal}`, { directUser: true });
    const notes = yield* BotContinuation.BotContinuation;
    const read = yield* refreshRead();
    assert.equal(shownText(read.uncovered?.sources[0]), quote);
    const decided = { ...empty(), decided: [{ text: "Ship Harbor on Friday", quote }] };
    const saved = yield* notes.save(
      { ...userSave("old-decision", null, decided), basis: read.basis!, acks: acksOf(read) },
      bot,
    );
    assert.equal(saved._tag, "saved");
    assert.deepInclude((yield* notes.get(scope)).note.decided[0]!.refs[0]!, {
      messageId: MessageId.make("message-1"),
      availability: "available",
    });
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect("sources a note item in a returned result shown on the page, never a decision", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* homeRun("result-only", 1);
    yield* returnedResult("result-only", 1);
    const notes = yield* BotContinuation.BotContinuation;
    const read = yield* refreshRead();
    assert.equal(read.uncovered?.sources[0]?.kind, "result");
    const quote = "The vendor needs a decision on the second quote.";
    const approval = yield* notes
      .save(
        {
          ...userSave("result-decision", null, {
            ...empty(),
            decided: [{ text: "Use it", quote }],
          }),
          basis: read.basis!,
          acks: acksOf(read),
        },
        bot,
      )
      .pipe(Effect.flip);
    assert.include(approval.message, "a proposal is not approval");
    const waiting = {
      ...empty(),
      waiting: [{ text: "Decide on the vendor's second quote", quote }],
    };
    const saved = yield* notes.save(
      { ...userSave("result-only-note", null, waiting), basis: read.basis!, acks: acksOf(read) },
      bot,
    );
    assert.equal(saved._tag, "saved");
    assert.deepInclude((yield* notes.get(scope)).note.waiting[0]!.refs[0]!, {
      messageId: MessageId.make("result-1"),
      availability: "available",
    });
    assert.deepEqual(yield* notes.coverage(scope), { _tag: "current" });
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect("a note refresh sources a new or reworded item only in the input it quotes", () =>
  Effect.gen(function* () {
    yield* seed;
    const plan = "Plan the offsite for about 40 people.";
    yield* input(1, plan, { directUser: true });
    const notes = yield* BotContinuation.BotContinuation;
    const kept = { ...empty(), requests: [{ text: "Plan the offsite" }] };
    const ordinary = yield* notes.save(
      {
        ...userSave("ordinary", null, {
          ...empty(),
          requests: [{ text: "Plan the offsite", quote: plan }],
        }),
        basis: (yield* notes.get(scope)).basis!,
      },
      bot,
    );
    assert.equal(ordinary._tag, "saved");
    yield* homeRun("night", 2);
    yield* input(2, "I will send the final headcount by Thursday.", {
      run: "night",
      directUser: true,
    });
    yield* input(3, "Should we pay the deposit now?", { run: "night", directUser: true });
    const read = yield* refreshRead();
    const save = (updateId: string, note: BotContinuationNoteInput) =>
      notes.save({ ...userSave(updateId, 1, note), basis: read.basis!, acks: acksOf(read) }, bot);
    const headcount = { text: "Send the final headcount by Thursday" };
    for (const [name, note] of [
      ["unquoted new item", { ...kept, waiting: [headcount] }],
      ["reworded existing item", { ...empty(), requests: [{ text: "Plan the offsite for 40" }] }],
    ] as const)
      assert.include((yield* save(name, note).pipe(Effect.flip)).message, "quote", name);
    const saved = yield* save("sourced", {
      ...kept,
      waiting: [{ ...headcount, quote: "final headcount by Thursday" }],
    });
    if (saved._tag !== "saved") return assert.fail();
    assert.deepEqual(
      [...saved.view.note.requests, ...saved.view.note.waiting].map((item) =>
        item.refs.map((ref) => (ref.kind === "message" ? ref.messageId : ref.kind)),
      ),
      [["message-1"], ["message-2"]],
    );
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "shows an input too large for any page by reference and passes it once the note keeps it",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const large = "Diff line of the pasted Harbor patch.\n".repeat(1_000);
      yield* input(1, large, { directUser: true });
      yield* input(2, "Keep the Harbor date open.", { directUser: true });
      const notes = yield* BotContinuation.BotContinuation;
      const read = yield* refreshRead();
      assert.isAtMost(toolResultBytes(read), refreshResponseBytes);
      const [reference, next] = read.uncovered!.sources;
      assert.deepEqual(reference?.tooLarge, { bytes: utf8Bytes(large), createdAt: now });
      const preview = shownText(reference)!;
      assert.isTrue(large.startsWith(preview) && preview.endsWith("\n"));
      assert.isAtMost(utf8Bytes(preview), 2_000);
      assert.equal(shownText(next), "Keep the Harbor date open.");
      // The model leaves out the ack of the part where the server cut the preview.
      const cutPart = reference!.parts.at(-1)!;
      const seen = acksOf(read).filter((ack) => !("ack" in cutPart) || ack !== cutPart.ack);
      assert.isTrue(reference!.parts.slice(0, -1).every((part) => "ack" in part));
      assert.include(cutPart, {
        cut: "The preview stops here. The full text stays in T3 history.",
      });

      const unlisted = yield* notes
        .save({ ...userSave("unlisted", null, empty()), basis: read.basis!, acks: seen }, bot)
        .pipe(Effect.flip);
      assert.include(unlisted.message, "message-1");
      const kept = {
        ...empty(),
        waiting: [{ text: "Unreviewed large input message-1: a pasted Harbor patch" }],
      };
      const saved = yield* notes.save(
        { ...userSave("listed", null, kept), basis: read.basis!, acks: seen },
        bot,
      );
      assert.equal(saved._tag, "saved");
      assert.deepInclude((yield* notes.get(scope)).note.waiting[0]!.refs[0]!, {
        messageId: MessageId.make("message-1"),
        quote: preview.slice(0, 400),
        availability: "available",
      });
      assert.deepEqual(yield* notes.coverage(scope), { _tag: "current" });
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect("never signs more large-input references on a page than the note can hold", () =>
  Effect.gen(function* () {
    yield* seed;
    for (let ordinal = 1; ordinal <= 21; ordinal += 1)
      yield* input(
        ordinal,
        `Retain export ${ordinal} for the Harbor audit.\n${JSON.stringify({ rows: "x".repeat(35_000) })}`,
        { directUser: true },
      );
    const notes = yield* BotContinuation.BotContinuation;
    const read = yield* refreshRead();
    const shown = read.uncovered!.sources;
    assert.lengthOf(shown, 20);
    assert.isTrue(shown.every((source) => source.tooLarge !== undefined));
    const kept = {
      ...empty(),
      waiting: shown.map((source) => ({
        text: `Unreviewed large input ${source.messageId}: an export for the Harbor audit`,
      })),
    };
    const saved = yield* notes.save(
      { ...userSave("all-slots", null, kept), basis: read.basis!, acks: acksOf(read) },
      bot,
    );
    assert.equal(saved._tag, "saved");
    // A full note leaves no item for the next reference, so refresh waits for the user.
    assert.deepEqual(yield* notes.coverage(scope), {
      _tag: "unprovable",
      reason: "note_too_large",
      inputs: 1,
      results: 0,
    });
  }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

/** Codex's code-mode print limit: 10,000 approximate tokens keep 20,000 bytes from each end. */
const codexPrint = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= 40_000) return text;
  let head = 20_000;
  while ((bytes[head]! & 0xc0) === 0x80) head -= 1;
  let tail = bytes.length - 20_000;
  while ((bytes[tail]! & 0xc0) === 0x80) tail += 1;
  const decoder = new TextDecoder();
  const removed = Math.ceil((bytes.length - 40_000) / 4);
  return `${decoder.decode(bytes.subarray(0, head))}…${removed} tokens truncated…${decoder.decode(bytes.subarray(tail))}`;
};
/** Every acknowledgement a model can copy from what it was shown, however it was encoded. */
const visibleAcks = (printed: string) =>
  [...printed.matchAll(/\\*"ack\\*":\\*"([0-9a-f]{8})\\*"/g)].map((match) => match[1]!);

it.effect(
  "certifies a page cut in the middle of its print only through the last item shown whole",
  () =>
    Effect.gen(function* () {
      yield* seed;
      for (let ordinal = 1; ordinal <= 3; ordinal += 1)
        yield* input(ordinal, `Answered question ${ordinal}`, { directUser: true });
      const qualification =
        "Before using this data, keep the Harbor launch on hold until Mira approves its date.";
      const rows = Array.from(
        { length: 440 },
        (_, row) =>
          `${row},${Array.from({ length: 10 }, (_, column) => `"${(row + column) % 3}"`).join(",")}`,
      );
      rows.splice(220, 0, qualification);
      yield* input(
        4,
        `Review this exported CSV and retain the approval constraint it contains.\n${rows.join("\n")}`,
        { directUser: true },
      );
      yield* input(5, "Keep the Harbor date open.", { directUser: true });
      const notes = yield* BotContinuation.BotContinuation;
      const read = yield* refreshRead();
      assert.deepEqual(
        read.uncovered!.sources.map((source) => [source.ordinal, source.tooLarge]),
        [1, 2, 3, 4, 5].map((ordinal) => [ordinal, undefined]),
      );
      // Printing the MCP text block encodes the read twice; Codex then cuts the CSV's middle.
      const printed = codexPrint(
        JSON.stringify({ type: "text", text: JSON.stringify({ continuation: read }) }),
      );
      assert.notInclude(printed, qualification);
      assert.include(printed, read.basis!.token);
      const cut = yield* notes.save(
        { ...userSave("cut", null), basis: read.basis!, acks: visibleAcks(printed) },
        bot,
      );
      assert.equal(cut._tag, "saved");
      assert.deepEqual(yield* notes.coverage(scope), { _tag: "behind", inputs: 2, results: 0 });

      const next = yield* refreshRead();
      const whole = JSON.stringify({ continuation: next });
      assert.equal(codexPrint(whole), whole);
      const saved = yield* notes.save(
        { ...userSave("whole", 1), basis: next.basis!, acks: visibleAcks(whole) },
        bot,
      );
      assert.equal(saved._tag, "saved");
      assert.deepEqual(yield* notes.coverage(scope), { _tag: "current" });
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);

it.effect.each(["notification", "delegatedCompletion"] as const)(
  "counts a returned %s until a save whose read showed it",
  (marker) =>
    Effect.gen(function* () {
      yield* seed;
      yield* input(1, "Ask the vendor for two quotes.", { directUser: true });
      const notes = yield* BotContinuation.BotContinuation;
      assert.equal((yield* saveShown("first"))._tag, "saved");
      assert.deepEqual(yield* notes.coverage(scope), { _tag: "current" });

      yield* homeRun("run-result", 2);
      yield* returnedResult("run-result", 2);
      const main = yield* SqlClient.SqlClient;
      if (marker === "delegatedCompletion")
        yield* main`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(json_remove(payload_json, '$.notification'), '$.delegatedCompletion', json('{"parentRunId":"run-1","generation":1,"taskIds":[]}')) WHERE message_id = 'result-2'`;
      const behind = { _tag: "behind", inputs: 0, results: 1 } as const;
      assert.deepEqual(yield* notes.coverage(scope), behind);
      const instructions = yield* notes.get(scope);
      assert.equal(
        (yield* notes.save({ ...userSave("unshown", 1), basis: instructions.basis! }, bot))._tag,
        "saved",
      );
      assert.deepEqual(yield* notes.coverage(scope), behind);
      // A user edit carries the proof but reads nothing itself.
      assert.equal((yield* notes.save(userSave("user", 2), { kind: "user" }))._tag, "saved");
      assert.deepEqual(yield* notes.coverage(scope), behind);
      // An ordinary turn already holds the result natively and is sent no page.
      assert.isUndefined((yield* notes.get(scope, { page: true })).uncovered);

      yield* homeRun("run-refresh", 3);
      const read = yield* refreshRead();
      assert.deepEqual(
        read.uncovered?.sources.map((source) => [source.messageId, source.kind]),
        [["result-2", "result"]],
      );
      assert.equal((yield* saveShown("shown"))._tag, "saved");
      assert.deepEqual(yield* notes.coverage(scope), { _tag: "current" });
      assert.equal((yield* notes.save(userSave("user-after", 4), { kind: "user" }))._tag, "saved");
      assert.deepEqual(yield* notes.coverage(scope), { _tag: "current" });
      // Restoring a revision from before the result brings back its proof, not the newer one.
      const restored = yield* notes.save(
        { ...userSave("restore", 5, { ...empty() }), restoredFrom: 1 },
        { kind: "user" },
      );
      assert.equal(restored._tag, "saved");
      assert.deepEqual(yield* notes.coverage(scope), behind);
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
);
