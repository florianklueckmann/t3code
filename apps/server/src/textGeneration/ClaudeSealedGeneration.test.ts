import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Options as ClaudeQueryOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { SealedRefusalReason } from "@t3tools/provider-core/server/sealedGeneration";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";
import {
  SEALED_CLAUDE_INSTRUCTIONS,
  makeClaudeSealedGeneration,
} from "./ClaudeSealedGeneration.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent_personal");
const POLICY = "FIXED_MAINTENANCE_POLICY";
const PACKET = "PACKET_ONLY";
const Proposal = Schema.Struct({ summary: Schema.String });
const ANSWER = { summary: "packet summary" };

const catalogModel = BUNDLED_CLAUDE_MODEL_CATALOG.models[0]!.model;
const MODEL = catalogModel.slug;
const OTHER_MODEL = BUNDLED_CLAUDE_MODEL_CATALOG.models[1]!.model.slug;

const selection: ModelSelection = { instanceId: INSTANCE, model: MODEL };

const baseSnapshot: ServerProvider = {
  instanceId: INSTANCE,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", type: "claude.ai", label: "Claude" },
  version: "2.1.331",
  checkedAt: "1970-01-01T00:00:00Z",
  models: [
    {
      ...catalogModel,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
          { id: "ultracode", label: "Ultracode", type: "boolean" },
        ],
      },
    },
    { slug: "my-custom", name: "Custom", isCustom: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const frame = (value: unknown) => value as SDKMessage;
const init = (overrides: Record<string, unknown> = {}) =>
  frame({
    type: "system",
    subtype: "init",
    model: MODEL,
    tools: ["StructuredOutput"],
    mcp_servers: [],
    ...overrides,
  });
const assistant = (content: ReadonlyArray<unknown>, overrides: Record<string, unknown> = {}) =>
  frame({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "response-1", model: MODEL, content },
    ...overrides,
  });
const answer = (input: unknown = ANSWER) =>
  assistant([
    { type: "thinking", thinking: "" },
    { type: "tool_use", id: "tool-1", name: "StructuredOutput", input },
  ]);
const result = (overrides: Record<string, unknown> = {}) =>
  frame({
    type: "result",
    subtype: "success",
    is_error: false,
    permission_denials: [],
    structured_output: ANSWER,
    ...overrides,
  });
const CLEAN = [init(), answer(), result()];

interface Harness {
  readonly calls: Array<{ readonly prompt: string; readonly options: ClaudeQueryOptions }>;
  /** Frames the generator read before it stopped. */
  readonly read: Array<SDKMessage>;
  /** Resolves once Claude was started. */
  readonly started: Promise<void>;
}

/** A sealed generation over scripted frames; `hang` keeps the stream open after them. */
const withGeneration = <A, E>(
  input: {
    readonly snapshot?: ServerProvider;
    readonly frames?: ReadonlyArray<SDKMessage>;
    readonly hang?: boolean;
    readonly fail?: boolean;
    readonly settingsFile?: string;
    readonly launchArgs?: string;
    readonly platform?: NodeJS.Platform;
    /** Calls the seal's own tool guard for this tool before the frames. */
    readonly attempt?: string;
  },
  use: (
    generation: Effect.Success<ReturnType<typeof makeClaudeSealedGeneration>>,
    harness: Harness,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-sealed-test-" });
    if (input.settingsFile !== undefined)
      yield* fileSystem.writeFileString(path.join(configDir, "settings.json"), input.settingsFile);
    let markStarted = () => {};
    const harness: Harness = {
      calls: [],
      read: [],
      started: new Promise((resolve) => (markStarted = resolve)),
    };
    const generation = yield* makeClaudeSealedGeneration({
      getSnapshot: Effect.succeed(input.snapshot ?? baseSnapshot),
      settings: decodeClaudeSettings({ launchArgs: input.launchArgs ?? "" }),
      environment: { CLAUDE_CONFIG_DIR: configDir },
      configDir,
      modelCatalog: () => Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
      deadline: Duration.seconds(30),
      query: ({ prompt, options }) => {
        harness.calls.push({ prompt, options });
        markStarted();
        return (async function* () {
          if (input.attempt !== undefined)
            await options.hooks!.PreToolUse![0]!.hooks[0]!(
              { hook_event_name: "PreToolUse", tool_name: input.attempt } as never,
              undefined,
              { signal: new AbortController().signal },
            );
          for (const message of input.frames ?? CLEAN) {
            harness.read.push(message);
            yield message;
          }
          if (input.fail === true) throw new Error("claude exited with code 1");
          if (input.hang === true)
            await new Promise((_, reject) =>
              options.abortController!.signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            );
        })();
      },
    });
    return yield* use(generation, harness);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcess.Platform, input.platform ?? "darwin"),
  );

const generateWith = (input: Parameters<typeof withGeneration>[0], model = selection) =>
  withGeneration(input, (generation, harness) =>
    generation
      .generate({ selection: model, instructions: POLICY, packet: PACKET, schema: Proposal })
      .pipe(
        Effect.result,
        Effect.map((outcome) => ({ outcome, harness })),
      ),
  );

it.effect("answers from exactly the selected model with no tool, server, setting or session", () =>
  Effect.gen(function* () {
    const { outcome, harness } = yield* generateWith(
      {},
      { ...selection, options: [{ id: "effort", value: "high" }] },
    );
    assert.deepEqual(outcome._tag === "Success" && outcome.success, {
      value: ANSWER,
      model: MODEL,
    });
    const [call] = harness.calls;
    if (call === undefined) return assert.fail();
    assert.equal(call.prompt, PACKET);
    const { cwd, hooks, abortController, env, ...options } = call.options;
    assert.deepEqual(options, {
      pathToClaudeCodeExecutable: "claude",
      model: MODEL,
      effort: "high",
      systemPrompt: `${POLICY}\n\n${SEALED_CLAUDE_INSTRUCTIONS}`,
      outputFormat: { type: "json_schema", schema: toJsonSchemaObject(Proposal) as never },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      plugins: [],
      skills: [],
      persistSession: false,
      verbatimPrompts: true,
      permissionMode: "dontAsk",
      settings: {
        fastMode: false,
        disableAllHooks: true,
        disableSkillShellExecution: true,
        disableClaudeAiConnectors: true,
        syncClaudeAiPlugins: false,
        autoMemoryEnabled: false,
        env: { CLAUDE_CODE_PLUGIN_DIRS: "", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      },
    });
    assert.deepEqual(Object.keys(hooks ?? {}), ["PreToolUse"]);
    assert.isTrue(abortController?.signal.aborted);
    assert.isTrue(env?.CLAUDE_CONFIG_DIR?.startsWith("/"));
    // The call ran in its own empty folder, which is gone afterwards.
    const fileSystem = yield* FileSystem.FileSystem;
    assert.match(cwd ?? "", /t3code-sealed-/);
    assert.isFalse(yield* fileSystem.exists(cwd ?? ""));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each<{
  readonly name: string;
  readonly snapshot?: Partial<ServerProvider>;
  readonly selection?: ModelSelection;
  readonly platform?: NodeJS.Platform;
  readonly settingsFile?: string;
  readonly launchArgs?: string;
  readonly reason: SealedRefusalReason;
}>([
  { name: "a disabled instance", snapshot: { enabled: false }, reason: "instance_unavailable" },
  {
    name: "another instance's snapshot",
    snapshot: { instanceId: ProviderInstanceId.make("claudeAgent_work") },
    reason: "instance_unavailable",
  },
  {
    name: "a signed-out account",
    snapshot: { auth: { status: "unauthenticated" } },
    reason: "provider_signed_out",
  },
  {
    name: "an account whose sign-in is unknown",
    snapshot: { auth: { status: "unknown" } },
    reason: "provider_signed_out",
  },
  { name: "a Linux server", platform: "linux", reason: "platform_unsupported" },
  {
    name: "a Claude Code older than the measured one",
    snapshot: { version: "2.1.330" },
    reason: "claude_version_unsupported",
  },
  {
    name: "an unreadable Claude Code version",
    snapshot: { version: null },
    reason: "claude_version_unsupported",
  },
  {
    name: "a model the account does not list",
    selection: { ...selection, model: OTHER_MODEL },
    reason: "selected_model_unavailable",
  },
  {
    name: "a custom model",
    selection: { ...selection, model: "my-custom" },
    reason: "selected_model_unavailable",
  },
  {
    name: "an option the model does not offer",
    selection: { ...selection, options: [{ id: "serviceTier", value: "fast" }] },
    reason: "option_unsupported",
  },
  {
    name: "an option value the model does not offer",
    selection: { ...selection, options: [{ id: "effort", value: "max" }] },
    reason: "option_unsupported",
  },
  {
    name: "Ultracode, which runs subagents",
    selection: { ...selection, options: [{ id: "ultracode", value: true }] },
    reason: "option_unsupported",
  },
  {
    name: "settings that send Claude to another backend",
    settingsFile: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }),
    reason: "claude_settings_unsupported",
  },
  {
    name: "settings with their own key helper",
    settingsFile: JSON.stringify({ apiKeyHelper: "/home/user/key.sh" }),
    reason: "claude_settings_unsupported",
  },
  {
    name: "settings it cannot read as JSON",
    settingsFile: '{ "env": { "ANTHROPIC_BASE_URL": "https://gateway.example" }, }',
    reason: "claude_settings_unsupported",
  },
  {
    name: "a launch argument that sends Claude to another backend",
    launchArgs: `--settings '{"env":{"ANTHROPIC_BASE_URL":"https://gateway.example"}}'`,
    reason: "claude_settings_unsupported",
  },
])(
  "refuses $name before any process starts",
  ({ snapshot, selection: selected, platform, settingsFile, launchArgs, reason }) =>
    withGeneration(
      {
        ...(launchArgs === undefined ? {} : { launchArgs }),
        snapshot: { ...baseSnapshot, ...snapshot },
        ...(settingsFile === undefined ? {} : { settingsFile }),
        ...(platform === undefined ? {} : { platform }),
      },
      (generation, harness) =>
        Effect.gen(function* () {
          const model = selected ?? selection;
          assert.equal(yield* generation.availability(model), reason);
          const refusal = yield* generation
            .generate({ selection: model, instructions: POLICY, packet: PACKET, schema: Proposal })
            .pipe(Effect.flip);
          assert.deepEqual(
            { tag: refusal._tag, reason: refusal.reason },
            { tag: "SealedGenerationRefused", reason },
          );
          assert.lengthOf(harness.calls, 0);
        }),
    ),
);

it.effect("accepts the answer of a re-prompt after the first one missed the schema", () =>
  Effect.gen(function* () {
    const { outcome } = yield* generateWith({
      frames: [
        init(),
        answer({ summary: 1 }),
        assistant([{ type: "tool_use", id: "tool-3", name: "StructuredOutput", input: ANSWER }], {
          message: { id: "response-2", model: MODEL, content: [] },
        }),
        result(),
      ],
    });
    assert.deepEqual(outcome._tag === "Success" && outcome.success, {
      value: ANSWER,
      model: MODEL,
    });
  }),
);

it.effect("is available with ordinary user settings, hooks included", () =>
  withGeneration(
    { settingsFile: JSON.stringify({ model: "haiku", hooks: { Stop: [] }, env: { FOO: "1" } }) },
    (generation) =>
      Effect.gen(function* () {
        assert.isNull(yield* generation.availability(selection));
      }),
  ),
);

const bash = { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "ls" } };

it.effect.each<{
  readonly name: string;
  readonly frames?: ReadonlyArray<SDKMessage>;
  readonly attempt?: string;
  readonly fail?: boolean;
  readonly tag?: "SealedGenerationRefused";
  readonly reason: string;
  /** How many frames were read before the call stopped; the rest never count. */
  readonly read?: number;
}>([
  {
    name: "a tool call",
    frames: [init(), assistant([bash]), answer(), result()],
    reason: "tool_attempt",
    read: 2,
  },
  {
    name: "a server-side tool call",
    frames: [init(), assistant([{ type: "server_tool_use", name: "web_search" }]), result()],
    reason: "tool_attempt",
    read: 2,
  },
  {
    name: "a subagent's message",
    frames: [init(), assistant([{ type: "text", text: "hi" }], { parent_tool_use_id: "t" })],
    reason: "tool_attempt",
  },
  {
    name: "a tool call its own guard refused",
    attempt: "Bash",
    reason: "tool_attempt",
  },
  {
    name: "a tool call Claude denied",
    frames: [init(), answer(), result({ permission_denials: [{ tool_name: "Bash" }] })],
    reason: "tool_attempt",
  },
  {
    name: "a tool beside StructuredOutput at startup",
    frames: [init({ tools: ["StructuredOutput", "Bash"] }), answer(), result()],
    reason: "config_changed",
    read: 1,
  },
  {
    name: "an MCP server at startup",
    frames: [init({ mcp_servers: [{ name: "github", status: "connected" }] }), answer(), result()],
    reason: "config_changed",
    read: 1,
  },
  {
    name: "an answer before the startup frame",
    frames: [answer(), result()],
    reason: "config_changed",
    read: 1,
  },
  {
    name: "another model at startup",
    frames: [init({ model: OTHER_MODEL }), answer(), result()],
    reason: "model_mismatch",
    read: 1,
  },
  {
    name: "another model answering",
    frames: [
      init(),
      assistant([{ type: "text", text: "hi" }], {
        message: { id: "response-1", model: OTHER_MODEL, content: [] },
      }),
      result(),
    ],
    reason: "model_mismatch",
    read: 2,
  },
  {
    name: "a fourth model response after re-prompts",
    frames: [
      init(),
      answer({ summary: 1 }),
      ...["response-2", "response-3", "response-4"].map((id) =>
        assistant([], { message: { id, model: MODEL, content: [] } }),
      ),
      result(),
    ],
    reason: "invalid_output",
    read: 5,
  },
  {
    name: "a message Claude Code wrote in the model's place",
    frames: [
      init(),
      assistant([{ type: "text", text: "hi" }], {
        message: { id: "response-1", model: "<synthetic>", content: [] },
      }),
      answer(),
      result(),
    ],
    reason: "turn_failed",
    read: 2,
  },
  {
    name: "structured output the model never called for",
    frames: [init(), assistant([{ type: "text", text: "hi" }]), result()],
    reason: "invalid_output",
  },
  {
    name: "a fallback after a refusal",
    frames: [
      init(),
      frame({ type: "system", subtype: "model_refusal_fallback", fallback_model: OTHER_MODEL }),
      answer(),
      result(),
    ],
    reason: "model_mismatch",
    read: 2,
  },
  {
    name: "output outside the schema",
    frames: [init(), answer({ summary: 1 }), result({ structured_output: { summary: 1 } })],
    reason: "invalid_output",
  },
  {
    name: "no structured output",
    frames: [
      init(),
      assistant([{ type: "text", text: "hi" }]),
      result({ structured_output: undefined }),
    ],
    reason: "invalid_output",
  },
  {
    name: "a result no model message backs",
    frames: [init(), result()],
    reason: "invalid_output",
  },
  {
    name: "structured output retries running out",
    frames: [
      init(),
      answer(),
      result({ subtype: "error_max_structured_output_retries", is_error: true }),
    ],
    reason: "invalid_output",
  },
  {
    name: "output over the size limit",
    frames: [init(), answer(), result({ structured_output: { summary: "x".repeat(64 * 1024) } })],
    reason: "output_too_large",
  },
  {
    name: "a failed turn",
    frames: [init(), result({ subtype: "error_during_execution", is_error: true })],
    reason: "turn_failed",
  },
  {
    name: "an API error",
    frames: [
      init(),
      assistant([], { error: "server_error", message: { model: "<synthetic>", content: [] } }),
      result(),
    ],
    reason: "turn_failed",
    read: 2,
  },
  {
    name: "a usage limit",
    frames: [
      init(),
      assistant([], { error: "rate_limit", message: { model: "<synthetic>", content: [] } }),
      result(),
    ],
    reason: "usage_limited",
    read: 2,
  },
  {
    name: "an account that turns out signed out",
    frames: [
      init(),
      assistant([], {
        error: "authentication_failed",
        message: { model: "<synthetic>", content: [] },
      }),
      result(),
    ],
    tag: "SealedGenerationRefused",
    reason: "provider_signed_out",
    read: 2,
  },
  {
    name: "a stream that ends without a result",
    frames: [init(), answer()],
    reason: "process_exit",
  },
  { name: "a process that fails", frames: [init()], fail: true, reason: "process_exit" },
])("discards $name", ({ frames, attempt, fail, tag, reason, read }) =>
  Effect.gen(function* () {
    const { outcome, harness } = yield* generateWith({
      ...(frames === undefined ? {} : { frames }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(fail === undefined ? {} : { fail }),
    });
    if (outcome._tag !== "Failure") return assert.fail("the call answered");
    assert.deepEqual(
      { tag: outcome.failure._tag, reason: outcome.failure.reason },
      { tag: tag ?? "SealedGenerationDiscarded", reason },
    );
    if (read !== undefined) assert.lengthOf(harness.read, read);
    assert.isTrue(harness.calls[0]?.options.abortController?.signal.aborted);
  }),
);

it.effect("discards a call that outlives its deadline and ends the process", () =>
  withGeneration({ frames: [init()], hang: true }, (generation, harness) =>
    Effect.gen(function* () {
      const fiber = yield* generation
        .generate({ selection, instructions: POLICY, packet: PACKET, schema: Proposal })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => harness.started);
      yield* TestClock.adjust(Duration.seconds(30));
      const failure = yield* Fiber.join(fiber);
      assert.deepEqual(
        { tag: failure._tag, reason: failure.reason },
        { tag: "SealedGenerationDiscarded", reason: "timeout" },
      );
      assert.isTrue(harness.calls[0]?.options.abortController?.signal.aborted);
    }),
  ),
);
