import {
  botProjectKeys,
  botRailKeys,
  isBotInProjectScope,
  threadsHiddenByProjectScope,
} from "@t3tools/client-runtime/state/project-areas";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  isListedThreadLineage,
  mayBeBotHomeThreadId,
  type EnvironmentId,
} from "@t3tools/contracts";

import {
  resolveThreadListV2Attention,
  threadListV2AttentionUrgency,
  type ThreadListV2Attention,
} from "../threads/threadListV2";

type ScopedBots = ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly bot: {
    readonly id: string;
    readonly archivedAt: unknown;
    readonly projects: ReadonlyArray<{
      readonly projectId: string;
      readonly homeThreadId: string;
      readonly detachedAt: unknown;
    }>;
    /** The Bot's own Home, which follows the Bot rather than an area. */
    readonly home?: { readonly homeThreadId: string } | null;
  };
}>;

const isHomeOf = (
  { environmentId, bot }: ScopedBots[number],
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
) =>
  environmentId === thread.environmentId &&
  (bot.home?.homeThreadId === thread.id ||
    bot.projects.some((context) => context.homeThreadId === thread.id));

/**
 * The dot on the project filter while an area hides part of the list: the most urgent state among
 * hidden threads and the Homes of Bots the row hides. Settled, snoozed and working threads stay quiet.
 */
export function resolveHomeAreaDot(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly scopedProjectKeys: ReadonlySet<string>;
  readonly bots: ScopedBots;
  readonly environmentId: EnvironmentId | null;
  readonly now: string;
}): Exclude<ThreadListV2Attention, "working"> | null {
  let dot: Exclude<ThreadListV2Attention, "working"> | null = null;
  const hidden = threadsHiddenByProjectScope(
    input.threads,
    input.scopedProjectKeys,
    botRailKeys(input.bots, input.scopedProjectKeys),
  );
  for (const thread of hidden) {
    const isHome = mayBeBotHomeThreadId(thread.id);
    // The Bot row spans every environment, so only list threads follow the environment filter.
    // A Home counts only while its Bot is one the row could show, not a cached disconnected one.
    if (
      (isHome && !input.bots.some((entry) => isHomeOf(entry, thread))) ||
      (!isHome && input.environmentId !== null && thread.environmentId !== input.environmentId) ||
      thread.settledOverride === "settled" ||
      effectiveSnoozed(thread, { now: input.now }) ||
      !(isHome || isListedThreadLineage(thread.lineage))
    ) {
      continue;
    }
    const attention = resolveThreadListV2Attention(thread);
    if (
      attention !== null &&
      attention !== "working" &&
      threadListV2AttentionUrgency(attention) > threadListV2AttentionUrgency(dot)
    ) {
      dot = attention;
    }
  }
  return dot;
}

/**
 * Whether opening this thread must leave the area: its project is outside it, or it is the Home of
 * a Bot the row hides. Null while that Home's Bot has not loaded, so it can be judged later.
 */
export function opensOutsideHomeArea(input: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId">;
  readonly scopedProjectKeys: ReadonlySet<string>;
  readonly bots: ScopedBots;
}): boolean | null {
  const { thread } = input;
  if (!mayBeBotHomeThreadId(thread.id)) {
    return !input.scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`);
  }
  const entry = input.bots.find((candidate) => isHomeOf(candidate, thread));
  if (entry === undefined) return null;
  return !isBotInProjectScope(
    botProjectKeys(entry.bot, entry.environmentId),
    input.scopedProjectKeys,
  );
}
