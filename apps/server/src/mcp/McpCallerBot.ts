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

/** Lets MCP tools ask without depending on the Bot services. A server without Bots has none. */
export class McpCallerBot extends Context.Reference<{
  readonly forThread: (thread: {
    readonly id: ThreadId;
    readonly lineage: OrchestrationV2AppThreadLineage;
  }) => Effect.Effect<McpCallerBotValue>;
}>("t3/mcp/McpCallerBot", {
  defaultValue: () => ({ forThread: () => Effect.succeed({ _tag: "none" }) }),
}) {}
