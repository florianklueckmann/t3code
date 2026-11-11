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
import * as Net from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HOME_CHECK_PROMPT } from "../../apps/server/src/bots/BotHomeCheck.ts";
import { resolveCliAuthConfig } from "../../apps/server/src/cli/config.ts";
import {
  createBotHome,
  files,
  homeIsEligible,
  noteOf,
  type ObservedNote,
  TERMINAL_TASK,
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
import { CASES, type HomeCheckCase } from "./cases.ts";
import { gradeSample, type Observation } from "./grade.ts";

/** The server starts a check only after the Home has been quiet this long; a little margin on top. */
const QUIET_WAIT = "11 minutes";
const POLL = "15 seconds";
const POLLS = 80;

const Outcome = Schema.Struct({ kind: Schema.String, added: Schema.optional(Schema.Number) });
const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(Outcome));

const inThreeWeeks = DateTime.now.pipe(
  Effect.map((now) =>
    DateTime.formatLocal(DateTime.add(now, { days: 21 }), {
      locale: "en-US",
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  ),
);
/** A daily time that passed a minute ago, in the shared machine's zone, which the server uses too. */
const passedSlot = DateTime.now.pipe(
  Effect.map((now) => {
    const { hour, minute } = DateTime.toParts(
      DateTime.setZone(DateTime.subtract(now, { minutes: 1 }), DateTime.zoneMakeLocal()),
    );
    return {
      timeOfDay: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      doneThrough: DateTime.formatIso(DateTime.subtract(now, { minutes: 3 })),
      now: DateTime.formatIso(now),
    };
  }),
);

/**
 * The Bot database of the parent-owned synthetic server. No client can start a check at once,
 * so the eval makes one owed, as a passed daily time would, and the server's scheduler runs it.
 */
const botDatabase = (path: string) => {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  return {
    owe: (home: string, slot: Effect.Success<typeof passedSlot>) => {
      db.prepare(
        `INSERT INTO bot_home_checks (home_thread_id, settings_revision, enabled, time_of_day, done_through, updated_at)
          VALUES (?, 1, 1, ?, ?, ?)
          ON CONFLICT (home_thread_id) DO UPDATE SET enabled = 1, time_of_day = excluded.time_of_day,
            done_through = excluded.done_through, check_message_id = NULL, last_outcome_json = NULL`,
      ).run(home, slot.timeOfDay, slot.doneThrough, slot.now);
    },
    read: (home: string) =>
      db
        .prepare(
          "SELECT check_message_id, last_outcome_json FROM bot_home_checks WHERE home_thread_id = ?",
        )
        .get(home) as
        | { readonly check_message_id: string | null; readonly last_outcome_json: string | null }
        | undefined,
    close: () => db.close(),
  };
};
type BotDatabase = ReturnType<typeof botDatabase>;

const setUp = Effect.fn("botHomeCheckEval.setUp")(function* (
  call: Call,
  testCase: HomeCheckCase,
  sample: number,
  work: string,
  model: string,
  effort: string,
) {
  const tag = `bhc-${testCase.id}-${sample}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const home = yield* createBotHome(call, { tag, work, model, effort });
  const { homeThreadId } = home;
  const userMessageIds: string[] = [];
  for (const text of testCase.seed) {
    const runId = yield* runTurn(
      call,
      homeThreadId,
      text.replace("{inThreeWeeks}", yield* inThreeWeeks),
    );
    const [message] = (yield* readItems(call, homeThreadId, "messages")).filter(
      (item) => item.runId === runId && item.type === "user_message",
    );
    if (message?.messageId != null) userMessageIds.push(message.messageId);
  }
  let taskId: string | null = null;
  if (testCase.task !== null) {
    const started = yield* call(
      "t3_bot",
      {
        action: "start_task",
        botId: tag,
        projectId: home.projectId,
        title: testCase.task.title,
        task: testCase.task.prompt,
      },
      Schema.Struct({ task: Schema.Struct({ id: Schema.String }) }),
    );
    taskId = started.task.id;
    yield* untilTasksSettled(call, tag);
  }
  return {
    id: testCase.id,
    sample,
    ...home,
    userMessageIds,
    taskId,
    filesBefore: files(home.root),
  };
});
type Fixture = Effect.Success<ReturnType<typeof setUp>>;

const untilTasksSettled = Effect.fn("botHomeCheckEval.untilTasksSettled")(function* (
  call: Call,
  botId: string,
) {
  for (let poll = 0; poll < POLLS; poll += 1) {
    const tasks = yield* taskList(call, botId);
    if (tasks.every((task) => TERMINAL_TASK.includes(task.status))) return;
    yield* Effect.sleep(POLL);
  }
  return yield* new SampleError({ message: "the case's task did not finish" });
});

/** Makes one check owed on every Home, then waits until each has an outcome. */
const runChecks = Effect.fn("botHomeCheckEval.runChecks")(function* (
  db: BotDatabase,
  homes: ReadonlyArray<string>,
  statePath: string,
) {
  yield* Effect.try({
    try: () => {
      const state = new NodeSqlite.DatabaseSync(statePath, { readOnly: true });
      try {
        for (const home of homes)
          if (!homeIsEligible(state, home))
            throw new Error(
              "The fixture Home needs an idle, completed ordinary turn and its native provider conversation.",
            );
      } finally {
        state.close();
      }
    },
    catch: () =>
      new SampleError({
        message:
          "Home fixture is ineligible for its restricted check; no quiet-period wait was started.",
      }),
  });
  yield* Effect.sleep(QUIET_WAIT);
  const slot = yield* passedSlot;
  for (const home of homes) db.owe(home, slot);
  for (let poll = 0; poll < POLLS; poll += 1) {
    if (homes.every((home) => db.read(home)?.last_outcome_json != null)) return;
    yield* Effect.sleep(POLL);
  }
});

const observe = Effect.fn("botHomeCheckEval.observe")(function* (
  call: Call,
  db: BotDatabase,
  fixture: Fixture,
  before: ObservedNote,
  tasksBefore: number,
  setup: ReadonlyArray<string>,
) {
  const row = db.read(fixture.homeThreadId);
  const items = yield* readItems(call, fixture.homeThreadId, "messages");
  const prompt = items.find(
    (item) => item.type === "user_message" && item.messageId === row?.check_message_id,
  );
  // The final answer; Codex may post a short preamble before its tool calls.
  const reply =
    items.filter((item) => item.type === "assistant_message" && item.runId === prompt?.runId).at(-1)
      ?.text ?? "";
  const run: Observation = {
    outcome: row?.last_outcome_json == null ? null : decodeOutcome(row.last_outcome_json),
    before,
    after: yield* noteOf(call, fixture),
    reply,
    taskId: fixture.taskId,
    userMessageIds: fixture.userMessageIds,
    tasksBefore,
    tasksAfter: (yield* taskList(call, fixture.botId)).length,
    unchangedFiles: files(fixture.root) === fixture.filesBefore,
    setup,
  };
  const checks = gradeSample(
    CASES.find((testCase) => testCase.id === fixture.id)!,
    run,
  );
  return {
    id: fixture.id,
    sample: fixture.sample,
    pass: checks.every((check) => check.pass),
    checks,
    // The baseline arm runs a server whose check prompt differs from this checkout's.
    promptMatchesSource: prompt?.text?.startsWith(HOME_CHECK_PROMPT) ?? false,
    checkPrompt: prompt?.text ?? null,
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
  const db = botDatabase(NodePath.join(NodePath.dirname(config.dbPath), "bots.sqlite"));
  NodeFS.writeFileSync(
    NodePath.join(out, "metadata.json"),
    encodeJson({
      harnessHead: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      model: values.model,
      effort: values.effort,
      samples,
      prompt: HOME_CHECK_PROMPT,
      baseline: values.baseline === undefined ? null : NodeFS.readFileSync(values.baseline, "utf8"),
    }),
  );
  yield* withTools(baseDir, "bot-home-check", (call) =>
    Effect.gen(function* () {
      yield* requireCodexModel(call, values.model, values.effort);
      const work = NodePath.resolve(values.work ?? NodePath.join(out, "work"));
      const fixtures: Fixture[] = [];
      for (const testCase of selected)
        for (let sample = 0; sample < samples; sample += 1)
          fixtures.push(yield* setUp(call, testCase, sample, work, values.model, values.effort));
      const setup = new Map(fixtures.map((fixture) => [fixture, [] as string[]]));

      // The control's first check proposes; the user then removes it before the graded check.
      const twice = fixtures.filter(
        (fixture) => CASES.find((testCase) => testCase.id === fixture.id)?.between != null,
      );
      if (twice.length > 0) {
        const before = new Map<Fixture, number>();
        for (const fixture of twice)
          before.set(fixture, (yield* noteOf(call, fixture)).waiting.length);
        yield* runChecks(
          db,
          twice.map((fixture) => fixture.homeThreadId),
          config.dbPath,
        );
        for (const fixture of twice) {
          if ((yield* noteOf(call, fixture)).waiting.length <= before.get(fixture)!)
            setup.get(fixture)!.push("the first check proposed nothing to remove");
          const between = CASES.find((testCase) => testCase.id === fixture.id)!.between!;
          yield* runTurn(call, fixture.homeThreadId, between);
        }
      }

      const baselines = new Map<Fixture, { note: ObservedNote; tasks: number }>();
      for (const fixture of fixtures) {
        const note = yield* noteOf(call, fixture);
        const pattern = CASES.find((testCase) => testCase.id === fixture.id)!.waitingBefore;
        if (
          pattern !== null &&
          !note.waiting.some((item) => new RegExp(pattern, "i").test(item.text))
        )
          setup.get(fixture)!.push("Waiting did not hold the proposal before the check");
        if (
          twice.includes(fixture) &&
          note.waiting.some((item) => /passport|lease/i.test(item.text))
        )
          setup.get(fixture)!.push("the user's removal did not leave Waiting");
        baselines.set(fixture, { note, tasks: (yield* taskList(call, fixture.botId)).length });
      }
      yield* runChecks(
        db,
        fixtures.map((fixture) => fixture.homeThreadId),
        config.dbPath,
      );
      for (const fixture of fixtures) {
        const { note, tasks } = baselines.get(fixture)!;
        const row = yield* observe(call, db, fixture, note, tasks, setup.get(fixture)!).pipe(
          Effect.catch((error) =>
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
        const own = rows.filter((row) => row.id === testCase.id);
        const passed = own.filter((row) => row.pass).length;
        return `| ${testCase.id} | ${passed}/${own.length} | ${passed * 2 > own.length ? "yes" : "no"} |`;
      }),
    ].join("\n"),
  );
});
if (import.meta.main)
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, Net.layer)),
    NodeRuntime.runMain,
  );
