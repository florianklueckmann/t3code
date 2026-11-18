/**
 * Grants a Bot two accounts of one synthetic mail service through a running T3 Code dev server,
 * asks its Home for one account's mail, and grades which account the Bot called. See README.md.
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
import { BotDetail, McpConnectionId } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { createBotHome } from "../shared/botHome.ts";
import { type WsClient, withRpc } from "../shared/devServerRpc.ts";
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
import { ACCOUNTS, CASES, type GrantCase } from "./cases.ts";

const MAIL_SERVER = NodePath.join(import.meta.dirname, "mailServer.ts");

export interface SampleRun {
  readonly text: string;
  /** The accounts the fixtures recorded a tool call on, one entry per call. */
  readonly calledAccounts: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ToolActivity>;
}

export const gradeSample = (testCase: GrantCase, run: SampleRun) => {
  const { expected } = testCase;
  return [
    { check: `called the ${expected} account`, pass: run.calledAccounts.includes(expected) },
    {
      check: "called no other account",
      pass: run.calledAccounts.every((account) => account === expected),
    },
  ];
};

const readCalls = (path: string): ReadonlyArray<string> =>
  NodeFS.existsSync(path)
    ? NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { readonly account: string }).account)
    : [];

const runSample = Effect.fn("botGrants.runSample")(function* (
  call: Call,
  rpc: WsClient,
  testCase: GrantCase,
  options: { readonly work: string; readonly modelSelection: BotModelSelection },
) {
  const tag = `bg-${testCase.id}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const home = yield* createBotHome(call, { tag, ...options });
  const callLog = NodePath.join(options.work, `${tag}.calls.jsonl`);
  const failed = (step: string) => (cause: unknown) =>
    new SampleError({ message: `${step}: ${String(cause)}` });
  const connections = yield* Effect.forEach(ACCOUNTS, ({ account, label }) =>
    rpc["mcpConnections.create"]({
      connectionId: McpConnectionId.make(NodeCrypto.randomUUID()),
      label,
      enabled: true,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [MAIL_SERVER],
        env: { MAIL_ACCOUNT: account, MAIL_CALL_LOG: callLog },
      },
    }).pipe(Effect.mapError(failed("mcpConnections.create"))),
  );
  return yield* Effect.gen(function* () {
    const { bot } = yield* call(
      "t3_bot",
      { action: "read", botId: home.botId },
      Schema.Struct({ bot: BotDetail }),
    );
    if (bot.mcpGrants === undefined) {
      return yield* Effect.die(new Error("This server has no MCP connection grants."));
    }
    yield* rpc["bots.setMcpGrants"]({
      botId: bot.id,
      expectedRevision: bot.mcpGrants.revision,
      connectionIds: connections.map((connection) => connection.id),
    }).pipe(Effect.mapError(failed("bots.setMcpGrants")));
    const runId = yield* runTurn(call, home.homeThreadId, testCase.prompt);
    const messages = yield* readItems(call, home.homeThreadId, "messages");
    return {
      text:
        messages.findLast((item) => item.runId === runId && item.type === "assistant_message")
          ?.text ?? "",
      calledAccounts: readCalls(callLog),
      tools: toolActivity(yield* readItems(call, home.homeThreadId, "activity")),
    } satisfies SampleRun;
  }).pipe(
    Effect.ensuring(
      Effect.forEach(connections, (connection) =>
        rpc["mcpConnections.remove"]({
          connectionId: connection.id,
          expectedRevision: connection.revision,
        }).pipe(Effect.ignore({ log: true })),
      ),
    ),
  );
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
  NodeFS.mkdirSync(work, { recursive: true });
  const rows = yield* withTools(baseDir, "bot-grants", (call) =>
    withRpc(baseDir, (rpc) =>
      Effect.gen(function* () {
        const modelSelection = yield* requireBotModel(call, {
          instance: values.instance,
          model: values.model,
          effort: values.effort,
        });
        return yield* Effect.forEach(
          jobs,
          ({ testCase, sample }) =>
            runSample(call, rpc, testCase, { work, modelSelection }).pipe(
              Effect.map((run) => {
                const checks = gradeSample(testCase, run);
                return {
                  id: testCase.id,
                  sample,
                  pass: checks.every((c) => c.pass),
                  checks,
                  ...run,
                };
              }),
              // An incomplete sample stays in the results as an error and counts as a failure.
              Effect.catch((error) =>
                Effect.succeed({ id: testCase.id, sample, pass: false, error: error.message }),
              ),
              Effect.tap((row) =>
                Effect.sync(() =>
                  NodeFS.appendFileSync(
                    NodePath.join(out, "results.jsonl"),
                    `${encodeJson(row)}\n`,
                  ),
                ),
              ),
            ),
          { concurrency: Number(values.concurrency) },
        );
      }),
    ),
  );
  const lines = selected.map((testCase) => {
    const own = rows.filter((row) => row.id === testCase.id);
    const passed = own.filter((row) => row.pass).length;
    const errors = own.filter((row) => "error" in row).length;
    return `| ${testCase.id} | ${passed}/${own.length} | ${errors} |`;
  });
  const summary = [
    `Commit \`${commit}\`, ${values.model} at ${values.effort} effort, ${samples} samples per case.`,
    "",
    "| Case | Passed | Errors |",
    "| ---- | ------ | ------ |",
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
