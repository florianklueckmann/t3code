import type {
  MessageSenderNames,
  OrchestrationV2ConversationMessage,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as BotTurnContext from "../bots/BotTurnContext.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

/** A failed lookup leaves the sender named by thread id; it never holds up the turn. */
export const loadMessageSenderNames = Effect.fn("loadMessageSenderNames")(function* (
  services: {
    readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
    readonly bots: BotTurnContext.BotTurnContext["Service"];
  },
  message: Pick<OrchestrationV2ConversationMessage, "createdBy" | "senderThreadId">,
) {
  const senderThreadId: ThreadId | undefined = message.senderThreadId;
  if (message.createdBy !== "agent" || senderThreadId === undefined) return {};
  return yield* Effect.all(
    {
      threadTitle: services.projections
        .getThreadTitles([senderThreadId])
        .pipe(Effect.map((titles) => titles[senderThreadId])),
      botName: services.bots.botNameOfThread(senderThreadId),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("message-sender-names.lookup-failed", { senderThreadId, cause }).pipe(
        Effect.as<MessageSenderNames>({}),
      ),
    ),
  );
});
