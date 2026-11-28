/**
 * Runs real Bot turns through a running T3 Code dev server and its configured Codex provider, then
 * grades the answers, the Bot's t3_bot calls, and the sources the server stored. See README.md.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BOT_TASK_TERMINAL_STATUSES,
  BotDetail,
  ProviderInstanceId,
  ProviderDriverKind,
  BotTaskSummary,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadReadResult,
  Project,
} from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type BotModelSelection,
  type Call,
  encodeJson,
  INSTANCE_FLAG,
  readItems,
  requireBotModel,
  runTurn,
  SampleError,
  type ToolActivity,
  toolActivity,
  withTools,
} from "../shared/devServerTools.ts";
import { judgeDay, verifyDayHomes } from "./dayJudge.ts";
import { daySummary, dayLedger } from "./daySummary.ts";
import { dayWorkerArgs, dayWorkerServer } from "./dayWorker.ts";
import { withRpc } from "../shared/devServerRpc.ts";
import { noteOf } from "../shared/botHome.ts";
import {
  BOT_INSTRUCTIONS,
  BOT_NAME,
  type BotSourcesCase,
  CASES,
  type LearningScopeKey,
  PROJECT_TITLE,
  PROJECTS,
  type ProjectKey,
  TWIN_SOURCES,
} from "./cases.ts";
import { DAY_CASE_ID, DAY_WORKER_MODEL, scoreDay } from "./homeDay.ts";
import { runDaySample } from "./homeDayRun.ts";

export interface SampleRun {
  readonly answers: ReadonlyArray<string>;
  /** The message ids of each turn's run, user and assistant. */
  readonly turnMessageIds?: ReadonlyArray<ReadonlyArray<string>>;
  readonly tools: ReadonlyArray<ToolActivity>;
  /** Source locations per Bot and project after the turns. */
  readonly sources: {
    readonly bot: Readonly<Record<ProjectKey, ReadonlyArray<string>>>;
    readonly twin: ReadonlyArray<string>;
  };
  readonly ids: { readonly botId: string; readonly projectIds: Record<ProjectKey, string> };
  /** The Bot's learning entries after the turns, by their newest revision. */
  readonly learning: ReadonlyArray<LearnedEntry>;
  readonly homeModel?: BotModelSelection;
  /**
   * Bot-level Home cases: the project checkouts still hold their fixture files. Their tasks write
   * in pooled worktrees, so only the Home could change a checkout.
   */
  readonly checkoutsUnchanged?: boolean;
}

export interface LearnedEntry {
  readonly scope: LearningScopeKey;
  readonly kind: string;
  readonly text: string;
  readonly origin: string;
  readonly status: string;
  /** Recorded from the Bot's own conversation rather than seeded by the eval. */
  readonly byBot: boolean;
}

/** An MCP call as T3 records it in the thread's activity. */
const decodeToolCall = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      toolName: Schema.String,
      input: Schema.Struct({
        action: Schema.optional(Schema.String),
        // Unknown, so a call with a malformed argument still counts as a call.
        botId: Schema.optional(Schema.Unknown),
        projectId: Schema.optional(Schema.Unknown),
        task: Schema.optional(Schema.Unknown),
      }),
      output: Schema.optional(Schema.Unknown),
    }),
  ),
);
const decodeWorker = Schema.decodeUnknownOption(OrchestratorMcpDelegateTaskResult);
const decodeTask = Schema.decodeUnknownOption(Schema.Struct({ task: BotTaskSummary }));
const decodeToolEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({ structuredContent: Schema.Unknown }),
);

/** The messages an answer's thread links open at. */
export const linkedMessageIds = (answer: string): ReadonlyArray<string> =>
  [...answer.matchAll(/t3-thread:\/\/v2\/[^\s<>()[\]]+/g)].flatMap((match) => {
    const message = parseThreadLinkHref(match[0])?.message;
    return message === undefined ? [] : [message.messageId];
  });

const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length &&
  left.every((item) => right.includes(item)) &&
  right.every((item) => left.includes(item));
const locations = (sources: ReadonlyArray<{ readonly location: string }>) =>
  sources.map((source) => source.location);

export const gradeSample = (testCase: BotSourcesCase, run: SampleRun) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  testCase.turns.forEach((turn, index) => {
    const answer = run.answers[index] ?? "";
    for (const p of turn.textMust ?? [])
      add(`turn ${index + 1} textMust /${p}/i`, new RegExp(p, "i").test(answer));
    for (const p of turn.textMustNot ?? [])
      add(`turn ${index + 1} textMustNot /${p}/i`, !new RegExp(p, "i").test(answer));
    if (turn.citesTurn !== undefined) {
      const cited = run.turnMessageIds?.[turn.citesTurn - 1] ?? [];
      add(
        `turn ${index + 1} links a message of turn ${turn.citesTurn}`,
        linkedMessageIds(answer).some((id) => cited.includes(id)),
      );
    }
  });
  for (const key of ["a", "b"] as const) {
    const expected = testCase.sourcesAfter?.[key] ?? locations(PROJECTS[key].sources);
    add(`sources ${key}`, sameSet(run.sources.bot[key], expected));
  }
  add("twin sources unchanged", sameSet(run.sources.twin, locations(TWIN_SOURCES)));
  const calls = run.tools.flatMap((tool) => {
    const call = decodeToolCall(tool.text ?? "");
    if (Option.isNone(call)) return [];
    const output = Option.getOrUndefined(decodeToolEnvelope(call.value.output))?.structuredContent;
    return [{ ...call.value, output: output ?? call.value.output }];
  });
  const botCalls = calls.filter(({ toolName }) => toolName.endsWith("t3_bot"));
  const updates = botCalls
    .filter(({ input }) => input.action === "update")
    .map(({ input }) => input);
  if (testCase.modelRouting !== undefined) {
    const workers = calls.filter(({ toolName }) => toolName.endsWith("delegate_task"));
    const tasks = botCalls.filter(({ input }) => input.action === "start_task");
    if (testCase.modelRouting === "direct") {
      add("ordinary lookup stays in Home", workers.length === 0 && tasks.length === 0);
    } else {
      const home = run.homeModel;
      const isClaude = home?.model.startsWith("claude-") === true;
      const fast = isClaude ? /haiku/ : /luna/;
      const strong = isClaude ? /opus|fable/ : /sol|astra/;
      if (testCase.modelRouting === "fast-worker") {
        add(
          "used a lighter model on the same provider for each worker",
          home !== undefined &&
            workers.length > 0 &&
            tasks.length === 0 &&
            workers.every(({ output }) => {
              const worker = Option.getOrUndefined(decodeWorker(output));
              return (
                worker !== undefined &&
                worker.childThreadId !== null &&
                worker.providerInstanceId === home.instanceId &&
                worker.model !== null &&
                worker.model !== home.model &&
                fast.test(worker.executedModel ?? worker.model)
              );
            }),
        );
      } else {
        const task = Option.getOrUndefined(decodeTask(tasks[0]?.output))?.task;
        const selection = task?.modelSelection;
        add(
          "started one separate Bot task on a stronger model on the same provider",
          home !== undefined &&
            tasks.length === 1 &&
            task !== undefined &&
            task.workThreadId !== null &&
            selection !== undefined &&
            selection.instanceId === home.instanceId &&
            selection.model !== home.model &&
            strong.test(selection.model),
        );
      }
    }
  }
  if (testCase.distribution !== undefined) {
    const attempts = botCalls.filter(({ input }) => input.action === "start_task");
    const started = attempts.flatMap(({ input, output }) => {
      const task = Option.getOrUndefined(decodeTask(output))?.task;
      return task === undefined ? [] : [{ input, task }];
    });
    const named = testCase.distribution.map((key) => run.ids.projectIds[key]);
    if (named.length === 0) {
      add("tried to start no task", attempts.length === 0);
    } else {
      for (const key of testCase.distribution) {
        add(
          `started exactly one task in project ${key}`,
          started.filter(
            ({ task }) =>
              task.botId === run.ids.botId && task.projectId === run.ids.projectIds[key],
          ).length === 1,
        );
      }
      add(
        "tried to start tasks only for this Bot in the named projects",
        attempts.every(
          ({ input }) =>
            input.botId === run.ids.botId && named.some((id) => id === input.projectId),
        ),
      );
      add(
        "every brief states when it is done",
        started.length > 0 &&
          started.every(
            ({ input }) => typeof input.task === "string" && /done when:?\s+\w/i.test(input.task),
          ),
      );
    }
    add(
      "edited no file in the Home",
      run.tools.every((tool) => tool.type !== "file_change") && run.checkoutsUnchanged === true,
    );
  }
  const learnedByBot = run.learning.filter((entry) => entry.byBot);
  if (testCase.learningAfter === undefined) {
    add("no learning recorded", learnedByBot.length === 0);
  }
  for (const expected of testCase.learningAfter ?? []) {
    add(
      `learning ${expected.scope} ${expected.origin} ${expected.status} /${expected.text}/i`,
      learnedByBot.some(
        (entry) =>
          entry.scope === expected.scope &&
          (expected.kind === undefined || entry.kind === expected.kind) &&
          entry.origin === expected.origin &&
          entry.status === expected.status &&
          new RegExp(expected.text, "i").test(entry.text),
      ),
    );
  }
  if (testCase.sourcesAfter === undefined) {
    add("no t3_bot update", updates.length === 0);
  } else {
    const home = testCase.home === "bot" ? undefined : run.ids.projectIds[testCase.home];
    add(
      "t3_bot update names its own botId and projectId",
      updates.length > 0 &&
        updates.every((input) => input.botId === run.ids.botId && input.projectId === home),
    );
  }
  return checks;
};

const runSample = Effect.fn("botSources.runSample")(function* (
  call: Call,
  testCase: BotSourcesCase,
  options: { readonly work: string; readonly modelSelection: BotModelSelection },
) {
  const tag = `${testCase.id}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const projectIds = {} as Record<ProjectKey, string>;
  for (const key of ["a", "b"] as const) {
    const root = NodePath.join(options.work, tag, key);
    for (const [file, text] of Object.entries(PROJECTS[key].files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, file), text);
    }
    // A repository gives the started tasks their own worktrees, away from the checkout.
    if (testCase.home === "bot") {
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-qm", "fixture");
    }
    if (key === testCase.home && testCase.modelRouting === "fast-worker") {
      const exports = NodePath.join(root, "thread-exports");
      NodeFS.mkdirSync(exports, { recursive: true });
      for (let batch = 0; batch < 8; batch += 1) {
        const entries = Array.from({ length: 32 }, (_, index) => {
          const number = batch * 32 + index;
          const status = number === 17 || number === 81 ? "Confirmed" : "Tentative";
          return `${status} supply delay WD-${String(number).padStart(3, "0")}`;
        });
        NodeFS.writeFileSync(NodePath.join(exports, `thread-${batch}.txt`), entries.join("\n"));
      }
    }
    const project = yield* call(
      "t3_project_create",
      { title: PROJECT_TITLE, workspaceRoot: root },
      Project,
    );
    projectIds[key] = project.id;
  }
  const modelSelection = options.modelSelection;
  const create = (botId: string) =>
    call(
      "t3_bot",
      {
        action: "create",
        botId,
        name: BOT_NAME,
        instructions: BOT_INSTRUCTIONS,
        modelSelection,
        learningPolicy: testCase.learningPolicy ?? "after_adoption",
      },
      Schema.Unknown,
    );
  const attach = (botId: string, key: ProjectKey, sources = PROJECTS[key].sources) =>
    call(
      "t3_bot",
      {
        action: "attach",
        botId,
        projectId: projectIds[key],
        guidance: PROJECTS[key].guidance,
        sources,
      },
      Schema.Struct({ bot: BotDetail }),
    );
  const botId = `bs-${tag}`;
  const twinId = `${botId}-twin`;
  yield* create(botId);
  yield* attach(botId, "a");
  const attached = yield* attach(botId, "b");
  yield* create(twinId);
  yield* attach(twinId, "a", TWIN_SOURCES);
  const homeKey = testCase.home;
  const home =
    homeKey === "bot"
      ? (yield* call("t3_bot", { action: "open_home", botId }, Schema.Struct({ bot: BotDetail })))
          .bot.home
      : attached.bot.projects.find((p) => p.projectId === projectIds[homeKey]);
  if (home == null) return yield* Effect.die(new Error("home conversation missing"));
  const seed = testCase.seed;
  const seeded =
    seed === undefined
      ? undefined
      : (yield* call(
          "t3_bot",
          {
            action: "learn",
            botId,
            projectId: projectIds[seed.project],
            learning: {
              origin: seed.origin,
              kind: seed.kind,
              text: seed.text,
              ...(seed.scope === undefined ? {} : { scope: seed.scope }),
            },
          },
          Schema.Struct({
            learned: Schema.Struct({ entryId: Schema.String, revision: Schema.Number }),
          }),
        )).learned;

  // Only the Home's choice is graded, so this stops the tasks' ungraded work early.
  const cancelTasks = Effect.forEach(testCase.home === "bot" ? [botId, twinId] : [], (id) =>
    Effect.gen(function* () {
      const { tasks } = yield* call(
        "t3_bot",
        { action: "list_tasks", botId: id },
        Schema.Struct({ tasks: Schema.Array(BotTaskSummary) }),
      );
      for (const task of tasks.filter((task) => !BOT_TASK_TERMINAL_STATUSES.has(task.status))) {
        yield* call(
          "t3_bot",
          { action: "cancel_task", botId: id, taskId: task.id },
          Schema.Unknown,
        );
      }
    }),
  );
  const answers: Array<string> = [];
  const turnMessageIds: Array<ReadonlyArray<string>> = [];
  yield* Effect.gen(function* () {
    for (const turn of testCase.turns) {
      if (turn.adoptSeedFirst === true && seeded !== undefined) {
        yield* call(
          "t3_bot",
          { action: "adopt", botId, entryId: seeded.entryId, revision: seeded.revision },
          Schema.Unknown,
        );
      }
      const runId = yield* runTurn(call, home.homeThreadId, turn.prompt, {
        freshContext: turn.freshContext === true,
        untilDelegatedWorkSettled: testCase.modelRouting === "fast-worker",
      });
      const messages = yield* readItems(call, home.homeThreadId, "messages");
      answers.push(
        messages.findLast((item) => item.runId === runId && item.type === "assistant_message")
          ?.text ?? "",
      );
      turnMessageIds.push(
        messages.flatMap((item) =>
          item.runId === runId && item.messageId !== null ? [item.messageId] : [],
        ),
      );
    }
  }).pipe(Effect.ensuring(Effect.ignore(cancelTasks)));
  // Any added, deleted or changed file in a checkout, which only the Home could have made.
  const checkoutsUnchanged =
    testCase.home !== "bot"
      ? undefined
      : (["a", "b"] as const).every(
          (key) =>
            NodeChildProcess.execFileSync(
              "git",
              ["-C", NodePath.join(options.work, tag, key), "status", "--porcelain"],
              { encoding: "utf8" },
            ) === "",
        );
  const tools = toolActivity(yield* readItems(call, home.homeThreadId, "activity"));
  const read = (id: string) =>
    call("t3_bot", { action: "read", botId: id }, Schema.Struct({ bot: BotDetail })).pipe(
      Effect.map(({ bot }) => bot),
    );
  const bot = yield* read(botId);
  const twin = yield* read(twinId);
  const { thread } = yield* call(
    "t3_thread_read",
    { threadId: home.homeThreadId, limit: 1, runLimit: 1 },
    OrchestratorMcpThreadReadResult,
  );
  const sourcesOf = (detail: BotDetail, key: ProjectKey) =>
    locations(detail.projects.find((p) => p.projectId === projectIds[key])?.sources ?? []);
  const run: SampleRun = {
    answers,
    homeModel: modelSelection,
    ...(checkoutsUnchanged === undefined ? {} : { checkoutsUnchanged }),
    turnMessageIds,
    tools,
    sources: {
      bot: { a: sourcesOf(bot, "a"), b: sourcesOf(bot, "b") },
      twin: sourcesOf(twin, "a"),
    },
    ids: { botId, projectIds },
    learning: bot.learning.flatMap((entry) => {
      const first = entry.revisions[0];
      const latest = entry.revisions.at(-1);
      if (first === undefined || latest === undefined) return [];
      const scope =
        entry.projectId === null
          ? ("all" as const)
          : (["a", "b"] as const).find((key) => projectIds[key] === entry.projectId);
      return scope === undefined
        ? []
        : [
            {
              scope,
              kind: entry.kind,
              text: latest.text,
              origin: latest.origin,
              status: latest.status,
              byBot: first.source.kind === "thread",
            },
          ];
    }),
  };
  return {
    ...run,
    homeThreadId: home.homeThreadId,
    // Not graded: a fact the working note carries is in the Bot's context after a fresh start.
    note: yield* noteOf(call, { botId, projectId: home.projectId }),
    twinId,
    // Not graded: tool calls that touched the user's home, where real memories and notes live,
    // make the sample less synthetic. The summary reports them.
    homeReads: tools.filter(
      (tool) =>
        /(^|[\s"'=])~\//.test(tool.text ?? "") ||
        (tool.text ?? "").includes(`${NodeOS.homedir()}/`),
    ).length,
    // What the conversation actually ran on, not what the flags asked for.
    threadModel: { providerInstanceId: thread.providerInstanceId, model: thread.model },
    botModelSelection: bot.modelSelection,
  };
});

const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      "base-dir": { type: "string" },
      work: { type: "string" },
      instance: INSTANCE_FLAG,
      model: { type: "string", default: "gpt-6.1-terra" },
      effort: { type: "string", default: "high" },
      samples: { type: "string", default: "3" },
      concurrency: { type: "string", default: "2" },
      case: { type: "string", multiple: true },
    },
  });
  const out = values.out;
  const baseDir = values["base-dir"];
  if (out === undefined || baseDir === undefined) {
    return yield* Effect.die(new Error("Pass --out <dir> and --base-dir <dev server .t3>."));
  }
  const selected = CASES.filter((c) => values.case === undefined || values.case.includes(c.id));
  const samples = Number(values.samples);
  const work = NodePath.resolve(values.work ?? NodePath.join(out, "work"));
  const commit = NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
    encoding: "utf8",
  }).trim();
  const jobs = selected.flatMap((testCase) =>
    Array.from({ length: samples }, (_, sample) => ({ testCase, sample })),
  );
  NodeFS.mkdirSync(out, { recursive: true });
  const runJobs = (call: Call, modelSelection: BotModelSelection) =>
    Effect.forEach(
      jobs,
      ({ testCase, sample }) =>
        runSample(call, testCase, { work, modelSelection }).pipe(
          Effect.map((run) => {
            const checks = gradeSample(testCase, run);
            return {
              id: testCase.id,
              kind: testCase.kind,
              sample,
              pass: checks.every((c) => c.pass),
              checks,
              ...run,
            };
          }),
          // An incomplete sample stays in the results as an error and counts as a failure.
          Effect.catch((error) =>
            Effect.succeed({
              id: testCase.id,
              kind: testCase.kind,
              sample,
              pass: false,
              error: error.message,
            }),
          ),
          Effect.tap((row) =>
            Effect.sync(() =>
              NodeFS.appendFileSync(NodePath.join(out, "results.jsonl"), `${encodeJson(row)}\n`),
            ),
          ),
        ),
      { concurrency: Number(values.concurrency) },
    );
  const liveCase = DAY_CASE_ID + "-live-workers";
  const live = values.case?.includes(liveCase) === true;
  if (live && values.case?.includes(DAY_CASE_ID))
    throw new Error("Run the live integration separately.");
  const dayJobs = live ? 1 : values.case?.includes(DAY_CASE_ID) ? samples : 0;
  if (dayJobs) verifyDayHomes();
  const ledger = dayJobs ? dayLedger(out, live) : undefined;
  const replayId = "dayReplay-" + NodeCrypto.randomUUID();
  let release: ((taskId: string, text: string) => void) | undefined;
  if (dayJobs && !live) {
    const replay = yield* Effect.acquireRelease(
      Effect.promise(() => dayWorkerServer(NodePath.resolve(baseDir), replayId)),
      ({ server }) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );
    release = replay.release;
    yield* Effect.acquireRelease(
      withRpc(
        baseDir,
        (rpc) =>
          rpc["server.updateSettings"]({
            patch: {},
            providerInstanceMutation: {
              operation: "upsert",
              instanceId: ProviderInstanceId.make(replayId),
              instance: {
                displayName: "Fixed day worker",
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                config: {
                  enabled: true,
                  homePath: process.env.CODEX_HOME,
                  customModels: ["fixed"],
                  launchArgs: dayWorkerArgs(replay.port),
                },
              },
            },
          }),
        ["providers:manage", "settings:write"],
      ),
      () =>
        withRpc(
          baseDir,
          (rpc) =>
            rpc["server.updateSettings"]({
              patch: {},
              providerInstanceMutation: {
                operation: "remove",
                instanceId: ProviderInstanceId.make(replayId),
              },
            }),
          ["providers:manage", "settings:write"],
        ).pipe(Effect.orDie),
    );
  }
  const runDays = (call: Call, modelSelection: BotModelSelection) =>
    Effect.forEach(
      Array.from({ length: dayJobs }, (_, sample) => sample),
      (sample) => {
        const id = live ? liveCase : DAY_CASE_ID;
        const attemptId = NodeCrypto.randomUUID();
        ledger!.write({ id, sample, attemptId, phase: "started" });
        return (
          live
            ? requireBotModel(call, DAY_WORKER_MODEL)
            : Effect.succeed({ instanceId: replayId, model: "fixed", options: [] })
        ).pipe(
          Effect.flatMap((workerSelection) =>
            runDaySample(call, { work, baseDir, modelSelection, workerSelection, release }),
          ),
          Effect.flatMap((run) =>
            Effect.tryPromise({
              try: () => judgeDay(run, work),
              catch: (cause) => new SampleError({ message: "Choice judge: " + String(cause) }),
            }).pipe(
              Effect.map((decisions) => ({ ...run, ...scoreDay(run, decisions), decisions })),
              Effect.catch((error) =>
                Effect.succeed({ ...run, pass: false, error: error.message }),
              ),
            ),
          ),
          Effect.catch((error) =>
            Effect.succeed({
              id: live ? liveCase : DAY_CASE_ID,
              sample,
              pass: false,
              error: error.message,
            }),
          ),
          Effect.tap((row) =>
            Effect.sync(() => ledger!.write({ ...row, id, attemptId, sample, phase: "finished" })),
          ),
        );
      },
      { concurrency: Number(values.concurrency) },
    );
  const results = yield* withTools(baseDir, "bot-sources", (call) =>
    Effect.gen(function* () {
      const modelSelection = yield* requireBotModel(call, {
        instance: values.instance,
        model: values.model,
        effort: values.effort,
      });
      const caseRows = yield* runJobs(call, modelSelection);
      yield* runDays(call, modelSelection);
      return { caseRows };
    }),
  );
  const rows = results.caseRows;
  const lines = selected.map((testCase) => {
    const own = rows.filter((row) => row.id === testCase.id);
    const passed = own.filter((row) => row.pass).length;
    const errors = own.filter((row) => "error" in row).length;
    const homeReads = own.filter((row) => "homeReads" in row && row.homeReads > 0).length;
    return `| ${testCase.id} | ${testCase.kind} | ${passed}/${own.length} | ${errors} | ${homeReads} |`;
  });
  const summary = [
    `Commit \`${commit}\`, ${values.instance} ${values.model} at ${values.effort} effort, ${samples} samples per case.`,
    "",
    "| Case | Kind | Passed | Errors | Samples with home reads |",
    "| ---- | ---- | ------ | ------ | ----------------------- |",
    ...lines,
    "",
    ...(live ? ["Live-worker integration (excluded from pass counts)."] : []),
    ...daySummary(ledger?.days() ?? []),
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(out, "summary.md"), summary);
  yield* Effect.log(summary);
});

if (import.meta.main) {
  main.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, Net.layer)),
    NodeRuntime.runMain,
  );
}
