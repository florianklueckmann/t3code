import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

type RevertClient = Pick<CodexClient.CodexAppServerClient["Service"], "request">;

/**
 * Walks the thread's turns newest first and returns the oldest one to revert, which
 * `thread/revert` takes as its boundary. `classify` stops the walk at a kept turn or at the last
 * turn to revert.
 */
const findRevertBoundary = Effect.fnUntraced(function* (
  client: RevertClient,
  threadId: string,
  pageLimit: (walked: number) => number,
  classify: (turnId: string, walked: number) => "keep" | "revert" | "last",
) {
  let walked = 0;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (true) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: pageLimit(walked),
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      const decision = classify(turn.id, walked);
      if (decision === "keep") return { beforeTurnId, reached: true };
      beforeTurnId = turn.id;
      walked += 1;
      if (decision === "last") return { beforeTurnId, reached: true };
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) return { beforeTurnId, reached: false };
  }
});

const revertBefore = (client: RevertClient, threadId: string, beforeTurnId: string | undefined) =>
  beforeTurnId === undefined
    ? client.request("thread/read", { threadId, includeTurns: false })
    : client.request("thread/revert", { threadId, beforeTurnId });

export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: RevertClient,
  threadId: string,
  numTurns: number,
) {
  if (numTurns <= 0) return yield* revertBefore(client, threadId, undefined);
  const { beforeTurnId } = yield* findRevertBoundary(
    client,
    threadId,
    (walked) => Math.min(numTurns - walked, 100),
    (_turnId, walked) => (walked + 1 === numTurns ? "last" : "revert"),
  );
  return yield* revertBefore(client, threadId, beforeTurnId);
});

/**
 * Reverts every native turn newer than the newest one in `keepTurnIds` (the target turn and the
 * turns T3 recorded before it). Codex can hold turns T3 never recorded, so counting T3's turns can
 * stop short; native ids cannot. A conversation recovery can drop the target itself, so the newest
 * surviving earlier turn is kept, and a conversation with none of them is reverted entirely.
 */
export const revertCodexThreadAfter = Effect.fn("revertCodexThreadAfter")(function* (
  client: RevertClient,
  threadId: string,
  keepTurnIds: ReadonlySet<string>,
) {
  const { beforeTurnId } = yield* findRevertBoundary(
    client,
    threadId,
    () => 100,
    (turnId) => (keepTurnIds.has(turnId) ? "keep" : "revert"),
  );
  return yield* revertBefore(client, threadId, beforeTurnId);
});
