import { MessageId } from "@t3tools/contracts";
import {
  botContinuationDraft,
  parseBotContinuationDraft,
  botContinuationWriterLabel,
  botContinuationRefCaption,
  botMaintenanceStatusLabel,
  canToggleBotMaintenance,
} from "./bots.ts";
import {
  BotId,
  type BotLearningEntry,
  BotLearningEntryId,
  type BotLearningRevision,
  type BotSummary,
  BotTaskId,
  type BotTaskStatus,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botLearningLeftOut,
  botLearningRevisionInput,
  botOfHomeThread,
  botProjectContextChanges,
  botProjectContextDraft,
  botRoutineDraft,
  botRoutineUpsertInput,
  botSourceDrafts,
  botTaskCardKey,
  botTaskResultMatchesThread,
  emptyBotSourceDraft,
  type HiddenBotTaskCards,
  hideBotTaskCard,
  homeBotTaskCards,
  parseBotSourceDrafts,
  rankBotConversations,
  showBotTaskCards,
} from "./bots.ts";

const draft = (label: string, location: string) => ({ ...emptyBotSourceDraft(), label, location });

describe("parseBotSourceDrafts", () => {
  it("trims rows and drops blank ones", () => {
    expect(
      parseBotSourceDrafts([
        draft("  Docs ", " https://docs.example.com "),
        draft("", "  "),
        draft("Runbook", "docs/runbook.md"),
      ]),
    ).toEqual({
      sources: [
        { label: "Docs", location: "https://docs.example.com" },
        { label: "Runbook", location: "docs/runbook.md" },
      ],
    });
  });

  it.each([
    ["label only", draft("Docs", " ")],
    ["location only", draft("", "https://docs.example.com")],
  ])("rejects a row with %s", (_case, row) => {
    expect(parseBotSourceDrafts([row])).toHaveProperty("error");
  });
});

describe("botProjectContextChanges", () => {
  const saved = {
    guidance: "Answer in English.",
    sources: [{ label: "Docs", location: "https://docs.example.com" }],
  };

  it("reports nothing for an untouched or whitespace-only edit", () => {
    expect(botProjectContextChanges(botProjectContextDraft(saved), saved)).toBeNull();
    expect(
      botProjectContextChanges(
        {
          guidance: " Answer in English.\n",
          sources: [...botSourceDrafts(saved.sources), emptyBotSourceDraft()],
        },
        saved,
      ),
    ).toBeNull();
  });

  it("sends only the fields that changed", () => {
    expect(
      botProjectContextChanges({ ...botProjectContextDraft(saved), guidance: "Be brief." }, saved),
    ).toEqual({ guidance: "Be brief." });
    expect(botProjectContextChanges({ guidance: saved.guidance, sources: [] }, saved)).toEqual({
      sources: [],
    });
  });
});

describe("botOfHomeThread", () => {
  const home = { id: "bot-home:companion:campaign-a", projectId: "campaign-a" };
  const bot = (overrides: { archivedAt?: string; detachedAt?: string } = {}): BotSummary => ({
    id: BotId.make("companion"),
    name: "Companion",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    learningPolicy: "after_adoption",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    pendingLearning: 0,
    projects: [
      {
        projectId: ProjectId.make(home.projectId),
        homeThreadId: ThreadId.make(home.id),
        attachedAt: "2026-01-01T00:00:00.000Z",
        detachedAt: overrides.detachedAt ?? null,
      },
    ],
  });

  it.each([
    ["an active home conversation", [bot()], home, "Companion"],
    ["a thread in another project", [bot()], { ...home, projectId: "campaign-b" }, null],
    ["an id that only looks like a home thread", [bot()], { ...home, id: "bot-home:x:y" }, null],
    ["a detached project", [bot({ detachedAt: "2026-01-02T00:00:00.000Z" })], home, null],
    ["an archived Bot", [bot({ archivedAt: "2026-01-02T00:00:00.000Z" })], home, null],
  ])("resolves %s", (_case, bots, thread, name) => {
    expect(botOfHomeThread(bots, thread)?.name ?? null).toBe(name);
  });
});

describe("rankBotConversations", () => {
  const context = (project: string, detachedAt: string | null = null) => ({
    projectId: ProjectId.make(project),
    homeThreadId: ThreadId.make(`bot-home:companion:${project}`),
    attachedAt: "2026-01-01T00:00:00.000Z",
    detachedAt,
  });
  const bot = (projects: BotSummary["projects"], archivedAt: string | null = null): BotSummary => ({
    id: BotId.make("companion"),
    name: "Companion",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    learningPolicy: "after_adoption",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
    pendingLearning: 0,
    projects,
  });
  const threads: Record<string, { updatedAt: string; urgency: number }> = {
    "bot-home:companion:old": { updatedAt: "2026-01-01T00:00:00.000Z", urgency: 0 },
    "bot-home:companion:new": { updatedAt: "2026-01-03T00:00:00.000Z", urgency: 0 },
    "bot-home:companion:asks": { updatedAt: "2026-01-02T00:00:00.000Z", urgency: 2 },
  };
  const rank = (summary: BotSummary) =>
    rankBotConversations(
      summary,
      (threadId) => threads[threadId] ?? null,
      (thread) => thread.urgency,
    ).map(({ context }) => context.projectId);

  it.each([
    ["the most recently updated first", [context("old"), context("new")], ["new", "old"]],
    [
      "one that needs the user before a newer one",
      [context("new"), context("asks")],
      ["asks", "new"],
    ],
    ["unloaded conversations last", [context("unloaded"), context("old")], ["old", "unloaded"]],
    ["no detached project", [context("new", "2026-01-04T00:00:00.000Z"), context("old")], ["old"]],
    ["nothing for a Bot without projects", [], []],
  ])("orders %s", (_case, projects, expected) => {
    expect(rank(bot(projects))).toEqual(expected);
  });

  it("offers nothing for an archived Bot", () => {
    expect(rank(bot([context("new")], "2026-01-04T00:00:00.000Z"))).toEqual([]);
  });
});

describe("home Bot task cards", () => {
  const environmentId = "env-a";
  const homeThreadId = ThreadId.make("bot-home:companion:campaign");
  const task = (
    id: string,
    overrides: Partial<{
      status: BotTaskStatus;
      completedAt: string | null;
      botId: string;
      projectId: string;
      homeThreadId: ThreadId;
    }> = {},
  ) => ({
    id: BotTaskId.make(id),
    botId: BotId.make(overrides.botId ?? "companion"),
    projectId: ProjectId.make(overrides.projectId ?? "campaign"),
    homeThreadId: overrides.homeThreadId ?? homeThreadId,
    status: overrides.status ?? "completed",
    completedAt:
      overrides.completedAt === undefined ? "2026-11-06T06:00:00.000Z" : overrides.completedAt,
  });
  const ids = (cards: { readonly visible: ReadonlyArray<{ readonly id: string }> }) =>
    cards.visible.map((card) => card.id);
  const tasks = [task("t1"), task("t2", { status: "failed" }), task("t3"), task("t4")];

  it("hides a finished card, keeps it hidden after a reload and shows it again", () => {
    const hidden = hideBotTaskCard([], environmentId, tasks[0]!);
    const reloadedHidden = JSON.parse(JSON.stringify(hidden)) as HiddenBotTaskCards;
    const reloadedTasks = tasks.map((entry) => ({ ...entry }));

    const cards = homeBotTaskCards(environmentId, reloadedTasks, homeThreadId, reloadedHidden);
    expect(ids(cards)).toEqual(["t2", "t3"]);
    expect(cards.hiddenKeys).toHaveLength(1);

    const shown = showBotTaskCards(reloadedHidden, cards.hiddenKeys);
    expect(ids(homeBotTaskCards(environmentId, reloadedTasks, homeThreadId, shown))).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("counts only the newest Home cards, so hiding never pulls older tasks in", () => {
    const otherHome = task("t0", { homeThreadId: ThreadId.make("bot-home:companion:old") });
    const hidden = tasks
      .slice(0, 3)
      .reduce<HiddenBotTaskCards>((next, entry) => hideBotTaskCard(next, environmentId, entry), []);
    const cards = homeBotTaskCards(environmentId, [otherHome, ...tasks], homeThreadId, hidden);
    expect(ids(cards)).toEqual([]);
    expect(cards.hiddenKeys).toHaveLength(3);
  });

  it("never hides open work and shows a card again once its task runs or finishes anew", () => {
    const hidden = hideBotTaskCard([], environmentId, tasks[0]!);
    for (const status of ["accepted", "running", "waiting"] as const) {
      const open = task("t1", { status, completedAt: null });
      expect(hideBotTaskCard([], environmentId, open)).toEqual([]);
      expect(ids(homeBotTaskCards(environmentId, [open], homeThreadId, hidden))).toEqual(["t1"]);
    }
    const finishedAgain = task("t1", { completedAt: "2026-11-06T07:00:00.000Z" });
    expect(ids(homeBotTaskCards(environmentId, [finishedAgain], homeThreadId, hidden))).toEqual([
      "t1",
    ]);
  });

  it("keeps hidden cards apart per environment, Bot and project", () => {
    const hidden = hideBotTaskCard([], environmentId, tasks[0]!);
    expect(ids(homeBotTaskCards("env-b", [tasks[0]!], homeThreadId, hidden))).toEqual(["t1"]);
    for (const other of [task("t1", { botId: "scout" }), task("t1", { projectId: "launch" })]) {
      expect(ids(homeBotTaskCards(environmentId, [other], homeThreadId, hidden))).toEqual(["t1"]);
    }
  });

  it("keeps other saved hides while deduplicating and bounding stored keys", () => {
    const otherBot = task("x1", { botId: "scout" });
    const kept = hideBotTaskCard([], environmentId, otherBot);
    const stale = hideBotTaskCard(kept, environmentId, task("gone"));
    const next = hideBotTaskCard(stale, environmentId, tasks[0]!);
    expect(next).toEqual([
      kept[0],
      botTaskCardKey(environmentId, task("gone")),
      botTaskCardKey(environmentId, tasks[0]!),
    ]);
    const repeated = hideBotTaskCard(next, environmentId, tasks[0]!);
    expect(repeated).toEqual(next);
    const bounded = Array.from({ length: 201 }, (_, index) =>
      task(`bounded-${index}`),
    ).reduce<HiddenBotTaskCards>((keys, entry) => hideBotTaskCard(keys, environmentId, entry), []);
    expect(bounded).toHaveLength(200);
    expect(bounded[0]).toBe(botTaskCardKey(environmentId, task("bounded-1")));
    expect(bounded.at(-1)).toBe(botTaskCardKey(environmentId, task("bounded-200")));
  });
});

describe("botRoutineUpsertInput", () => {
  const target = {
    botId: BotId.make("campaign-companion"),
    projectId: ProjectId.make("project-campaign"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  };
  const sessionAtMs = Date.parse("2026-11-06T19:00:00.000Z");
  const now = Date.parse("2026-11-02T12:00:00.000Z");

  it("runs a session routine once, the lead time before the session", () => {
    const result = botRoutineUpsertInput(
      {
        title: " Session 12 ",
        prompt: "Prepare session 12.",
        allowChanges: false,
        timing: "session",
        sessionAtMs,
        leadMinutes: 90,
      },
      target,
      now,
    );
    if (!("input" in result)) throw new Error(result.error);
    expect(result.input.title).toBe("Session 12");
    expect(result.input.schedule).toEqual({ type: "once", runAt: "2026-11-06T17:30:00.000Z" });
    expect(result.input.bot).toEqual({
      botId: target.botId,
      sessionAt: "2026-11-06T19:00:00.000Z",
      allowChanges: false,
    });
    expect(result.input.runtimeMode).toBe("full-access");
    // Editing the saved routine starts from the same session and lead time.
    expect(
      botRoutineDraft({ ...result.input, bot: result.input.bot } as ScheduledTask),
    ).toMatchObject({ timing: "session", sessionAtMs, leadMinutes: 90, allowChanges: false });
  });

  it("refuses a preparation time that has already passed", () => {
    const result = botRoutineUpsertInput(
      {
        title: "Prep",
        prompt: "Prepare.",
        allowChanges: true,
        timing: "session",
        sessionAtMs,
        leadMinutes: 7 * 24 * 60,
      },
      target,
      now,
    );
    expect(result).toHaveProperty("error");
  });

  it("keeps a recurring routine on its time of day and weekdays", () => {
    const result = botRoutineUpsertInput(
      {
        title: "Weekly",
        prompt: "Prepare.",
        allowChanges: true,
        timing: "recurring",
        timeOfDay: "18:00",
        weekdays: [5],
      },
      target,
      now,
    );
    expect(result).toMatchObject({
      input: {
        schedule: { type: "fixed_time", timeOfDay: "18:00", weekdays: [5] },
        bot: { botId: target.botId, sessionAt: null, allowChanges: true },
      },
    });
  });
});

it("keeps working-note lines separate and rejects oversized drafts without truncation", () => {
  const note = {
    requests: [{ text: "Draft launch checklist", refs: [{ kind: "user" as const, revision: 1 }] }],
    waiting: [{ text: "Proposal: blue packaging", refs: [] }],
    decided: [],
    context: [],
  };
  const draft = botContinuationDraft(note);
  expect(draft.waiting).toBe("Proposal: blue packaging");
  expect(parseBotContinuationDraft(draft)).toEqual({
    note: {
      requests: [{ text: "Draft launch checklist" }],
      waiting: [{ text: "Proposal: blue packaging" }],
      decided: [],
      context: [],
    },
  });
  expect(parseBotContinuationDraft({ ...draft, requests: "a".repeat(401) })).toHaveProperty(
    "error",
  );
  expect(botContinuationWriterLabel({ kind: "user" })).toBe("Updated by you");
  expect(
    botContinuationRefCaption({
      kind: "message",
      messageId: MessageId.make("source"),
      ordinal: 1,
      digest: "digest",
      quote: "original",
      directUser: true,
      availability: "historical_unverified",
    }),
  ).toContain("historical/unverified");
});

it("shows a persisted enabled maintenance setting as stopped when the server cannot run it", () => {
  const view = {
    botId: BotId.make("bot"),
    projectId: ProjectId.make("project"),
    homeThreadId: ThreadId.make("home"),
    revision: 1,
    enabled: true,
    startedAt: "2026-11-01T00:00:00.000Z",
    unavailableReason: null,
    writable: true,
  };
  expect(botMaintenanceStatusLabel(view)).toBe("On");
  for (const [unavailableReason, explanation] of [
    ["no_tool_profile_unavailable", "needs a tool-free model profile"],
    ["codex_required", "Pick a Codex model for this Bot"],
    ["instance_unavailable", "Codex provider is off or missing"],
    ["provider_signed_out", "Sign in to Codex"],
    ["codex_version_unsupported", "Update Codex"],
    ["selected_model_unavailable", "model isn't available on its Codex account"],
    ["option_unsupported", "model options isn't supported"],
    ["reason_from_a_newer_server", "Not available on this server."],
    ["constructor", "Not available on this server."],
  ] as const) {
    const unavailable = { ...view, unavailableReason };
    expect(botMaintenanceStatusLabel(unavailable)).toMatch(/^On · stopped · /);
    expect(botMaintenanceStatusLabel(unavailable)).toContain(explanation);
    expect(canToggleBotMaintenance(unavailable, false)).toBe(true);
  }
});

it("keeps pausing maintenance reachable while the Bot form is locked", () => {
  const view = {
    botId: BotId.make("bot"),
    projectId: ProjectId.make("project"),
    homeThreadId: ThreadId.make("home"),
    revision: 1,
    enabled: true,
    startedAt: "2026-11-01T00:00:00.000Z",
    unavailableReason: null,
    writable: false,
  };
  expect(canToggleBotMaintenance(view, true)).toBe(true);
  const paused = { ...view, enabled: false, writable: true };
  expect(canToggleBotMaintenance(paused, false)).toBe(true);
  expect(canToggleBotMaintenance(paused, true)).toBe(false);
  expect(canToggleBotMaintenance({ ...paused, writable: false }, false)).toBe(false);
});

describe("bot learning", () => {
  const projectA = ProjectId.make("project-a");
  const projectB = ProjectId.make("project-b");
  const lesson = (
    id: string,
    minute: number,
    options: {
      readonly projectId?: ProjectId | null;
      readonly origin?: BotLearningRevision["origin"];
      readonly status?: BotLearningRevision["status"];
      readonly text?: string;
      readonly learnedInProjectId?: ProjectId;
    } = {},
  ): BotLearningEntry => ({
    id: BotLearningEntryId.make(id),
    projectId: options.projectId === undefined ? projectA : options.projectId,
    kind: "preference",
    revisions: [
      {
        revision: 1,
        text: options.text ?? `Lesson ${id}.`,
        rationale: `Why ${id}.`,
        evidence: `Quote ${id}.`,
        origin: options.origin ?? "correction",
        source: { kind: "user" },
        learnedInProjectId: options.learnedInProjectId ?? projectA,
        status: options.status ?? "active",
        baseRevision: null,
        conflictsWithInstruction: false,
        createdAt: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
        decidedAt: null,
      },
    ],
  });
  const many = (count: number, options: Parameters<typeof lesson>[2] = {}) =>
    Array.from({ length: count }, (_, index) =>
      lesson(`e${String(index + 1).padStart(2, "0")}`, index + 1, options),
    );

  it.each([
    { name: "leaves nothing out within the limits", entries: many(3), leftOut: [] },
    {
      name: "leaves out the oldest lessons past 40, never a standing instruction",
      entries: [lesson("instruction", 0, { origin: "instruction" }), ...many(41)],
      leftOut: ["e02", "e01"],
    },
    {
      name: "counts shared lessons but not other projects' lessons",
      entries: [
        lesson("shared", 0, { projectId: null }),
        ...many(40),
        lesson("other", 0, { projectId: projectB }),
      ],
      leftOut: ["shared"],
    },
    {
      name: "leaves out lessons past 8,000 characters",
      entries: many(9, { text: "x".repeat(1_000) }),
      leftOut: ["e02", "e01"],
    },
    {
      name: "never lists lessons that are not in use",
      entries: [
        ...many(40),
        lesson("retired", 0, { status: "retired" }),
        lesson("pending", 0, { status: "pending" }),
      ],
      leftOut: [],
    },
  ])("$name", ({ entries, leftOut }) => {
    expect(botLearningLeftOut(entries, projectA).map(({ entry }) => entry.id)).toEqual(leftOut);
  });

  const bot = {
    id: BotId.make("bot"),
    projects: [
      { projectId: projectB, detachedAt: null },
      { projectId: ProjectId.make("project-c"), detachedAt: "2026-11-01T00:00:00.000Z" },
    ],
  };
  it.each([
    {
      name: "rewords a project lesson in its project",
      entry: lesson("local", 0, { projectId: projectB }),
      change: { text: "  New wording.  " },
      expected: { projectId: projectB, text: "New wording." },
    },
    {
      name: "moves a project lesson to all projects with its rationale and evidence",
      entry: lesson("local", 0, { projectId: projectB }),
      change: { scope: "bot" as const },
      expected: {
        projectId: projectB,
        text: "Lesson local.",
        rationale: "Why local.",
        evidence: "Quote local.",
        scope: "bot",
      },
    },
    {
      name: "rewords a shared lesson from an attached project once its own was detached",
      entry: lesson("shared", 0, {
        projectId: null,
        learnedInProjectId: ProjectId.make("project-c"),
      }),
      change: { text: "Shared wording." },
      expected: { projectId: projectB, text: "Shared wording." },
    },
  ])("$name", ({ entry, change, expected }) => {
    expect(botLearningRevisionInput(bot, entry, change)).toEqual({
      botId: bot.id,
      kind: "preference",
      replaces: { entryId: entry.id, revision: 1 },
      ...expected,
    });
  });

  it("cannot revise a lesson without an attached project to record it from", () => {
    const detached = { ...bot, projects: bot.projects.slice(1) };
    expect(
      botLearningRevisionInput(detached, lesson("shared", 0, { projectId: null }), { text: "x" }),
    ).toBeNull();
  });
});

it("keeps notification results scoped to their task, project and work thread", () => {
  const task = {
    id: BotTaskId.make("task"),
    projectId: ProjectId.make("project"),
    workThreadId: ThreadId.make("work"),
  };
  const thread = { taskId: task.id, projectId: task.projectId, threadId: task.workThreadId };
  expect(botTaskResultMatchesThread(task, thread)).toBe(true);
  expect(botTaskResultMatchesThread(task, { ...thread, taskId: "other" })).toBe(false);
  expect(botTaskResultMatchesThread(task, { ...thread, projectId: ProjectId.make("other") })).toBe(
    false,
  );
  expect(botTaskResultMatchesThread(task, { ...thread, threadId: ThreadId.make("other") })).toBe(
    false,
  );
});
