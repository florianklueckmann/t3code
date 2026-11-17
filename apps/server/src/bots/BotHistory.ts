import {
  BotError,
  type MessageId,
  type OrchestrationThreadSearchSource,
  type ThreadId,
} from "@t3tools/contracts";
import { findSearchTokenRanges, messageSearchTokens } from "@t3tools/shared/paletteSearch";
import * as Effect from "effect/Effect";

import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as BotService from "./BotService.ts";
import type { BotTurnScope } from "./BotTurnContext.ts";

/** One search shows a few excerpts, never a transcript; paging stops at `reachable`. */
export const HOME_HISTORY_LIMITS = { page: 5, excerptChars: 500, reachable: 25 } as const;
const EXCERPT_LEAD = 160;
/** A model's query rarely needs more words; each is one more search when none matches all. */
const MAX_WORDS = 6;

/** The word as the message spells it, since find in a thread matches accents as written. */
const asWritten = (text: string, word: string) => {
  const range = findSearchTokenRanges(text, word)[0];
  return range === undefined ? word : text.slice(range.start, range.end);
};

/**
 * When no message has every word, the messages with most of them, each in its search's order.
 * Models describe a fact in more words than the message that holds it.
 */
const anyWordHits = Effect.fn("BotHistory.anyWordHits")(function* <E>(
  words: ReadonlyArray<string>,
  search: (query: string) => Effect.Effect<ReadonlyArray<ThreadSearch.ThreadMessageHit> | null, E>,
) {
  const byMessage = new Map<
    MessageId,
    { hit: ThreadSearch.ThreadMessageHit; found: Array<string>; first: number }
  >();
  for (const word of words) {
    for (const hit of (yield* search(word)) ?? []) {
      const seen = byMessage.get(hit.messageId);
      if (seen === undefined) {
        byMessage.set(hit.messageId, { hit, found: [word], first: byMessage.size });
      } else {
        seen.found.push(word);
      }
    }
  }
  return [...byMessage.values()]
    .sort((left, right) => right.found.length - left.found.length || left.first - right.first)
    .map(({ hit, found }) => ({ hit, find: longestWord(found) }));
});

const longestWord = (words: ReadonlyArray<string>) =>
  words.reduce((best, word) => (word.length > best.length ? word : best), "");

export interface HomeHistoryMatch {
  readonly messageId: MessageId;
  readonly role: OrchestrationThreadSearchSource;
  readonly at: string | null;
  readonly excerpt: string;
  /** A word of the query the message contains, for opening it at the match. */
  readonly find: string;
}

export type HomeHistory =
  | { readonly outcome: "unavailable"; readonly scope: BotTurnScope }
  | {
      readonly outcome: "found" | "no_matches";
      readonly scope: BotTurnScope;
      readonly matches: ReadonlyArray<HomeHistoryMatch>;
      readonly nextCursor: number | null;
      /** Matches exist past the last page this search reaches. */
      readonly beyondReach: boolean;
    };

/**
 * Searches the Home of the Bot and project the calling thread belongs to. The caller names
 * no Bot, project or thread, so it cannot widen what it reads.
 */
export const searchHomeHistory = Effect.fn("BotHistory.searchHomeHistory")(function* (input: {
  readonly callerThreadId: ThreadId;
  readonly query: string;
  readonly cursor?: number | undefined;
}) {
  const bots = yield* BotService.BotService;
  const threadSearch = yield* ThreadSearch.ThreadSearch;
  const scope = yield* bots.scopeOfThread(input.callerThreadId);
  if (scope === undefined) {
    return yield* new BotError({
      message:
        "Only a Bot's Home or work thread can search its earlier Home conversation; this thread is neither.",
    });
  }
  if (scope === "inactive") {
    return yield* new BotError({
      message:
        "This Bot is archived or detached from this project, so its Home history cannot be searched.",
    });
  }
  const search = (query: string) =>
    threadSearch
      .searchThreadMessages({ threadId: scope.homeThreadId, query })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BotError({ message: "Home history search failed.", botId: scope.botId, cause }),
        ),
      );
  const all = yield* search(input.query);
  if (all === null) return { outcome: "unavailable", scope } satisfies HomeHistory;
  const words = [...new Set(messageSearchTokens(input.query).long)].slice(0, MAX_WORDS);
  const hits =
    all.length > 0 || words.length < 2
      ? all.map((hit) => ({ hit, find: longestWord(words) }))
      : yield* anyWordHits(words, search);
  const { page, excerptChars, reachable } = HOME_HISTORY_LIMITS;
  const start = Math.min(input.cursor ?? 0, reachable);
  const end = Math.min(start + page, reachable, hits.length);
  return {
    outcome: hits.length === 0 ? "no_matches" : "found",
    scope,
    matches: hits.slice(start, end).map(({ hit, find }) => ({
      messageId: hit.messageId,
      role: hit.source,
      at: hit.messageCreatedAt,
      excerpt: ThreadSearch.buildSearchSnippet(hit.text, hit.offset, {
        length: excerptChars,
        lead: EXCERPT_LEAD,
      }),
      find: asWritten(hit.text, find),
    })),
    nextCursor: end < Math.min(reachable, hits.length) ? end : null,
    beyondReach: hits.length > reachable && end >= reachable,
  } satisfies HomeHistory;
});
