import { assert, it } from "@effect/vitest";
import {
  BotId,
  BotTaskId,
  McpConnectionId,
  type OrchestrationV2AppThread,
  type OrchestrationV2RunRestriction,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as BotExecutionConstraint from "./BotExecutionConstraint.ts";
import * as BotRuntimePolicy from "./BotRuntimePolicy.ts";
import * as BotStore from "./BotStore.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

const botThread = ThreadId.make("bot-home:companion:campaign");
const workThread = ThreadId.make("bot-work:bot-task:1");
const archivedBotThread = ThreadId.make("bot-home:archived:campaign");
const brokenThread = ThreadId.make("bot-home:broken:campaign");
const noChangesThread = ThreadId.make("bot-work:bot-task:no-changes");
const archivedNoChangesThread = ThreadId.make("bot-work:bot-task:archived-no-changes");
const unreadableTaskThread = ThreadId.make("bot-work:bot-task:unreadable");
// Forks and subagents are not Bot conversations, but their MCP access follows their Bot.
const botForkThread = ThreadId.make("fork-of-bot-home");
const ungrantedBotThread = ThreadId.make("bot-home:ungranted:campaign");
const ungrantedBotForkThread = ThreadId.make("fork-of-ungranted-bot-home");
const botSubagentThread = ThreadId.make("subagent-of-codex-bot-home");
const ungrantedBotSubagentThread = ThreadId.make("subagent-of-ungranted-codex-bot-home");
const orphanThread = ThreadId.make("subagent-of-lost-parent");
const privateMail = McpConnectionId.make("2a2a2a2a-0000-4000-8000-00000000002a");

const mcpAccessOf = (id: ThreadId): BotTurnContext.BotMcpAccess => {
  const bot = (connectionIds: ReadonlyArray<McpConnectionId>) =>
    ({ _tag: "bot", botId: BotId.make("companion"), botName: "Mail Bot", connectionIds }) as const;
  if ([botThread, workThread, noChangesThread, botForkThread, botSubagentThread].includes(id))
    return bot([privateMail]);
  if ([ungrantedBotThread, ungrantedBotForkThread, ungrantedBotSubagentThread].includes(id))
    return bot([]);
  if (id === archivedBotThread || id === archivedNoChangesThread || id === orphanThread)
    return { _tag: "refused", message: "parent lost" };
  return { _tag: "none" };
};

const activeScope = (id: ThreadId) =>
  ({
    _tag: "active",
    instructions: "",
    scope: {
      botId: BotId.make("companion"),
      projectId: ProjectId.make("campaign"),
      homeThreadId: botThread,
      taskId: id === botThread ? null : BotTaskId.make("bot-task:1"),
    },
  }) as const;

interface PolicyOptions {
  readonly instanceId?: string;
  readonly platform?: NodeJS.Platform;
  readonly restriction?: OrchestrationV2RunRestriction;
}

const usePolicy = <A, E>(
  threadId: ThreadId,
  options: PolicyOptions,
  use: (
    policy: RuntimePolicy.RuntimePolicyV2Shape,
    input: RuntimePolicy.RuntimePolicyV2Input,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    return yield* use(policy, {
      thread: {
        id: threadId,
        projectId: ProjectId.make("campaign"),
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: "/campaign",
      } as OrchestrationV2AppThread,
      modelSelection: {
        instanceId: ProviderInstanceId.make(options.instanceId ?? "codex_work"),
        model: "gpt-5",
      },
      ...(options.restriction === undefined ? {} : { restriction: options.restriction }),
    });
  }).pipe(
    Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
    Effect.provide(
      BotRuntimePolicy.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            RuntimePolicy.layer,
            // Instance ids are not driver kinds: the registry decides which driver runs one.
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed(
                  id === "codex_work"
                    ? ({ driverKind: ProviderDriverKind.make("codex") } as ProviderInstance)
                    : id === "codex"
                      ? ({ driverKind: ProviderDriverKind.make("claudeAgent") } as ProviderInstance)
                      : id === "pi"
                        ? ({ driverKind: ProviderDriverKind.make("pi") } as ProviderInstance)
                        : undefined,
                ),
            }),
            Layer.mock(BotTurnContext.BotTurnContext)({
              mcpAccessForThread: (thread) => Effect.succeed(mcpAccessOf(thread.id)),
              forThread: (id) =>
                id === botThread ||
                id === workThread ||
                id === noChangesThread ||
                id === ungrantedBotThread
                  ? Effect.succeed(activeScope(id))
                  : id === archivedBotThread || id === archivedNoChangesThread
                    ? Effect.succeed({ _tag: "inactive", message: "archived" } as const)
                    : id === brokenThread
                      ? Effect.fail(new BotStore.BotStoreError({ operation: "read", cause: "x" }))
                      : Effect.succeed({ _tag: "none" } as const),
            }),
            // The task row decides, whatever the Bot's state: it is never edited after admission.
            Layer.mock(BotExecutionConstraint.BotExecutionConstraint)({
              forThread: (id) =>
                id === noChangesThread || id === archivedNoChangesThread
                  ? Effect.succeed("no-changes")
                  : id === unreadableTaskThread
                    ? Effect.fail(
                        new BotStore.BotStoreError({ operation: "read-task", cause: "x" }),
                      )
                    : Effect.succeed("standard"),
            }),
          ),
        ),
      ),
    ),
  );

const resolveFor = (threadId: ThreadId, options: PolicyOptions = {}) =>
  usePolicy(threadId, options, (policy, input) => policy.resolve(input));

it.effect("turns provider memory off for Bot conversations only", () =>
  Effect.gen(function* () {
    assert.equal((yield* resolveFor(botThread)).nativeMemory, "disabled");
    assert.equal((yield* resolveFor(workThread)).nativeMemory, "disabled");
    assert.equal((yield* resolveFor(archivedBotThread)).nativeMemory, "disabled");
    const plain = yield* resolveFor(ThreadId.make("plain"));
    assert.isUndefined(plain.nativeMemory);
    assert.equal(plain.cwd, "/campaign");
    // An unreadable Bot record must not start the turn with memory on.
    const broken = yield* resolveFor(brokenThread).pipe(Effect.flip);
    assert.equal(broken._tag, "RuntimePolicyResolveError");
  }),
);

it.effect("never resolves a No changes task to a policy that can change things", () =>
  Effect.gen(function* () {
    for (const threadId of [noChangesThread, archivedNoChangesThread]) {
      const restricted = yield* resolveFor(threadId);
      assert.equal(restricted.nativeTools, "readOnly");
      assert.equal(restricted.nativeMemory, "disabled");
      for (const [options, reason] of [
        [{ instanceId: "codex" }, "provider"],
        [{ instanceId: "missing" }, "provider"],
        [{ platform: "linux" }, "platform"],
      ] as const) {
        const refused = yield* resolveFor(threadId, options).pipe(Effect.flip);
        assert.equal(refused._tag, "RuntimePolicyUnsupportedError");
        assert.equal(refused._tag === "RuntimePolicyUnsupportedError" && refused.reason, reason);
      }
    }
    const unreadable = yield* resolveFor(unreadableTaskThread).pipe(Effect.flip);
    assert.equal(unreadable._tag, "RuntimePolicyResolveError");
    // Changes allowed, direct tasks (also stored with allow_changes = 0) and Home are unchanged.
    for (const threadId of [workThread, botThread, ThreadId.make("plain")]) {
      assert.isUndefined((yield* resolveFor(threadId)).nativeTools);
    }
  }),
);

it.effect(
  "loads only the Bot's granted MCP connections in every thread its work derives from",
  () =>
    Effect.gen(function* () {
      for (const threadId of [botThread, workThread, botForkThread]) {
        const policy = yield* resolveFor(threadId);
        assert.deepEqual(policy.mcpConnections, [privateMail], threadId);
        assert.equal(policy.nativeMemory, "disabled");
        assert.isUndefined(policy.nativeTools);
      }
      assert.deepEqual((yield* resolveFor(ungrantedBotThread)).mcpConnections, []);
      // No changes keeps the grants under its seal; the scoped Home turn needs no external account.
      const noChanges = yield* resolveFor(noChangesThread);
      assert.equal(noChanges.nativeTools, "readOnly");
      assert.deepEqual(noChanges.mcpConnections, [privateMail]);
      assert.deepEqual(
        (yield* resolveFor(botThread, { restriction: "botNote" })).mcpConnections,
        [],
      );
      assert.isUndefined((yield* resolveFor(ThreadId.make("plain"))).mcpConnections);

      const orphan = yield* resolveFor(orphanThread).pipe(Effect.flip);
      assert.equal(orphan._tag, "RuntimePolicyMcpUnsupportedError");
      assert.equal(orphan.message, "parent lost");
    }),
);

it.effect.each([
  ["Claude Bot", botThread, ungrantedBotThread, { instanceId: "codex" }],
  ["Claude fork", botForkThread, ungrantedBotForkThread, { instanceId: "codex" }],
  ["Linux Bot", botThread, ungrantedBotThread, { platform: "linux" }],
  [
    "Codex Bot delegating to Claude",
    botSubagentThread,
    ungrantedBotSubagentThread,
    { instanceId: "codex" },
  ],
  ["missing instance", botForkThread, ungrantedBotForkThread, { instanceId: "missing" }],
  ["Pi Bot", botThread, ungrantedBotThread, { instanceId: "pi" }],
] as const)(
  "allows %s without grants and refuses it with grants where they cannot be enforced",
  ([_, grantedThreadId, ungrantedThreadId, options]) =>
    Effect.gen(function* () {
      const refused = yield* resolveFor(grantedThreadId, options).pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyMcpUnsupportedError");
      assert.include(refused.message, "Mail Bot uses only the MCP connections granted to it");

      const policy = yield* resolveFor(ungrantedThreadId, options);
      assert.isFalse(Object.hasOwn(policy, "mcpConnections"));
      assert.equal(policy.nativeMemory, "disabled");
      assert.isUndefined(policy.nativeTools);
    }),
);

it.effect("seals a restricted run only in an active Bot Home on Codex and macOS", () =>
  Effect.gen(function* () {
    const sealed = yield* resolveFor(botThread, { restriction: "botNote" });
    assert.equal(sealed.nativeTools, "t3BotOnly");
    assert.equal(sealed.nativeMemory, "disabled");
    assert.isUndefined((yield* resolveFor(botThread)).nativeTools);
    for (const [threadId, options, reason] of [
      [workThread, {}, "home"],
      [noChangesThread, {}, "home"],
      [archivedBotThread, {}, "home"],
      [ThreadId.make("plain"), {}, "home"],
      [botThread, { instanceId: "codex" }, "provider"],
      [botThread, { instanceId: "missing" }, "provider"],
      [botThread, { platform: "linux" }, "platform"],
    ] as const) {
      const refused = yield* resolveFor(threadId, { ...options, restriction: "botWaiting" }).pipe(
        Effect.flip,
      );
      assert.equal(refused._tag, "RuntimePolicyUnsupportedError");
      assert.equal(refused._tag === "RuntimePolicyUnsupportedError" && refused.reason, reason);
    }
  }),
);
