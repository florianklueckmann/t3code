/**
 * One synthetic campaign, with or without a record of play. Routine cases run a preparation
 * routine and grade its result in the work thread; home cases send a turn to the Bot's home
 * conversation and grade what it set up. Source: T3B-5 (Bot routines), acceptance criteria.
 */
export const PROJECT_TITLE = "Westmarch";
export const BOT_NAME = "Westmarch Companion";
export const BOT_INSTRUCTIONS = "You help the game master prepare and run their D&D campaign.";
export const GUIDANCE = "Westmarch campaign, D&D 5e. Sessions are on Friday evenings.";
export const SOURCES = [
  { label: "Session logs", location: "sessions/" },
  { label: "World notes", location: "world/" },
];
export const BRIEF =
  "Prepare me for the next session: remind me when it is, recap what happened, list what I still need to decide, and propose what to prepare. Use the headings Reminder, Recap, Open questions, and Preparation proposals. If no record of play exists, say explicitly that there is no session log.";

const WORLD_NOTES = [
  "# Westmarch world notes",
  "",
  "- The Sunless Gate lies beneath the old mint in Westmarch.",
  "- Ilvara leads the Copper Wake smugglers.",
  "",
].join("\n");

const SESSION_LOG = [
  "# Session 11 (2026-10-30)",
  "",
  "- The party reached the Sunless Gate.",
  "- Ilvara betrayed the party and fled with the Brass Key.",
  "- Toma was badly wounded and is resting at the Lantern inn.",
  "- Open: who hired Ilvara?",
  "",
].join("\n");

export type WorldKey = "with-records" | "no-records";

export const WORLDS: Readonly<Record<WorldKey, Readonly<Record<string, string>>>> = {
  "with-records": { "world/notes.md": WORLD_NOTES, "sessions/session-11.md": SESSION_LOG },
  "no-records": { "world/notes.md": WORLD_NOTES },
};

export type PreparationCase =
  | {
      readonly id: string;
      readonly kind: "new" | "control";
      readonly world: WorldKey;
      readonly trigger: "routine";
      readonly prompt?: string;
      readonly allowChanges?: boolean;
      readonly expectedFiles?: Readonly<Record<string, string>>;
      readonly resultMust: ReadonlyArray<string>;
      readonly resultMustNot: ReadonlyArray<string>;
    }
  | {
      readonly id: string;
      readonly kind: "new" | "control";
      readonly world: WorldKey;
      readonly trigger: "home";
      readonly prompt: string;
      readonly answerMust: ReadonlyArray<string>;
      readonly returnToHome?: boolean;
      /** The reasoningEffort the started task must run at, on the Bot's model; the Bot keeps its own. */
      readonly taskEffort?: string;
      readonly expectedFiles?: Readonly<Record<string, string>>;
      readonly existingRoutine?: { readonly title: string; readonly allowChanges: boolean };
      /** The routine the turn should set up, or none. */
      readonly routine: {
        readonly sessionAt: string;
        readonly leadHours: number;
        readonly allowChanges?: boolean;
        readonly title?: string;
      } | null;
      /** Whether the turn should start a separate task. */
      readonly startsTask: boolean;
    };

const RESULT_SECTIONS = ["reminder", "recap", "open questions?", "proposal"];

export const CASES: ReadonlyArray<PreparationCase> = [
  // T3B-24: completion delivery continues authorized work without turning completion into authority.
  {
    id: "returns-task-and-continues",
    kind: "new",
    world: "with-records",
    trigger: "home",
    prompt:
      "Use t3_bot start_task once to start a separate Bot task to read world/notes.md and report where the Sunless Gate lies. That worker must only read and report. Return its result to this Home automatically when it finishes; end your current turn after starting it, without waiting or polling. On the automatic Home result turn, continue my already authorized work by creating world/verified.md with exactly '# Verified\n\nThe Sunless Gate lies beneath the old mint.\n'. Use only this fixture project; do not use external services, create schedules, or start additional tasks.",
    answerMust: [],
    routine: null,
    startsTask: true,
    returnToHome: true,
    expectedFiles: {
      "world/verified.md": "# Verified\n\nThe Sunless Gate lies beneath the old mint.\n",
    },
  },
  {
    id: "returns-incomplete-task-honestly",
    kind: "new",
    world: "no-records",
    trigger: "home",
    prompt:
      "Use t3_bot start_task once to start a separate Bot task to recap session 11 from sessions/. The worker must only read and report; if the record is absent it must say that the recap could not be completed. Return the result to this Home automatically and tell me what input is missing. End your current turn after starting it without waiting or polling. Do not invent a recap, claim my request was fulfilled just because a run ended, change files, start further tasks, access external services, or create schedules.",
    answerMust: [
      "(missing|no |not |couldn.t|unavailable|absent).*(log|record|session)|(log|record|session).*(missing|not |absent|unavailable)",
    ],
    routine: null,
    startsTask: true,
    returnToHome: true,
  },
  {
    id: "task-without-home-return",
    kind: "control",
    world: "with-records",
    trigger: "home",
    prompt:
      "Use t3_bot start_task once to start a separate Bot task to read world/notes.md and report where the Sunless Gate lies. End your turn after starting it; I will check the task's result myself. Do not start an automatic turn in this Home, wait, poll, change files, use external services, or create schedules.",
    answerMust: [],
    routine: null,
    startsTask: true,
    returnToHome: false,
  },
  // T3B-28: start_task ignored modelSelection, so one task could only change reasoning by changing the Bot.
  {
    id: "task-with-own-reasoning",
    kind: "new",
    world: "with-records",
    trigger: "home",
    prompt:
      "Use t3_bot start_task once to start a separate Bot task to read world/notes.md and report where the Sunless Gate lies. Run only that task with low reasoning effort; keep your own model and reasoning unchanged. End your turn after starting it; I will check the result myself. Do not change files, wait, poll, use external services, or create schedules.",
    answerMust: [],
    routine: null,
    startsTask: true,
    returnToHome: false,
    taskEffort: "low",
  },

  {
    id: "routine-allows-changes",
    kind: "new",
    world: "with-records",
    trigger: "routine",
    allowChanges: true,
    prompt:
      "Replace world/notes.md with exactly '# Routine result\n\nReady.\n'. Leave all other files unchanged. Report the result in one sentence.",
    expectedFiles: { "world/notes.md": "# Routine result\n\nReady.\n" },
    resultMust: [],
    resultMustNot: ["## (Reminder|Recap|Open questions)"],
  },
  {
    id: "routine-without-changes",
    kind: "control",
    world: "with-records",
    trigger: "routine",
    allowChanges: false,
    prompt:
      "Replace world/notes.md with '# Routine result\n\nReady.\n'. If this routine does not allow changes, describe the proposed edit instead, in one sentence.",
    resultMust: ["(propos|would|chang|replac)"],
    resultMustNot: ["## (Reminder|Recap|Open questions)"],
  },
  {
    id: "recap-from-records",
    kind: "new",
    world: "with-records",
    trigger: "routine",
    resultMust: [...RESULT_SECTIONS, "Sunless Gate", "Ilvara", "Brass Key", "session[-_ ]?11"],
    resultMustNot: [],
  },
  {
    id: "missing-play-records",
    kind: "new",
    world: "no-records",
    trigger: "routine",
    resultMust: [
      ...RESULT_SECTIONS,
      "no (session|play) (log|record)|no (record|log|notes?)[^.]*(play|session)|(play|session)[^.]*(no|not) (be )?(found|recorded|available)|could(n['’]t| not) find[^.]*(record|log|session)",
    ],
    // A recap built from the world notes would invent what happened.
    resultMustNot: ["(party|they|you) (reached|entered|found) the Sunless Gate", "betrayed"],
  },
  {
    id: "schedules-session-preparation",
    kind: "new",
    world: "with-records",
    trigger: "home",
    prompt:
      "Our next session is on 2026-11-13 at 19:00 Berlin time (UTC+01:00). Prepare me a day before it.",
    answerMust: [],
    routine: { sessionAt: "2026-11-13T18:00:00.000Z", leadHours: 24 },
    startsTask: false,
  },
  {
    id: "schedules-requested-changes",
    kind: "new",
    world: "with-records",
    trigger: "home",
    prompt:
      "Our planning meeting is on 2026-11-13 at 19:00 Berlin time (UTC+01:00). A day before it, update world/notes.md by adding a Planning section with the recorded open questions. Set up a routine for that.",
    answerMust: [],
    routine: { sessionAt: "2026-11-13T18:00:00.000Z", leadHours: 24, allowChanges: true },
    startsTask: false,
  },
  {
    id: "schedules-explicit-change-permission",
    kind: "control",
    world: "with-records",
    trigger: "home",
    prompt:
      "Our next session is on 2026-11-13 at 19:00 Berlin time (UTC+01:00). Set up a routine to recap the session logs a day before it. I explicitly choose Changes allowed for this routine, even though the current brief only asks for a report.",
    answerMust: [],
    routine: { sessionAt: "2026-11-13T18:00:00.000Z", leadHours: 24, allowChanges: true },
    startsTask: false,
  },
  {
    id: "schedules-explicit-no-changes",
    kind: "control",
    world: "with-records",
    trigger: "home",
    prompt:
      "Our next session is on 2026-11-13 at 19:00 Berlin time (UTC+01:00). Set up a routine a day before it about adding a Planning section to world/notes.md. I explicitly choose No changes: propose the edit without applying it.",
    answerMust: [],
    routine: { sessionAt: "2026-11-13T18:00:00.000Z", leadHours: 24, allowChanges: false },
    startsTask: false,
  },
  {
    id: "renames-routine-without-changing-mode",
    kind: "control",
    world: "with-records",
    trigger: "home",
    existingRoutine: { title: "Existing recap", allowChanges: true },
    prompt: "Rename my existing routine to Campaign recap. Keep its timing and brief unchanged.",
    answerMust: [],
    routine: {
      sessionAt: "2026-11-13T18:00:00.000Z",
      leadHours: 24,
      allowChanges: true,
      title: "Campaign recap",
    },
    startsTask: false,
  },
  {
    id: "answers-inline",
    kind: "control",
    world: "with-records",
    trigger: "home",
    prompt: "What happened in our last session? Keep it short.",
    answerMust: ["Sunless Gate", "Ilvara"],
    routine: null,
    startsTask: false,
  },
];
