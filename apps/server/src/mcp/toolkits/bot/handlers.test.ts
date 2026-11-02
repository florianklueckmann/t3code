import { expect, it } from "@effect/vitest";
import {
  BotId,
  type BotDetail,
  BotError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotHandlers from "./handlers.ts";
import { BotToolkit, type BotToolInput } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:bots");
const threadId = ThreadId.make("thread:bots");
const botId = BotId.make("faerun-companion");
const campaignA = ProjectId.make("project-campaign-a");

const detail = {
  id: botId,
  name: "Faerun Companion",
  instructions: "",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  learningPolicy: "automatic",
  appearance: { color: "teal", face: "happy", topper: "antenna" },
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  archivedAt: null,
  projects: [],
} satisfies BotDetail;

const callTool = (params: BotToolInput, access: "read-only" | undefined) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (call: string) =>
      Ref.update(calls, (current) => [...current, call]).pipe(Effect.as(detail));
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* BotToolkit;
      const results = yield* toolkit
        .handle("t3_bot", params)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.encodedResult;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(BotHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId,
                requestNamespace: "provider:bots",
                thread: {
                  threadId,
                  providerSessionId: "provider:bots",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client:
                  access === undefined
                    ? undefined
                    : { sessionId: "session:bots", label: "Read-only client", access },
                capabilities: new Set(["orchestration" as const]),
                issuedAt: 0,
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
              }),
              Layer.mock(BotService.BotService)({
                list: Effect.succeed({ bots: [] }),
                get: () => record("get"),
                attachProject: (input) => record(`attach:${input.projectId}`),
                updateProjectContext: (input) =>
                  record(`project:${input.projectId}:${input.guidance}:${input.sources?.length}`),
                update: () => Effect.fail(new BotError({ message: "This Bot is archived." })),
              }),
            ),
          ),
        ),
      ),
    );
    return { result, calls: yield* Ref.get(calls) };
  });

it.effect("routes project updates to that project's guidance and sources", () =>
  Effect.gen(function* () {
    const { calls } = yield* callTool(
      {
        action: "update",
        botId,
        projectId: campaignA,
        guidance: "Use the vault from now on.",
        sources: [{ label: "Vault", location: "/vaults/a" }],
      },
      undefined,
    );
    expect(calls).toEqual([`project:${campaignA}:Use the vault from now on.:1`]);
  }),
);

it.effect("lets read-only clients read Bots but not change them", () =>
  Effect.gen(function* () {
    const read = yield* callTool({ action: "read", botId }, "read-only");
    expect(read.calls).toEqual(["get"]);
    // Appearance is client presentation; the agent's view of a Bot stays unchanged.
    expect(read.result).toMatchObject({ bot: { name: detail.name } });
    expect(read.result).not.toHaveProperty("bot.appearance");
    const attach = yield* callTool({ action: "attach", botId, projectId: campaignA }, "read-only");
    expect(attach.result).toMatchObject({ code: "capability_denied" });
    expect(attach.calls).toEqual([]);
  }),
);

it.effect("reports missing fields and service refusals as request errors", () =>
  Effect.gen(function* () {
    const attach = yield* callTool({ action: "attach", botId }, undefined);
    expect(attach.result).toMatchObject({
      code: "invalid_request",
      message: "`attach` needs `projectId`.",
    });
    const update = yield* callTool({ action: "update", botId, name: "Renamed" }, undefined);
    expect(update.result).toMatchObject({
      code: "invalid_request",
      message: "This Bot is archived.",
    });
  }),
);
