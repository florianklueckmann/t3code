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
  "Prepare me for the next session: remind me when it is, recap what happened, list what I still need to decide, and propose what to prepare.";

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
      /** The routine the turn should set up, or none. */
      readonly routine: { readonly sessionAt: string; readonly leadHours: number } | null;
      /** Whether the turn should start a separate task. */
      readonly startsTask: boolean;
    };

const RESULT_SECTIONS = ["reminder", "recap", "open questions?", "proposal"];

export const CASES: ReadonlyArray<PreparationCase> = [
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
      "no (record|log|notes?)[^.]*(play|session)|(play|session)[^.]*(no|not) (be )?(found|recorded|available)|could(n['’]t| not) find[^.]*(record|log|session)",
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
