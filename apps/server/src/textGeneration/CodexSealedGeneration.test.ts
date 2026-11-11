import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { SealedRefusalReason } from "@t3tools/provider-core/server/sealedGeneration";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { codexStoreStartPermit } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  SEALED_DEVELOPER_INSTRUCTIONS,
  makeCodexSealedGeneration,
} from "./CodexSealedGeneration.ts";

const INSTANCE = ProviderInstanceId.make("codex");
const MODEL = "gpt-6";
const POLICY = "FIXED_MAINTENANCE_POLICY";
const PACKET = "PACKET_ONLY";
const THREAD = "thread-1";
const TURN = "turn-1";
const Proposal = Schema.Struct({ summary: Schema.String });
const CLEAN_ANSWER = JSON.stringify({ summary: "packet summary" });

const selection: ModelSelection = {
  instanceId: INSTANCE,
  model: MODEL,
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "fast" },
  ],
};

const baseSnapshot: ServerProvider = {
  instanceId: INSTANCE,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT" },
  version: "0.166.0",
  checkedAt: "1970-01-01T00:00:00Z",
  models: [
    {
      slug: MODEL,
      name: "GPT-6",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
          {
            id: "serviceTier",
            label: "Service Tier",
            type: "select",
            options: [
              { id: "default", label: "Standard" },
              { id: "fast", label: "Fast" },
            ],
          },
        ],
      },
    },
    { slug: "my-custom", name: "Custom", isCustom: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

type Entry = CodexReplay.CodexAppServerReplayEntry;
const expectOut = (frame: unknown): Entry => ({ type: "expect_outbound", frame });
const emit = (frame: unknown): Entry => ({ type: "emit_inbound", frame });
const notify = (method: string, params: unknown) => emit({ method, params });

const configRead = (mcp: ReadonlyArray<string>) => ({
  config: { mcp_servers: Object.fromEntries(mcp.map((name) => [name, { command: "probe" }])) },
  origins: {},
});

const threadStartResult = (model: string, ephemeral: boolean) => ({
  thread: {
    id: THREAD,
    sessionId: THREAD,
    projectId: null,
    preview: "",
    ephemeral,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    cwd: "/sealed",
    cliVersion: "0.166.0",
    source: "vscode",
    turns: [],
  },
  model,
  modelProvider: "openai",
  cwd: "/sealed",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "readOnly" },
});

const turn = (status: string, error: unknown = null) => ({
  id: TURN,
  items: [],
  itemsView: "notLoaded",
  status,
  error,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: null,
});

const SEAL_KEYS = {
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.view_image": false,
  "features.goals": false,
  "features.sleep_tool": false,
  "features.skill_search": false,
  "features.default_mode_request_user_input": false,
  "features.apps": false,
  "features.plugins": false,
  "features.image_generation": false,
  "features.hooks": false,
  "agents.enabled": false,
  "tools.update_plan.enabled": false,
  "tools.view_image": false,
  "tools.experimental_request_user_input.enabled": false,
  web_search: "disabled",
  notify: [],
  project_doc_max_bytes: 0,
  "skills.include_instructions": false,
  include_environment_context: false,
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
};

/** Wire frames up to the turn/start response; replay ignores thread cwd, model and MCP keys. */
const preamble = (
  cwd: string,
  options: {
    readonly mcp?: ReadonlyArray<string>;
    readonly mcpAfter?: ReadonlyArray<string>;
    readonly model?: string;
    readonly ephemeral?: boolean;
  } = {},
): ReadonlyArray<Entry> => {
  const mcp = options.mcp ?? [];
  const mismatched = options.model !== undefined || options.ephemeral === false;
  const changed = options.mcpAfter !== undefined;
  return [
    expectOut({ id: 1, method: "config/read", params: { cwd, includeLayers: false } }),
    emit({ id: 1, result: configRead(mcp) }),
    expectOut({
      id: 2,
      method: "thread/start",
      params: {
        serviceTier: "fast",
        allowProviderModelFallback: false,
        experimentalRawEvents: true,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        baseInstructions: POLICY,
        developerInstructions: SEALED_DEVELOPER_INSTRUCTIONS,
        config: SEAL_KEYS,
      },
    }),
    emit({
      id: 2,
      result: threadStartResult(options.model ?? MODEL, options.ephemeral ?? true),
    }),
    ...(mismatched
      ? []
      : [
          expectOut({ id: 3, method: "config/read", params: { cwd, includeLayers: false } }),
          emit({ id: 3, result: configRead(options.mcpAfter ?? mcp) }),
        ]),
    ...(mismatched || changed
      ? []
      : [
          expectOut({
            id: 4,
            method: "turn/start",
            params: {
              threadId: THREAD,
              input: [{ type: "text", text: PACKET, text_elements: [] }],
              sandboxPolicy: { type: "readOnly", networkAccess: false },
              approvalPolicy: "on-request",
              effort: "high",
              outputSchema: toJsonSchemaObject(Proposal),
            },
          }),
          emit({ id: 4, result: { turn: turn("inProgress") } }),
        ]),
  ];
};

const raw = (item: unknown) =>
  notify("rawResponseItem/completed", { threadId: THREAD, turnId: TURN, item });
const codeModeTools = (namespaces: ReadonlyArray<unknown>) => ({
  type: "additional_tools",
  id: "at_1",
  role: "developer",
  tools: namespaces,
});
const EXEC = { type: "custom", name: "exec", description: "Run JavaScript" };
const WAIT = { type: "function", name: "wait", description: "Wait on exec", parameters: {} };
const functionsNamespace = (tools: ReadonlyArray<unknown>) => ({
  type: "namespace",
  name: "functions",
  description: "",
  tools,
});
/** What Codex declares on every turn of a code-mode-only catalog model. */
const CODE_MODE_TOOLS = codeModeTools([functionsNamespace([EXEC, WAIT])]);
const assistant = (text: string) =>
  raw({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const completed = (status = "completed", error: unknown = null) =>
  notify("turn/completed", { threadId: THREAD, turn: turn(status, error) });
const interrupt: ReadonlyArray<Entry> = [
  expectOut({ id: 5, method: "turn/interrupt", params: { threadId: THREAD, turnId: TURN } }),
  emit({ id: 5, result: {} }),
];

const harness = Effect.fn("harness")(function* (
  transcript: (cwd: string) => ReadonlyArray<Entry>,
  options: {
    readonly snapshot?: ServerProvider;
    readonly deadline?: Duration.Duration;
    readonly onAwaitingTurn?: Deferred.Deferred<void>;
  } = {},
) {
  const opens = yield* Ref.make(0);
  const closed = yield* Ref.make(false);
  const requests = yield* Ref.make<ReadonlyArray<readonly [string, unknown]>>([]);
  const driver = yield* Deferred.make<CodexReplay.CodexAppServerReplayDriver>();
  const storeHomePath = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  const storePermit = yield* codexStoreStartPermit(storeHomePath);
  const storePermitHeldWhileOpening = yield* Ref.make(false);
  const generation = yield* makeCodexSealedGeneration({
    getSnapshot: Effect.succeed(options.snapshot ?? baseSnapshot),
    storeHomePath,
    ...(options.deadline ? { deadline: options.deadline } : {}),
    openClient: (cwd) =>
      Effect.gen(function* () {
        yield* Ref.update(opens, (count) => count + 1);
        const free = yield* storePermit.takeIfAvailable(1);
        if (free) yield* storePermit.release(1);
        yield* Ref.set(storePermitHeldWhileOpening, !free);
        yield* Effect.addFinalizer(() => Ref.set(closed, true));
        const replay = yield* CodexReplay.makeReplayDriver({
          provider: "codex",
          protocol: "codex.app-server",
          version: "test",
          scenario: "sealed-generation",
          entries: transcript(cwd),
        });
        yield* Deferred.succeed(driver, replay);
        const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(replay)).pipe(
          Effect.orDie,
        );
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(context),
        );
        return {
          ...client,
          request: (method, params) =>
            Ref.update(requests, (all) => [...all, [method, params] as const]).pipe(
              Effect.andThen(client.request(method, params)),
            ),
          // The generator watches for process exit only once the turn is running.
          awaitTermination: options.onAwaitingTurn
            ? Deferred.succeed(options.onAwaitingTurn, undefined).pipe(
                Effect.andThen(client.awaitTermination),
              )
            : client.awaitTermination,
        } satisfies CodexClient.CodexAppServerClient["Service"];
      }),
  });
  const replayState = Deferred.await(driver).pipe(
    Effect.flatMap((replay) => Ref.get(replay.state)),
  );
  return {
    generation,
    opens,
    closed,
    requests,
    replayState,
    storePermit,
    storePermitHeldWhileOpening,
  };
});

const generateInput = { selection, instructions: POLICY, packet: PACKET, schema: Proposal };

it.layer(NodeServices.layer)("CodexSealedGeneration", (it) => {
  it.effect("returns the decoded answer and the model Codex reported", () =>
    Effect.gen(function* () {
      const { generation, replayState, closed } = yield* harness((cwd) => [
        ...preamble(cwd),
        raw({ type: "reasoning", summary: [] }),
        raw({ type: "message", role: "developer", content: [{ type: "input_text", text: "x" }] }),
        raw({ type: "message", role: "user", content: [{ type: "input_text", text: PACKET }] }),
        raw({ type: "configuration_update", reasoning: { effort: "high" } }),
        raw(CODE_MODE_TOOLS),
        assistant(CLEAN_ANSWER),
        completed(),
      ]);
      const result = yield* generation.generate(generateInput);
      assert.deepEqual(result, { value: { summary: "packet summary" }, model: MODEL });
      assert.isNull((yield* replayState).failure);
      assert.isTrue(yield* Ref.get(closed));
    }),
  );

  it.effect("sends the sealed thread and a turn holding only the packet", () =>
    Effect.gen(function* () {
      const { generation, requests, replayState } = yield* harness((cwd) => [
        ...preamble(cwd, { mcp: ["github", "dotted.name"] }),
        assistant(CLEAN_ANSWER),
        completed(),
      ]);
      yield* generation.generate(generateInput);
      assert.isNull((yield* replayState).failure);
      const sent = new Map(yield* Ref.get(requests));
      const threadStart = sent.get("thread/start") as Record<string, unknown>;
      assert.equal(threadStart.model, MODEL);
      assert.equal(threadStart.cwd, (sent.get("config/read") as { cwd: string }).cwd);
      assert.deepEqual(threadStart.config, {
        ...SEAL_KEYS,
        mcp_servers: { "dotted.name": { enabled: false }, github: { enabled: false } },
      });
      const turnStart = sent.get("turn/start") as Record<string, unknown>;
      assert.deepEqual(turnStart.input, [{ type: "text", text: PACKET, text_elements: [] }]);
    }),
  );

  const discardRows: ReadonlyArray<{
    readonly label: string;
    readonly item: unknown;
    readonly afterCodeModeTools?: true;
  }> = [
    {
      label: "function_call",
      item: { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c" },
    },
    {
      label: "an exec call after the code-mode declaration",
      item: { type: "custom_tool_call", name: "exec", input: "text('x')", call_id: "c" },
      afterCodeModeTools: true,
    },
    {
      label: "a wait call after the code-mode declaration",
      item: { type: "function_call", name: "wait", arguments: "{}", call_id: "c" },
      afterCodeModeTools: true,
    },
    {
      label: "mcp function_call",
      item: {
        type: "function_call",
        name: "read",
        namespace: "mcp__fs",
        arguments: "{}",
        call_id: "c",
      },
    },
    {
      label: "custom_tool_call",
      item: { type: "custom_tool_call", name: "apply_patch", input: "x", call_id: "c" },
    },
    {
      label: "local_shell_call",
      item: {
        type: "local_shell_call",
        status: "completed",
        action: { type: "exec", command: ["ls"] },
      },
    },
    { label: "web_search_call", item: { type: "web_search_call", status: "completed" } },
    {
      label: "function_call_output",
      item: { type: "function_call_output", call_id: "c", output: "denied" },
    },
    { label: "an undecodable item", item: { type: "computer_call", call_id: "c" } },
    {
      label: "a code-mode declaration with another function",
      item: codeModeTools([
        functionsNamespace([EXEC, WAIT, { type: "function", name: "exec_command" }]),
      ]),
    },
    {
      label: "a code-mode declaration with another namespace",
      item: codeModeTools([
        functionsNamespace([EXEC, WAIT]),
        { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn" }] },
      ]),
    },
    {
      label: "a code-mode declaration whose exec is a plain function",
      item: codeModeTools([functionsNamespace([{ ...EXEC, type: "function" }, WAIT])]),
    },
    { label: "a declaration of exec alone", item: codeModeTools([functionsNamespace([EXEC])]) },
  ];
  it.effect.each(discardRows)(
    "discards $label next to a valid answer and interrupts the turn",
    ({ item, afterCodeModeTools }) =>
      Effect.gen(function* () {
        const { generation, replayState, closed } = yield* harness((cwd) => [
          ...preamble(cwd),
          ...(afterCodeModeTools ? [raw(CODE_MODE_TOOLS)] : []),
          raw(item),
          assistant(CLEAN_ANSWER),
          ...interrupt,
        ]);
        const error = yield* generation.generate(generateInput).pipe(Effect.flip);
        assert.deepInclude(error, { _tag: "SealedGenerationDiscarded", reason: "tool_attempt" });
        assert.isNull((yield* replayState).failure);
        assert.isTrue(yield* Ref.get(closed));
      }),
  );

  it.effect.each([
    {
      label: "tool call",
      item: { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c" },
    },
    ...["tool", "function", "unknown"].map((role) => ({
      label: `${role} message`,
      item: { type: "message", role, content: [{ type: "output_text", text: "tool result" }] },
    })),
  ])("keeps the $label rejection even when the turn completes with a valid answer", ({ item }) =>
    Effect.gen(function* () {
      const { generation, replayState } = yield* harness((cwd) => [
        ...preamble(cwd),
        raw(item),
        assistant(CLEAN_ANSWER),
        completed(),
        // Sent only when the rejection is handled before turn/completed is dispatched.
        ...interrupt,
      ]);
      const error = yield* generation.generate(generateInput).pipe(Effect.flip);
      assert.deepInclude(error, { reason: "tool_attempt" });
      assert.isNull((yield* replayState).failure);
    }),
  );

  it.effect.each([
    {
      label: "user input",
      method: "item/tool/requestUserInput",
      params: { isBlocking: true, itemId: "i", threadId: THREAD, turnId: TURN, questions: [] },
    },
    {
      label: "approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD, turnId: TURN },
    },
    {
      label: "nested exec patch approval",
      method: "item/fileChange/requestApproval",
      params: { threadId: THREAD, turnId: TURN, itemId: "i" },
    },
  ])("leaves the $label request unanswered and interrupts the turn", ({ method, params }) =>
    Effect.gen(function* () {
      const { generation, replayState } = yield* harness((cwd) => [
        ...preamble(cwd),
        emit({ id: "srv-1", method, params }),
        ...interrupt,
      ]);
      const error = yield* generation.generate(generateInput).pipe(Effect.flip);
      assert.deepInclude(error, { reason: "server_request" });
      const state = yield* replayState;
      assert.isNull(state.failure);
      assert.equal(state.cursor, preamble("").length + 1 + interrupt.length);
    }),
  );

  it.effect.each([
    { label: "another model", options: { model: "gpt-other" }, reason: "model_mismatch" },
    { label: "a persistent thread", options: { ephemeral: false }, reason: "model_mismatch" },
    {
      label: "a changed MCP set",
      options: { mcp: ["a"], mcpAfter: ["a", "b"] },
      reason: "config_changed",
    },
  ] as const)("discards $label before any turn starts", ({ options, reason }) =>
    Effect.gen(function* () {
      const { generation, requests, replayState } = yield* harness((cwd) => preamble(cwd, options));
      const error = yield* generation.generate(generateInput).pipe(Effect.flip);
      assert.deepInclude(error, { reason });
      assert.isNull((yield* replayState).failure);
      assert.notInclude(
        (yield* Ref.get(requests)).map(([method]) => method),
        "turn/start",
      );
    }),
  );

  it.effect.each([
    {
      label: "a failed turn",
      tail: [completed("failed", { message: "boom" })],
      reason: "turn_failed",
    },
    {
      label: "a usage-limited turn",
      tail: [completed("failed", { message: "limit", codexErrorInfo: "usageLimitExceeded" })],
      reason: "usage_limited",
    },
    { label: "an interrupted turn", tail: [completed("interrupted")], reason: "cancelled" },
    {
      label: "invalid JSON",
      tail: [assistant("{not json"), completed()],
      reason: "invalid_output",
    },
    {
      label: "a schema mismatch",
      tail: [assistant(JSON.stringify({ other: 1 })), completed()],
      reason: "invalid_output",
    },
    { label: "a turn with no answer", tail: [completed()], reason: "invalid_output" },
    {
      label: "an answer only in an injected user message",
      tail: [
        raw({
          type: "message",
          role: "user",
          content: [{ type: "output_text", text: CLEAN_ANSWER }],
        }),
        completed(),
      ],
      reason: "invalid_output",
    },
    {
      label: "an oversized answer",
      tail: [assistant(JSON.stringify({ summary: "x".repeat(64 * 1024) })), completed()],
      reason: "output_too_large",
    },
  ] as const)("discards $label", ({ tail, reason }) =>
    Effect.gen(function* () {
      const { generation, replayState } = yield* harness((cwd) => [...preamble(cwd), ...tail]);
      const error = yield* generation.generate(generateInput).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "SealedGenerationDiscarded", reason });
      assert.isNull((yield* replayState).failure);
    }),
  );

  const managedSnapshot: ServerProvider = {
    ...baseSnapshot,
    auth: { status: "authenticated", type: "chatgpt", subscriptionSharing: true },
    models: baseSnapshot.models.map((model) => ({
      ...model,
      capabilities: model.capabilities && {
        optionDescriptors: (model.capabilities.optionDescriptors ?? []).filter(
          (option) => option.id !== "serviceTier",
        ),
      },
    })),
  };
  const withoutServiceTier: ModelSelection = {
    ...selection,
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const admissionRows: ReadonlyArray<{
    readonly label: string;
    readonly snapshot: ServerProvider;
    readonly chosen: ModelSelection;
    readonly expected: SealedRefusalReason | null;
  }> = [
    { label: "native ChatGPT login", snapshot: baseSnapshot, chosen: selection, expected: null },
    {
      label: "native API key",
      snapshot: { ...baseSnapshot, auth: { status: "authenticated", type: "apiKey" } },
      chosen: selection,
      expected: null,
    },
    {
      label: "managed ChatGPT",
      snapshot: managedSnapshot,
      chosen: withoutServiceTier,
      expected: null,
    },
    {
      label: "a disabled instance",
      snapshot: { ...baseSnapshot, enabled: false },
      chosen: selection,
      expected: "instance_unavailable",
    },
    {
      label: "a missing Codex install",
      snapshot: { ...baseSnapshot, installed: false },
      chosen: selection,
      expected: "instance_unavailable",
    },
    {
      label: "another instance",
      snapshot: baseSnapshot,
      chosen: { ...selection, instanceId: ProviderInstanceId.make("codex-work") },
      expected: "instance_unavailable",
    },
    {
      label: "a signed-out account",
      snapshot: { ...baseSnapshot, auth: { status: "unauthenticated" } },
      chosen: selection,
      expected: "provider_signed_out",
    },
    {
      label: "an unknown sign-in",
      snapshot: { ...baseSnapshot, auth: { status: "unknown" } },
      chosen: selection,
      expected: "provider_signed_out",
    },
    {
      label: "an older Codex",
      snapshot: { ...baseSnapshot, version: "0.165.9" },
      chosen: selection,
      expected: "codex_version_unsupported",
    },
    {
      label: "an unknown Codex version",
      snapshot: { ...baseSnapshot, version: null },
      chosen: selection,
      expected: "codex_version_unsupported",
    },
    {
      label: "a Codex version that is not semver",
      snapshot: { ...baseSnapshot, version: "dev" },
      chosen: selection,
      expected: "codex_version_unsupported",
    },
    {
      label: "an unlisted model",
      snapshot: baseSnapshot,
      chosen: { ...selection, model: "gpt-other" },
      expected: "selected_model_unavailable",
    },
    {
      label: "a custom model",
      snapshot: baseSnapshot,
      chosen: { ...selection, model: "my-custom", options: [] },
      expected: "selected_model_unavailable",
    },
    {
      label: "an option without a sealed mapping",
      snapshot: baseSnapshot,
      chosen: { ...selection, options: [{ id: "fastMode", value: true }] },
      expected: "option_unsupported",
    },
    {
      label: "an effort the model does not offer",
      snapshot: baseSnapshot,
      chosen: { ...selection, options: [{ id: "reasoningEffort", value: "xhigh" }] },
      expected: "option_unsupported",
    },
    {
      label: "a stale service tier on managed ChatGPT",
      snapshot: managedSnapshot,
      chosen: selection,
      expected: "option_unsupported",
    },
  ];
  it.effect.each(admissionRows)(
    "admission for $label is $expected (null: supported)",
    ({ snapshot, chosen, expected }) =>
      Effect.gen(function* () {
        const { generation, opens } = yield* harness(() => [], { snapshot });
        assert.equal(yield* generation.availability(chosen), expected);
        if (expected === null) return;
        const error = yield* generation
          .generate({ ...generateInput, selection: chosen })
          .pipe(Effect.flip);
        assert.deepInclude(error, { _tag: "SealedGenerationRefused", reason: expected });
        assert.equal(yield* Ref.get(opens), 0);
      }),
  );

  it.effect("interrupts the turn and closes the process at the deadline", () =>
    Effect.gen(function* () {
      const awaitingTurn = yield* Deferred.make<void>();
      const { generation, replayState, closed } = yield* harness(
        (cwd) => [...preamble(cwd), ...interrupt],
        { deadline: Duration.minutes(1), onAwaitingTurn: awaitingTurn },
      );
      const fiber = yield* generation.generate(generateInput).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(awaitingTurn);
      yield* TestClock.adjust(Duration.minutes(1));
      assert.deepInclude(yield* Fiber.join(fiber), { reason: "timeout" });
      const state = yield* replayState;
      assert.isNull(state.failure);
      assert.equal(state.cursor, preamble("").length + interrupt.length);
      assert.isTrue(yield* Ref.get(closed));
    }),
  );

  it.effect("holds the shared store start permit only while the process starts", () =>
    Effect.gen(function* () {
      const awaitingTurn = yield* Deferred.make<void>();
      const { generation, storePermit, storePermitHeldWhileOpening } = yield* harness(
        (cwd) => [...preamble(cwd), ...interrupt],
        { onAwaitingTurn: awaitingTurn },
      );
      const fiber = yield* generation.generate(generateInput).pipe(Effect.forkChild);
      yield* Deferred.await(awaitingTurn);
      assert.isTrue(yield* Ref.get(storePermitHeldWhileOpening));
      assert.isTrue(yield* storePermit.takeIfAvailable(1));
      yield* storePermit.release(1);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("interrupts the turn and closes the process when the caller stops", () =>
    Effect.gen(function* () {
      const awaitingTurn = yield* Deferred.make<void>();
      const { generation, replayState, closed } = yield* harness(
        (cwd) => [...preamble(cwd), ...interrupt],
        { onAwaitingTurn: awaitingTurn },
      );
      const fiber = yield* generation.generate(generateInput).pipe(Effect.forkChild);
      yield* Deferred.await(awaitingTurn);
      yield* Fiber.interrupt(fiber);
      const state = yield* replayState;
      assert.isNull(state.failure);
      assert.equal(state.cursor, preamble("").length + interrupt.length);
      assert.isTrue(yield* Ref.get(closed));
    }),
  );
});
