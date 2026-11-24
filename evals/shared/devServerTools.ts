/**
 * Talks to a running T3 Code dev server through its MCP tools, as `t3 thread` does. Shared by the
 * evals that run real Bot turns end to end.
 */
import {
  OrchestratorMcpProviderCapability,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
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

const WAIT_SLICE_MS = 15_000;

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
  structuredContent: Schema.optional(Schema.Unknown),
});

/** A sample that could not finish. It stays in the results and counts as a failure. */
export class SampleError extends Schema.TaggedError<SampleError>()("SampleError", {
  message: Schema.String,
}) {}

export type Call = <S extends Schema.Decoder<unknown, never>>(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  schema: S,
) => Effect.Effect<S["Type"], SampleError>;

/** A tool an agent called, as the thread's activity records it. */
export interface ToolActivity {
  readonly type: string;
  readonly title: string | null;
  readonly text: string | null;
}

/** Signs in as a short-lived MCP client of the dev server, as `t3 thread` does, and revokes it after. */
export const withTools = Effect.fn("evals.withTools")(function* <A, E, R>(
  baseDir: string,
  clientName: string,
  body: (call: Call) => Effect.Effect<A, E, R>,
) {
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
        label: `${clientName} eval`,
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      }),
      (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const session = yield* mcpToolSession({
      endpoint: new URL("/mcp", state.value.origin).href,
      authorization: `Bearer ${issued.token}`,
      clientName: `${clientName}-eval`,
    });
    const failed = (tool: string) => (cause: unknown) =>
      new SampleError({ message: `${tool}: ${String(cause)}` });
    const call: Call = Effect.fn("evals.call")(function* <S extends Schema.Decoder<unknown, never>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ) {
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
});

const Capabilities = Schema.Struct({ providers: Schema.Array(OrchestratorMcpProviderCapability) });

export interface BotModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

/** Codex names its effort option `reasoningEffort`, Claude `effort`, Pi `thinking`. */
const EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "thinking"];

/**
 * The Bot model a run creates its Bots with, from `--instance`, `--model` and `--effort`. No
 * fallback: what the server's catalog does not offer stops the run.
 */
export const requireBotModel = Effect.fn("evals.requireBotModel")(function* (
  call: Call,
  input: {
    readonly instance: string;
    readonly model: string;
    readonly effort: string;
  },
) {
  // The search keeps a model past the default short list in the answer.
  const { providers } = yield* call(
    "orchestrator_capabilities",
    { search: input.model },
    Capabilities,
  );
  const provider = providers.find((candidate) => candidate.providerInstanceId === input.instance);
  if (provider === undefined) {
    return yield* Effect.die(new Error(`This server has no provider instance ${input.instance}.`));
  }
  const effortOption = provider.models
    .find((candidate) => candidate.id === input.model)
    ?.options?.find((option) => EFFORT_OPTION_IDS.includes(option.id));
  if (effortOption === undefined || !effortOption.values.includes(input.effort)) {
    return yield* Effect.die(
      new Error(`${input.instance} does not offer ${input.model} with effort ${input.effort}.`),
    );
  }
  const selection: BotModelSelection = {
    instanceId: input.instance,
    model: input.model,
    options: [{ id: effortOption.id, value: input.effort }],
  };
  return selection;
});

/** The `--instance` flag of the Bot evals. */
export const INSTANCE_FLAG = { type: "string", default: "codex" } as const;

/** Waits for a run, or the thread's latest when `runId` is omitted, to end; fails unless it completed. */
export const waitForRun = Effect.fn("evals.waitForRun")(function* (
  call: Call,
  threadId: string,
  runId?: string,
  untilDelegatedWorkSettled = false,
) {
  while (true) {
    const waited = yield* call(
      "t3_thread_wait",
      {
        threadId,
        ...(runId === undefined ? {} : { runId }),
        ...(untilDelegatedWorkSettled ? { untilDelegatedWorkSettled: true } : {}),
        timeoutMs: WAIT_SLICE_MS,
      },
      OrchestratorMcpThreadWaitResult,
    );
    if (!waited.timedOut) {
      if (waited.status !== "completed") {
        return yield* new SampleError({
          message: `run ${waited.runId ?? runId} in ${threadId} ended ${waited.status}`,
        });
      }
      return waited.resultRun?.runId ?? waited.runId;
    }
    const { thread } = yield* call(
      "t3_thread_read",
      { threadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    if (thread.pendingRequestCount > 0) {
      return yield* new SampleError({ message: `${threadId} is waiting for user input` });
    }
  }
});

export const runTurn = Effect.fn("evals.runTurn")(function* (
  call: Call,
  threadId: string,
  prompt: string,
  options?: { readonly freshContext?: boolean; readonly untilDelegatedWorkSettled?: boolean },
) {
  const sent = yield* call(
    "t3_thread_send",
    { threadId, message: prompt, ...(options?.freshContext ? { freshContext: true } : {}) },
    OrchestratorMcpThreadSendResult,
  );
  return (
    (yield* waitForRun(call, threadId, sent.runId, options?.untilDelegatedWorkSettled)) ??
    sent.runId
  );
});

export const readItems = Effect.fn("evals.readItems")(function* (
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

/** The tool calls in a thread's activity, without its messages. */
export const toolActivity = (
  items: ReadonlyArray<OrchestratorMcpThreadReadResult["items"][number]>,
): ReadonlyArray<ToolActivity> =>
  items
    .filter((item) => item.type !== "user_message" && item.type !== "assistant_message")
    .map((item) => ({ type: item.type, title: item.title, text: item.text }));
