// No T3 imports inside the string; resolve Pi from the user's Pi install.
export const PI_T3_BOT_EXTENSION_FILENAME = "pi-t3-bot-extension.ts";
export const PI_T3_BOT_SESSION_COMMAND = "t3-bot-session";
/** Written next to the payload once applied: the command's answer cannot say whether it failed. */
export const PI_T3_BOT_SESSION_ACK_SUFFIX = ".applied";

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
const ACK_SUFFIX = ${JSON.stringify(PI_T3_BOT_SESSION_ACK_SUFFIX)};

type McpExtensionFactory = (options: {
  loadConfig: () => { servers: never[]; errors: string[] };
  credentials: unknown;
}) => (pi: ExtensionAPI) => unknown;

export default async function t3BotExtension(pi: ExtensionAPI) {
  const createMcpExtension = (Pi as { createMcpExtension?: McpExtensionFactory }).createMcpExtension;
  const mcpAvailable =
    typeof createMcpExtension === "function" &&
    typeof pi.registerMcpServer === "function" &&
    typeof pi.unregisterMcpServer === "function";
  // Pi's own MCP client with no configured servers: it connects only the servers registered below.
  // Its OAuth store lives only in this session, so a grant never picks up the user's Pi sign-ins.
  const oauth = new Map<string, { tokens?: unknown }>();
  const credentials = {
    forServer: (name: string, url: string) => ({
      load: () => oauth.get(name + " " + url),
      save: (state: { tokens?: unknown }) => void oauth.set(name + " " + url, state),
      withRefreshLock: <T>(fn: () => Promise<T>) => fn(),
    }),
    tokens: (name: string, url: string) => oauth.get(name + " " + url)?.tokens,
    remove: (name: string, url: string) => oauth.delete(name + " " + url),
  };
  if (mcpAvailable)
    await createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), credentials })(pi);

  let instructions: string | undefined;
  const registered = new Map<string, string>();

  const apply = async (path: string) => {
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
        throw new Error("this Pi version cannot load MCP connections. Update Pi.");
      return;
    }
    for (const name of [...registered.keys()]) {
      if (name in servers) continue;
      pi.unregisterMcpServer(name);
      registered.delete(name);
    }
    const changed: string[] = [];
    for (const [name, server] of Object.entries(servers)) {
      // Declared directly: Pi's tool search and codemode are built-ins this session leaves off.
      const config = { ...server, exposure: "direct" };
      const key = JSON.stringify(config);
      if (registered.get(name) === key) continue;
      changed.push("mcp__" + name.replace(/[^A-Za-z0-9_]/g, "_") + "__");
      pi.registerMcpServer(name, config as Parameters<ExtensionAPI["registerMcpServer"]>[1]);
      registered.set(name, key);
    }
    // Pi connects a new or replaced server in the background and hides a replaced one's tools until
    // it lists them again; give them a bounded chance to reach this turn.
    const deadline = Date.now() + 10_000;
    const listed = (prefix: string) =>
      pi.getAllTools().some((tool) => tool.name.startsWith(prefix) && tool.exposure !== "hidden");
    while (changed.some((prefix) => !listed(prefix)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  pi.registerCommand(SESSION_COMMAND, {
    description: "Apply T3 Code's Bot instructions and granted MCP connections",
    handler: async (args, ctx) => {
      const path = args.trim();
      try {
        await apply(path);
        // Pi answers "handled" even when this throws, so the adapter waits for this mark instead.
        NodeFS.writeFileSync(path + ACK_SUFFIX, "");
      } catch (error) {
        // Fail closed: never keep connections or instructions this turn may no longer have.
        instructions = undefined;
        for (const name of registered.keys()) pi.unregisterMcpServer(name);
        registered.clear();
        ctx.ui.notify(
          "This Bot's MCP connections and instructions could not be loaded: " +
            (error instanceof Error ? error.message : String(error)),
          "error",
        );
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
