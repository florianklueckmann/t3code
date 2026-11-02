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
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotDetail,
  OrchestratorMcpProviderCapability,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  Project,
} from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../../apps/server/src/auth/EnvironmentAuth.ts";
import { resolveCliAuthConfig } from "../../apps/server/src/cli/config.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { mcpToolSession } from "../../apps/server/src/mcp/AcpMcpStdioBridge.ts";
import { readPersistedServerRuntimeState } from "../../apps/server/src/serverRuntimeState.ts";
import {
  BOT_INSTRUCTIONS,
  BOT_NAME,
  type BotSourcesCase,
  CASES,
  PROJECT_TITLE,
  PROJECTS,
  type ProjectKey,
  TWIN_SOURCES,
} from "./cases.ts";

const WAIT_SLICE_MS = 15_000;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
  structuredContent: Schema.optional(Schema.Unknown),
});

/** A sample that could not finish. It stays in the results and counts as a failure. */
class SampleError extends Schema.TaggedError<SampleError>()("SampleError", {
  message: Schema.String,
}) {}

type Call = <S extends Schema.Decoder<unknown, never>>(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  schema: S,
) => Effect.Effect<S["Type"], SampleError>;

/** A tool the Bot called during the sample, as the thread's activity records it. */
export interface ToolActivity {
  readonly type: string;
  readonly title: string | null;
  readonly text: string | null;
}

export interface SampleRun {
  readonly answers: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ToolActivity>;
  /** Source locations per Bot and project after the turns. */
  readonly sources: {
    readonly bot: Readonly<Record<ProjectKey, ReadonlyArray<string>>>;
    readonly twin: ReadonlyArray<string>;
  };
  readonly ids: { readonly botId: string; readonly projectIds: Record<ProjectKey, string> };
}

const Capabilities = Schema.Struct({ providers: Schema.Array(OrchestratorMcpProviderCapability) });

/** A Codex MCP call as T3 records it in the thread's activity. */
const decodeToolCall = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      toolName: Schema.String,
      input: Schema.Struct({
        action: Schema.optional(Schema.String),
        botId: Schema.optional(Schema.String),
        projectId: Schema.optional(Schema.String),
      }),
    }),
  ),
);

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
  });
  for (const key of ["a", "b"] as const) {
    const expected = testCase.sourcesAfter?.[key] ?? locations(PROJECTS[key].sources);
    add(`sources ${key}`, sameSet(run.sources.bot[key], expected));
  }
  add("twin sources unchanged", sameSet(run.sources.twin, locations(TWIN_SOURCES)));
  const updates = run.tools.flatMap((tool) => {
    const call = decodeToolCall(tool.text ?? "");
    return Option.isSome(call) &&
      call.value.toolName.endsWith("t3_bot") &&
      call.value.input.action === "update"
      ? [call.value.input]
      : [];
  });
  if (testCase.sourcesAfter === undefined) {
    add("no t3_bot update", updates.length === 0);
  } else {
    const home = run.ids.projectIds[testCase.home];
    add(
      "t3_bot update names its own botId and projectId",
      updates.length > 0 &&
        updates.every((input) => input.botId === run.ids.botId && input.projectId === home),
    );
  }
  return checks;
};

/** Signs in as a short-lived MCP client of the dev server, as `t3 thread` does, and revokes it after. */
const withTools = Effect.fn("botSources.withTools")(function* <A, E, R>(
  baseDir: string,
  body: (call: Call) => Effect.Effect<A, E, R>,
) {
  {
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none(), {
      quietLogs: true,
    });
    return yield* Effect.gen(function* () {
      const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(state)) {
        return yield* Effect.die(new Error(`No running T3 Code server uses ${baseDir}.`));
      }
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* Effect.acquireRelease(
        auth.issueMcpClientSession({
          label: "bot-sources eval",
          access: "full-access",
          peerLink: false,
          client: { deviceType: "bot" },
        }),
        (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
      );
      const session = yield* mcpToolSession({
        endpoint: new URL("/mcp", state.value.origin).href,
        authorization: `Bearer ${issued.token}`,
        clientName: "bot-sources-eval",
      });
      const failed = (tool: string) => (cause: unknown) =>
        new SampleError({ message: `${tool}: ${String(cause)}` });
      const call: Call = Effect.fn("botSources.call")(function* <
        S extends Schema.Decoder<unknown, never>,
      >(tool: string, args: Readonly<Record<string, unknown>>, schema: S) {
        const result = yield* session
          .call(tool, args)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ToolResult)),
            Effect.mapError(failed(tool)),
          );
        if (result.isError === true) {
          const text = result.content?.map((c) => c.text ?? "").join("\n");
          return yield* new SampleError({ message: `${tool}: ${text}` });
        }
        return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
          Effect.mapError(failed(tool)),
        );
      });
      return yield* body(call);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  }
});

const runTurn = Effect.fn("botSources.runTurn")(function* (
  call: Call,
  threadId: string,
  prompt: string,
) {
  const sent = yield* call(
    "t3_thread_send",
    { threadId, message: prompt },
    OrchestratorMcpThreadSendResult,
  );
  while (true) {
    const waited = yield* call(
      "t3_thread_wait",
      { threadId, runId: sent.runId, timeoutMs: WAIT_SLICE_MS },
      OrchestratorMcpThreadWaitResult,
    );
    if (!waited.timedOut) {
      if (waited.status !== "completed") {
        return yield* new SampleError({ message: `run ${sent.runId} ended ${waited.status}` });
      }
      break;
    }
    const { thread } = yield* call(
      "t3_thread_read",
      { threadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    if (thread.pendingRequestCount > 0) {
      return yield* new SampleError({ message: `run ${sent.runId} is waiting for user input` });
    }
  }
  return sent.runId;
});

const readItems = Effect.fn("botSources.readItems")(function* (
  call: Call,
  threadId: string,
  view: "messages" | "activity",
) {
  const items: Array<OrchestratorMcpThreadReadResult["items"][number]> = [];
  let afterPosition: number | undefined;
  while (true) {
    const page = yield* call(
      "t3_thread_read",
      {
        threadId,
        view,
        limit: 100,
        maxCharsPerItem: 50_000,
        runLimit: 1,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      },
      OrchestratorMcpThreadReadResult,
    );
    items.push(...page.items);
    if (!page.hasMore || page.nextPosition === null) return items;
    afterPosition = page.nextPosition;
  }
});

const runSample = Effect.fn("botSources.runSample")(function* (
  call: Call,
  testCase: BotSourcesCase,
  options: { readonly work: string; readonly model: string; readonly effort: string },
) {
  const tag = `${testCase.id}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const projectIds = {} as Record<ProjectKey, string>;
  for (const key of ["a", "b"] as const) {
    const root = NodePath.join(options.work, tag, key);
    for (const [file, text] of Object.entries(PROJECTS[key].files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, file), text);
    }
    const project = yield* call(
      "t3_project_create",
      { title: PROJECT_TITLE, workspaceRoot: root },
      Project,
    );
    projectIds[key] = project.id;
  }
  const modelSelection = {
    instanceId: "codex",
    model: options.model,
    options: [{ id: "reasoningEffort", value: options.effort }],
  };
  const create = (botId: string) =>
    call(
      "t3_bot",
      {
        action: "create",
        botId,
        name: BOT_NAME,
        instructions: BOT_INSTRUCTIONS,
        modelSelection,
        learningPolicy: "after_adoption",
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
  const home = attached.bot.projects.find((p) => p.projectId === projectIds[testCase.home]);
  if (home === undefined) return yield* Effect.die(new Error("home conversation missing"));

  const answers: Array<string> = [];
  for (const turn of testCase.turns) {
    const runId = yield* runTurn(call, home.homeThreadId, turn.prompt);
    const messages = yield* readItems(call, home.homeThreadId, "messages");
    answers.push(
      messages.findLast((item) => item.runId === runId && item.type === "assistant_message")
        ?.text ?? "",
    );
  }
  const activity = yield* readItems(call, home.homeThreadId, "activity");
  const tools = activity
    .filter((item) => item.type !== "user_message" && item.type !== "assistant_message")
    .map((item) => ({ type: item.type, title: item.title, text: item.text }));
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
    tools,
    sources: {
      bot: { a: sourcesOf(bot, "a"), b: sourcesOf(bot, "b") },
      twin: sourcesOf(twin, "a"),
    },
    ids: { botId, projectIds },
  };
  return {
    ...run,
    homeThreadId: home.homeThreadId,
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
  const runJobs = (call: Call) =>
    Effect.forEach(
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
  const rows = yield* withTools(baseDir, (call) =>
    Effect.gen(function* () {
      // No fallback: a model or effort the Codex catalog does not offer stops the run.
      const { providers } = yield* call("orchestrator_capabilities", {}, Capabilities);
      const offered = providers
        .find((provider) => provider.providerInstanceId === "codex")
        ?.models.find((model) => model.id === values.model)
        ?.options?.find((option) => option.id === "reasoningEffort")
        ?.values?.includes(values.effort);
      if (offered !== true) {
        return yield* Effect.die(
          new Error(`Codex does not offer ${values.model} with reasoningEffort ${values.effort}.`),
        );
      }
      return yield* runJobs(call);
    }),
  );
  const lines = selected.map((testCase) => {
    const own = rows.filter((row) => row.id === testCase.id);
    const passed = own.filter((row) => row.pass).length;
    const errors = own.filter((row) => "error" in row).length;
    const homeReads = own.filter((row) => "homeReads" in row && row.homeReads > 0).length;
    return `| ${testCase.id} | ${testCase.kind} | ${passed}/${own.length} | ${errors} | ${homeReads} |`;
  });
  const summary = [
    `Commit \`${commit}\`, ${values.model} at ${values.effort} effort, ${samples} samples per case.`,
    "",
    "| Case | Kind | Passed | Errors | Samples with home reads |",
    "| ---- | ---- | ------ | ------ | ----------------------- |",
    ...lines,
    "",
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(out, "summary.md"), summary);
  yield* Effect.log(summary);
});

if (import.meta.main) {
  main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Net.layer)), NodeRuntime.runMain);
}
