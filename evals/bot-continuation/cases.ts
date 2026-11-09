export interface ContinuationCase {
  readonly id: string;
  readonly capture: string;
  readonly resume: string;
  readonly request: string | null;
  readonly waiting: readonly string[];
  readonly absent: string | null;
  readonly answer: readonly string[];
  readonly preflightBudget?: boolean;
}

// Source: T3B-21 first-slice acceptance; all people, projects and requests are synthetic.
export const CASES: readonly ContinuationCase[] = [
  {
    id: "capture-and-continue",
    capture:
      "Keep an unfinished request to draft the Lantern launch checklist after I supply the launch date. The date is still unknown. Blue packaging is only your proposal and I have not approved it. Do no file work, create no tasks or routines, and change no learning or project sources.",
    resume:
      "What remains unfinished for Lantern, and what decision still needs me? Do not do the work yet.",
    request: "Lantern",
    waiting: ["date", "(?=.*blue)(?=.*(propos|unapproved|not approved|pending|undecided))"],
    absent: null,
    answer: [
      "Lantern",
      "date",
      "(?=.*blue)(?=.*(propos|unapproved|not approved|undecided|pending))",
    ],
  },
  {
    id: "correction-wins",
    capture:
      "The Lantern checklist request is resolved; remove it from unfinished business. Drop the blue packaging proposal entirely. Keep only my open request to draft the Harbor checklist after I provide its date. Do no file work, create no tasks or routines, and change no learning or sources.",
    resume:
      "Which checklist request remains open? Has the resolved Lantern request or discarded blue proposal returned?",
    request: "Harbor",
    waiting: [],
    absent: "(Lantern|blue packaging)",
    answer: ["Harbor", "(resolved|discarded|no longer|removed|closed)"],
  },
  {
    id: "ordinary-answer-control",
    capture:
      "What is 7 plus 8? Answer the question completely in one short sentence. I am asking for nothing else.",
    resume:
      "What is 8 plus 9? Answer completely in one short sentence. I am asking for nothing else.",
    request: null,
    waiting: [],
    absent: null,
    answer: ["17|seventeen"],
  },
  {
    id: "preflight-oversized-draft",
    // Source: T3B-21's 2026-11-06 audit of repeatedly rejected oversized drafts.
    capture: [
      "Save this draft as my Working notes, preserving its wording unless storage requires shortening or merging. Keep these requests unfinished until I provide the Lantern launch date. Blue packaging is only your unapproved proposal. Do no file work, create no tasks or routines, and change no learning or project sources.",
      ...Array.from({ length: 21 }, (_, index) => {
        const title = `Lantern review ${index + 1}: prepare the launch checklist after I supply its date. `;
        return (
          title +
          "Keep this request pending until the launch date is supplied. ".repeat(
            index === 0 ? 7 : 3,
          )
        );
      }),
    ].join("\n"),
    resume:
      "What remains unfinished for Lantern, and what decision still needs me? Do not do the work yet.",
    request: "Lantern",
    waiting: ["date", "(?=.*blue)(?=.*(propos|unapproved|not approved|pending|undecided))"],
    absent: null,
    answer: [
      "Lantern",
      "date",
      "(?=.*blue)(?=.*(propos|unapproved|not approved|pending|undecided))",
    ],
    preflightBudget: true,
  },
];
