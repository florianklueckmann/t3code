// @effect-diagnostics nodeBuiltinImport:off - a standalone stdio MCP fixture that Codex starts.
/**
 * A synthetic mail account as a stdio MCP server. Every account offers the same tool with the same
 * text, so only the label T3 sends tells two accounts apart. Each call is appended to
 * `MAIL_CALL_LOG` as `{"account": MAIL_ACCOUNT, "tool", "arguments"}`, which the eval grades.
 */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const MAIL_TOOL = "search_inbox";
const CANNED_INBOX =
  "1 unread message. From sam@example.com, subject 'Lunch on Friday?': 'Are we still on for Friday?'";

const account = process.env.MAIL_ACCOUNT ?? "";
const callLog = process.env.MAIL_CALL_LOG ?? "";

const reply = (id: unknown, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

const handle = (message: {
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: { readonly protocolVersion?: string; readonly arguments?: unknown };
}) => {
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mail", version: "1.0.0" },
      });
    case "ping":
      return reply(message.id, {});
    case "tools/list":
      return reply(message.id, {
        tools: [
          {
            name: MAIL_TOOL,
            description: "Searches the mailbox and returns matching messages, newest first.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Words to match; empty for all." },
              },
            },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    case "tools/call":
      NodeFS.appendFileSync(
        callLog,
        `${JSON.stringify({ account, tool: MAIL_TOOL, arguments: message.params?.arguments ?? null })}\n`,
      );
      return reply(message.id, { content: [{ type: "text", text: CANNED_INBOX }] });
    default:
      return process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`,
      );
  }
};

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() !== "") handle(JSON.parse(line));
});
