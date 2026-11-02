import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotProjectGuard from "./BotProjectGuard.ts";
import * as BotService from "./BotService.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

const campaignA = ProjectId.make("project-campaign-a");
const campaignB = ProjectId.make("project-campaign-b");
const botId = BotId.make("faerun-companion");
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

interface FakeThread {
  readonly projectId: ProjectId;
  readonly archived: boolean;
  readonly model: string;
}

/** Stands in for the orchestrator: records home threads and the commands that reach them. */
const makeThreadWorld = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<ThreadId, FakeThread>());
  const commands = yield* Ref.make<ReadonlyArray<string>>([]);
  const failNext = yield* Ref.make<string | null>(null);

  const setThread = (threadId: ThreadId, update: (thread: FakeThread) => FakeThread) =>
    Ref.update(threads, (current) => {
      const thread = current.get(threadId);
      return thread === undefined ? current : new Map(current).set(threadId, update(thread));
    });

  const dispatch = Effect.fn("FakeThreads.dispatch")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    if ((yield* Ref.get(failNext)) === command.type) {
      yield* Ref.set(failNext, null);
      return yield* Effect.die(`injected ${command.type} failure`);
    }
    yield* Ref.update(commands, (current) => [...current, command.type]);
    if (command.type === "thread.archive" || command.type === "thread.unarchive") {
      const archived = command.type === "thread.archive";
      yield* setThread(command.threadId, (thread) => ({ ...thread, archived }));
    }
    if (command.type === "thread.model-selection.set") {
      const model = command.modelSelection.model;
      yield* setThread(command.threadId, (thread) => ({ ...thread, model }));
    }
    return { storedEvents: [] } as never;
  });

  const threadLayer = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch,
      getThreadShell: Effect.fn("FakeThreads.getThreadShell")(function* (threadId: ThreadId) {
        const thread = (yield* Ref.get(threads)).get(threadId);
        if (thread === undefined) return null;
        const shell: Pick<
          OrchestrationV2ThreadShell,
          "archivedAt" | "deletedAt" | "modelSelection"
        > = {
          archivedAt: thread.archived ? DateTime.makeUnsafe(0) : null,
          deletedAt: null,
          modelSelection: { ...codex, model: thread.model },
        };
        return shell as OrchestrationV2ThreadShell;
      }),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: Effect.fn("FakeThreads.launch")(function* (input) {
        const threadId = input.threadId ?? ThreadId.make("unexpected");
        yield* Ref.update(commands, (current) => [...current, "thread.create"]);
        yield* Ref.update(threads, (current) =>
          current.has(threadId)
            ? current
            : new Map(current).set(threadId, {
                projectId: input.projectId,
                archived: false,
                model: input.modelSelection.model,
              }),
        );
        return { threadId, resumed: false } as never;
      }),
    }),
  );
  return { threads, commands, failNext, threadLayer };
});

const layerSupport = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId: ProjectId) =>
      Effect.succeedSome({ id: projectId, deletedAt: null } as Project),
  }),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(instanceId === "claude" ? "claudeAgent" : "codex"),
      } as ProviderInstance),
  }),
  BotProjectGuard.layer,
  Scheduler.layer,
  ServerSettings.layerTest(),
);

const layerDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const seedProjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [projectId, title] of [
    [campaignA, "Campaign A"],
    [campaignB, "Campaign B"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, ${title}, ${`/campaigns/${projectId}`}, NULL,
        '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      )
    `;
  }
});

/** Builds the services fresh, as a server restart over the same database would. */
const withServices = <A, E>(
  threadLayer: Layer.Layer<
    ThreadManagementService.ThreadManagementService | ThreadLaunchService.ThreadLaunchService
  >,
  body: (services: {
    readonly bots: BotService.BotService["Service"];
    readonly turnContext: BotTurnContext.BotTurnContext["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const turnContext = yield* BotTurnContext.BotTurnContext;
    return yield* body({ bots, turnContext });
  }).pipe(
    Effect.provide(
      Layer.merge(BotService.layer, BotTurnContext.layer).pipe(
        Layer.provide(Layer.merge(threadLayer, layerSupport)),
      ),
    ),
    Effect.scoped,
  );

const instructionsFor = Effect.fn("BotServiceTest.instructionsFor")(function* (
  turnContext: BotTurnContext.BotTurnContext["Service"],
  threadId: ThreadId,
) {
  const result = yield* turnContext.forThread(threadId);
  return result._tag === "active" ? result.instructions : result._tag;
});

const createCampaignBot = (bots: BotService.BotService["Service"]) =>
  bots.create({
    botId,
    name: "Faerun Companion",
    instructions: "Answer as the campaign companion.",
    modelSelection: codex,
    learningPolicy: "after_adoption",
  });

it.effect(
  "serves two campaigns with separate conversations and instructions across a restart",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const world = yield* makeThreadWorld;
      const homes = yield* withServices(world.threadLayer, ({ bots }) =>
        Effect.gen(function* () {
          yield* createCampaignBot(bots);
          yield* bots.attachProject({
            botId,
            projectId: campaignA,
            guidance: "Strahd is alive in this campaign.",
            sources: [{ label: "Campaign A vault", location: "/vaults/a" }],
          });
          const detail = yield* bots.attachProject({
            botId,
            projectId: campaignB,
            guidance: "Strahd was defeated in this campaign.",
          });
          const [a, b] = detail.projects;
          assert.notEqual(a?.homeThreadId, b?.homeThreadId);
          return { a: a?.homeThreadId ?? assert.fail(), b: b?.homeThreadId ?? assert.fail() };
        }),
      );

      yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
        Effect.gen(function* () {
          const a = yield* instructionsFor(turnContext, homes.a);
          assert.include(a, "Strahd is alive");
          assert.include(a, 'project "Campaign A"');
          assert.include(a, "- Campaign A vault: /vaults/a");
          assert.notInclude(a, "Strahd was defeated");
          const b = yield* instructionsFor(turnContext, homes.b);
          assert.include(b, "Strahd was defeated");
          assert.notInclude(b, "Strahd is alive");
          assert.equal(yield* instructionsFor(turnContext, ThreadId.make("plain")), "none");

          // Edits reach the next turn without touching the provider session.
          yield* bots.updateProjectContext({
            botId,
            projectId: campaignA,
            guidance: "Strahd fled to the Amber Temple.",
          });
          assert.include(yield* instructionsFor(turnContext, homes.a), "Amber Temple");

          // A repeated attach keeps the existing conversation.
          yield* bots.attachProject({ botId, projectId: campaignA });
        }),
      );
      const created = (yield* Ref.get(world.commands)).filter((type) => type === "thread.create");
      assert.lengthOf(created, 2);
      const threads = yield* Ref.get(world.threads);
      assert.equal(threads.get(homes.a)?.projectId, campaignA);
      assert.equal(threads.get(homes.b)?.projectId, campaignB);
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("archive blocks the conversations and restore reopens them", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        const detail = yield* bots.attachProject({ botId, projectId: campaignA });
        const home = detail.projects[0]?.homeThreadId ?? assert.fail();

        const archived = yield* bots.setArchived({ botId, archived: true });
        assert.isNotNull(archived.archivedAt);
        assert.isTrue((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.equal(yield* instructionsFor(turnContext, home), "inactive");
        const edit = yield* bots.update({ botId, name: "Renamed" }).pipe(Effect.flip);
        assert.include(edit.message, "archived");

        yield* bots.setArchived({ botId, archived: false });
        assert.isFalse((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.include(yield* instructionsFor(turnContext, home), "campaign companion");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("detach and reattach keep the same conversation and its guidance", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        const attached = yield* bots.attachProject({
          botId,
          projectId: campaignA,
          guidance: "Use the session log.",
        });
        const home = attached.projects[0]?.homeThreadId ?? assert.fail();

        const detached = yield* bots.detachProject({ botId, projectId: campaignA });
        assert.isNotNull(detached.projects[0]?.detachedAt);
        assert.isTrue((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.equal(yield* instructionsFor(turnContext, home), "inactive");
        // A model change while detached reaches the conversation on reattach.
        yield* bots.update({ botId, modelSelection: { ...codex, model: "gpt-5.5" } });
        assert.equal((yield* Ref.get(world.threads)).get(home)?.model, "gpt-5");

        const reattached = yield* bots.attachProject({ botId, projectId: campaignA });
        assert.equal(reattached.projects[0]?.homeThreadId, home);
        assert.isNull(reattached.projects[0]?.detachedAt);
        assert.isFalse((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.equal((yield* Ref.get(world.threads)).get(home)?.model, "gpt-5.5");
        assert.include(yield* instructionsFor(turnContext, home), "Use the session log.");
      }),
    );
    const created = (yield* Ref.get(world.commands)).filter((type) => type === "thread.create");
    assert.lengthOf(created, 1);
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("finishes an interrupted archive when the request is repeated", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        const detail = yield* bots.attachProject({ botId, projectId: campaignA });
        const home = detail.projects[0]?.homeThreadId ?? assert.fail();

        yield* Ref.set(world.failNext, "thread.archive");
        yield* bots.setArchived({ botId, archived: true }).pipe(Effect.exit);
        // The intent is recorded, so the conversation is already blocked.
        assert.isFalse((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.equal(yield* instructionsFor(turnContext, home), "inactive");

        yield* bots.setArchived({ botId, archived: true });
        assert.isTrue((yield* Ref.get(world.threads)).get(home)?.archived);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("moves home conversations to a new model and rejects providers without Bot support", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        const detail = yield* bots.attachProject({ botId, projectId: campaignA });
        const home = detail.projects[0]?.homeThreadId ?? assert.fail();

        yield* bots.update({ botId, modelSelection: { ...codex, model: "gpt-5.5" } });
        assert.equal((yield* Ref.get(world.threads)).get(home)?.model, "gpt-5.5");

        const claude = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" };
        const rejected = yield* bots.update({ botId, modelSelection: claude }).pipe(Effect.flip);
        assert.include(rejected.message, "Codex");
        const rejectedCreate = yield* bots
          .create({
            botId: BotId.make("other-bot"),
            name: "Other",
            instructions: "",
            modelSelection: claude,
            learningPolicy: "automatic",
          })
          .pipe(Effect.flip);
        assert.include(rejectedCreate.message, "Codex");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("selects the only attached project and asks when several match", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        yield* bots.attachProject({ botId, projectId: campaignA });
        assert.equal((yield* bots.resolveProject({ botId })).projectId, campaignA);

        yield* bots.attachProject({ botId, projectId: campaignB });
        const ambiguous = yield* bots.resolveProject({ botId }).pipe(Effect.flip);
        assert.include(ambiguous.message, "choose one");
        assert.equal(
          (yield* bots.resolveProject({ botId, projectId: campaignB })).projectId,
          campaignB,
        );
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);
