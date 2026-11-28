import {
  MAC_CALENDAR_CONNECTION_ID,
  macCalendarsForBot,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { piMcpGrantsPlatformSupported } from "@t3tools/provider-pi/server";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotExecutionConstraint from "./BotExecutionConstraint.ts";
import * as BotProviderSupport from "./BotProviderSupport.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

type ProviderInstances = ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];

/** An instance id is not a driver, so the registry says which driver runs it. */
const driverOf = (providerInstances: ProviderInstances, instanceId: ProviderInstanceId) =>
  providerInstances
    .getInstance(instanceId)
    .pipe(Effect.map((instance) => instance?.driverKind as string | undefined));

/**
 * Why a sealed Bot run cannot be enforced on this instance here, or undefined. Codex and Claude
 * seal every mode, each only where that was verified natively; Pi seals none.
 */
export const restrictionUnenforceable = Effect.fn("BotRuntimePolicy.restrictionUnenforceable")(
  function* (
    providerInstances: ProviderInstances,
    instanceId: ProviderInstanceId,
    seal: NonNullable<ProviderAdapter.ProviderAdapterV2RuntimePolicy["nativeTools"]>,
  ) {
    const driver = yield* driverOf(providerInstances, instanceId);
    const support = BotProviderSupport.botDriverSupport(driver);
    if (!(seal === "t3BotOnly" ? support.homeSeal : support.readOnlySeal))
      return BotProviderSupport.unsupportedReason(driver);
    const platform = yield* HostProcess.Platform;
    const measured =
      driver === "claudeAgent"
        ? ClaudeAdapterV2.claudeSealPlatformSupported(platform)
        : CodexAdapterV2.codexSealPlatformSupported(platform);
    return measured ? undefined : ("platform" as const);
  },
);

/**
 * A Bot's whole lineage runs without provider memory and with only its granted MCP connections
 * (plus the user's own Codex servers when switched on). Codex, Claude and Pi enforce grants; any
 * other provider is refused. No changes tasks and the Bot-level Home with read access also run
 * restricted.
 */
export const layer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  | RuntimePolicy.RuntimePolicyV2
  | BotTurnContext.BotTurnContext
  | BotExecutionConstraint.BotExecutionConstraint
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const botTurnContext = yield* BotTurnContext.BotTurnContext;
    const executionConstraint = yield* BotExecutionConstraint.BotExecutionConstraint;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("BotRuntimePolicy.resolve")(function* (input) {
        const policy = yield* base.resolve(input);
        const resolveError = (cause: unknown) =>
          new RuntimePolicy.RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          });
        // Inactive Bot conversations count too: a failed read must not leave memory on.
        const bot = yield* botTurnContext
          .forThread(input.thread.id)
          .pipe(Effect.mapError(resolveError));
        const sealUnenforceable = (
          seal: NonNullable<ProviderAdapter.ProviderAdapterV2RuntimePolicy["nativeTools"]>,
        ) =>
          restrictionUnenforceable(providerInstances, input.modelSelection.instanceId, seal).pipe(
            Effect.map((reason) =>
              reason === BotProviderSupport.CLAUDE_UNSUPPORTED ||
              reason === BotProviderSupport.PI_UNSUPPORTED
                ? "provider"
                : reason,
            ),
          );
        if (input.restriction !== undefined) {
          const reason =
            bot._tag !== "active" ||
            bot.scope.taskId !== null ||
            bot.scope.homeThreadId !== input.thread.id
              ? ("home" as const)
              : yield* sealUnenforceable("t3BotOnly");
          if (reason !== undefined) {
            return yield* new RuntimePolicy.RuntimePolicyUnsupportedError({
              threadId: input.thread.id,
              providerInstanceId: input.modelSelection.instanceId,
              reason,
              restriction: input.restriction,
            });
          }
          // The working note and Waiting check need no external account, so none load.
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...policy,
            nativeMemory: "disabled",
            nativeTools: "t3BotOnly",
            mcpConnections: [],
          });
        }
        const constraint = yield* executionConstraint
          .forThread(input.thread.id)
          .pipe(Effect.mapError(resolveError));
        // The Bot-level Home with read access reads like No changes and changes only through tasks.
        const readSeal =
          constraint === "no-changes"
            ? ("readOnly" as const)
            : constraint === "home-read"
              ? ("readOnlyT3Bot" as const)
              : undefined;
        const noChanges = readSeal !== undefined;
        if (readSeal !== undefined) {
          const reason = yield* sealUnenforceable(readSeal);
          if (reason !== undefined) {
            return yield* new RuntimePolicy.RuntimePolicyUnsupportedError({
              threadId: input.thread.id,
              providerInstanceId: input.modelSelection.instanceId,
              reason,
              ...(readSeal === "readOnlyT3Bot" ? { botHomeAccess: "read" as const } : {}),
            });
          }
        }
        const access = yield* botTurnContext
          .mcpAccessForThread(input.thread)
          .pipe(Effect.mapError(resolveError));
        if (access._tag === "none") {
          return readSeal !== undefined
            ? ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                nativeMemory: "disabled",
                nativeTools: readSeal,
              })
            : policy;
        }
        // Its own inactive conversation refuses with its Bot instructions; a derived one here.
        if (access._tag === "refused" && bot._tag === "none") {
          return yield* new RuntimePolicy.RuntimePolicyMcpUnsupportedError({
            threadId: input.thread.id,
            providerInstanceId: input.modelSelection.instanceId,
            detail: access.message,
          });
        }
        const calendarGranted =
          access._tag === "bot" && access.connectionIds.includes(MAC_CALENDAR_CONNECTION_ID);
        // The Bot's calendars decide whether the calendar loads and offers write tools, so a choice
        // that changes either reloads the provider. Each call checks the current choice anyway.
        const calendars =
          access._tag === "bot" && calendarGranted
            ? macCalendarsForBot(
                (yield* settings.getSettings.pipe(Effect.mapError(resolveError))).macCalendar
                  .calendars,
                access.calendarIds,
              )
            : [];
        const mcpConnections =
          access._tag === "bot"
            ? access.connectionIds.filter(
                (id) => id !== MAC_CALENDAR_CONNECTION_ID || calendars.length > 0,
              )
            : [];
        const botName = access._tag === "bot" ? access.botName : "This Bot";
        const refuseMcp = (detail: string) =>
          new RuntimePolicy.RuntimePolicyMcpUnsupportedError({
            threadId: input.thread.id,
            providerInstanceId: input.modelSelection.instanceId,
            detail,
          });
        const driver = yield* driverOf(providerInstances, input.modelSelection.instanceId);
        const support = BotProviderSupport.botDriverSupport(driver);
        if (!support.mcpIsolation) {
          return yield* refuseMcp(
            `${botName}'s threads run only on Codex, Claude or Pi, which keep them to T3 Code's tools and the Bot's own connections, so nothing ran. Switch this thread to a Codex, Claude or Pi model.`,
          );
        }
        const platform = yield* HostProcess.Platform;
        const codex = driver === "codex";
        const grantsVerified =
          driver === "claudeAgent"
            ? ClaudeAdapterV2.claudeMcpGrantsPlatformSupported(platform)
            : driver === "pi"
              ? piMcpGrantsPlatformSupported(platform)
              : CodexAdapterV2.codexMcpGrantsPlatformSupported(platform);
        if (!grantsVerified && mcpConnections.length > 0) {
          return yield* refuseMcp(
            `${botName} uses only the MCP connections granted to it, which ${codex ? "is only verified on macOS and Linux" : `on ${driver === "pi" ? "Pi" : "Claude"} is only verified on macOS`}, so nothing ran.`,
          );
        }
        // Elsewhere a Codex Bot without grants keeps Codex's own MCP setup, as documented; a Claude
        // or Pi Bot stays on T3 Code's server everywhere.
        const grantsPlatform = !codex || grantsVerified;
        // That fallback would hand another machine's Bot this machine's own MCP servers.
        if (!grantsPlatform && access._tag === "bot" && access.environmentId !== undefined) {
          return yield* refuseMcp(
            `${botName} is a Bot on another machine. Here its Codex threads can be kept to T3 Code's tools only on macOS and Linux, so nothing ran. Switch this thread to a Claude or Pi model.`,
          );
        }
        // The user's own servers are Codex's; on Claude a Bot thread loads T3 Code's server only.
        const userMcpServers =
          support.ownMcpServers && access._tag === "bot" && access.ownCodexMcpServers && !noChanges
            ? { userMcpServers: "enabled" as const }
            : {};
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          nativeMemory: "disabled",
          ...(readSeal === undefined ? {} : { nativeTools: readSeal }),
          ...(grantsPlatform ? { mcpConnections, ...userMcpServers } : {}),
          ...(grantsPlatform &&
          !noChanges &&
          access._tag === "bot" &&
          access.direct !== undefined &&
          access.levels?.[MAC_CALENDAR_CONNECTION_ID] === "read-write" &&
          calendars.some((calendar) => calendar.allowWrite === true)
            ? { macCalendarWrite: true as const }
            : {}),
        });
      }),
    });
  }),
);
