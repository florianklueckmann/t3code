import {
  BotId,
  McpConnectionId,
  ProviderDriverKind,
  type BotMcpGrants,
  type BotSetMcpGrantsInput,
  type BotSummary,
  type McpConnectionSummary,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botMcpGrantsChange,
  botMcpGrantsSection,
  codexMcpServerNames,
  latestBotMcpGrants,
  mcpConnectionRemovalMessage,
  mcpConnectionUsage,
  mcpConnectionUsedByText,
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
    readonly ownServers?: boolean;
  },
) =>
  botMcpGrantsSection({
    botId: BOT,
    grants: {
      revision: 3,
      connectionIds: patch.granted ?? [MAIL],
      ...(patch.ownServers === undefined ? {} : { ownCodexMcpServers: patch.ownServers }),
    },
    codexMcpServerNames: ["docs", "probe"],
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

  const EMPTY = "This Bot has no MCP connections.";
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

  it.each([
    ["a server without the switch", undefined, ["probe"], null],
    [
      "the switch off",
      false,
      ["docs", "probe"],
      { on: false, description: "Also loads docs and probe from your Codex config." },
    ],
    [
      "the switch on",
      true,
      ["probe"],
      { on: true, description: "Also loads probe from your Codex config." },
    ],
    [
      "no servers in the Codex config",
      false,
      [],
      { on: false, description: "Your Codex config has no MCP servers." },
    ],
    [
      "servers Codex has not reported",
      true,
      null,
      { on: true, description: "Also loads the MCP servers in your Codex config." },
    ],
  ] as const)("shows the own-servers switch with %s", (_, ownServers, names, expected) => {
    const result = section({
      ...(ownServers === undefined ? {} : { ownServers }),
      codexMcpServerNames: names === null ? null : [...names],
    });
    expect(result.ownServers).toEqual(
      expected === null ? null : { label: "Use my own Codex MCP servers", ...expected },
    );
  });

  it("drops the empty note while the Bot uses its own Codex MCP servers", () => {
    expect(noteTexts(section({ granted: [], ownServers: true }))).toEqual([
      "Changes apply from the Bot's next turn.",
    ]);
  });

  it("points to the catalog when it is empty", () => {
    expect(noteTexts(section({ catalog: [], granted: [] }))).toEqual([
      "No connections yet. Add one to grant it to this Bot.",
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

  const NEW = McpConnectionId.make("00000000-0000-4000-8000-000000000005");

  it.each([
    ["grants one", { connectionId: MAIL, granted: true }, [MAIL, DOCS], {}],
    ["ungrants one", { connectionId: DOCS, granted: false }, [], {}],
    ["ungrants a removed one", { connectionId: GONE, granted: false }, [DOCS], {}],
    // Added from the Bot's section: this client's catalog has not caught up with it yet.
    ["grants one just added", { connectionId: NEW, granted: true }, [DOCS, NEW], {}],
    [
      "switches its own Codex MCP servers on",
      { ownCodexMcpServers: true },
      [DOCS],
      { ownCodexMcpServers: true },
    ],
  ] as const)(
    "%s as the whole set in catalog order, on the revision it saw, without removed ids",
    (_, change, connectionIds, switched) => {
      expect(botMcpGrantsChange(BOT, grants, CATALOG, change)).toEqual({
        botId: BOT,
        expectedRevision: 7,
        connectionIds,
        ...switched,
      });
    },
  );
});

describe("codexMcpServerNames", () => {
  const provider = (driver: string, enabled: boolean, mcpServerNames?: ReadonlyArray<string>) => ({
    driver: ProviderDriverKind.make(driver),
    enabled,
    ...(mcpServerNames === undefined ? {} : { mcpServerNames }),
  });

  it.each([
    ["no Codex provider reports them", [provider("codex", true)], null],
    [
      "enabled Codex providers report them",
      [
        provider("codex", true, ["probe", "docs"]),
        provider("codex", true, ["docs", "mail"]),
        provider("codex", false, ["off"]),
        provider("claudeAgent", true, ["claude-only"]),
      ],
      ["docs", "mail", "probe"],
    ],
    ["the Codex config has none", [provider("codex", true, [])], []],
  ] as const)("names each server once when %s", (_, providers, expected) => {
    expect(codexMcpServerNames(providers)).toEqual(expected);
  });
});

describe("latestBotMcpGrants", () => {
  // The server's compare-and-set: a save on any other revision than the saved one is refused.
  const serverGrants = (initial: BotMcpGrants) => {
    let saved = initial;
    return {
      saved: () => saved,
      save: (input: BotSetMcpGrantsInput): BotMcpGrants | null => {
        if (input.expectedRevision !== saved.revision) return null;
        saved = { revision: saved.revision + 1, connectionIds: input.connectionIds };
        return saved;
      },
    };
  };
  const toggle = (
    live: BotMcpGrants,
    acknowledged: BotMcpGrants | null,
    connectionId: McpConnectionId,
  ) =>
    botMcpGrantsChange(BOT, latestBotMcpGrants(live, acknowledged), CATALOG, {
      connectionId,
      granted: true,
    });

  it("saves consecutive toggles before the live Bot list delivers the first save", () => {
    const live: BotMcpGrants = { revision: 0, connectionIds: [] };
    const server = serverGrants(live);
    let acknowledged: BotMcpGrants | null = null;
    for (const connectionId of [MAIL, DOCS]) {
      acknowledged = server.save(toggle(live, acknowledged, connectionId));
      expect(acknowledged).not.toBeNull();
    }
    expect(server.saved()).toEqual({ revision: 2, connectionIds: [MAIL, DOCS] });
    expect(latestBotMcpGrants(live, acknowledged)).toEqual(server.saved());
    const caughtUp = { revision: 2, connectionIds: [MAIL, DOCS] };
    expect(latestBotMcpGrants(caughtUp, acknowledged)).toBe(caughtUp);
  });

  it("refuses a toggle over another client's change, then shows and saves on the live set", () => {
    const server = serverGrants({ revision: 0, connectionIds: [] });
    const acknowledged = server.save(toggle({ revision: 0, connectionIds: [] }, null, MAIL));
    const otherClient = server.save({ botId: BOT, expectedRevision: 1, connectionIds: [WORK] });
    expect(otherClient).toEqual({ revision: 2, connectionIds: [WORK] });

    const stale = { revision: 0, connectionIds: [] };
    expect(server.save(toggle(stale, acknowledged, DOCS))).toBeNull();

    const live = { revision: 2, connectionIds: [WORK] };
    expect(latestBotMcpGrants(live, acknowledged)).toBe(live);
    expect(server.save(toggle(live, acknowledged, DOCS))).toEqual({
      revision: 3,
      connectionIds: [WORK, DOCS],
    });
  });
});

describe("mcpConnectionUsage", () => {
  const bot = (name: string, mcpGrants?: BotMcpGrants) =>
    ({ name, ...(mcpGrants === undefined ? {} : { mcpGrants }) }) as BotSummary;
  const BOTS = [
    bot("Work Bot", { revision: 1, connectionIds: [MAIL, WORK] }),
    bot("Mail Bot", { revision: 2, connectionIds: [MAIL] }),
    bot("Archive Bot", { revision: 1, connectionIds: [MAIL] }),
    bot("Plain Bot", { revision: 0, connectionIds: [] }),
  ];

  it("names the Bots granted each connection and says who loses it on removal", () => {
    const usage = mcpConnectionUsage({ botsSupported: true, bots: BOTS, error: null });
    expect(mcpConnectionUsedByText(usage, MAIL)).toBe("Used by Archive Bot, Mail Bot and Work Bot");
    expect(mcpConnectionUsedByText(usage, DOCS)).toBeNull();
    expect(mcpConnectionRemovalMessage(usage, WORK)).toMatch(/^Work Bot loses this connection\. /);
    expect(mcpConnectionRemovalMessage(usage, MAIL)).toMatch(
      /^Archive Bot, Mail Bot and Work Bot lose this connection\. /,
    );
    expect(mcpConnectionRemovalMessage(usage, DOCS)).toMatch(/^Its saved credentials/);
  });

  it.each([
    ["while the Bot list loads", null, { state: "loading" }],
    ["when the Bot list failed", "Connection lost", { state: "failed", error: "Connection lost" }],
  ] as const)("cannot confirm a removal %s", (_, error, state) => {
    const usage = mcpConnectionUsage({ botsSupported: true, bots: null, error });
    expect(usage).toEqual(state);
    expect(mcpConnectionUsedByText(usage, MAIL)).toBeNull();
    expect(mcpConnectionRemovalMessage(usage, MAIL)).toBeNull();
  });

  it.each([
    ["a server without grants", { botsSupported: true, bots: [bot("Mail Bot")], error: null }],
    ["a server without Bots", { botsSupported: false, bots: null, error: null }],
  ])("confirms a removal without names on %s", (_, input) => {
    const usage = mcpConnectionUsage(input);
    expect(mcpConnectionUsedByText(usage, MAIL)).toBeNull();
    expect(mcpConnectionRemovalMessage(usage, MAIL)).toMatch(/^Its saved credentials/);
  });
});
