/** What a graded check must add to Waiting, or nothing when it must not save. */
export interface ExpectedItem {
  readonly pattern: string;
  /** `task`: the item names the case's task. `quote`: it quotes the user's own Home message. */
  readonly source: "task" | "quote";
}

export interface HomeCheckCase {
  readonly id: string;
  readonly source: string;
  /** Ordinary Home turns before the first check. `{inThreeWeeks}` becomes a date three weeks out. */
  readonly seed: readonly string[];
  /** A direct task the user starts from outside the Home before the check, with its title. */
  readonly task: { readonly title: string; readonly prompt: string } | null;
  /** One check runs, then this Home turn, then the graded check. */
  readonly between: string | null;
  /** Waiting must already hold an item matching this before the graded check. */
  readonly waitingBefore: string | null;
  readonly expect: ExpectedItem | null;
}

const appointment =
  "the notary appointment for the Acme lease, and I must bring my passport and the signed lease";
const acknowledge =
  'Reply only "Noted." Do not start tasks and do not change your working notes for this.';

// Source: T3B-24 U5 plan, eval cases (design/round2-u5-plan.md). All people and places are synthetic.
export const CASES: readonly HomeCheckCase[] = [
  {
    id: "decision-needed-to-waiting",
    source: "T3B-24 scenario: a finished task needs the user's choice",
    seed: [`Hello. ${acknowledge}`],
    task: {
      title: "Compare venues",
      prompt:
        "Use no tools and change no files. Reply with exactly this sentence: Both venues fit the Acme offsite; Harbor Hall costs less and Lantern Loft is closer, so which one should I book?",
    },
    between: null,
    waitingBefore: null,
    expect: { pattern: "(?=.*harbor\\s+hall)(?=.*lantern\\s+loft)", source: "task" },
  },
  {
    id: "upcoming-event-preparation",
    source: "T3B-24 scenario: an upcoming event the user must prepare for",
    seed: [`Heads-up: tomorrow at 10:00 I have ${appointment}. ${acknowledge}`],
    task: null,
    between: null,
    waitingBefore: null,
    expect: { pattern: "passport|lease|notary", source: "quote" },
  },
  {
    id: "nothing-useful-noop",
    source: "T3B-24 scenario: nothing worth saying",
    seed: [
      "What is 7 plus 8? Answer completely in one short sentence. I am asking for nothing else.",
    ],
    task: null,
    between: null,
    waitingBefore: null,
    expect: null,
  },
  {
    id: "event-after-next-check",
    source: "Control: the same appointment, but after the next check",
    seed: [`Heads-up: on {inThreeWeeks} at 10:00 I have ${appointment}. ${acknowledge}`],
    task: null,
    between: null,
    waitingBefore: null,
    expect: null,
  },
  {
    id: "already-in-waiting",
    source: "Control: Waiting already holds the proposal",
    seed: [
      `Heads-up: tomorrow at 10:00 I have ${appointment}. Add one Waiting item to your working notes that I must bring my passport and the signed lease to that appointment, then reply only "Noted." Start no tasks.`,
    ],
    task: null,
    between: null,
    waitingBefore: "passport|lease|notary",
    expect: null,
  },
  {
    id: "removed-not-repeated",
    source: "Control: the user removed what an earlier check proposed",
    seed: [`Heads-up: tomorrow at 10:00 I have ${appointment}. ${acknowledge}`],
    task: null,
    between:
      'I have packed my passport and the signed lease, so that is handled. Remove that item from Waiting in your working notes and reply only "Done." Start no tasks.',
    waitingBefore: null,
    expect: null,
  },
];
