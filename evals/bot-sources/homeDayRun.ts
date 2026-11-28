// @effect-diagnostics nodeBuiltinImport:off
/** Runs the scripted day of `homeDay.ts` against a running dev server. See README.md. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import {
  AuthOrchestrationOperateScope,
  BOT_TASK_TERMINAL_STATUSES,
  BOT_TASK_UPDATE_MESSAGE_ID_PREFIX,
  BotDetail,
  BotTaskSummary,
  OrchestratorMcpThreadReadResult,
  Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { withRpc } from "../shared/devServerRpc.ts";
import {
  type BotModelSelection,
  type Call,
  readItems,
  runTurn,
  SampleError,
  toolActivity,
} from "../shared/devServerTools.ts";
import {
  DAY_BOT_INSTRUCTIONS,
  DAY_BOT_NAME,
  DAY_PROJECT_KEYS,
  DAY_PROJECTS,
  DAY_PROMPTS,
  DAY_TASKS,
  type DayHomeRun,
  type DayProjectKey,
  type DayRecord,
  type DayRun,
  workerScript,
} from "./homeDay.ts";

const POLL_MS = 10_000;
const MIDDAY_TIMEOUT_MS = 20 * 60_000;
const EVENING_TIMEOUT_MS = 40 * 60_000;
/** Batch-1 tasks that have ended before the fresh conversation, so others are still open. */
const MIDDAY_ENDED = 3;

const TaskList = Schema.Struct({ tasks: Schema.Array(BotTaskSummary) });

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const makeRepository = (root: string, key: DayProjectKey) => {
  const fixture = DAY_PROJECTS[key];
  const files = {
    ...fixture.files,
    "README.md": `# ${fixture.title}\n`,
    "AGENTS.md": workerScript(key),
  };
  for (const [file, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), text);
  }
  git(root, "init", "-q", "-b", fixture.noBase === true ? "trunk" : "main");
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=eval",
    "-c",
    "user.email=eval@example.com",
    "commit",
    "-qm",
    "fixture",
  );
  if (fixture.noBase === true) git(root, "symbolic-ref", "HEAD", "refs/heads/main");
};

/** The `t3_bot` start_task calls in the Home's activity, with the brief each one sent. */
const startedBriefs = (tools: ReturnType<typeof toolActivity>) => {
  const briefs = new Map<string, string>();
  for (const tool of tools) {
    try {
      const call = JSON.parse(tool.text ?? "") as {
        toolName?: string;
        input?: { action?: string; task?: unknown };
        output?: { structuredContent?: { task?: { id?: string } }; task?: { id?: string } };
      };
      const id = call.output?.structuredContent?.task?.id ?? call.output?.task?.id;
      if (call.input?.action === "start_task" && typeof call.input.task === "string" && id)
        briefs.set(id, call.input.task);
    } catch {
      // Not an MCP call.
    }
  }
  return briefs;
};

/** Groups the Home's messages by run, with the task updates that started each run. */
const homeRuns = (
  messages: ReadonlyArray<OrchestratorMcpThreadReadResult["items"][number]>,
): ReadonlyArray<DayHomeRun> => {
  const runs = new Map<string, { updateTaskIds: Array<string>; answer: Array<string> }>();
  for (const item of messages) {
    if (item.runId === null) continue;
    const run = runs.get(item.runId) ?? { updateTaskIds: [], answer: [] };
    runs.set(item.runId, run);
    const id = item.messageId ?? "";
    if (item.type === "user_message" && id.startsWith(BOT_TASK_UPDATE_MESSAGE_ID_PREFIX)) {
      // bot-task-update:<taskId>:<status>:<key>, where the task id is `bot-task:<uuid>`.
      const rest = id.slice(BOT_TASK_UPDATE_MESSAGE_ID_PREFIX.length).split(":");
      run.updateTaskIds.push(rest.slice(0, 2).join(":"));
    }
    if (item.type === "assistant_message" && item.text !== null) run.answer.push(item.text);
  }
  return [...runs].map(([runId, run]) => ({
    runId,
    updateTaskIds: run.updateTaskIds,
    answer: run.answer.join("\n"),
  }));
};

/** The Home's runs and token usage, read from the server's own state without writing to it. */
const homeUsage = (baseDir: string, homeThreadId: string) => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    const turns = db
      .prepare(
        `SELECT json_extract(payload_json, '$.turnTokenUsage.inputTokens') AS input,
           json_extract(payload_json, '$.turnTokenUsage.cachedInputTokens') AS cached,
           json_extract(payload_json, '$.turnTokenUsage.outputTokens') AS output
         FROM orchestration_v2_projection_provider_turns WHERE thread_id = ?`,
      )
      .all(homeThreadId);
    const runs = db
      .prepare("SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ?")
      .get(homeThreadId);
    const sum = (column: string) =>
      turns.reduce((total, turn) => total + Number(turn[column] ?? 0), 0);
    return {
      homeTurns: Number(runs?.count ?? 0),
      providerTurns: turns.length,
      providerTurnsWithoutUsage: turns.filter((turn) => turn.input === null).length,
      inputTokens: sum("input"),
      cachedInputTokens: sum("cached"),
      outputTokens: sum("output"),
    };
  } finally {
    db.close();
  }
};

export type DayUsage = ReturnType<typeof homeUsage>;

export const runDaySample = Effect.fn("botSources.runDaySample")(function* (
  call: Call,
  options: {
    readonly work: string;
    readonly baseDir: string;
    /** The model under test, for the Home. */
    readonly modelSelection: BotModelSelection;
    /** The Bot's model, which its tasks run on. */
    readonly workerSelection: BotModelSelection;
  },
) {
  const tag = `day-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const roots = {} as Record<DayProjectKey, string>;
  const projectIds = {} as Record<DayProjectKey, string>;
  for (const key of DAY_PROJECT_KEYS) {
    roots[key] = NodePath.join(options.work, tag, key);
    makeRepository(roots[key], key);
    const project = yield* call(
      "t3_project_create",
      { title: DAY_PROJECTS[key].title, workspaceRoot: roots[key] },
      Project,
    );
    projectIds[key] = project.id;
  }
  const checkouts = () => DAY_PROJECT_KEYS.map((key) => git(roots[key], "status", "--porcelain"));
  const before = checkouts();
  const botId = `day-${tag}`;
  yield* call(
    "t3_bot",
    {
      action: "create",
      botId,
      name: DAY_BOT_NAME,
      instructions: DAY_BOT_INSTRUCTIONS,
      modelSelection: options.workerSelection,
      learningPolicy: "after_adoption",
    },
    Schema.Unknown,
  );
  for (const key of DAY_PROJECT_KEYS) {
    yield* call(
      "t3_bot",
      {
        action: "attach",
        botId,
        projectId: projectIds[key],
        guidance: DAY_PROJECTS[key].guidance,
        sources: [],
      },
      Schema.Unknown,
    );
  }
  const home = (yield* call(
    "t3_bot",
    { action: "open_home", botId },
    Schema.Struct({ bot: BotDetail }),
  )).bot.home;
  if (home == null) return yield* new SampleError({ message: "the Bot's own Home is missing" });
  const homeThreadId = home.homeThreadId;
  // As a user picks another model in the Home's composer; tasks keep the Bot's model.
  yield* call(
    "t3_thread_configure",
    { threadId: homeThreadId, modelSelection: options.modelSelection },
    Schema.Unknown,
  );

  const listTasks = call("t3_bot", { action: "list_tasks", botId }, TaskList).pipe(
    Effect.map(({ tasks }) => tasks),
  );
  const ended = (task: BotTaskSummary) => BOT_TASK_TERMINAL_STATUSES.has(task.status);
  /** Whether the Home is idle and has answered the update of every task in `told`. */
  const homeSettled = Effect.fn("botSources.homeSettled")(function* (
    told: ReadonlyArray<BotTaskSummary>,
  ) {
    const { thread } = yield* call(
      "t3_thread_read",
      { threadId: homeThreadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    if (thread.activeRunId !== null) return false;
    const runs = homeRuns(yield* readItems(call, homeThreadId, "messages"));
    return told.every((task) =>
      runs.some((run) => run.updateTaskIds.includes(task.id) && run.answer !== ""),
    );
  });
  const owesUpdate = (task: BotTaskSummary) => ended(task) && task.status !== "cancelled";
  /** Polls until `done`; a phase that never settles fails the sample. */
  const settle = Effect.fn("botSources.settle")(function* (
    phase: string,
    done: (tasks: ReadonlyArray<BotTaskSummary>) => Effect.Effect<boolean, SampleError>,
    timeoutMs: number,
  ) {
    for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
      if (yield* done(yield* listTasks)) return;
      yield* Effect.sleep(POLL_MS);
    }
    return yield* new SampleError({ message: `${phase} did not settle in ${timeoutMs} ms` });
  });

  let userCancelled: string | null = null;
  let summaryRunId = "";
  const timeline: Array<string> = [];
  const mark = (event: string) =>
    DateTime.now.pipe(
      Effect.map((now) => {
        timeline.push(`${DateTime.formatIso(now)} ${event}`);
      }),
    );
  const day = Effect.gen(function* () {
    yield* mark("batch 1");
    yield* runTurn(call, homeThreadId, DAY_PROMPTS.batch1);
    yield* settle(
      "midday",
      (tasks) => {
        const endedTasks = tasks.filter(ended);
        return endedTasks.length < MIDDAY_ENDED
          ? Effect.succeed(false)
          : homeSettled(endedTasks.filter(owesUpdate));
      },
      MIDDAY_TIMEOUT_MS,
    );
    yield* mark("midday settled");
    yield* runTurn(call, homeThreadId, DAY_PROMPTS.batch2, { freshContext: true });
    yield* mark("batch 2 answered");
    // The user changes their mind about one task, from its card.
    const faq = DAY_TASKS.find((task) => task.outcome === "cancelled")!;
    const briefs = startedBriefs(toolActivity(yield* readItems(call, homeThreadId, "activity")));
    const target = (yield* listTasks).find(
      (task) =>
        task.projectId === projectIds[faq.project] &&
        !ended(task) &&
        new RegExp(faq.match, "i").test(`${task.title}\n${briefs.get(task.id) ?? ""}`),
    );
    if (target !== undefined) {
      yield* withRpc(options.baseDir, (rpc) => rpc["bots.cancelTask"]({ taskId: target.id }), [
        AuthOrchestrationOperateScope,
      ]).pipe(
        Effect.mapError(
          (cause) => new SampleError({ message: `Cancel from the task card: ${cause}` }),
        ),
      );
      userCancelled = target.id;
    }
    yield* mark(`user cancelled: ${userCancelled}`);
    yield* settle(
      "evening",
      (tasks) =>
        tasks.every(ended) ? homeSettled(tasks.filter(owesUpdate)) : Effect.succeed(false),
      EVENING_TIMEOUT_MS,
    );
    yield* mark("evening settled");
    summaryRunId = yield* runTurn(call, homeThreadId, DAY_PROMPTS.summary);
    yield* mark("summary answered");
  });
  const cancelOpen = Effect.gen(function* () {
    for (const task of (yield* listTasks).filter((task) => !ended(task)))
      yield* call("t3_bot", { action: "cancel_task", botId, taskId: task.id }, Schema.Unknown);
  });
  // A day that stops early still reports what the Home spent; its row fails on `incomplete`.
  const incomplete = yield* day.pipe(
    Effect.as(null),
    Effect.catchTags({ SampleError: (error) => Effect.succeed(error.message) }),
    Effect.ensuring(Effect.ignore(cancelOpen)),
  );

  const tools = toolActivity(yield* readItems(call, homeThreadId, "activity"));
  const briefs = startedBriefs(tools);
  const finalTasks = yield* listTasks;
  const { recentRuns } = yield* call(
    "t3_thread_read",
    { threadId: homeThreadId, limit: 1, runLimit: 50 },
    OrchestratorMcpThreadReadResult,
  );
  // What actually ran: the Home on the model under test, the tasks on the worker model.
  const models = {
    home: [...new Set(recentRuns.map((run) => `${run.providerInstanceId} ${run.model}`))],
    tasks: [
      ...new Set(
        finalTasks.map((task) =>
          task.modelSelection === undefined
            ? "unknown"
            : `${task.modelSelection.instanceId} ${task.modelSelection.model}`,
        ),
      ),
    ],
  };
  const records: ReadonlyArray<DayRecord> = finalTasks.map((task) => ({
    id: task.id,
    title: task.title,
    detail: task.detail,
    brief: briefs.get(task.id) ?? null,
    projectId: task.projectId,
    status: task.status,
    ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
  }));
  const run: DayRun = {
    records,
    homeRuns: homeRuns(yield* readItems(call, homeThreadId, "messages")),
    incomplete,
    summaryRunId,
    userCancelled,
    tools,
    checkoutsUnchanged: checkouts().every((status, index) => status === before[index]),
    ids: { botId, projectIds },
  };
  return {
    ...run,
    homeThreadId,
    timeline,
    models,
    usage: homeUsage(options.baseDir, homeThreadId),
  };
});
