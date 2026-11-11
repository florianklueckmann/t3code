import {
  type BotId,
  type EnvironmentId,
  type OrchestrationV2LinkOrigin,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { Tool, type Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { assertNotLinked, assertSameLink, callerLinkOrigin } from "./linkOrigin.ts";
import * as McpCallerBot from "./McpCallerBot.ts";
import * as McpCallerChanges from "./McpCallerChanges.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./delegatedTaskModes.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

/** Private constructors only enforce types; the token also blocks runtime construction. */
const builtHere: unique symbol = Symbol("t3/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
  remote: RemoteCheck<P> | undefined,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

/**
 * What a call bound for a linked environment checks here before it goes: the
 * caller, not the thread or project it names, which live there and are
 * checked there. `undefined` for tools that act as the calling thread itself.
 */
type RemoteCheck<P> = (
  params: P,
) => Effect.Effect<unknown, OrchestratorMcpFailure, Effect.Services<typeof writingCaller>>;
let remoteCheckOf: <Handler>(declaration: Declaration<Handler>) => RemoteCheck<never> | undefined;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/** t3code/no-raw-mcp-registration confines Effect's unchecked registration API to McpHttpServer. */
export class Declaration<out Handler> {
  readonly #handle: Handler;
  readonly #remote: RemoteCheck<never> | undefined;
  private constructor(
    token: typeof builtHere,
    handle: Handler,
    remote: RemoteCheck<never> | undefined,
  ) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
    this.#remote = remote;
  }
  static {
    declare = (handle, remote) => new Declaration(builtHere, handle, remote);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
    remoteCheckOf = (declaration) => declaration.#remote;
  }
}

const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "read-only"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
);

const MAX_SUBAGENT_DEPTH = 16;

const noChangesRefusal = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This task is set to No changes, so tools that change things are refused. Report what you found, or describe the change you propose, in your result.",
});

const restrictedRunRefusal = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This Bot maintenance turn may only save its own Home's working note, so other tools that change things are refused.",
});

const endedRestrictedRunRefusal = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This call comes from a Bot maintenance turn that has ended, so tools that change things are refused.",
});

const missingAncestorRefusal = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This subagent's parent thread could not be found, so tools that change things are refused.",
});

/**
 * A subagent acts for its parents, so a restriction anywhere up its line applies to it. A
 * recorded parent that cannot be found is unknown authority, not the end of the line.
 */
const refuseRestrictedCaller = Effect.fn("McpToolAccess.refuseRestrictedCaller")(function* (
  caller: Caller,
) {
  if (caller.caller === undefined) return;
  // A sealed load serves only a restricted run, which these tools refuse whatever its state.
  if ((yield* McpInvocationContext.McpInvocationContext).thread?.sealedLoad === true)
    return yield* restrictedRunRefusal;
  const changes = yield* McpCallerChanges.McpCallerChanges;
  let shell = caller.caller;
  for (let depth = 0; ; depth++) {
    if (depth >= MAX_SUBAGENT_DEPTH) return yield* noChangesRefusal;
    const answer = yield* changes.forThread(shell.id);
    if (answer === "none") return yield* noChangesRefusal;
    if (answer !== "allowed") return yield* restrictedRunRefusal;
    const parentId =
      shell.lineage.relationshipToParent === "subagent" ? shell.lineage.parentThreadId : null;
    if (parentId === null) return;
    const parent = yield* caller.threads
      .getThreadShell(parentId)
      .pipe(Effect.mapError(unavailable));
    if (parent === null) return yield* missingAncestorRefusal;
    shell = parent;
  }
});

/** The Bot whose access the calling thread runs under; undefined for any other caller. */
const callerBot = Effect.gen(function* () {
  const { caller } = yield* loadCaller();
  if (caller === undefined) return undefined;
  const access = yield* (yield* McpCallerBot.McpCallerBot).forThread(caller);
  if (access._tag === "unknown") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This thread's Bot could not be determined, so it cannot start work. Start a new thread.",
    });
  }
  return access._tag === "bot" ? access.botId : undefined;
});

const outsideBotRefusal = (work: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `A Bot starts work only as its own tasks and routines, so ${work} would run outside the MCP connections granted to it. Use t3_bot start_task, or schedule_task with your botId.`,
  });

const otherBotRefusal = (bot: BotId, other: BotId) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This thread works for Bot "${bot}", so it can start and change only that Bot's tasks, routines and threads, not those of "${other}".`,
  });

/** The Bot whose line `thread` belongs to; undefined for a thread of no Bot or an unknown line. */
export const threadBot = Effect.fn("McpToolAccess.threadBot")(function* (
  thread: McpCallerBot.McpCallerBotThread,
) {
  const access = yield* (yield* McpCallerBot.McpCallerBot).forThread(thread);
  return access._tag === "bot" ? access.botId : undefined;
});

/**
 * A Bot's work loads only its granted MCP connections, which holds for its own tasks and
 * routines. Other new work would run with the user's own servers, so a Bot's thread may not start it.
 */
export const refuseBotCaller = (work: string) =>
  callerBot.pipe(
    Effect.flatMap((bot) =>
      bot === undefined ? Effect.void : Effect.fail(outsideBotRefusal(work)),
    ),
  );

/**
 * A Bot's thread starts or changes tasks and routines only for its own Bot, whose grants they
 * load. `owner` is read only for a Bot's thread; undefined means the work is no Bot's.
 */
export const requireOwnBot = <E, R>(owner: Effect.Effect<BotId | undefined, E, R>, work: string) =>
  callerBot.pipe(
    Effect.flatMap((bot) =>
      bot === undefined
        ? Effect.void
        : Effect.flatMap(owner, (other) =>
            other === undefined
              ? Effect.fail(outsideBotRefusal(work))
              : other === bot
                ? Effect.void
                : Effect.fail(otherBotRefusal(bot, other)),
          ),
    ),
  );

const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
  Effect.tap(refuseRestrictedCaller),
);

const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
  Effect.tap(refuseRestrictedCaller),
);

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) => handle(params),
    () => Effect.void,
  );

export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))), undefined);

export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      requireThreadCaller.pipe(
        Effect.andThen(writingCaller),
        Effect.flatMap(() => handle(params)),
      ),
    undefined,
  );

/**
 * Changes something that belongs to no thread, such as a pending upload or a
 * scheduled task. Work a linked environment started may not: none of it
 * carries the link's origin, so none of it is that link's.
 */
export const writes = <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
  options?: {
    /** Whether a linked caller may make it, as for uploads its own sends need. */
    readonly linkedCallers?: "allowed";
  },
) =>
  declare(
    (params: P) =>
      orchestratingCaller.pipe(
        Effect.tap((caller) =>
          options?.linkedCallers === "allowed"
            ? Effect.void
            : assertNotLinked(caller, "change this environment's scheduled tasks"),
        ),
        Effect.flatMap(() => handle(params)),
      ),
    () => orchestratingCaller,
  );

/** Requires handler capability checks, not thread control; linked work is refused the same way. */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      writingCaller.pipe(
        Effect.tap((caller) => assertNotLinked(caller, "start work here that is not its link's")),
        Effect.flatMap(() => handle(params)),
      ),
    () => writingCaller,
  );

export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        for (const threadId of threads(params)) {
          if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
          const target = yield* caller.threads
            .getThreadShell(threadId)
            .pipe(Effect.mapError(unavailable));
          if (target !== null && target.deletedAt === null) {
            yield* assertTargetWithinLimits(caller.limits, target);
            yield* assertSameLink(caller, target);
          }
        }
        // Modes can rise after this check; the orchestrator rechecks under lock and records refusal before handlers wrap errors.
        const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
        return yield* handle(params).pipe(
          Effect.provideService(DispatchModeLimit, { ...caller.limits, refused }),
          Effect.catch((error) =>
            Effect.flatMap(Ref.get(refused), (refusal) =>
              Effect.fail<E | OrchestratorMcpFailure>(
                refusal === undefined ? error : escalationDenied(refusal),
              ),
            ),
          ),
        );
      }),
    () => writingCaller,
  );

const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** The linked environment the caller acts for. The thread must carry it. */
  readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
}

/**
 * Starts threads with the modes `modes` requests, which may not be broader
 * than the caller's. `linked` says what a linked caller gets: threads stamped
 * with its `linkOrigin`, or a refusal where the tool cannot carry one.
 */
export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
  linked: "stamped" | { readonly refused: string },
) => {
  const started = Effect.fn("McpToolAccess.started")(function* (caller: Caller, params: P) {
    const requested = modes(params);
    return {
      runtimeMode: yield* resolveRuntimeMode(caller.limits.runtimeMode, requested.runtimeMode),
      interactionMode: yield* resolveInteractionMode(
        caller.limits.interactionMode,
        requested.interactionMode,
      ),
      linkOrigin: callerLinkOrigin(caller),
    } satisfies StartedModes;
  });
  return declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        if (linked !== "stamped") yield* assertNotLinked(caller, linked.refused);
        return yield* handle(params, yield* started(caller, params));
      }),
    (params: P) => Effect.flatMap(writingCaller, (caller) => started(caller, params)),
  );
};

/** One tool with two access rules, picked per call, such as create versus update. */
export const either = <P, A, E, R, A2, E2, R2>(
  useFirst: (params: P) => boolean,
  first: Declaration<(params: P) => Effect.Effect<A, E, R>>,
  second: Declaration<(params: P) => Effect.Effect<A2, E2, R2>>,
) => {
  const remotes = [remoteCheckOf(first), remoteCheckOf(second)] as ReadonlyArray<
    RemoteCheck<P> | undefined
  >;
  return declare(
    (params: P): Effect.Effect<A | A2, E | E2, R | R2> =>
      useFirst(params) ? checkedHandler(first)(params) : checkedHandler(second)(params),
    (params) =>
      remotes[useFirst(params) ? 0 : 1]?.(params) ??
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This action acts as the calling thread, which is here. Omit environmentId.",
        }),
      ),
  );
};

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/** Recheck after waits before writing; caller modes may have changed. */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
  options?: {
    /**
     * Whether a linked caller may make it, as for adding a project: it leaves
     * everything already here as it was.
     */
    readonly linkedCallers?: "allowed";
  },
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) =>
      options?.linkedCallers === "allowed"
        ? Effect.void
        : assertNotLinked(caller, "change projects or environment settings"),
    ),
    Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
  );
  return declare(
    (params: P) => check.pipe(Effect.flatMap(() => handle(params, check))),
    // Linked work never reaches a link at all; that is checked as the call goes.
    () =>
      orchestratingCaller.pipe(
        Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
      ),
  );
};

/**
 * Saves the calling Home's own working note: `writesEnvironment`'s checks, except that a restricted
 * run may pass. Only a thread's own credential qualifies, never a subagent, outside client or link.
 */
export const writesOwnHomeNote = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) => {
  const check = Effect.gen(function* () {
    const scope = yield* requireThreadCaller;
    const caller = yield* refuseReadOnlyClient.pipe(Effect.andThen(readCaller()));
    yield* assertLiveCaller(caller);
    yield* assertNotLinked(caller, "change projects or environment settings");
    yield* assertFullAccess(caller, fullAccessRequired);
    if (
      scope.thread.subagent === true ||
      caller.caller === undefined ||
      caller.caller.lineage.relationshipToParent === "subagent"
    )
      return yield* restrictedRunRefusal;
    const answer = yield* (yield* McpCallerChanges.McpCallerChanges).forThread(caller.caller.id);
    if (answer === "none") return yield* noChangesRefusal;
    if (answer === "allowed" && scope.thread.sealedLoad === true)
      return yield* endedRestrictedRunRefusal;
  });
  return declare((params: P) => check.pipe(Effect.flatMap(() => handle(params))), undefined);
};

type CheckServices = Effect.Services<typeof orchestratingCaller>;

type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

type NotCallable = { readonly call?: never } & { readonly apply?: never };

export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

/**
 * A tool runs in a linked environment when its parameters take this target
 * as `environmentId`. Other tools may name an environment for their own
 * reasons, such as the one to link or to move a thread to.
 */
const takesLinkedEnvironment = (tool: Tool.Any) => {
  const parameters: unknown = tool.parametersSchema;
  return (
    Predicate.hasProperty(parameters, "fields") &&
    Predicate.hasProperty(parameters.fields, "environmentId") &&
    parameters.fields.environmentId === OrchestratorMcpEnvironmentTarget
  );
};

const linksUnavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "This environment cannot reach linked environments.",
});

/**
 * Every tool that takes a linked environment runs there the same way: its
 * declaration checks the caller here, and the same call goes to the other
 * environment, which checks the rest. The handler here never sees
 * `environmentId`, so it cannot leak into what it writes.
 */
const routed = Effect.fn("McpToolAccess.routed")(function* <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  declarations: Handlers<Tools>,
  checked: Toolkit.HandlersFrom<Tools>,
) {
  // Optional so toolkits that never leave this environment build without it.
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  const handlers: Record<string, unknown> = { ...checked };
  for (const [name, declaration] of Object.entries<Declaration<unknown>>(declarations)) {
    const tool = toolkit.tools[name];
    if (tool === undefined || !takesLinkedEnvironment(tool)) continue;
    const remote = remoteCheckOf(declaration);
    if (remote === undefined)
      return yield* Effect.die(
        `${name} takes a linked environment, but it acts as its calling thread, which is here.`,
      );
    const here = handlers[name] as (
      params: object,
    ) => Effect.Effect<unknown, Tool.Failure<Tools[keyof Tools]>>;
    handlers[name] = ({ environmentId, ...params }: { readonly environmentId?: EnvironmentId }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const target = PeerForwarding.remoteTarget(scope, environmentId);
        if (target === undefined) return yield* here(params);
        if (scope.linkedEnvironments === false) return yield* PeerForwarding.linkedEnvironmentsOff;
        // Connection ids are this environment's, so a Bot's grants cannot follow it there.
        if (!Context.get(tool.annotations, Tool.Readonly))
          yield* refuseBotCaller("work in another environment");
        yield* (remote as RemoteCheck<typeof params>)(params);
        if (Option.isNone(forwarding)) return yield* linksUnavailable;
        return yield* forwarding.value.call(scope, tool, target, { ...params, environmentId });
      });
  }
  return handlers as Toolkit.HandlersFrom<Tools>;
});

export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> => {
  // Checked as soon as they are given, so a forged declaration fails here.
  const withDeclarations = (declarations: Handlers<Tools>) =>
    routed(toolkit, declarations, checkedHandlers(declarations));
  return handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build) ? Effect.flatMap(build, withDeclarations) : withDeclarations(build),
    ),
  );
};
