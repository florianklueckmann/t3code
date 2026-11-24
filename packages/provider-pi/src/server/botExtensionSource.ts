// No T3 imports inside the string; resolve Pi from the user's Pi install.
export const PI_T3_BOT_EXTENSION_FILENAME = "pi-t3-bot-extension.ts";
export const PI_T3_BOT_SESSION_COMMAND = "t3-bot-session";

/** What the adapter writes for the Bot session command: one JSON file, deleted once read. */
export interface PiBotSessionPayload {
  readonly instructions: string | null;
  /** Pi `mcpServers` entries by native server name. */
  readonly servers: Readonly<Record<string, PiBotMcpServer>>;
}

export type PiBotMcpServer =
  | {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    }
  | { readonly url: string; readonly headers: Readonly<Record<string, string>> };

/**
 * Loaded only in a Bot's Pi sessions, which run with --no-extensions: Pi's built-in MCP, which
 * always reads mcp.json, stays off, and this extension connects only the servers T3 Code grants.
 */
export const PI_T3_BOT_EXTENSION_SOURCE = `\
import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeFS from "node:fs";

const SESSION_COMMAND = ${JSON.stringify(PI_T3_BOT_SESSION_COMMAND)};

type McpExtensionFactory = (options: {
  loadConfig: () => { servers: never[]; errors: string[] };
}) => (pi: ExtensionAPI) => unknown;

export default async function t3BotExtension(pi: ExtensionAPI) {
  const createMcpExtension = (Pi as { createMcpExtension?: McpExtensionFactory }).createMcpExtension;
  const mcpAvailable =
    typeof createMcpExtension === "function" &&
    typeof pi.registerMcpServer === "function" &&
    typeof pi.unregisterMcpServer === "function";
  // Pi's own MCP client with no configured servers: it connects only the servers registered below.
  if (mcpAvailable) await createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) })(pi);

  let instructions: string | undefined;
  const registered = new Map<string, string>();

  pi.registerCommand(SESSION_COMMAND, {
    description: "Apply T3 Code's Bot instructions and granted MCP connections",
    handler: async (args, ctx) => {
      const path = args.trim();
      let payload: { instructions?: unknown; servers?: Record<string, Record<string, unknown>> };
      try {
        payload = JSON.parse(NodeFS.readFileSync(path, "utf8"));
      } finally {
        NodeFS.rmSync(path, { force: true });
      }
      instructions =
        typeof payload.instructions === "string" && payload.instructions.length > 0
          ? payload.instructions
          : undefined;
      const servers = payload.servers ?? {};
      if (!mcpAvailable) {
        if (Object.keys(servers).length > 0)
          ctx.ui.notify(
            "This Bot's MCP connections are unavailable: this Pi version cannot load them. Update Pi.",
            "error",
          );
        return;
      }
      for (const name of [...registered.keys()]) {
        if (name in servers) continue;
        pi.unregisterMcpServer(name);
        registered.delete(name);
      }
      for (const [name, server] of Object.entries(servers)) {
        // Declared directly: Pi's tool search and codemode are built-ins this session leaves off.
        const config = { ...server, exposure: "direct" };
        const key = JSON.stringify(config);
        if (registered.get(name) === key) continue;
        pi.registerMcpServer(name, config as Parameters<ExtensionAPI["registerMcpServer"]>[1]);
        registered.set(name, key);
      }
    },
  });

  pi.on("before_agent_start", (event) => {
    if (instructions === undefined) return;
    const sections = event.systemPromptOptions?.sections;
    if (sections && typeof sections === "object" && event.systemPromptOptions?.forceSystemPrompt === undefined) {
      sections.t3_bot_instructions = instructions;
      return undefined;
    }
    return { systemPrompt: event.systemPrompt + "\\n\\n" + instructions };
  });
}
`;
