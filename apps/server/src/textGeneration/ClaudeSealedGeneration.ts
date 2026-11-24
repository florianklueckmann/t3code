import {
  query as claudeQuery,
  type HookCallback,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings, ModelSelection, ServerProvider } from "@t3tools/contracts";
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
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import { claudeSettingsRouteModels } from "../provider/ClaudeCodeModelRoutes.ts";
import {
  type ClaudeModelCatalog,
  resolveClaudeModelSlug,
  resolveClaudeReportedModelSlug,
} from "../provider/ClaudeModelCatalog.ts";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";
import { hasClaudeManagedMcpConfig } from "../provider/Drivers/ClaudeHome.ts";
import { readClaudeLaunchArgSettings } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

// Not `ClaudeTextGeneration`: `claude -p --output-format json` reports only the result, so a
// model swap, a tool call or a loaded MCP server would go unseen. The SDK stream shows the init
// frame and every assistant block, and anything outside the seal discards the call.

/** The oldest Claude Code whose sealed call was measured natively (macOS). */
const SEALED_GENERATION_MIN_CLAUDE_VERSION = "2.1.331";
// Starting limits to tune, not measurements; the same as the Codex seal.
const DEFAULT_DEADLINE = Duration.minutes(10);
const MAX_OUTPUT_BYTES = 64 * 1024;
// Claude Code re-prompts when the answer misses the schema; Haiku needs that in about a third of
// calls (measured), so one response only would fail them. Each response passes the same checks.
// Claude has no option that caps model requests, so a fourth is discarded when it arrives.
const MAX_MODEL_RESPONSES = 3;

/** Claude Code answers a JSON schema through this tool; it is the only one a sealed call has. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

export const SEALED_CLAUDE_INSTRUCTIONS =
  "Answer only by calling StructuredOutput once, with one JSON object that matches its schema. Call no other tool.";

/** Message blocks that are the model thinking or writing; any other block is a tool attempt. */
const PLAIN_BLOCKS = new Set(["text", "thinking", "redacted_thinking"]);

/** Claude Code's own stand-in for an assistant message when the API call failed. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * No filesystem settings load (`settingSources: []`), so hooks, plugins, permission rules and
 * instruction files of the user and of any project stay out. Organization-managed settings still
 * apply; Claude Code has no switch for them.
 */
const SEAL_SETTINGS = {
  disableAllHooks: true,
  disableSkillShellExecution: true,
  disableClaudeAiConnectors: true,
  syncClaudeAiPlugins: false,
  autoMemoryEnabled: false,
  env: { CLAUDE_CODE_PLUGIN_DIRS: "", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
} as const;

interface SealedPlan {
  /** The catalog slug of the selected model, which every reported model must resolve to. */
  readonly slug: string;
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly settings: Readonly<Record<string, boolean>>;
}

type AdmissionResult =
  | { readonly _tag: "Refused"; readonly reason: SealedRefusalReason }
  | { readonly _tag: "Admitted"; readonly plan: SealedPlan };

const refused = (reason: SealedRefusalReason): AdmissionResult => ({ _tag: "Refused", reason });

function admitSealedGeneration(input: {
  readonly snapshot: ServerProvider;
  readonly selection: ModelSelection;
  readonly catalog: ClaudeModelCatalog;
  readonly platform: NodeJS.Platform;
}): AdmissionResult {
  const { snapshot, selection, catalog } = input;
  if (
    !snapshot.enabled ||
    !snapshot.installed ||
    snapshot.availability === "unavailable" ||
    snapshot.instanceId !== selection.instanceId
  )
    return refused("instance_unavailable");
  if (snapshot.auth.status !== "authenticated") return refused("provider_signed_out");
  if (input.platform !== "darwin") return refused("platform_unsupported");
  if (
    snapshot.version === null ||
    parseSemver(snapshot.version) === null ||
    compareSemverVersions(snapshot.version, SEALED_GENERATION_MIN_CLAUDE_VERSION) < 0
  )
    return refused("claude_version_unsupported");
  const slug = resolveClaudeModelSlug(catalog, selection.model);
  const model = snapshot.models.find((candidate) => !candidate.isCustom && candidate.slug === slug);
  if (!model) return refused("selected_model_unavailable");
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  for (const option of selection.options ?? []) {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    const valid =
      descriptor?.type === "select"
        ? descriptor.options.some((choice) => choice.id === option.value)
        : descriptor?.type === "boolean" && typeof option.value === "boolean";
    if (!valid) return refused("option_unsupported");
  }
  const compiled = compileClaudeModelSelection(selection, catalog);
  // Ultracode runs subagents, and a prompt-injected effort would rewrite the packet.
  if (compiled.settings.ultracode === true || compiled.promptEffort !== undefined)
    return refused("option_unsupported");
  return {
    _tag: "Admitted",
    plan: {
      slug,
      apiModelId: compiled.apiModelId,
      effort: compiled.effort,
      settings: compiled.settings,
    },
  };
}

const discarded = (reason: SealedDiscardReason) => new SealedGenerationDiscarded({ reason });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Verdict =
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Failed"; readonly error: SealedGenerationFailure }
  | { readonly _tag: "Answered"; readonly output: unknown; readonly model: string };

const CONTINUE: Verdict = { _tag: "Continue" };
const failed = (reason: SealedDiscardReason): Verdict => ({
  _tag: "Failed",
  error: discarded(reason),
});

/**
 * Reads one sealed call's stream. The first failure wins: the caller stops reading at it, so a
 * later result or valid-looking answer never clears it.
 */
function makeSealedStreamReader(plan: SealedPlan, catalog: ClaudeModelCatalog) {
  const isSelectedModel = (reported: string) =>
    resolveClaudeReportedModelSlug(catalog, reported.replace(/\[[^\]]*\]$/, "").trim()) ===
    plan.slug;
  let sealVerified = false;
  const responseIds = new Set<string>();
  let answeredBy: string | null = null;
  let blockedToolCall = false;

  const guard: HookCallback = (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name === STRUCTURED_OUTPUT_TOOL)
      return Promise.resolve({});
    blockedToolCall = true;
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "This call has no tools.",
      },
    });
  };

  const read = (message: SDKMessage): Verdict => {
    if (message.type === "system") {
      if (message.subtype === "model_refusal_fallback") return failed("model_mismatch");
      if (message.subtype !== "init") return CONTINUE;
      if (
        message.tools.length !== 1 ||
        message.tools[0] !== STRUCTURED_OUTPUT_TOOL ||
        message.mcp_servers.length > 0
      )
        return failed("config_changed");
      if (!isSelectedModel(message.model)) return failed("model_mismatch");
      sealVerified = true;
      return CONTINUE;
    }
    if (message.type === "assistant") {
      if (!sealVerified) return failed("config_changed");
      if (message.parent_tool_use_id !== null) return failed("tool_attempt");
      if (message.error === "authentication_failed" || message.error === "oauth_org_not_allowed")
        return {
          _tag: "Failed",
          error: new SealedGenerationRefused({ reason: "provider_signed_out" }),
        };
      if (message.error === "rate_limit" || message.error === "billing_error")
        return failed("usage_limited");
      if (message.error !== undefined) return failed("turn_failed");
      // Claude Code writes these in the model's place; without an error they are unknown.
      if (message.message.model === SYNTHETIC_MODEL) return failed("turn_failed");
      if (!isSelectedModel(message.message.model)) return failed("model_mismatch");
      responseIds.add(message.message.id);
      if (responseIds.size > MAX_MODEL_RESPONSES) return failed("invalid_output");
      for (const block of message.message.content) {
        if (PLAIN_BLOCKS.has(block.type)) continue;
        if (block.type !== "tool_use" || block.name !== STRUCTURED_OUTPUT_TOOL)
          return failed("tool_attempt");
        answeredBy = message.message.model;
      }
      return CONTINUE;
    }
    if (message.type !== "result") return CONTINUE;
    if (blockedToolCall || message.permission_denials.length > 0) return failed("tool_attempt");
    if (message.subtype === "error_max_structured_output_retries") return failed("invalid_output");
    if (message.subtype !== "success" || message.is_error) return failed("turn_failed");
    if (answeredBy === null || message.structured_output === undefined)
      return failed("invalid_output");
    return { _tag: "Answered", output: message.structured_output, model: answeredBy };
  };

  return { guard, read };
}

const decodeSettingsFile = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export type ClaudeSealedQuery = (input: {
  readonly prompt: string;
  readonly options: ClaudeQueryOptions;
}) => AsyncIterable<SDKMessage>;

/** Starts Claude Code through the SDK. */
export const startClaudeSealedQuery: ClaudeSealedQuery = claudeQuery;

export interface ClaudeSealedGenerationOptions {
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly settings: ClaudeSettings;
  /** The instance's process environment, with its config directory. */
  readonly environment: NodeJS.ProcessEnv;
  /** Where the instance keeps its user settings. */
  readonly configDir: string;
  /** The model catalog as a call in `cwd` routes it; null reads it unrouted. */
  readonly modelCatalog: (cwd: string | null) => Effect.Effect<ClaudeModelCatalog>;
  readonly query?: ClaudeSealedQuery;
  readonly deadline?: Duration.Duration;
}

export const makeClaudeSealedGeneration = Effect.fn("makeClaudeSealedGeneration")(function* (
  options: ClaudeSealedGenerationOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const startQuery = options.query ?? startClaudeSealedQuery;

  const home = yield* HostProcess.HomeDirectory;
  const launchSettings = parseCliArgs(options.settings.launchArgs, {
    valueFlags: ["append-system-prompt"],
  }).flags.settings?.trim();
  const relativeLaunchSettings =
    typeof launchSettings === "string" &&
    !launchSettings.startsWith("{") &&
    !path.isAbsolute(expandHomePath(launchSettings, home));
  // As Claude gets it: padding would make it read another directory than admission does.
  const inheritedConfigDir = options.environment.CLAUDE_CONFIG_DIR ?? "";
  const relativeConfigDir =
    inheritedConfigDir.length > 0 &&
    (inheritedConfigDir !== inheritedConfigDir.trim() || !path.isAbsolute(inheritedConfigDir));

  const routesElsewhere = (settings: unknown) =>
    !isRecord(settings) ||
    settings.apiKeyHelper !== undefined ||
    claudeSettingsRouteModels(settings as ClaudeSdkSettings);

  /**
   * The call loads no settings and no launch argument, so user settings or `--settings` that
   * pick the backend, credential or model mapping would send it elsewhere than the Bot's turns;
   * unreadable ones refuse too. Managed MCP makes Claude Code refuse the strict MCP flag.
   * A project's own settings are not read: the call belongs to the instance.
   */
  const settingsRefusal = Effect.gen(function* () {
    if (yield* hasClaudeManagedMcpConfig()) return true;
    // Home turns resolve relative paths from their project, so no one file could be checked.
    if (relativeConfigDir || relativeLaunchSettings) return true;
    const launch = yield* readClaudeLaunchArgSettings({
      settings: options.settings,
      cwd: null,
      fileSystem,
      path,
    }).pipe(Effect.result);
    if (launch._tag === "Failure") return true;
    if (launch.success !== undefined && routesElsewhere(launch.success)) return true;
    const text = yield* fileSystem
      .readFileString(path.join(options.configDir, "settings.json"))
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
        Effect.result,
      );
    if (text._tag === "Failure") return true;
    if (text.success === undefined) return false;
    const settings = decodeSettingsFile(text.success);
    return Option.isNone(settings) || routesElsewhere(settings.value);
  }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

  const admit = Effect.fn("ClaudeSealedGeneration.admit")(function* (
    selection: ModelSelection,
    cwd: string | null,
  ) {
    const admission = admitSealedGeneration({
      snapshot: yield* options.getSnapshot,
      selection,
      catalog: yield* options.modelCatalog(cwd),
      platform,
    });
    if (admission._tag === "Refused") return admission;
    return (yield* settingsRefusal) ? refused("claude_settings_unsupported") : admission;
  });

  const availability: SealedGeneration["availability"] = (selection) =>
    admit(selection, null).pipe(
      Effect.map((admission) => (admission._tag === "Refused" ? admission.reason : null)),
    );

  const runTurn = Effect.fn("ClaudeSealedGeneration.runTurn")(function* <S extends Schema.Top>(
    input: SealedGenerationInput<S>,
  ) {
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3code-sealed-" })
      .pipe(Effect.mapError(() => discarded("process_exit")));
    const admission = yield* admit(input.selection, cwd);
    if (admission._tag === "Refused")
      return yield* new SealedGenerationRefused({ reason: admission.reason });
    const { plan } = admission;
    const reader = makeSealedStreamReader(plan, yield* options.modelCatalog(cwd));
    const executable = yield* resolveClaudeSdkExecutablePath(
      options.settings.binaryPath || "claude",
      options.environment,
    );
    const queryOptions: ClaudeQueryOptions = {
      cwd,
      env: options.environment,
      pathToClaudeCodeExecutable: executable,
      model: plan.apiModelId,
      ...(plan.effort === undefined
        ? {}
        : { effort: plan.effort as NonNullable<ClaudeQueryOptions["effort"]> }),
      systemPrompt: `${input.instructions}\n\n${SEALED_CLAUDE_INSTRUCTIONS}`,
      outputFormat: {
        type: "json_schema",
        schema: toJsonSchemaObject(input.schema) as Record<string, unknown>,
      },
      // Availability, not permission: no built-in tool exists for a rule or a skill to allow.
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      plugins: [],
      skills: [],
      persistSession: false,
      // The packet quotes Home messages: an `@path` in one must not attach that file.
      verbatimPrompts: true,
      permissionMode: "dontAsk",
      settings: { ...plan.settings, ...SEAL_SETTINGS } as ClaudeSdkSettings,
      // A failed or timed-out guard blocks the call.
      hooks: { PreToolUse: [{ hooks: [reader.guard], onFailure: "block" }] },
    };

    const verdict = yield* Effect.tryPromise({
      try: async (signal): Promise<Verdict> => {
        const abortController = new AbortController();
        const abort = () => abortController.abort();
        signal.addEventListener("abort", abort);
        try {
          const stream = startQuery({
            prompt: input.packet,
            options: { ...queryOptions, abortController },
          });
          for await (const message of stream) {
            const next = reader.read(message);
            if (next._tag !== "Continue") return next;
          }
          return failed("process_exit");
        } finally {
          // Ends Claude Code at the first failure, at the answer and on interruption alike.
          abort();
          signal.removeEventListener("abort", abort);
        }
      },
      catch: () => discarded("process_exit"),
    });
    if (verdict._tag !== "Answered")
      return yield* verdict._tag === "Failed" ? verdict.error : discarded("process_exit");
    const encoded = yield* encodeJson(verdict.output).pipe(
      Effect.mapError(() => discarded("invalid_output")),
    );
    if (new TextEncoder().encode(encoded).byteLength > MAX_OUTPUT_BYTES)
      return yield* discarded("output_too_large");
    const decodeOutput = Schema.decodeUnknownEffect(input.schema);
    const value = yield* decodeOutput(verdict.output).pipe(
      Effect.mapError(() => discarded("invalid_output")),
    );
    return { value, model: verdict.model };
  });

  const generate = Effect.fn("ClaudeSealedGeneration.generate")(function* <S extends Schema.Top>(
    input: SealedGenerationInput<S>,
  ) {
    return yield* runTurn(input).pipe(
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
