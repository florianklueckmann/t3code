#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - standalone eval CLI and its output files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import * as Schema from "effect/Schema";
import * as Evidence from "../../apps/server/src/bots/BotMaintenanceEvidence.ts";
import {
  checkCodexProviderStatus,
  withCodexAppServerClient,
} from "../../apps/server/src/provider/CodexProvider.ts";
import {
  codexAccountHomePath,
  resolveCodexHomeLayout,
} from "../../apps/server/src/provider/Drivers/CodexHomeLayout.ts";
import { resolveCodexLaunchArgs } from "../../apps/server/src/provider/codexLaunchArgs.ts";
import { applyCodexModelCatalog } from "../../apps/server/src/provider/codexModelCatalog.ts";
import { makeCodexSealedGeneration } from "../../apps/server/src/textGeneration/CodexSealedGeneration.ts";
import { CASES } from "./cases.ts";
import { batchFor, casePasses, gradeSample, type SampleGrade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "gpt-6.1-terra" },
    effort: { type: "string", default: "high" },
    samples: { type: "string", default: "3" },
    case: { type: "string", multiple: true },
    baseline: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
/** The live process environment: Codex children and `os.tmpdir()` both read it. */
const environment = process.env;
const out = NodePath.resolve(values.out);
const samples = Number(values.samples);
const selected = values.case ? CASES.filter((item) => values.case!.includes(item.id)) : CASES;
if (selected.length === 0) throw new Error(`No case matches ${values.case?.join(", ")}.`);

/** What the eval saw on the app-server connection of one sealed call. */
interface Observed {
  readonly requests: Record<string, number>;
  readonly items: Array<string>;
  /** Notifications the client could not decode; a raw item among them discards the turn. */
  readonly undecoded: Array<string>;
  readonly hooks: Array<{
    readonly event: string;
    readonly source: string;
    readonly status: string;
  }>;
  tokens: { readonly input: number; readonly cached: number; readonly output: number } | null;
}

const observed = (): Observed => ({
  requests: {},
  items: [],
  undecoded: [],
  hooks: [],
  tokens: null,
});

interface Row {
  readonly id: string;
  readonly sample: number;
  readonly model: string;
  readonly effort: string;
  readonly threadModel: string | null;
  readonly error: string | null;
  readonly output: unknown;
  readonly grade: SampleGrade | null;
  readonly pass: boolean;
  readonly observed: Observed;
}

const BaselineRow = Schema.Struct({ id: Schema.String, pass: Schema.Boolean });
const decodeBaselineRow = Schema.decodeUnknownSync(Schema.fromJsonString(BaselineRow));
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeToolShape = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
);
const toolName = (tool: unknown) =>
  Option.match(decodeToolShape(tool), {
    onNone: () => "?",
    onSome: (shape) => `${shape.type ?? "?"}:${shape.name ?? "?"}`,
  });
const decodeItemShape = Schema.decodeUnknownOption(
  Schema.Struct({ item: Schema.Record(Schema.String, Schema.Unknown) }),
);

/** Counts requests and records hooks, raw items and usage; changes nothing the generator sees. */
const observe = Effect.fn("botMaintenanceEval.observe")(function* (
  client: Effect.Success<ReturnType<typeof withCodexAppServerClient>>["client"],
  seen: Observed,
) {
  yield* client.handleServerNotification("hook/completed", ({ run }) =>
    Effect.sync(() => {
      seen.hooks.push({ event: run.eventName, source: run.sourcePath, status: run.status });
    }),
  );
  yield* client.handleServerNotification("rawResponseItem/completed", ({ item }) =>
    Effect.sync(() => {
      if (item.type !== "message") return seen.items.push(item.type);
      // Only the first line: it names what Codex injected without copying its content.
      const head = item.content
        .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
        .join("")
        .split("\n")[0]!
        .slice(0, 60);
      return seen.items.push(`message:${item.role} ${encodeJson(head)}`);
    }),
  );
  yield* client.handleServerNotification("thread/tokenUsage/updated", ({ tokenUsage }) =>
    Effect.sync(() => {
      seen.tokens = {
        input: tokenUsage.total.inputTokens,
        cached: tokenUsage.total.cachedInputTokens,
        output: tokenUsage.total.outputTokens,
      };
    }),
  );
  const request: typeof client.request = (method, payload) =>
    Effect.suspend(() => {
      seen.requests[method] = (seen.requests[method] ?? 0) + 1;
      return client.request(method, payload);
    });
  // The generator owns the one unknown-notification slot; record what reaches it first.
  const handleUnknownServerNotification: typeof client.handleUnknownServerNotification = (
    handler,
  ) =>
    client.handleUnknownServerNotification((method, params) =>
      Effect.sync(() => {
        const item = Option.getOrUndefined(decodeItemShape(params))?.item;
        seen.undecoded.push(
          item === undefined
            ? method
            : `${method} type=${String(item.type)} role=${String(item.role)} keys=${Object.keys(item).toSorted().join(",")}${
                Array.isArray(item.tools)
                  ? ` tools=${item.tools.map((tool) => toolName(tool)).join(",")}`
                  : ""
              }`,
        );
      }).pipe(Effect.andThen(handler(method, params))),
    );
  return { ...client, request, handleUnknownServerNotification };
});

/** Every path created below `root` while the run is live, by its first path segment. */
const watchCreated = (root: string) => {
  const created = new Map<string, Set<string>>();
  const watcher = NodeFS.watch(root, { recursive: true }, (_event, name) => {
    if (name === null) return;
    const [sample, ...rest] = name.split(NodePath.sep);
    if (sample === undefined || rest.length === 0) return;
    const entries = created.get(sample) ?? new Set<string>();
    entries.add(rest.join(NodePath.sep));
    created.set(sample, entries);
  });
  return { created, close: () => watcher.close() };
};

const summarize = (input: {
  readonly rows: ReadonlyArray<Row>;
  readonly header: ReadonlyArray<string>;
  readonly created: ReadonlyMap<string, ReadonlySet<string>>;
  readonly leftover: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly baseline: ReadonlyArray<typeof BaselineRow.Type>;
}) => {
  const { rows } = input;
  const lines = [...input.header, "", "## Learning quality", ""];
  lines.push(
    `| Case | Passed | Verdict${input.baseline.length > 0 ? " | Baseline" : ""} | Failed checks and rejections |`,
    `| --- | --- | ---${input.baseline.length > 0 ? " | ---" : ""} | --- |`,
  );
  for (const testCase of selected) {
    const caseRows = rows.filter((row) => row.id === testCase.id);
    if (caseRows.length === 0) continue;
    const failed = new Map<string, number>();
    for (const row of caseRows) {
      const reasons = row.error
        ? [`error: ${row.error}`]
        : row.grade?.verifier !== "verified"
          ? [`verifier: ${row.grade?.verifier}`]
          : row.grade.checks.filter((check) => !check.pass).map((check) => check.check);
      for (const reason of reasons) failed.set(reason, (failed.get(reason) ?? 0) + 1);
    }
    const before = input.baseline.filter((row) => row.id === testCase.id);
    lines.push(
      `| ${testCase.id} | ${caseRows.filter((row) => row.pass).length}/${caseRows.length} | ${
        casePasses(caseRows) ? "pass" : "FAIL"
      }${
        input.baseline.length > 0
          ? ` | ${before.filter((row) => row.pass).length}/${before.length}`
          : ""
      } | ${[...failed].map(([reason, count]) => `${reason} (${count})`).join("; ") || "none"} |`,
    );
  }

  const calls = rows.filter((row) => row.error === null);
  const counts = (method: string) =>
    [...new Set(rows.map((row) => row.observed.requests[method] ?? 0))].toSorted().join(", ");
  const hooks = [
    ...new Set(
      rows.flatMap((row) =>
        row.observed.hooks.map((hook) => `${hook.event} ${hook.source} (${hook.status})`),
      ),
    ),
  ];
  const itemShapes = [...new Set(rows.map((row) => row.observed.items.join(" ")))];
  const tokens = rows.reduce(
    (sum, row) => ({
      input: sum.input + (row.observed.tokens?.input ?? 0),
      cached: sum.cached + (row.observed.tokens?.cached ?? 0),
      output: sum.output + (row.observed.tokens?.output ?? 0),
    }),
    { input: 0, cached: 0, output: 0 },
  );
  const createdNames = [
    ...new Set(
      [...input.created.values()].flatMap((names) =>
        [...names].map((name) => name.replace(/[A-Za-z0-9]{6,}$/, "*")),
      ),
    ),
  ];
  const leftover = [...input.leftover].filter(([, names]) => names.length > 0);
  lines.push(
    "",
    "## Sealed call acceptance",
    "",
    `- Calls that returned a proposal: ${calls.length}/${rows.length}. Thread models: ${[...new Set(rows.map((row) => row.threadModel ?? "none"))].join(", ")}.`,
    `- \`turn/start\` requests per call: ${counts("turn/start")}. \`thread/start\` per call: ${counts("thread/start")}.`,
    `- Raw response items per call: ${itemShapes.map((shape) => `\`${shape || "none"}\``).join("; ")}.`,
    `- Notifications the client could not decode: ${[...new Set(rows.flatMap((row) => row.observed.undecoded))].join("; ") || "none"}.`,
    `- Hooks the app-server ran: ${hooks.length === 0 ? "none" : hooks.join("; ")}.`,
    `- Paths created under the per-sample TMPDIR: ${createdNames.length === 0 ? "none" : createdNames.join(", ")}.`,
    `- Paths left under it after the run: ${leftover.length === 0 ? "none" : leftover.map(([sample, names]) => `${sample}: ${names.join(", ")}`).join("; ")}.`,
    `- Tokens: ${tokens.input} input (${tokens.cached} cached), ${tokens.output} output.`,
  );
  return `${lines.join("\n")}\n`;
};

const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  NodeFS.mkdirSync(out, { recursive: true });
  const resultsPath = NodePath.join(out, "results.jsonl");
  const summaryPath = NodePath.join(out, "summary.md");
  NodeFS.writeFileSync(resultsPath, "");
  const baseline = values.baseline
    ? NodeFS.readFileSync(values.baseline, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => decodeBaselineRow(line))
    : [];

  // The same wiring as CodexDriver's sealed generation, on the default Codex home.
  const settings = yield* decodeCodexSettings({});
  const layout = yield* resolveCodexHomeLayout(settings, environment.CODEX_HOME);
  const snapshot = withInstanceIdentity({
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: ProviderDriverKind.make("codex"),
    displayName: undefined,
    accentColor: undefined,
    continuationGroupKey: layout.continuationKey,
  })(
    applyCodexModelCatalog(
      yield* checkCodexProviderStatus(settings, undefined, environment),
      undefined,
    ),
  );
  const selection: ModelSelection = {
    instanceId: snapshot.instanceId,
    model: values.model,
    options: [{ id: "reasoningEffort", value: values.effort }],
  };
  const sealedFor = (seen: Observed) =>
    makeCodexSealedGeneration({
      getSnapshot: Effect.succeed(snapshot),
      storeHomePath: codexAccountHomePath(layout),
      openClient: (cwd) =>
        withCodexAppServerClient({
          binaryPath: settings.binaryPath,
          homePath: settings.homePath,
          launchArgs: resolveCodexLaunchArgs(settings.launchArgs, environment),
          cwd,
          environment,
        }).pipe(
          Effect.flatMap(({ client }) => observe(client, seen)),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    });

  const header = [
    `# Bot maintenance eval: ${values.model} ${values.effort}`,
    "",
    `- Codex ${snapshot.version ?? "unknown"}, account ${snapshot.auth.type ?? "unknown"} (${snapshot.auth.status}), ${samples} sample(s) per case.`,
  ];
  const refusal = yield* (yield* sealedFor(observed())).availability(selection);
  if (refusal !== null) {
    NodeFS.writeFileSync(
      summaryPath,
      `${[...header, "", `Sealed generation refused before any model call: \`${refusal}\`.`].join("\n")}\n`,
    );
    return yield* Effect.die(new Error(`Sealed generation refused: ${refusal}.`));
  }

  // Each sample gets its own TMPDIR, inherited by Codex and its hooks, so writes there show.
  const tmpRoot = NodePath.join(out, "tmp");
  NodeFS.mkdirSync(tmpRoot, { recursive: true });
  const watch = watchCreated(tmpRoot);
  const rows: Array<Row> = [];
  let refused: string | null = null;
  for (const testCase of selected) {
    const batch = batchFor(testCase);
    for (let sample = 1; sample <= samples && refused === null; sample += 1) {
      const tmp = NodePath.join(tmpRoot, `${testCase.id}-${sample}`);
      NodeFS.mkdirSync(tmp, { recursive: true });
      environment.TMPDIR = tmp;
      const seen = observed();
      const result = yield* (yield* sealedFor(seen))
        .generate({
          selection,
          instructions: Evidence.MAINTENANCE_POLICY,
          packet: encodeJson(batch.packet),
          schema: Evidence.Proposal,
        })
        .pipe(Effect.result);
      const failure = result._tag === "Failure" ? result.failure : null;
      if (failure?._tag === "SealedGenerationRefused") refused = failure.reason;
      const grade =
        result._tag === "Success" ? gradeSample(testCase, batch, result.success.value) : null;
      const row: Row = {
        id: testCase.id,
        sample,
        model: values.model,
        effort: values.effort,
        threadModel: result._tag === "Success" ? result.success.model : null,
        error: failure === null ? null : `${failure._tag}: ${failure.reason}`,
        output: result._tag === "Success" ? result.success.value : null,
        grade,
        pass: grade?.pass ?? false,
        observed: seen,
      };
      rows.push(row);
      NodeFS.appendFileSync(resultsPath, `${encodeJson(row)}\n`);
      yield* Effect.logInfo(
        `${testCase.id} #${sample}: ${row.error ?? (row.pass ? "pass" : "fail")}`,
      );
    }
  }
  // FSEvents delivers late; let the last sample's events land before closing the watcher.
  yield* Effect.sleep("3 seconds");
  watch.close();
  const leftover = new Map(
    NodeFS.readdirSync(tmpRoot).map((sample) => [
      sample,
      NodeFS.readdirSync(NodePath.join(tmpRoot, sample), { recursive: true }).map(String),
    ]),
  );
  NodeFS.writeFileSync(
    summaryPath,
    summarize({
      rows,
      header:
        refused === null
          ? header
          : [...header, "", `Stopped: sealed generation refused \`${refused}\`.`],
      created: watch.created,
      leftover,
      baseline,
    }),
  );
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
