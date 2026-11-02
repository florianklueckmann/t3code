import type { ProjectId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BotStore from "./BotStore.ts";

/**
 * Serializes attaching a Bot to a project with deleting that project, so a
 * delete never misses an attachment made while it runs. Both sides must use
 * the same instance; the server builds this layer once.
 */
export class BotProjectGuard extends Context.Service<
  BotProjectGuard,
  {
    readonly withProjectLock: <A, E, R>(
      projectId: ProjectId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly attachedBotNames: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, BotStore.BotStoreError>;
    readonly forgetProject: (projectId: ProjectId) => Effect.Effect<void, BotStore.BotStoreError>;
  }
>()("t3/bots/BotProjectGuard") {}

export const layer = Layer.effect(
  BotProjectGuard,
  Effect.gen(function* () {
    const store = yield* BotStore.BotStore;
    const locks = yield* KeyedLock.make<ProjectId>();
    return BotProjectGuard.of({
      withProjectLock: locks.withLock,
      attachedBotNames: store.attachedBotNames,
      forgetProject: store.deleteContextsForProject,
    });
  }),
).pipe(Layer.provide(BotStore.layer));
