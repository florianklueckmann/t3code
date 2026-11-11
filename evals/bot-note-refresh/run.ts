// @effect-diagnostics nodeBuiltinImport:off - standalone eval CLI and fixture files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BOT_TASK_TERMINAL_STATUSES,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { NOTE_REFRESH_PROMPT } from "../../apps/server/src/bots/BotMaintenance.ts";
import { resolveCliAuthConfig } from "../../apps/server/src/cli/config.ts";
import {
  createBotHome,
  files,
  homeIsEligible,
  NOTE_SECTIONS,
  noteOf,
  type ObservedNote,
  taskList,
} from "../shared/botHome.ts";
import {
  type Call,
  encodeJson,
  readItems,
  requireCodexModel,
  runTurn,
  SampleError,
  withTools,
} from "../shared/devServerTools.ts";
import { CASES, type NoteRefreshCase } from "./cases.ts";
import { casePasses, gradeSample, type Observation } from "./grade.ts";

const POLL = "15 seconds";
const POLLS = 120;
/** The server refreshes at most this many pages a night. */
const NIGHTLY_PAGES = 3;
const REFRESH_MESSAGE = "bot-maintenance:note:";
const NOT_TOOLS = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "checkpoint",
  "todo_list",
  "system_notice",
  "proposed_plan",
  "error",
]);

interface Position {
  readonly runOrdinal: number;
  readonly ordinal: number;
}

/** Sends Home input and stops its turn at once, so no ordinary turn records it. */
const sendUnrecorded = Effect.fn("botNoteRefreshEval.sendUnrecorded")(function* (
  call: Call,
  threadId: string,
  message: string,
) {
  const sent = yield* call(
    "t3_thread_send",
    { threadId, message },
    OrchestratorMcpThreadSendResult,
  );
  yield* call(
    "t3_thread_interrupt",
    { threadId, runId: sent.runId },
    OrchestratorMcpThreadInterruptResult,
  );
  while (true) {
    const waited = yield* call(
      "t3_thread_wait",
      { threadId, runId: sent.runId, timeoutMs: 15_000 },
      OrchestratorMcpThreadWaitResult,
    );
    if (!waited.timedOut) return { messageId: sent.messageId, status: waited.status };
  }
});

/**
 * The parent-owned synthetic server's databases. No client can start a night at once, so the
 * eval turns maintenance on as a first enable does and leaves a night owed; the server's own
 * scheduler then runs learning, the note refresh and compaction.
 */
const databases = (statePath: string, botsPath: string) => {
  const bots = new NodeSqlite.DatabaseSync(botsPath);
  bots.exec("PRAGMA busy_timeout = 5000;");
  const state = () => new NodeSqlite.DatabaseSync(statePath, { readOnly: true });
  const reading = <A>(read: (db: NodeSqlite.DatabaseSync) => A) => {
    const db = state();
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  return {
    /** Every Home input so far is the learning baseline, as `BotMaintenance.configure` records it. */
    enable: (home: string, now: string, owedSince: string) => {
      const inputs = reading((db) =>
        db
          .prepare(
            "SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role = 'user'",
          )
          .all(home)
          .map((row) => row.message_id as string),
      );
      bots.exec("BEGIN");
      try {
        bots
          .prepare(
            `INSERT INTO bot_maintenance (home_thread_id, settings_revision, enabled, started_at, scan_through_sequence, processed_through_sequence, nightly_at, updated_at)
            VALUES (?, 1, 1, ?, 0, 0, ?, ?)`,
          )
          .run(home, now, owedSince, now);
        bots
          .prepare(
            `INSERT INTO bot_maintenance_sources (home_thread_id, kind, source_id, state, recorded_at)
            SELECT ?, 'home-input', value, 'baseline', ? FROM json_each(?)`,
          )
          .run(home, now, encodeJson(inputs));
        bots
          .prepare(
            `INSERT INTO bot_maintenance_sources (home_thread_id, kind, source_id, state, recorded_at)
            SELECT home_thread_id, 'task-result', task_id, 'baseline', ? FROM bot_tasks
            WHERE home_thread_id = ? AND status IN (SELECT value FROM json_each(?))`,
          )
          .run(now, home, encodeJson(BOT_TASK_TERMINAL_STATUSES));
        bots.exec("COMMIT");
      } catch (cause) {
        bots.exec("ROLLBACK");
        throw cause;
      }
    },
    /** The night's note refresh attempts, as `note` or `note:reason`. */
    attempts: (home: string) =>
      bots
        .prepare(
          `SELECT json_extract(outcome_json, '$.note') AS note, json_extract(outcome_json, '$.reason') AS reason
          FROM bot_maintenance_runs WHERE home_thread_id = ? AND json_extract(outcome_json, '$.note') IS NOT NULL
          ORDER BY started_at, finished_at`,
        )
        .all(home)
        .map((row) => (row.reason == null ? String(row.note) : `${row.note}:${row.reason}`)),
    frontier: (home: string) => {
      const row = bots
        .prepare(
          "SELECT json_extract(revision_json, '$.frontier') AS frontier FROM bot_continuation_revisions WHERE home_thread_id = ? ORDER BY revision DESC LIMIT 1",
        )
        .get(home);
      return row?.frontier == null ? null : (JSON.parse(String(row.frontier)) as Position);
    },
    /** Where a Home input sits in the stream the note covers, or null when it never landed. */
    position: (home: string, messageId: string) =>
      reading((db) => {
        const row = db
          .prepare(
            `SELECT i.ordinal, COALESCE(r.ordinal, 0) AS run_ordinal FROM orchestration_v2_projection_turn_items i
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
            WHERE i.thread_id = ? AND i.type = 'user_message' AND json_extract(i.payload_json, '$.messageId') = ?`,
          )
          .get(home, messageId);
        return row === undefined
          ? null
          : ({ runOrdinal: Number(row.run_ordinal), ordinal: Number(row.ordinal) } as Position);
      }),
    eligible: (home: string) => reading((db) => homeIsEligible(db, home)),
    close: () => bots.close(),
  };
};
type Databases = ReturnType<typeof databases>;

const reaches = (frontier: Position | null, target: Position | null) =>
  frontier !== null &&
  target !== null &&
  (frontier.runOrdinal > target.runOrdinal ||
    (frontier.runOrdinal === target.runOrdinal && frontier.ordinal >= target.ordinal));

const setUp = Effect.fn("botNoteRefreshEval.setUp")(function* (
  call: Call,
  testCase: NoteRefreshCase,
  sample: number,
  work: string,
  model: string,
  effort: string,
) {
  const tag = `bnr-${testCase.id}-${sample}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const home = yield* createBotHome(call, { tag, work, model, effort });
  for (const text of testCase.seed) yield* runTurn(call, home.homeThreadId, text);
  const stopped: Array<{ readonly messageId: string; readonly status: string }> = [];
  for (const text of testCase.unrecorded)
    stopped.push(yield* sendUnrecorded(call, home.homeThreadId, text));
  return { id: testCase.id, sample, home, stopped, filesBefore: files(home.root) };
});
type Fixture = Effect.Success<ReturnType<typeof setUp>>;

const preconditions = (
  testCase: NoteRefreshCase,
  fixture: Fixture,
  note: ObservedNote,
  db: Databases,
) => {
  const issues: string[] = [];
  const items = NOTE_SECTIONS.flatMap((section) => note[section]);
  if (!db.eligible(fixture.home.homeThreadId))
    issues.push("the Home had no idle native conversation for a refresh");
  if (testCase.needsExistingItems && items.length === 0)
    issues.push("the seed turn saved no note items to keep");
  for (const pattern of testCase.absentBefore)
    if (items.some((item) => new RegExp(pattern, "i").test(item.text)))
      issues.push(`an ordinary turn already recorded /${pattern}/`);
  for (const stopped of fixture.stopped)
    if (db.position(fixture.home.homeThreadId, stopped.messageId) === null)
      issues.push(`stopped input ${stopped.messageId} (${stopped.status}) never reached the Home`);
  return issues;
};

/** The night is over once its last attempt did not refresh, or the note covers every input. */
const nightOver = (db: Databases, fixture: Fixture) => {
  const home = fixture.home.homeThreadId;
  const attempts = db.attempts(home);
  const last = fixture.stopped.at(-1);
  return (
    attempts.length > 0 &&
    db.eligible(home) &&
    (attempts.at(-1) !== "refreshed" ||
      attempts.length >= NIGHTLY_PAGES ||
      (last !== undefined && reaches(db.frontier(home), db.position(home, last.messageId))))
  );
};

const observe = Effect.fn("botNoteRefreshEval.observe")(function* (
  call: Call,
  db: Databases,
  fixture: Fixture,
  before: { readonly note: ObservedNote; readonly tasks: number; readonly setup: string[] },
) {
  const { home } = fixture;
  const messages = yield* readItems(call, home.homeThreadId, "messages");
  const refreshRuns = messages
    .filter(
      (item) =>
        item.type === "user_message" && item.messageId?.startsWith(REFRESH_MESSAGE) === true,
    )
    .map((item) => item.runId);
  const activity = (yield* readItems(call, home.homeThreadId, "activity")).filter((item) =>
    refreshRuns.includes(item.runId),
  );
  const last = fixture.stopped.at(-1);
  const testCase = CASES.find((candidate) => candidate.id === fixture.id)!;
  const run: Observation = {
    attempts: db.attempts(home.homeThreadId),
    covered:
      last !== undefined &&
      reaches(db.frontier(home.homeThreadId), db.position(home.homeThreadId, last.messageId)),
    before: before.note,
    after: yield* noteOf(call, home),
    // The final answer; Codex may post a short preamble before its tool calls.
    reply:
      messages
        .filter((item) => item.type === "assistant_message" && item.runId === refreshRuns[0])
        .at(-1)?.text ?? "",
    tools: activity
      .filter((item) => !NOT_TOOLS.has(item.type))
      .map((item) => {
        const text = item.text ?? "";
        const tool = /"toolName":\s*"([^"]+)"/.exec(text)?.[1] ?? item.title ?? item.type;
        const action = /"action":\s*"([^"]+)"/.exec(text)?.[1];
        return action === undefined ? tool : `${tool} ${action}`;
      }),
    largeInputId:
      testCase.largeInput === null
        ? null
        : (fixture.stopped[testCase.largeInput]?.messageId ?? null),
    tasksBefore: before.tasks,
    tasksAfter: (yield* taskList(call, home.botId)).length,
    unchangedFiles: files(home.root) === fixture.filesBefore,
    setup: before.setup,
  };
  const checks = gradeSample(testCase, run);
  return {
    id: fixture.id,
    sample: fixture.sample,
    pass: checks.every((check) => check.pass),
    checks,
    homeThreadId: home.homeThreadId,
    stopped: fixture.stopped,
    refreshRuns,
    // The baseline arm runs a server whose refresh prompt differs from this checkout's.
    promptMatchesSource:
      messages.find((item) => item.runId === refreshRuns[0] && item.type === "user_message")
        ?.text === NOTE_REFRESH_PROMPT,
    activity,
    ...run,
  };
});

const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      "base-dir": { type: "string" },
      work: { type: "string" },
      model: { type: "string", default: "gpt-6.1-terra" },
      effort: { type: "string", default: "high" },
      samples: { type: "string", default: "3" },
      case: { type: "string", multiple: true },
      baseline: { type: "string" },
    },
  });
  if (values.out === undefined || values["base-dir"] === undefined)
    return yield* Effect.die(
      new Error("Pass --out and --base-dir for a parent-owned synthetic server."),
    );
  const baseDir = NodePath.resolve(values["base-dir"]);
  if (baseDir === NodePath.join(NodeOS.homedir(), ".t3"))
    return yield* Effect.die(new Error("Never run this eval against the live T3 Code home."));
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1)
    return yield* Effect.die(new Error("--samples must be a positive integer."));
  const selected = CASES.filter(
    (testCase) => values.case === undefined || values.case.includes(testCase.id),
  );
  if (selected.length === 0) return yield* Effect.die(new Error("No matching cases."));
  const out = NodePath.resolve(values.out);
  NodeFS.mkdirSync(out, { recursive: true });
  const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none(), {
    quietLogs: true,
  });
  const db = databases(
    config.dbPath,
    NodePath.join(NodePath.dirname(config.dbPath), "bots.sqlite"),
  );
  NodeFS.writeFileSync(
    NodePath.join(out, "metadata.json"),
    encodeJson({
      harnessHead: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      model: values.model,
      effort: values.effort,
      samples,
      prompt: NOTE_REFRESH_PROMPT,
      baseline: values.baseline === undefined ? null : NodeFS.readFileSync(values.baseline, "utf8"),
    }),
  );
  yield* withTools(baseDir, "bot-note-refresh", (call) =>
    Effect.gen(function* () {
      yield* requireCodexModel(call, values.model, values.effort);
      const work = NodePath.resolve(values.work ?? NodePath.join(out, "work"));
      const fixtures: Fixture[] = [];
      for (const testCase of selected)
        for (let sample = 0; sample < samples; sample += 1)
          fixtures.push(yield* setUp(call, testCase, sample, work, values.model, values.effort));

      const before = new Map<Fixture, { note: ObservedNote; tasks: number; setup: string[] }>();
      for (const fixture of fixtures) {
        const note = yield* noteOf(call, fixture.home);
        const testCase = CASES.find((candidate) => candidate.id === fixture.id)!;
        before.set(fixture, {
          note,
          tasks: (yield* taskList(call, fixture.home.botId)).length,
          setup: preconditions(testCase, fixture, note, db),
        });
      }
      const now = yield* DateTime.now;
      for (const fixture of fixtures)
        db.enable(
          fixture.home.homeThreadId,
          DateTime.formatIso(now),
          DateTime.formatIso(DateTime.subtract(now, { days: 2 })),
        );
      for (let poll = 0; poll < POLLS; poll += 1) {
        if (fixtures.every((fixture) => nightOver(db, fixture))) break;
        yield* Effect.sleep(POLL);
      }
      for (const fixture of fixtures) {
        const row = yield* observe(call, db, fixture, before.get(fixture)!).pipe(
          Effect.catch((error: SampleError) =>
            Effect.succeed({
              id: fixture.id,
              sample: fixture.sample,
              pass: false,
              infrastructureError: error.message,
            }),
          ),
        );
        NodeFS.appendFileSync(NodePath.join(out, "results.jsonl"), `${encodeJson(row)}\n`);
      }
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => db.close())));
  const rows = NodeFS.readFileSync(NodePath.join(out, "results.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly id: string; readonly pass: boolean });
  NodeFS.writeFileSync(
    NodePath.join(out, "summary.md"),
    [
      "| Case | Passed samples | Case passes |",
      "| --- | --- | --- |",
      ...selected.map((testCase) => {
        const own = rows.filter((row) => row.id === testCase.id).map((row) => row.pass);
        return `| ${testCase.id} | ${own.filter(Boolean).length}/${own.length} | ${casePasses(own) ? "yes" : "no"} |`;
      }),
    ].join("\n"),
  );
});
if (import.meta.main)
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, Net.layer)),
    NodeRuntime.runMain,
  );
