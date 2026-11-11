import type { BotId, OrchestrationV2AppThreadLineage, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Which Bot's access a calling thread runs under, following forks and subagents to their Bot.
 * "unknown" when its line cannot be followed or its Bot cannot run.
 */
export type McpCallerBotValue =
  | { readonly _tag: "none" }
  | { readonly _tag: "bot"; readonly botId: BotId }
  | { readonly _tag: "unknown" };

export interface McpCallerBotThread {
  readonly id: ThreadId;
  readonly lineage: OrchestrationV2AppThreadLineage;
}

/**
 * Lets MCP tools ask without depending on the Bot services. Unprovided, every line is unknown, so
 * a lost provide refuses Bot-guarded work rather than allowing it.
 */
export class McpCallerBot extends Context.Reference<{
  readonly forThread: (thread: McpCallerBotThread) => Effect.Effect<McpCallerBotValue>;
}>("t3/mcp/McpCallerBot", {
  defaultValue: () => ({ forThread: () => Effect.succeed({ _tag: "unknown" }) }),
}) {}
