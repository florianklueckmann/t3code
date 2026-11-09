/**
 * Runs Bot preparation routines and home-conversation turns through a running T3 Code dev server
 * and its configured Codex provider, then grades the results. See README.md.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotDetail,
  BotTaskSummary,
  type ModelSelection,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpThreadReadResult,
  Project,
} from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type Call,
  encodeJson,
  readItems,
  requireCodexModel,
  runTurn,
  SampleError,
  type ToolActivity,
  toolActivity,
  waitForRun,
  withTools,
} from "../shared/devServerTools.ts";
import {
  BOT_INSTRUCTIONS,
  BOT_NAME,
  BRIEF,
  CASES,
  GUIDANCE,
  type PreparationCase,
  PROJECT_TITLE,
  SOURCES,
  WORLDS,
} from "./cases.ts";

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "skipped"]);

export interface SampleRun {
  /** The routine's result in its work thread, or the home conversation's answer. */
  readonly text: string;
  readonly tools: ReadonlyArray<ToolActivity>;
  readonly tasks: ReadonlyArray<
    Pick<BotTaskSummary, "status" | "origin" | "returnToHome" | "modelSelection">
  >;
  /** The Bot's selection when the sample created it, and after the turn. */
  readonly botSelection?: {
    readonly created: ModelSelection;
    readonly after: ModelSelection;
  };
  readonly routines: ReadonlyArray<{
    readonly botId: string | undefined;
    readonly sessionAt: string | undefined;
    readonly runAt: string | null;
    readonly allowChanges?: boolean;
    readonly title?: string;
  }>;
  /** Runs in the home conversation; a routine's result must not start one. */
  readonly homeRuns: number;
  readonly filesChanged: ReadonlyArray<string>;
  readonly filesAfter: Readonly<Record<string, string>>;
  readonly botId: string;
}

/** A Codex MCP call as T3 records it in the thread's activity. */
const decodeToolCall = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      toolName: Schema.String,
      input: Schema.Struct({ action: Schema.optional(Schema.String) }),
    }),
  ),
);

const calledTool = (tools: ReadonlyArray<ToolActivity>, name: string, action?: string) =>
  tools.some((tool) => {
    const call = decodeToolCall(tool.text ?? "");
    return (
      Option.isSome(call) &&
      call.value.toolName.endsWith(name) &&
      (action === undefined || call.value.input.action === action)
    );
  });

const reasoningEffort = (selection: ModelSelection | undefined) =>
  selection?.options?.find((option) => option.id === "reasoningEffort")?.value;

export const gradeSample = (testCase: PreparationCase, run: SampleRun) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const expectedFiles = testCase.expectedFiles;
  if (expectedFiles === undefined) {
    add("no project files changed", run.filesChanged.length === 0);
  } else {
    add(
      "only requested files changed",
      run.filesChanged.length === Object.keys(expectedFiles).length &&
        run.filesChanged.every((path) => path in expectedFiles),
    );
    for (const [path, content] of Object.entries(expectedFiles)) {
      add(`requested content in ${path}`, run.filesAfter[path] === content);
    }
  }
  if (testCase.trigger === "routine") {
    add(
      "one completed routine task",
      run.tasks.length === 1 && run.tasks[0]?.status === "completed",
    );
    add("no turn in the home conversation", run.homeRuns === 0);
    for (const p of testCase.resultMust)
      add(`result must /${p}/i`, new RegExp(p, "i").test(run.text));
    for (const p of testCase.resultMustNot)
      add(`result must not /${p}/i`, !new RegExp(p, "i").test(run.text));
    return checks;
  }
  for (const p of testCase.answerMust)
    add(`answer must /${p}/i`, new RegExp(p, "i").test(run.text));
  add(
    testCase.startsTask ? "started a task" : "no task started",
    calledTool(run.tools, "t3_bot", "start_task") === testCase.startsTask,
  );
  if (testCase.returnToHome !== undefined) {
    add(
      "one completed direct task",
      run.tasks.length === 1 &&
        run.tasks[0]?.origin === "direct" &&
        run.tasks[0]?.status === "completed",
    );
    add(
      "requested Home return policy",
      (run.tasks[0]?.returnToHome ?? false) === testCase.returnToHome,
    );
    add("bounded Home turns", run.homeRuns === (testCase.returnToHome ? 2 : 1));
  }
  if (testCase.taskEffort !== undefined) {
    const { created, after } = run.botSelection ?? {};
    const task = run.tasks[0]?.modelSelection;
    add(
      "task runs at the requested reasoning on the Bot's model",
      task?.model === created?.model && reasoningEffort(task) === testCase.taskEffort,
    );
    add(
      "Bot keeps its model and reasoning",
      created !== undefined &&
        after?.model === created.model &&
        reasoningEffort(after) === reasoningEffort(created),
    );
    add("Bot not updated", !calledTool(run.tools, "t3_bot", "update"));
  }
  if (testCase.routine === null) {
    add("no routine", run.routines.length === 0 && !calledTool(run.tools, "schedule_task"));
    return checks;
  }
  const { sessionAt, leadHours } = testCase.routine;
  const [routine, ...others] = run.routines;
  add("one routine for this Bot", routine?.botId === run.botId && others.length === 0);
  if (testCase.routine.title !== undefined) {
    add("routine title", routine?.title === testCase.routine.title);
  }
  add(
    "routine change permission",
    (routine?.allowChanges ?? false) === (testCase.routine.allowChanges ?? false),
  );
  add(
    "session time",
    routine?.sessionAt !== undefined && Date.parse(routine.sessionAt) === Date.parse(sessionAt),
  );
  add(
    "runs the lead time before the session",
    routine?.runAt != null &&
      Date.parse(routine.runAt) === Date.parse(sessionAt) - leadHours * 60 * 60 * 1_000,
  );
  return checks;
};

const snapshot = (root: string): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  for (const entry of NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = NodePath.join(entry.parentPath, entry.name);
    files.set(NodePath.relative(root, path), NodeFS.readFileSync(path, "utf8"));
  }
  return files;
};

const changedFiles = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path),
  );

const listTasks = (call: Call, botId: string) =>
  call(
    "t3_bot",
    { action: "list_tasks", botId },
    Schema.Struct({ tasks: Schema.Array(BotTaskSummary) }),
  ).pipe(Effect.map(({ tasks }) => tasks));

/** The server records a task's end on its next scheduler pass, a few seconds after the run. */
const settledTasks = Effect.fn("botPreparation.settledTasks")(function* (
  call: Call,
  botId: string,
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const tasks = yield* listTasks(call, botId);
    if (tasks.every((task) => TERMINAL.has(task.status))) return tasks;
    yield* Effect.sleep("2 seconds");
  }
  return yield* new SampleError({ message: "the Bot task did not settle" });
});

const runSample = Effect.fn("botPreparation.runSample")(function* (
  call: Call,
  testCase: PreparationCase,
  options: { readonly work: string; readonly model: string; readonly effort: string },
) {
  const tag = `${testCase.id}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const root = NodePath.join(options.work, tag);
  for (const [file, text] of Object.entries(WORLDS[testCase.world])) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), text);
  }
  const before = snapshot(root);
  const project = yield* call(
    "t3_project_create",
    { title: PROJECT_TITLE, workspaceRoot: root },
    Project,
  );
  const botId = `bp-${tag}`;
  const created = yield* call(
    "t3_bot",
    {
      action: "create",
      botId,
      name: BOT_NAME,
      instructions: BOT_INSTRUCTIONS,
      modelSelection: {
        instanceId: "codex",
        model: options.model,
        options: [{ id: "reasoningEffort", value: options.effort }],
      },
      learningPolicy: "after_adoption",
    },
    Schema.Struct({ bot: BotDetail }),
  );
  const attached = yield* call(
    "t3_bot",
    { action: "attach", botId, projectId: project.id, guidance: GUIDANCE, sources: SOURCES },
    Schema.Struct({ bot: BotDetail }),
  );
  const home = attached.bot.projects[0]?.homeThreadId;
  if (home === undefined) return yield* Effect.die(new Error("home conversation missing"));

  let text: string;
  let tools: ReadonlyArray<ToolActivity>;
  if (testCase.trigger === "routine") {
    const now = yield* DateTime.now;
    const inDays = (days: number) => DateTime.formatIso(DateTime.add(now, { days }));
    const routine = yield* call(
      "schedule_task",
      {
        projectId: project.id,
        title: "Session preparation",
        prompt: testCase.prompt ?? BRIEF,
        schedule: { type: "once", runAt: inDays(1) },
        botId,
        ...(testCase.allowChanges === undefined ? {} : { allowChanges: testCase.allowChanges }),
        sessionAt: inDays(2),
      },
      OrchestratorMcpScheduleTaskResult,
    );
    const started = yield* call(
      "run_scheduled_task_now",
      { taskId: routine.scheduledTaskId },
      Schema.Struct({ threadId: Schema.NullOr(Schema.String) }),
    );
    if (started.threadId === null) {
      return yield* new SampleError({ message: "the routine did not start a work thread" });
    }
    const runId = yield* waitForRun(call, started.threadId);
    const messages = yield* readItems(call, started.threadId, "messages");
    text =
      messages.findLast((item) => item.runId === runId && item.type === "assistant_message")
        ?.text ?? "";
    tools = toolActivity(yield* readItems(call, started.threadId, "activity"));
  } else {
    if (testCase.existingRoutine !== undefined && testCase.routine !== null) {
      const { sessionAt, leadHours } = testCase.routine;
      yield* call(
        "schedule_task",
        {
          projectId: project.id,
          botId,
          title: testCase.existingRoutine.title,
          prompt: BRIEF,
          allowChanges: testCase.existingRoutine.allowChanges,
          schedule: {
            type: "once",
            runAt: DateTime.formatIso(
              DateTime.add(DateTime.makeUnsafe(sessionAt), { hours: -leadHours }),
            ),
          },
          sessionAt,
        },
        OrchestratorMcpScheduleTaskResult,
      );
    }
    const runId = yield* runTurn(call, home, testCase.prompt);
    const messages = yield* readItems(call, home, "messages");
    text =
      messages.findLast((item) => item.runId === runId && item.type === "assistant_message")
        ?.text ?? "";
    tools = toolActivity(yield* readItems(call, home, "activity"));
  }
  const tasks = yield* settledTasks(call, botId);
  if (testCase.trigger === "home" && testCase.returnToHome === true) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const { thread } = yield* call(
        "t3_thread_read",
        { threadId: home, limit: 1, runLimit: 1 },
        OrchestratorMcpThreadReadResult,
      );
      if (thread.runCount >= 2 && thread.latestRunId !== null) {
        yield* waitForRun(call, home, thread.latestRunId);
        break;
      }
      yield* Effect.sleep("2 seconds");
    }
    const messages = yield* readItems(call, home, "messages");
    text = messages.findLast((item) => item.type === "assistant_message")?.text ?? "";
    tools = toolActivity(yield* readItems(call, home, "activity"));
  }
  const scheduled = yield* call(
    "list_scheduled_tasks",
    { projectId: project.id },
    OrchestratorMcpListScheduledTasksResult,
  );
  const { thread } = yield* call(
    "t3_thread_read",
    { threadId: home, limit: 1, runLimit: 1 },
    OrchestratorMcpThreadReadResult,
  );
  const botAfter = yield* call(
    "t3_bot",
    { action: "read", botId },
    Schema.Struct({ bot: BotDetail }),
  );
  const run: SampleRun = {
    text,
    tools,
    tasks: tasks.map(({ status, origin, returnToHome, modelSelection }) => ({
      status,
      origin,
      returnToHome,
      modelSelection,
    })),
    botSelection: {
      created: created.bot.modelSelection,
      after: botAfter.bot.modelSelection,
    },
    routines: scheduled.tasks.map((task) => ({
      botId: task.botId,
      sessionAt: task.sessionAt,
      runAt: task.schedule.type === "once" ? task.schedule.runAt : null,
      allowChanges: task.allowChanges ?? false,
      title: task.title,
    })),
    homeRuns: thread.runCount,
    filesChanged: changedFiles(before, snapshot(root)),
    filesAfter: Object.fromEntries(snapshot(root)),
    botId,
  };
  return { ...run, homeThreadId: home, threadModel: { model: thread.model } };
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
  const rows = yield* withTools(baseDir, "bot-preparation", (call) =>
    Effect.gen(function* () {
      yield* requireCodexModel(call, values.model, values.effort);
      return yield* Effect.forEach(
        jobs,
        ({ testCase, sample }) =>
          runSample(call, testCase, { work, model: values.model, effort: values.effort }).pipe(
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
    }),
  );
  const lines = selected.map((testCase) => {
    const own = rows.filter((row) => row.id === testCase.id);
    const passed = own.filter((row) => row.pass).length;
    const errors = own.filter((row) => "error" in row).length;
    return `| ${testCase.id} | ${testCase.kind} | ${passed}/${own.length} | ${errors} |`;
  });
  const summary = [
    `Commit \`${commit}\`, ${values.model} at ${values.effort} effort, ${samples} samples per case.`,
    "",
    "| Case | Kind | Passed | Errors |",
    "| ---- | ---- | ------ | ------ |",
    ...lines,
    "",
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(out, "summary.md"), summary);
  yield* Effect.log(summary);
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, Net.layer)),
    NodeRuntime.runMain,
  );
}
