import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  conversationSummaryContext,
  DEFAULT_HANDOFF_TOKEN_CAP,
  freshConversationTokenCap,
  handoffCoverage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { providerHandoffMessages } from "../../apps/server/src/orchestration-v2/ContextHandoffService.ts";
import {
  conversationRecoveryHandoffItems,
  freshConversationPlan,
} from "../../apps/server/src/orchestration-v2/ConversationRecovery.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import { cases, type SummaryCase } from "./cases.ts";
import { grade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "gpt-6-luna" },
    mode: { type: "string", default: "summary" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    "codex-home": { type: "string" },
    baseline: { type: "string" },
  },
});
const { out, model, mode } = values;
const samples = mode === "selection" ? 1 : Number(values.samples);
const fixtures = cases.filter((fixture) => !values.case || values.case.includes(fixture.id));
if (
  !out ||
  !fixtures.length ||
  (mode !== "summary" && mode !== "selection") ||
  !Number.isSafeInteger(samples) ||
  samples < 1
) {
  throw new Error(
    "Use --out <directory> [--mode summary|selection] [--model <id>] [--case <id>] [--samples <n>] [--codex-home <dir>] [--baseline <results.json>].",
  );
}

const threadId = ThreadId.make("thread-summary-eval");
const now = DateTime.makeUnsafe("2026-11-11T12:00:00Z");

/** The case as stored turn items, so the eval goes through the same filter as the server. */
const history = (fixture: SummaryCase) => {
  const items: Array<OrchestrationV2TurnItem> = [];
  const add = (runId: RunId, fields: object) =>
    items.push({
      id: TurnItemId.make(`item-${items.length + 1}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: items.length + 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      ...fields,
    } as OrchestrationV2TurnItem);
  const runs = fixture.runs.map((run, index) => {
    const id = RunId.make(`run-${index + 1}`);
    add(id, { type: "user_message", text: run.user, attachments: [] });
    for (const command of run.commands ?? [])
      add(id, { type: "command_execution", ...command, exitCode: 1 });
    add(id, { type: "assistant_message", text: run.reply });
    return { id, ordinal: index + 1, status: "completed" as const };
  });
  return providerHandoffMessages(conversationRecoveryHandoffItems(items), runs);
};

const Row = Schema.Struct({
  id: Schema.String,
  sample: Schema.Number,
  mode: Schema.String,
  model: Schema.String,
  pass: Schema.Boolean,
  failures: Schema.Array(Schema.String),
  summary: Schema.String,
  handoffBytes: Schema.Number,
});
const Rows = Schema.fromJsonString(Schema.Array(Row));
const decodeRows = Schema.decodeEffect(Rows);
const encodeRows = Schema.encodeEffect(Rows);
const decodeSettings = Schema.decodeEffect(CodexSettings);

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-summary-eval-" });
    const service = yield* makeCodexTextGeneration(
      yield* decodeSettings(values["codex-home"] ? { homePath: values["codex-home"] } : {}),
    );
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeRows))
      : [];
    const rows: Array<typeof Row.Type> = [];
    for (const fixture of fixtures) {
      const messages = history(fixture);
      const coverage = handoffCoverage({
        threadId,
        coveredRunOrdinals: { from: 1, to: fixture.runs.length },
      });
      for (let sample = 1; sample <= samples; sample++) {
        let summaryText = "";
        let handoff: string;
        if (mode === "selection") {
          // The handoff before T3B-50: newest messages only, at the default cap.
          const selected = selectHistory({ messages, coverage, budget: DEFAULT_HANDOFF_TOKEN_CAP });
          handoff = renderHistory(selected.messages, selected.context);
        } else {
          const plan = freshConversationPlan({
            messages,
            coverage,
            tokenCap: DEFAULT_HANDOFF_TOKEN_CAP,
            previousSummary:
              fixture.previousSummary === undefined
                ? undefined
                : { text: fixture.previousSummary, throughRunOrdinal: 1 },
          });
          if (plan.type !== "summarize")
            throw new Error(`${fixture.id} fits verbatim; lengthen its padding.`);
          const generated = yield* service.generateConversationSummary({
            cwd,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: model! },
            previousSummary: plan.previousSummary,
            messages: plan.messages.map(({ role, runOrdinal, text }) => ({
              role,
              runOrdinal,
              text,
            })),
          });
          summaryText = generated.summary;
          const summary = { text: summaryText, throughRunOrdinal: plan.throughRunOrdinal };
          const selected = selectHistory({
            messages,
            coverage: `${coverage}\n${conversationSummaryContext(summary)}`,
            budget: freshConversationTokenCap(DEFAULT_HANDOFF_TOKEN_CAP, summary),
          });
          handoff = renderHistory(selected.messages, selected.context);
        }
        const result = grade({ summary: summaryText, handoff }, fixture.checks);
        rows.push({
          id: fixture.id,
          sample,
          mode: mode!,
          model: mode === "selection" ? "none" : model!,
          ...result,
          summary: summaryText,
          handoffBytes: Buffer.byteLength(handoff),
        });
        yield* Effect.logInfo(
          `${fixture.id} #${sample}: ${result.pass ? "pass" : `fail (${result.failures.join(", ")})`}`,
        );
      }
    }
    const caseResult = (all: ReadonlyArray<typeof Row.Type>, id: string) => {
      const sampled = all.filter((row) => row.id === id);
      const passed = sampled.filter((row) => row.pass).length;
      return sampled.length === 0
        ? "-"
        : `${passed}/${sampled.length} ${passed * 2 > sampled.length ? "pass" : "FAIL"}`;
    };
    const report = [
      `# Conversation summary (${mode}${mode === "summary" ? `, ${model}` : ""})`,
      "",
      `| Case | Result |${values.baseline ? " Baseline |" : ""}`,
      `| --- | --- |${values.baseline ? " --- |" : ""}`,
      ...fixtures.map(
        (fixture) =>
          `| ${fixture.id} | ${caseResult(rows, fixture.id)} |${values.baseline ? ` ${caseResult(baseline, fixture.id)} |` : ""}`,
      ),
      "",
    ].join("\n");
    yield* fs.makeDirectory(out, { recursive: true });
    yield* fs.writeFileString(path.join(out, "results.json"), yield* encodeRows(rows));
    yield* fs.writeFileString(path.join(out, "summary.md"), report);
    yield* Effect.logInfo(`\n${report}`);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-summary-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
