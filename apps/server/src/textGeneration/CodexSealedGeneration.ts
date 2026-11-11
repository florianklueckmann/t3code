import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  SealedGenerationDiscarded,
  SealedGenerationRefused,
  type SealedDiscardReason,
  type SealedGeneration,
  type SealedGenerationFailure,
  type SealedGenerationInput,
  type SealedRefusalReason,
} from "@t3tools/provider-core/server/sealedGeneration";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { codexDefaultReasoningEffortOverride } from "../provider/CodexProvider.ts";
import { codexStoreStartPermit } from "../provider/Drivers/CodexHomeLayout.ts";

// Not `CodexTextGeneration`: `codex exec` can substitute models, keeps MCP servers when listing
// them fails, and cannot show denied tool attempts. Raw response events show every model item,
// so anything but reasoning, Codex's settings item or a message in a known role discards the turn.

/** The oldest Codex version whose app-server was proven to accept raw events and this seal. */
const SEALED_GENERATION_MIN_CODEX_VERSION = "0.166.0";
// Starting limits to tune, not measurements.
const DEFAULT_DEADLINE = Duration.minutes(10);
const MAX_OUTPUT_BYTES = 64 * 1024;
const INTERRUPT_GRACE = Duration.seconds(5);

export const SEALED_DEVELOPER_INSTRUCTIONS =
  "Answer only with one JSON object that matches the output schema. Do not call tools.";

// Some keys match current Codex defaults; they stay so a flipped default cannot widen the turn.
const SEAL_CONFIG = {
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
  // Hooks and notify run the user's programs outside the sandbox.
  "features.hooks": false,
  // Code-mode catalogs offer the `collaboration` sub-agent tools while this is on.
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
} as const;

/** Exactly `functions{exec, wait}`: the tools Codex cannot switch off for code-mode models. */
const isCodeModeDeclaration = Schema.is(
  Schema.Struct({
    item: Schema.Struct({
      type: Schema.Literal("additional_tools"),
      tools: Schema.Tuple([
        Schema.Struct({
          type: Schema.Literal("namespace"),
          name: Schema.Literal("functions"),
          tools: Schema.Tuple([
            Schema.Struct({ type: Schema.Literal("custom"), name: Schema.Literal("exec") }),
            Schema.Struct({ type: Schema.Literal("function"), name: Schema.Literal("wait") }),
          ]),
        }),
      ]),
    }),
  }),
);

/** Codex 0.166.0 echoes its injected context as developer and user messages; the model answers. */
const MESSAGE_ROLES = new Set(["developer", "user", "assistant"]);

/** Codex options with a verified sealed mapping; any other selected option refuses. */
const MAPPED_OPTIONS = new Set(["reasoningEffort", "serviceTier"]);

interface SealedPlan {
  readonly model: string;
  readonly effort: string | undefined;
  readonly serviceTier: string | undefined;
}

type AdmissionResult =
  | { readonly _tag: "Refused"; readonly reason: SealedRefusalReason }
  | { readonly _tag: "Admitted"; readonly plan: SealedPlan };

const refused = (reason: SealedRefusalReason): AdmissionResult => ({ _tag: "Refused", reason });

function admitSealedGeneration(
  snapshot: ServerProvider,
  selection: ModelSelection,
): AdmissionResult {
  if (
    !snapshot.enabled ||
    !snapshot.installed ||
    snapshot.availability === "unavailable" ||
    snapshot.instanceId !== selection.instanceId
  )
    return refused("instance_unavailable");
  if (snapshot.auth.status !== "authenticated") return refused("provider_signed_out");
  if (
    snapshot.version === null ||
    parseSemver(snapshot.version) === null ||
    compareSemverVersions(snapshot.version, SEALED_GENERATION_MIN_CODEX_VERSION) < 0
  )
    return refused("codex_version_unsupported");
  const model = snapshot.models.find(
    (candidate) => !candidate.isCustom && candidate.slug === selection.model,
  );
  if (!model) return refused("selected_model_unavailable");
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const values = new Map<string, string>();
  for (const option of selection.options ?? []) {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (
      !MAPPED_OPTIONS.has(option.id) ||
      descriptor?.type !== "select" ||
      typeof option.value !== "string" ||
      !descriptor.options.some((choice) => choice.id === option.value)
    )
      return refused("option_unsupported");
    values.set(option.id, option.value);
  }
  return {
    _tag: "Admitted",
    plan: {
      model: model.slug,
      effort: values.get("reasoningEffort") ?? codexDefaultReasoningEffortOverride(model.slug),
      serviceTier: values.get("serviceTier"),
    },
  };
}

const discarded = (reason: SealedDiscardReason) => new SealedGenerationDiscarded({ reason });

const clientFailureReason = (error: CodexError.CodexAppServerError): SealedDiscardReason =>
  error._tag === "CodexAppServerRequestError" ? "turn_failed" : "process_exit";

const mcpServerNames = (response: CodexSchema.V2ConfigReadResponse): ReadonlyArray<string> => {
  const servers = response.config.mcp_servers;
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? Object.keys(servers).toSorted()
    : [];
};

const assistantText = (
  item: CodexSchema.V2RawResponseItemCompletedNotification["item"],
): string | null =>
  item.type === "message" && item.role === "assistant"
    ? item.content.flatMap((part) => (part.type === "output_text" ? [part.text] : [])).join("")
    : null;

type TurnCompleted = CodexSchema.V2TurnCompletedNotification["turn"];

const turnFailureReason = (turn: TurnCompleted): SealedDiscardReason => {
  if (turn.status === "interrupted") return "cancelled";
  const info = turn.error?.codexErrorInfo;
  return info === "usageLimitExceeded" || info === "rateLimitExceeded"
    ? "usage_limited"
    : "turn_failed";
};

export interface CodexSealedGenerationOptions {
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /** The account's conversation store, whose start permit sessions on it share. */
  readonly storeHomePath: string;
  /** Starts and initializes an app-server for the instance in `cwd`, owned by the scope. */
  readonly openClient: (
    cwd: string,
  ) => Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    SealedGenerationFailure | CodexError.CodexAppServerError,
    Scope.Scope
  >;
  readonly deadline?: Duration.Duration;
}

export const makeCodexSealedGeneration = Effect.fn("makeCodexSealedGeneration")(function* (
  options: CodexSealedGenerationOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const availability: SealedGeneration["availability"] = (selection) =>
    options.getSnapshot.pipe(
      Effect.map((snapshot) => {
        const admission = admitSealedGeneration(snapshot, selection);
        return admission._tag === "Refused" ? admission.reason : null;
      }),
    );

  const runTurn = Effect.fn("CodexSealedGeneration.runTurn")(function* <S extends Schema.Top>(
    plan: SealedPlan,
    input: { readonly instructions: string; readonly packet: string; readonly schema: S },
  ) {
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3code-sealed-" })
      .pipe(Effect.mapError(() => discarded("process_exit")));
    const startPermit = yield* codexStoreStartPermit(options.storeHomePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => discarded("process_exit")),
    );
    const client = yield* startPermit.withPermit(options.openClient(cwd));

    // The first reason wins, and a later completion or valid-looking answer never clears it.
    const rejection = yield* Deferred.make<never, SealedGenerationDiscarded>();
    const reject = (reason: SealedDiscardReason) =>
      Deferred.fail(rejection, discarded(reason)).pipe(Effect.asVoid);
    const completed = yield* Deferred.make<TurnCompleted>();
    let answer: string | null = null;

    yield* client.handleServerNotification("rawResponseItem/completed", ({ item }) => {
      // `configuration_update` is Codex's injected reasoning setting, never model output.
      if (item.type === "reasoning" || item.type === "configuration_update") return Effect.void;
      if (item.type !== "message" || !MESSAGE_ROLES.has(item.role)) return reject("tool_attempt");
      answer = assistantText(item) ?? answer;
      return Effect.void;
    });
    // A raw item this client cannot decode lands here; an unknown shape counts as a tool attempt.
    // Code-mode catalog models always declare `exec` and `wait`; any call to them still discards.
    yield* client.handleUnknownServerNotification((method, params) =>
      method !== "rawResponseItem/completed" || isCodeModeDeclaration(params)
        ? Effect.void
        : reject("tool_attempt"),
    );
    // Never answered: the rejection interrupts the turn and closes the process instead.
    yield* client.handleUnknownServerRequest(() =>
      reject("server_request").pipe(Effect.andThen(Effect.never)),
    );
    yield* client.handleServerNotification("turn/completed", ({ turn }) =>
      Deferred.succeed(completed, turn).pipe(Effect.asVoid),
    );

    const readMcpServerNames = client
      .request("config/read", { cwd, includeLayers: false })
      .pipe(Effect.map(mcpServerNames));
    const mcpNames = yield* readMcpServerNames;
    const threadStart: typeof CodexClient.V2ThreadStartParamsWithExperimental.Type = {
      cwd,
      model: plan.model,
      ...(plan.serviceTier === undefined ? {} : { serviceTier: plan.serviceTier }),
      allowProviderModelFallback: false,
      experimentalRawEvents: true,
      ephemeral: true,
      sandbox: "read-only",
      // Code-mode `exec` runs under every policy; `on-request` makes its nested patch ask, which
      // discards. The pinned reviewer keeps a user's `auto_review` from answering that request.
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      baseInstructions: input.instructions,
      developerInstructions: SEALED_DEVELOPER_INSTRUCTIONS,
      config: {
        ...SEAL_CONFIG,
        ...(mcpNames.length === 0
          ? {}
          : {
              mcp_servers: Object.fromEntries(mcpNames.map((name) => [name, { enabled: false }])),
            }),
      },
    };
    const thread = yield* client.request("thread/start", threadStart);
    if (thread.model !== plan.model || !thread.thread.ephemeral)
      return yield* discarded("model_mismatch");
    if ((yield* readMcpServerNames).join("\n") !== mcpNames.join("\n"))
      return yield* discarded("config_changed");

    const interruptUnlessCompleted = (turnId: string) =>
      Deferred.isDone(completed).pipe(
        Effect.flatMap((done) =>
          done
            ? Effect.void
            : client
                .request("turn/interrupt", { threadId: thread.thread.id, turnId })
                .pipe(Effect.timeout(INTERRUPT_GRACE), Effect.ignore),
        ),
      );
    // Register the interrupt before a deadline or caller interruption can land.
    yield* Effect.uninterruptibleMask((restore) =>
      restore(
        client.request("turn/start", {
          threadId: thread.thread.id,
          input: [{ type: "text", text: input.packet, text_elements: [] }],
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          approvalPolicy: "on-request",
          ...(plan.effort === undefined ? {} : { effort: plan.effort }),
          outputSchema: toJsonSchemaObject(input.schema) as Schema.Json,
        }),
      ).pipe(
        Effect.tap(({ turn }) => Effect.addFinalizer(() => interruptUnlessCompleted(turn.id))),
      ),
    );

    const finished = yield* Effect.raceFirst(
      Deferred.await(completed),
      Effect.raceFirst(Deferred.await(rejection), client.awaitTermination),
    );
    // Notifications dispatch in order, so a rejection before turn/completed is already recorded.
    if (yield* Deferred.isDone(rejection)) return yield* Deferred.await(rejection);
    if (finished.status !== "completed") return yield* discarded(turnFailureReason(finished));
    if (answer === null) return yield* discarded("invalid_output");
    if (new TextEncoder().encode(answer).byteLength > MAX_OUTPUT_BYTES)
      return yield* discarded("output_too_large");
    const decodeAnswer = Schema.decodeEffect(Schema.fromJsonString(input.schema));
    const value = yield* decodeAnswer(answer).pipe(
      Effect.mapError(() => discarded("invalid_output")),
    );
    return { value, model: thread.model };
  });

  const generate = Effect.fn("CodexSealedGeneration.generate")(function* <S extends Schema.Top>(
    input: SealedGenerationInput<S>,
  ) {
    const admission = admitSealedGeneration(yield* options.getSnapshot, input.selection);
    if (admission._tag === "Refused")
      return yield* new SealedGenerationRefused({ reason: admission.reason });
    return yield* runTurn(admission.plan, input).pipe(
      Effect.catchIf(Schema.is(CodexError.CodexAppServerError), (error) =>
        Effect.fail(discarded(clientFailureReason(error))),
      ),
      Effect.scoped,
      Effect.timeoutOption(options.deadline ?? DEFAULT_DEADLINE),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(discarded("timeout")),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

  return { availability, generate } satisfies SealedGeneration;
});
