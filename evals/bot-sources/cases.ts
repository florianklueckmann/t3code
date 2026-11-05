/**
 * Every case runs in the same synthetic world: two projects that are both titled "Faerun", one
 * Bot attached to both, and a second Bot with the same name attached to project `a`. Only the
 * ids in the Bot's context tell them apart.
 */
export type ProjectKey = "a" | "b";

export interface SourceFixture {
  readonly label: string;
  readonly location: string;
}

export interface ProjectFixture {
  readonly guidance: string;
  readonly sources: ReadonlyArray<SourceFixture>;
  /** Files in the project folder. Established sources may name files that are missing. */
  readonly files: Readonly<Record<string, string>>;
}

export const PROJECT_TITLE = "Faerun";
export const BOT_NAME = "Faerun Companion";
export const BOT_INSTRUCTIONS = "You help the game master run their D&D campaign.";

const canonA = { label: "Campaign canon", location: "canon/session-log.md" };
const houseRules = { label: "House rules", location: "rules/house-rules.md" };
const bestiary = { label: "Homebrew bestiary", location: "bestiary/homebrew.md" };

export const PROJECTS: Readonly<Record<ProjectKey, ProjectFixture>> = {
  a: {
    guidance: "Waterdeep campaign. Rules: D&D 5e, 2014 Player's Handbook.",
    sources: [canonA, houseRules, bestiary],
    files: {
      "canon/session-log.md": [
        "# Session log, Waterdeep campaign",
        "",
        "## Session 9 (2026-08-30)",
        "- Mirt the Moneylender was named Open Lord of Waterdeep after Laeral Silverhand stepped down. This is campaign canon and overrides published lore.",
        "",
        "## Session 10 (2026-09-06)",
        "- Table ruling: drinking a potion of healing takes a full action, also when you drink it yourself.",
        "",
      ].join("\n"),
      "rules/house-rules.md": [
        "# House rules (D&D 5e, 2014 Player's Handbook)",
        "",
        "- Drinking a potion of healing yourself is a bonus action.",
        "- Critical hits: maximum damage for the first set of dice.",
        "",
      ].join("\n"),
      "rules/house-rules-v2.md": [
        "# House rules v2 (D&D 5e, 2024 Player's Handbook)",
        "",
        "- Drinking a potion of healing is a bonus action for anyone.",
        "",
      ].join("\n"),
      "lore/sword-coast-notes.md": [
        "# Sword Coast notes (player research, not campaign canon)",
        "",
        "- Neverwinter is ruled by the Council of Five since Lord Neverember was ousted.",
        "- The Council of Five: Arlen Vos, Selka Durn, Brother Tomas, Ilyra Fenwick, Harbourmaster Quell.",
        "",
      ].join("\n"),
    },
  },
  b: {
    guidance: "A second Waterdeep table with its own canon.",
    sources: [{ label: "Campaign canon", location: "canon/session-log.md" }],
    files: {
      "canon/session-log.md": [
        "# Session log, second table",
        "",
        "## Session 5 (2026-07-12)",
        "- Laeral Silverhand remains Open Lord of Waterdeep; the party serves as her agents.",
        "",
      ].join("\n"),
    },
  },
};

/** The twin Bot shares the Bot's name and project `a`, with its own source list. */
export const TWIN_SOURCES: ReadonlyArray<SourceFixture> = [canonA];

export interface Turn {
  readonly prompt: string;
  /** Case-insensitive regexes on the answer. */
  readonly textMust?: ReadonlyArray<string>;
  readonly textMustNot?: ReadonlyArray<string>;
  /** The user adopts the seeded proposal in settings before this turn. */
  readonly adoptSeedFirst?: boolean;
}

/** Where a learning entry applies: one project, or every project of the Bot. */
export type LearningScopeKey = ProjectKey | "all";

/**
 * Learning recorded before the turns by someone other than the Bot, as the user or another agent
 * would. It never appears in the conversation, so only the Bot's context can carry it.
 */
export interface LearningSeed {
  readonly origin: "instruction" | "correction";
  readonly kind: "fact" | "preference" | "procedure";
  readonly text: string;
  readonly project: ProjectKey;
  readonly scope?: "project" | "bot";
}

/** A learning entry the Bot itself must have recorded during the turns. */
export interface ExpectedLearning {
  readonly scope: LearningScopeKey;
  readonly kind?: LearningSeed["kind"];
  /** Case-insensitive regex on the entry's text. */
  readonly text: string;
  readonly origin: "instruction" | "correction";
  readonly status: "active" | "pending";
}

export interface BotSourcesCase {
  readonly id: string;
  /** `bad` reproduces a gap in the old context, `guard` protects correct behavior, `control` is ordinary work. */
  readonly kind: "bad" | "guard" | "control";
  readonly source: string;
  readonly experience: string;
  /** The project whose home conversation gets the turns. */
  readonly home: ProjectKey;
  readonly turns: ReadonlyArray<Turn>;
  /** The Bot's source locations per project after the turns. Unlisted projects stay unchanged. */
  readonly sourcesAfter?: Partial<Record<ProjectKey, ReadonlyArray<string>>>;
  /** Defaults to "after_adoption". */
  readonly learningPolicy?: "automatic" | "after_adoption";
  readonly seed?: LearningSeed;
  /** What the Bot must record. Without it, the Bot must record no learning at all. */
  readonly learningAfter?: ReadonlyArray<ExpectedLearning>;
}

const T3B_4 = "T3B-4 acceptance criteria (synthetic)";
const T3B_6 = "T3B-6 acceptance criteria (synthetic)";

const OPEN_LORD = "Who is the Open Lord of Waterdeep in our campaign right now?";
const TABLE_READY = "End every answer with the line 'Table ready.'";
const tooLong = [
  { prompt: OPEN_LORD, textMust: ["Mirt"] },
  {
    prompt: "Too long. I read your answers out at the table, so I need them in a single sentence.",
  },
];

export const CASES: ReadonlyArray<BotSourcesCase> = [
  {
    id: "source-first",
    kind: "guard",
    source: T3B_4,
    experience:
      "An answer that is in an established source must win over conflicting published lore.",
    home: "a",
    turns: [
      {
        prompt: "Who is the Open Lord of Waterdeep in our campaign right now?",
        textMust: ["Mirt", "session[ -]?(9|log)"],
      },
    ],
  },
  {
    id: "missing-and-conflicting-sources",
    kind: "guard",
    source: T3B_4,
    experience:
      "A missing established source and two sources that disagree must be named, not papered over.",
    home: "a",
    turns: [
      {
        prompt:
          "Two things for tonight: give me the Ashen Drake's stat block from our homebrew bestiary, and tell me whether drinking a healing potion is a bonus action at our table.",
        textMust: [
          "missing|not found|no such|does ?n[o'’]t exist|could ?n[o'’]t (find|read|open)|unreadable|not (present|available)",
          "conflict|contradict|inconsisten|disagree",
        ],
      },
    ],
  },
  {
    id: "task-only-research",
    kind: "guard",
    source: T3B_4,
    experience:
      '"Look in X" must cover the task and its follow-ups, then later questions return to the established sources, which stay unchanged.',
    home: "a",
    turns: [
      {
        prompt: "Look in lore/sword-coast-notes.md for this one: who rules Neverwinter?",
        textMust: ["Council of Five"],
      },
      { prompt: "Who sits on it?", textMust: ["Arlen Vos"] },
      {
        prompt: "Different topic: who is the Open Lord of Waterdeep in our campaign?",
        textMust: ["Mirt"],
      },
    ],
  },
  {
    id: "standing-source-added",
    kind: "bad",
    source: T3B_4,
    experience:
      "A standing source instruction must update only this Bot's selected project, by id, and keep the existing sources.",
    home: "a",
    turns: [
      { prompt: "From now on, also use lore/sword-coast-notes.md as a source for this campaign." },
    ],
    sourcesAfter: {
      a: [
        "canon/session-log.md",
        "rules/house-rules.md",
        "bestiary/homebrew.md",
        "lore/sword-coast-notes.md",
      ],
    },
  },
  {
    id: "standing-source-replaced",
    kind: "control",
    source: T3B_4,
    experience: "When the user asks to replace a source, only that source goes.",
    home: "a",
    turns: [
      { prompt: "From now on, use rules/house-rules-v2.md instead of rules/house-rules.md." },
    ],
    sourcesAfter: {
      a: ["canon/session-log.md", "rules/house-rules-v2.md", "bestiary/homebrew.md"],
    },
  },
  {
    id: "campaign-separation",
    kind: "guard",
    source: T3B_4,
    experience: "The second campaign answers from its own canon, with nothing from the first.",
    home: "b",
    turns: [
      {
        prompt: "Who is the Open Lord of Waterdeep in our campaign right now?",
        textMust: ["Laeral"],
        textMustNot: ["Mirt"],
      },
    ],
  },
  {
    id: "correction-learned-automatically",
    kind: "bad",
    source: T3B_6,
    experience:
      "A correction that should carry over becomes one project lesson, active at once when the Bot learns automatically.",
    home: "a",
    learningPolicy: "automatic",
    turns: tooLong,
    learningAfter: [
      { scope: "a", text: "sentence|short|brief|concise", origin: "correction", status: "active" },
    ],
  },
  {
    id: "correction-waits-for-adoption",
    kind: "bad",
    source: T3B_6,
    experience:
      "With learning after adoption, the same correction is proposed and waits, and the Bot says so.",
    home: "a",
    turns: [tooLong[0]!, { ...tooLong[1]!, textMust: ["adopt|approv|review|settings"] }],
    learningAfter: [
      { scope: "a", text: "sentence|short|brief|concise", origin: "correction", status: "pending" },
    ],
  },
  {
    id: "standing-instruction-applies-at-once",
    kind: "bad",
    source: T3B_6,
    experience:
      "A standing instruction applies at once even when inferred lessons wait for adoption.",
    home: "a",
    turns: [{ prompt: "From now on, end every answer with the line 'Table ready.'" }],
    learningAfter: [{ scope: "a", text: "table ready", origin: "instruction", status: "active" }],
  },
  {
    id: "fact-stays-in-project-by-default",
    kind: "guard",
    source: "User request: explicitly shared facts (synthetic)",
    experience: "A fact the user asks the Bot to remember stays in this project by default.",
    home: "a",
    turns: [
      {
        prompt: "Remember for later: my name is Rowan.",
        textMust: ["Rowan", "(this|the|our).{0,40}(project|campaign)"],
      },
    ],
    learningAfter: [
      { scope: "a", kind: "fact", text: "Rowan", origin: "instruction", status: "active" },
    ],
  },
  {
    id: "fact-shared-on-explicit-request",
    kind: "bad",
    source: "User request: explicitly shared facts (synthetic)",
    experience: "A fact is shared across the Bot's projects only at the user's explicit request.",
    home: "a",
    turns: [
      {
        prompt: "Remember for later, across all your projects: my name is Rowan.",
        textMust: ["Rowan", "all (your |my )?(projects|campaigns)|across.*(projects|campaigns)"],
      },
    ],
    learningAfter: [
      { scope: "all", kind: "fact", text: "Rowan", origin: "instruction", status: "active" },
    ],
  },
  {
    id: "adopted-lesson-reaches-new-conversation",
    kind: "guard",
    source: T3B_6,
    experience:
      "A proposed lesson the conversation never saw changes answers only after the user adopts it.",
    home: "a",
    seed: { origin: "correction", kind: "preference", text: TABLE_READY, project: "a" },
    turns: [
      { prompt: OPEN_LORD, textMust: ["Mirt"], textMustNot: ["table ready"] },
      {
        prompt: "Who held the title before Mirt?",
        adoptSeedFirst: true,
        textMust: ["table ready"],
      },
    ],
  },
  {
    id: "automatic-lesson-reaches-new-conversation",
    kind: "guard",
    source: T3B_6,
    experience:
      "When the Bot learns automatically, a lesson applies in a new conversation at once.",
    home: "a",
    learningPolicy: "automatic",
    seed: { origin: "correction", kind: "preference", text: TABLE_READY, project: "a" },
    turns: [{ prompt: OPEN_LORD, textMust: ["Mirt", "table ready"] }],
  },
  {
    id: "lesson-stays-in-its-campaign",
    kind: "guard",
    source: T3B_6,
    experience: "A lesson from campaign A does not change answers in campaign B.",
    home: "b",
    seed: { origin: "instruction", kind: "preference", text: TABLE_READY, project: "a" },
    turns: [{ prompt: OPEN_LORD, textMust: ["Laeral"], textMustNot: ["table ready"] }],
  },
  {
    id: "shared-preference-reaches-both-campaigns",
    kind: "control",
    source: T3B_6,
    experience: "A preference the user shares across projects applies in campaign B too.",
    home: "b",
    seed: {
      origin: "instruction",
      kind: "preference",
      text: TABLE_READY,
      project: "a",
      scope: "bot",
    },
    turns: [{ prompt: OPEN_LORD, textMust: ["Laeral", "table ready"] }],
  },
];
