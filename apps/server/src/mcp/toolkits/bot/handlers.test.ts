import * as BotContinuation from "../../../bots/BotContinuation.ts";
import { expect, it } from "@effect/vitest";
import {
  BotId,
  type BotDetail,
  BotError,
  BotLearningEntryId,
  BotTaskId,
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
import * as BotTaskService from "../../../bots/BotTaskService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
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
  learning: [],
  pendingLearning: 0,
} satisfies BotDetail;

const callTool = (
  params: BotToolInput,
  access: "read-only" | undefined,
  /** The Bot conversation the calling thread is, if any. */
  callerBot?: { readonly botId: BotId; readonly projectId: ProjectId; readonly taskId?: BotTaskId },
  external = false,
) =>
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
                thread: external
                  ? undefined
                  : {
                      threadId,
                      providerSessionId: "provider:bots",
                      providerInstanceId: ProviderInstanceId.make("codex"),
                    },
                client:
                  access === undefined && !external
                    ? undefined
                    : {
                        sessionId: "session:bots",
                        label: "Test client",
                        access: access ?? "full-access",
                      },
                capabilities: new Set(["orchestration" as const]),
                issuedAt: 0,
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
              }),
              Layer.mock(BotContinuation.BotContinuation)({
                get: (input) =>
                  Effect.succeed({
                    ...input,
                    homeThreadId: threadId,
                    revision: null,
                    note: { requests: [], waiting: [], decided: [], context: [] },
                    updatedBy: null,
                    updatedAt: null,
                    restoredFrom: null,
                    coverage: null,
                    basis: null,
                    writable: true,
                    newerInputs: { count: 0, firstOrdinal: null, lastOrdinal: null },
                    sources: [],
                    moreSources: 0,
                    activeTasks: [],
                    moreActiveTasks: 0,
                  }),
              }),
              Layer.mock(BotService.BotService)({
                list: Effect.succeed({ bots: [] }),
                get: () => record("get"),
                attachProject: (input) => record(`attach:${input.projectId}`),
                updateProjectContext: (input) =>
                  record(`project:${input.projectId}:${input.guidance}:${input.sources?.length}`),
                update: () => Effect.fail(new BotError({ message: "This Bot is archived." })),
                scopeOfThread: () =>
                  Effect.succeed(
                    callerBot === undefined
                      ? undefined
                      : { homeThreadId: threadId, taskId: null, ...callerBot },
                  ),
                recordLearning: (input) =>
                  record(
                    `learn:${input.projectId}:${input.origin}:${
                      input.source.kind === "thread" ? input.source.threadId : input.source.kind
                    }`,
                  ).pipe(
                    Effect.map((bot) => ({
                      bot,
                      learned: {
                        entryId: BotLearningEntryId.make("entry-1"),
                        revision: 1,
                        status: "pending" as const,
                        duplicate: false,
                      },
                    })),
                  ),
                decideLearning: (input) => record(`decide:${input.decision}`),
                resolveProject: (input) =>
                  Effect.succeed({ projectId: input.projectId ?? campaignA } as never),
              }),
              Layer.mock(BotTaskService.BotTaskService)({
                list: () =>
                  Ref.update(calls, (current) => [...current, "list_tasks"]).pipe(
                    Effect.as({ tasks: [] }),
                  ),
                start: (input) =>
                  Ref.update(calls, (current) => [
                    ...current,
                    `start:${JSON.stringify(input.modelSelection ?? null)}`,
                  ]).pipe(
                    Effect.as({
                      id: BotTaskId.make("bot-task:1"),
                      botId,
                      projectId: input.projectId,
                      homeThreadId: threadId,
                      workThreadId: ThreadId.make("bot-work:bot-task:1"),
                      origin: "direct" as const,
                      title: "Recap",
                      scheduledTaskId: null,
                      occurrenceDueAt: null,
                      sessionAt: null,
                      runtimeMode: "full-access" as const,
                      status: "accepted" as const,
                      detail: null,
                      createdAt: "2026-11-02T00:00:00.000Z",
                      updatedAt: "2026-11-02T00:00:00.000Z",
                      completedAt: null,
                      modelSelection: input.modelSelection ?? detail.modelSelection,
                    }),
                  ),
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

it.effect(
  "records learning only from the Bot's own conversation and leaves decisions to the user",
  () =>
    Effect.gen(function* () {
      const campaignB = ProjectId.make("project-campaign-b");
      const own = { botId, projectId: campaignA };
      const learning = {
        origin: "correction" as const,
        kind: "preference" as const,
        text: "Dates use Dale Reckoning.",
      };

      const learned = yield* callTool(
        { action: "learn", botId, projectId: campaignA, learning },
        undefined,
        own,
      );
      // The source is the calling thread, whatever the caller claims.
      expect(learned.calls).toEqual([`learn:${campaignA}:correction:${threadId}`]);
      expect(learned.result).toMatchObject({ learned: { status: "pending" } });

      const otherProject = yield* callTool(
        { action: "learn", botId, projectId: campaignB, learning },
        undefined,
        own,
      );
      expect(otherProject.result).toMatchObject({ code: "invalid_request" });
      expect(otherProject.calls).toEqual([]);

      // A work thread's lesson is attributed to its task, which the server resolved.
      const fromTask = yield* callTool(
        { action: "learn", botId, projectId: campaignA, learning },
        undefined,
        { ...own, taskId: BotTaskId.make("bot-task:1") },
      );
      expect(fromTask.calls).toEqual([`learn:${campaignA}:correction:task`]);

      const selfAdopt = yield* callTool(
        { action: "adopt", botId, entryId: BotLearningEntryId.make("entry-1"), revision: 1 },
        undefined,
        own,
      );
      expect(selfAdopt.result).toMatchObject({ code: "invalid_request" });
      expect(selfAdopt.calls).toEqual([]);

      // Another agent the user directs can decide, behind the same write access as other edits.
      const adopted = yield* callTool(
        { action: "adopt", botId, entryId: BotLearningEntryId.make("entry-1"), revision: 1 },
        undefined,
      );
      expect(adopted.calls).toEqual(["decide:adopt"]);
      const readOnly = yield* callTool(
        { action: "learn", botId, projectId: campaignA, learning },
        "read-only",
      );
      expect(readOnly.result).toMatchObject({ code: "capability_denied" });
    }),
);

it.effect("starts a task on its own model without updating the Bot", () =>
  Effect.gen(function* () {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.1",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    const started = yield* callTool(
      { action: "start_task", botId, task: "Recap.", modelSelection },
      undefined,
    );
    expect(started.calls).toEqual([`start:${JSON.stringify(modelSelection)}`]);
    expect(started.result).toMatchObject({ task: { modelSelection } });
    const inherited = yield* callTool({ action: "start_task", botId, task: "Recap." }, undefined);
    expect(inherited.calls).toEqual(["start:null"]);
    const malformed = yield* callTool(
      {
        action: "start_task",
        botId,
        task: "Recap.",
        modelSelection: { ...modelSelection, options: { reasoningEffort: 123 } },
      } as unknown as BotToolInput,
      undefined,
    );
    expect(malformed.result).toMatchObject({
      reason: { _tag: "ToolParameterValidationError" },
    });
    expect(malformed.calls).toEqual([]);
    const value = { anyOf: [{ type: "string" }, { type: "boolean" }] };
    const options = {
      anyOf: [
        { type: "array", items: { properties: { value } } },
        { type: "object", additionalProperties: value },
      ],
    };
    expect(advertisedJsonSchema(BotToolkit.tools.t3_bot)).toMatchObject({
      properties: {
        modelSelection: {
          anyOf: [
            { required: ["instanceId", "model"], properties: { options } },
            { required: ["provider", "model"], properties: { options } },
          ],
        },
      },
    });
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
    const tasks = yield* callTool({ action: "list_tasks", botId }, "read-only");
    expect(tasks.calls).toEqual(["list_tasks"]);
    const start = yield* callTool(
      { action: "start_task", botId, task: "Prepare.", returnToHome: true },
      "read-only",
    );
    expect(start.result).toMatchObject({ code: "capability_denied" });
    expect(start.calls).toEqual([]);
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

it.effect(
  "allows external inspection but refuses an external continuation writer before reaching the service",
  () =>
    Effect.gen(function* () {
      const read = yield* callTool(
        { action: "read_continuation", botId, projectId: campaignA },
        undefined,
        undefined,
        true,
      );
      expect(read.result).toMatchObject({
        continuation: { revision: null, homeThreadId: threadId },
      });
      const save = yield* callTool(
        {
          action: "save_continuation",
          botId,
          projectId: campaignA,
          continuation: {
            baseRevision: null,
            updateId: "external",
            note: { requests: [], waiting: [], decided: [], context: [] },
          },
        },
        undefined,
        undefined,
        true,
      );
      expect(save.result).toMatchObject({
        code: "invalid_request",
        message: "Working-note writes require this project's active Home thread credential.",
      });
    }),
);
