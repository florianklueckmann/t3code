import * as FileSystem from "effect/FileSystem";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  BotTaskId,
  ProjectId,
  ThreadId,
  type BotSaveContinuationInput,
  type BotContinuationNoteInput,
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
      const result = yield* notes.save(
        userSave("bounded", null, {
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
      const root = process.env.T3B21_FIXTURE_ROOT;
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
        assert.deepEqual(history.at(-1), { migration_id: 9, name: "BotContinuation" });
      }).pipe(Effect.provide(connection), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer)),
);
