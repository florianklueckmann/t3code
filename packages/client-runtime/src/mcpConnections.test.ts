import {
  BotId,
  McpConnectionId,
  ProviderDriverKind,
  type BotMcpGrants,
  type BotSummary,
  type McpConnectionSummary,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botMcpGrantsChange,
  botMcpGrantsSection,
  mcpConnectionRemovalMessage,
  mcpConnectionUsedByText,
  mcpConnectionUsers,
} from "./mcpConnections.ts";

const MAIL = McpConnectionId.make("00000000-0000-4000-8000-000000000001");
const WORK = McpConnectionId.make("00000000-0000-4000-8000-000000000002");
const DOCS = McpConnectionId.make("00000000-0000-4000-8000-000000000003");
const GONE = McpConnectionId.make("00000000-0000-4000-8000-000000000004");
const BOT = BotId.make("bot-mail");

const connection = (
  id: McpConnectionId,
  label: string,
  patch: Partial<McpConnectionSummary> = {},
): McpConnectionSummary => ({
  id,
  label,
  enabled: true,
  revision: 1,
  transport: "http",
  status: { state: "ready" },
  ...patch,
});

const CATALOG = [
  connection(MAIL, "Private mail", { transport: "stdio" }),
  connection(WORK, "Work mail", { enabled: false }),
  connection(DOCS, "Docs", {
    status: { state: "blocked", problem: { reason: "binding-unresolved", binding: "TOKEN" } },
  }),
];

const routine = (botId: BotId, allowChanges: boolean | undefined) =>
  ({ bot: { botId, ...(allowChanges === undefined ? {} : { allowChanges }) } }) as ScheduledTask;

const section = (
  patch: Partial<Parameters<typeof botMcpGrantsSection>[0]> & {
    readonly granted?: McpConnectionId[];
  },
) =>
  botMcpGrantsSection({
    botId: BOT,
    grants: { revision: 3, connectionIds: patch.granted ?? [MAIL] },
    catalog: CATALOG,
    providerDriver: ProviderDriverKind.make("codex"),
    platformOs: "darwin",
    environmentLabel: "Studio Mac",
    routines: [],
    canChange: true,
    archived: false,
    ...patch,
  });

const noteTexts = (result: ReturnType<typeof botMcpGrantsSection>) =>
  result.notes.map((note) => note.text);

describe("botMcpGrantsSection", () => {
  it("lists the catalog in order, then granted connections it no longer has", () => {
    expect(
      section({ granted: [GONE, MAIL] }).rows.map((row) => [
        row.label,
        row.transport,
        row.granted,
        row.status.tone,
        row.status.text,
      ]),
    ).toEqual([
      ["Private mail", "stdio", true, "ok", "Credentials resolved"],
      [
        "Work mail",
        "http",
        false,
        "muted",
        "Disabled. The Bot doesn't load it until you enable it.",
      ],
      ["Docs", "http", false, "error", "TOKEN could not be read from its secret provider."],
      ["Removed connection", null, true, "muted", "Removed. The Bot no longer loads it."],
    ]);
  });

  const EMPTY =
    "This Bot has no MCP connections. Your Codex MCP servers are not available to Bots.";
  const PROVIDER_LIMIT =
    "MCP connections apply only to Codex on macOS. This Bot's model is not on a Codex provider, so without connections it uses that provider's own MCP setup. A Bot with connections does not run there.";
  const PLATFORM_LIMIT =
    "MCP connections apply only to Codex on macOS. On Studio Mac, this Bot without connections uses Codex's own MCP setup. A Bot with connections does not run there.";
  const claude = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");

  it.each([
    ["Claude, with grants", claude, "darwin", [MAIL], [PROVIDER_LIMIT]],
    ["Claude, without grants", claude, "darwin", [], [PROVIDER_LIMIT]],
    ["a missing instance", undefined, "darwin", [MAIL], [PROVIDER_LIMIT]],
    ["Codex on Linux, with grants", codex, "linux", [MAIL], [PLATFORM_LIMIT]],
    ["Codex on Linux, without grants", codex, "linux", [], [PLATFORM_LIMIT]],
    ["Codex on macOS, with grants", codex, "darwin", [MAIL], []],
    ["Codex on macOS, without grants", codex, "darwin", [], [EMPTY]],
  ] as const)(
    "with %s, says where grants apply and what runs instead",
    (_, providerDriver, platformOs, granted, expected) => {
      expect(
        noteTexts(section({ providerDriver, platformOs, granted: [...granted], routines: null })),
      ).toEqual([...expected, "Changes apply from the Bot's next turn."]);
    },
  );
  const READ_ONLY_TOOLS =
    "No changes routines use only the tools a connection marks as read-only. The connection's server sets that mark, so a tool marked read-only can still change things.";

  it.each([
    ["no grants", [], [routine(BOT, false)], [EMPTY]],
    ["only a removed grant", [GONE], [routine(BOT, false)], [EMPTY]],
    ["grants and a No changes routine", [MAIL], [routine(BOT, false)], [READ_ONLY_TOOLS]],
    [
      "grants and a routine with no changes by default",
      [MAIL],
      [routine(BOT, undefined)],
      [READ_ONLY_TOOLS],
    ],
    ["grants and a routine allowed changes", [MAIL], [routine(BOT, true)], []],
    [
      "grants and another Bot's No changes routine",
      [MAIL],
      [routine(BotId.make("bot-other"), false)],
      [],
    ],
    ["grants on a server without routines", [MAIL], null, []],
  ] as const)("with %s, notes only what applies", (_, granted, routines, expected) => {
    expect(noteTexts(section({ granted: [...granted], routines }))).toEqual([
      ...expected,
      "Changes apply from the Bot's next turn.",
    ]);
  });

  it("points to the catalog when it is empty", () => {
    expect(noteTexts(section({ catalog: [], granted: [] }))).toEqual([
      "Add connections in Settings → MCP connections.",
      EMPTY,
      "Changes apply from the Bot's next turn.",
    ]);
  });

  it.each([
    ["can change settings", true, false, true, false],
    ["lacks the settings grant", false, false, false, true],
    ["edits an archived Bot", true, true, false, false],
  ] as const)(
    "is editable only when the client %s and the Bot is active",
    (_, canChange, archived, editable, explains) => {
      const result = section({ canChange, archived });
      expect(result.editable).toBe(editable);
      expect(
        noteTexts(result).includes(
          "Changing a Bot's MCP connections needs permission to change settings on this environment.",
        ),
      ).toBe(explains);
    },
  );
});

describe("botMcpGrantsChange", () => {
  const grants: BotMcpGrants = { revision: 7, connectionIds: [DOCS, GONE] };

  it.each([
    ["grants one", { connectionId: MAIL, granted: true }, [MAIL, DOCS]],
    ["ungrants one", { connectionId: DOCS, granted: false }, []],
    ["ungrants a removed one", { connectionId: GONE, granted: false }, [DOCS]],
  ] as const)(
    "%s as the whole set in catalog order, on the revision it saw, without removed ids",
    (_, change, connectionIds) => {
      expect(botMcpGrantsChange(BOT, grants, CATALOG, change)).toEqual({
        botId: BOT,
        expectedRevision: 7,
        connectionIds,
      });
    },
  );
});

describe("mcpConnectionUsers", () => {
  const bot = (name: string, mcpGrants?: BotMcpGrants) =>
    ({ name, ...(mcpGrants === undefined ? {} : { mcpGrants }) }) as BotSummary;

  it("names the Bots granted each connection and says who loses it on removal", () => {
    const users = mcpConnectionUsers([
      bot("Work Bot", { revision: 1, connectionIds: [MAIL, WORK] }),
      bot("Mail Bot", { revision: 2, connectionIds: [MAIL] }),
      bot("Archive Bot", { revision: 1, connectionIds: [MAIL] }),
      bot("Plain Bot", { revision: 0, connectionIds: [] }),
    ]);
    expect(mcpConnectionUsedByText(users.get(MAIL))).toBe(
      "Used by Archive Bot, Mail Bot and Work Bot",
    );
    expect(mcpConnectionUsedByText(users.get(DOCS))).toBeNull();
    expect(mcpConnectionRemovalMessage(users.get(WORK))).toMatch(
      /^Work Bot loses this connection\. /,
    );
    expect(mcpConnectionRemovalMessage(users.get(MAIL))).toMatch(
      /^Archive Bot, Mail Bot and Work Bot lose this connection\. /,
    );
  });

  it("shows nothing new for a server without grants", () => {
    const users = mcpConnectionUsers([bot("Mail Bot")]);
    expect(users.size).toBe(0);
    expect(mcpConnectionUsedByText(users.get(MAIL))).toBeNull();
    expect(mcpConnectionRemovalMessage(users.get(MAIL))).toMatch(/^Its saved credentials/);
  });
});
