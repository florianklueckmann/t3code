// @effect-diagnostics nodeBuiltinImport:off - standalone eval CLI and fixture files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import {
  BotDetail,
  Project,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  type Call,
  encodeJson,
  readItems,
  requireCodexModel,
  withTools,
} from "../shared/devServerTools.ts";
import { CASES, type ContinuationCase } from "./cases.ts";
import { gradeSample, isMissingContinuationApi, type Observation } from "./grade.ts";
import { readToolCalls } from "./observe.ts";

// Wire-only subset: never import candidate continuation decoders into the old-server harness.
const Ref = Schema.Struct({
  kind: Schema.String,
  messageId: Schema.optional(Schema.String),
  quote: Schema.optional(Schema.String),
  digest: Schema.optional(Schema.String),
});
const Item = Schema.Struct({ text: Schema.String, refs: Schema.Array(Ref) });
const Note = Schema.Struct({
  botId: Schema.String,
  projectId: Schema.String,
  homeThreadId: Schema.String,
  revision: Schema.NullOr(Schema.Number),
  note: Schema.Struct({
    requests: Schema.Array(Item),
    waiting: Schema.Array(Item),
    decided: Schema.Array(Item),
    context: Schema.Array(Item),
  }),
  updatedBy: Schema.NullOr(
    Schema.Struct({
      kind: Schema.String,
      threadId: Schema.optional(Schema.String),
      runId: Schema.optional(Schema.String),
    }),
  ),
  newerInputs: Schema.Struct({ count: Schema.Number }),
});
const Capture = Schema.Struct({
  id: Schema.String,
  sample: Schema.Number,
  root: Schema.String,
  botId: Schema.String,
  projectId: Schema.String,
  homeThreadId: Schema.String,
  captured: Schema.NullOr(Note),
  seed: Schema.NullOr(Note),
  captureRunId: Schema.String,
  seedRunId: Schema.NullOr(Schema.String),
  filesBefore: Schema.String,
  filesCaptured: Schema.String,
  filesSeed: Schema.String,
  errors: Schema.Array(Schema.String),
  settled: Schema.Boolean,
  settingsBefore: Schema.String,
});
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  model: Schema.String,
  effort: Schema.String,
  captures: Schema.Array(Capture),
});
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));
type Captured = typeof Capture.Type;
const files = (root: string): string =>
  encodeJson(
    NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
      .flatMap((entry) => {
        const path = NodePath.relative(root, NodePath.join(entry.parentPath, entry.name));
        if (path.split(NodePath.sep).includes(".git") || entry.isDirectory()) return [];
        return [
          [
            path,
            entry.isSymbolicLink()
              ? NodeFS.readlinkSync(NodePath.join(root, path))
              : NodeCrypto.createHash("sha256")
                  .update(NodeFS.readFileSync(NodePath.join(root, path)))
                  .digest("hex"),
          ],
        ];
      })
      .sort((left, right) => left[0]!.localeCompare(right[0]!)),
  );
const settings = (bot: BotDetail) =>
  encodeJson({
    instructions: bot.instructions,
    learning: bot.learning,
    sources: bot.projects.map((project) => ({
      projectId: project.projectId,
      guidance: project.guidance,
      sources: project.sources,
    })),
  });

const inspect = Effect.fn("botContinuationEval.inspect")(function* (
  call: Call,
  capture: Pick<Captured, "botId" | "projectId">,
) {
  return yield* call(
    "t3_bot",
    { action: "read_continuation", botId: capture.botId, projectId: capture.projectId },
    Schema.Struct({ continuation: Note }),
  ).pipe(
    Effect.map((result) => ({ view: result.continuation, error: null })),
    Effect.catchIf(
      (error) => isMissingContinuationApi(error.message),
      (error) => Effect.succeed({ view: null, error: error.message }),
    ),
  );
});
const turn = Effect.fn("botContinuationEval.turn")(function* (
  call: Call,
  threadId: string,
  message: string,
) {
  const sent = yield* call(
    "t3_thread_send",
    { threadId, message },
    OrchestratorMcpThreadSendResult,
  );
  for (let slice = 0; slice < 40; slice += 1) {
    const waited = yield* call(
      "t3_thread_wait",
      { threadId, runId: sent.runId, timeoutMs: 15000 },
      OrchestratorMcpThreadWaitResult,
    );
    if (!waited.timedOut)
      return {
        settled: waited.status === "completed",
        runId: sent.runId,
        error: waited.status === "completed" ? null : `run ended ${waited.status}`,
      };
  }
  return {
    settled: false,
    runId: sent.runId,
    error: "run did not settle within 40 wait slices; not retried",
  };
});
const capture = Effect.fn("botContinuationEval.capture")(function* (
  call: Call,
  testCase: ContinuationCase,
  sample: number,
  work: string,
  model: string,
  effort: string,
) {
  const tag = `bc-${testCase.id}-${sample}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const root = NodePath.join(work, tag);
  NodeFS.mkdirSync(root, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "--quiet", root]);
  const project = yield* call(
    "t3_project_create",
    { title: "Acme launch planning", workspaceRoot: root },
    Project,
  );
  yield* call(
    "t3_bot",
    {
      action: "create",
      botId: tag,
      name: "Acme planning assistant",
      instructions:
        "Help plan synthetic Acme launches. Do not create tasks, routines, learning or change sources unless explicitly asked.",
      learningPolicy: "after_adoption",
      modelSelection: {
        instanceId: "codex",
        model,
        options: [{ id: "reasoningEffort", value: effort }],
      },
    },
    Schema.Unknown,
  );
  const attached = yield* call(
    "t3_bot",
    { action: "attach", botId: tag, projectId: project.id },
    Schema.Struct({ bot: BotDetail }),
  );
  const homeThreadId = attached.bot.projects[0]?.homeThreadId;
  if (homeThreadId === undefined) return yield* Effect.die(new Error("fixture Home missing"));
  const errors: string[] = [];
  let settled = true;
  const filesBefore = files(root);
  let seedView: typeof Note.Type | null = null;
  let seedRunId: string | null = null;
  let filesSeed = filesBefore;
  if (testCase.id === "correction-wins") {
    const seed = yield* turn(call, homeThreadId, CASES[0]!.capture);
    settled &&= seed.settled;
    seedRunId = seed.runId;
    const observedSeed = yield* inspect(call, { botId: tag, projectId: project.id });
    seedView = observedSeed.view;
    if (observedSeed.error !== null) errors.push(observedSeed.error);
    filesSeed = files(root);
    if (seed.error !== null) errors.push(seed.error);
  }
  const capturedTurn = yield* turn(call, homeThreadId, testCase.capture);
  settled &&= capturedTurn.settled;
  if (capturedTurn.error !== null) errors.push(capturedTurn.error);
  const result = yield* inspect(call, { botId: tag, projectId: project.id });
  if (result.error !== null) errors.push(result.error);
  return {
    id: testCase.id,
    sample,
    root,
    botId: tag,
    projectId: project.id,
    homeThreadId,
    captured: result.view,
    seed: seedView,
    seedRunId,
    captureRunId: capturedTurn.runId,
    filesBefore,
    filesSeed,
    filesCaptured: files(root),
    errors,
    settled,
    settingsBefore: settings(attached.bot),
  } satisfies Captured;
});
const resume = Effect.fn("botContinuationEval.resume")(function* (
  call: Call,
  testCase: ContinuationCase,
  captured: Captured,
) {
  const before = yield* inspect(call, captured);
  const continued = yield* turn(call, captured.homeThreadId, testCase.resume);
  const after = yield* inspect(call, captured);
  const items = yield* readItems(call, captured.homeThreadId, "activity");
  const calls = readToolCalls(items);
  const bot = yield* call(
    "t3_bot",
    { action: "read", botId: captured.botId },
    Schema.Struct({ bot: BotDetail }),
  );
  const tasks = yield* call(
    "t3_bot",
    { action: "list_tasks", botId: captured.botId },
    Schema.Struct({ tasks: Schema.Array(Schema.Unknown) }),
  );
  const routines = yield* call(
    "list_scheduled_tasks",
    { projectId: captured.projectId },
    Schema.Struct({ tasks: Schema.Array(Schema.Unknown) }),
  );
  const run: Observation = {
    supported: captured.captured !== null && before.view !== null && after.view !== null,
    capture: captured.captured,
    seed: captured.seed,
    seedRunId: captured.seedRunId,
    captureRunId: captured.captureRunId,
    unchangedFiles:
      captured.filesBefore === captured.filesSeed &&
      captured.filesBefore === captured.filesCaptured &&
      captured.filesBefore === files(captured.root),
    directInputs: items
      .filter((item) => item.type === "user_message" && item.messageId !== null)
      .map((item) => ({
        messageId: item.messageId!,
        threadId: item.sourceThreadId,
        text: item.text ?? "",
        digest: NodeCrypto.createHash("sha256")
          .update(item.text ?? "")
          .digest("hex"),
        direct:
          item.sourceThreadId === captured.homeThreadId &&
          item.senderThreadId == null &&
          ((item.createdBy === "user" &&
            (item.creationSource === "web" || item.creationSource === "mobile")) ||
            (item.createdBy === "agent" && item.creationSource === "mcp")) &&
          item.title === null,
      })),
    resumed: before.view,
    answer: items
      .filter((item) => item.runId === continued.runId && item.type === "assistant_message")
      .map((item) => item.text ?? "")
      .join("\n"),
    calls,
    botId: captured.botId,
    projectId: captured.projectId,
    homeThreadId: captured.homeThreadId,
    errors: [
      ...captured.errors,
      ...[before.error, after.error, continued.error].filter(
        (value): value is string => value !== null,
      ),
    ],
    settled: captured.settled && continued.settled,
    unchangedSettings: settings(bot.bot) === captured.settingsBefore,
    tasks: tasks.tasks.length,
    routines: routines.tasks.length,
  };
  const checks = gradeSample(testCase, run);
  return {
    id: testCase.id,
    sample: captured.sample,
    pass: checks.every((check) => check.pass),
    checks,
    ...run,
    afterResume: after.view,
    rawActivity: items,
  };
});
const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      "base-dir": { type: "string" },
      work: { type: "string" },
      phase: { type: "string", default: "all" },
      manifest: { type: "string" },
      model: { type: "string", default: "gpt-6-luna" },
      effort: { type: "string", default: "medium" },
      samples: { type: "string", default: "3" },
      concurrency: { type: "string", default: "1" },
      case: { type: "string", multiple: true },
      baseline: { type: "string" },
      "lifecycle-evidence": { type: "string" },
    },
  });
  if (values.out === undefined || values["base-dir"] === undefined)
    return yield* Effect.die(
      new Error("Pass --out and --base-dir for a parent-owned synthetic server."),
    );
  if (
    !["all", "capture", "resume"].includes(values.phase) ||
    values.concurrency !== "1" ||
    !Number.isInteger(Number(values.samples)) ||
    Number(values.samples) < 1
  )
    return yield* Effect.die(
      new Error("Use phase all/capture/resume, positive samples and concurrency 1."),
    );
  const out = NodePath.resolve(values.out);
  NodeFS.mkdirSync(out, { recursive: true });
  const manifestPath = NodePath.resolve(values.manifest ?? NodePath.join(out, "manifest.json"));
  const selected = CASES.filter(
    (testCase) => values.case === undefined || values.case.includes(testCase.id),
  );
  if (selected.length === 0) return yield* Effect.die(new Error("No matching cases."));
  yield* withTools(values["base-dir"], "bot-continuation", (call) =>
    Effect.gen(function* () {
      yield* requireCodexModel(call, values.model, values.effort);
      let manifest: typeof Manifest.Type;
      if (values.phase === "resume") {
        manifest = yield* decodeManifest(NodeFS.readFileSync(manifestPath, "utf8"));
        if (manifest.model !== values.model || manifest.effort !== values.effort)
          return yield* Effect.die(
            new Error("Resume must use the captured model and effort; no fallback."),
          );
      } else {
        const captures: Captured[] = [];
        for (const testCase of selected)
          for (let sample = 0; sample < Number(values.samples); sample += 1) {
            const captured = yield* capture(
              call,
              testCase,
              sample,
              NodePath.resolve(values.work ?? NodePath.join(out, "work")),
              values.model,
              values.effort,
            );
            captures.push(captured);
            NodeFS.writeFileSync(
              manifestPath,
              encodeJson({ version: 1, model: values.model, effort: values.effort, captures }),
            );
          }
        manifest = { version: 1, model: values.model, effort: values.effort, captures };
      }
      NodeFS.writeFileSync(
        NodePath.join(out, "metadata.json"),
        encodeJson({
          harnessHead: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          phase: values.phase,
          model: values.model,
          effort: values.effort,
          baseline:
            values.baseline === undefined ? null : NodeFS.readFileSync(values.baseline, "utf8"),
          lifecycleEvidence:
            values["lifecycle-evidence"] === undefined
              ? null
              : NodeFS.readFileSync(values["lifecycle-evidence"], "utf8"),
        }),
      );
      if (values.phase === "capture") return;
      for (const captured of manifest.captures) {
        const testCase = selected.find((candidate) => candidate.id === captured.id);
        if (testCase === undefined) continue;
        const row = yield* resume(call, testCase, captured).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              id: captured.id,
              sample: captured.sample,
              pass: false,
              infrastructureError: error.message,
            }),
          ),
        );
        NodeFS.appendFileSync(NodePath.join(out, "results.jsonl"), `${encodeJson(row)}\n`);
      }
    }),
  );
});
if (import.meta.main)
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, Net.layer)),
    NodeRuntime.runMain,
  );
