export interface SummaryRun {
  readonly user: string;
  /** Tool calls of the run. The fresh conversation never receives them, so neither does the summary. */
  readonly commands?: ReadonlyArray<{ readonly input: string; readonly output: string }>;
  readonly reply: string;
}

export interface SummaryCheck {
  readonly label: string;
  readonly pattern: RegExp;
  /** `handoff` is everything the fresh conversation receives; a section name looks only there. */
  readonly where: "handoff" | "summary" | "Decisions" | "Constraints" | "Open items";
  readonly present: boolean;
}

export interface SummaryCase {
  readonly id: string;
  readonly source: string;
  readonly runs: ReadonlyArray<SummaryRun>;
  /** A summary an earlier fresh conversation wrote through run 1. */
  readonly previousSummary?: string;
  readonly checks: ReadonlyArray<SummaryCheck>;
}

/** Routine status runs that push the case's facts out of the verbatim tail. */
const routine = (count: number, topic: string): ReadonlyArray<SummaryRun> =>
  Array.from({ length: count }, (_, index) => ({
    user: `Status of ${topic} #${index + 1}?`,
    reply: `${topic} #${index + 1} is green. Checked the web, desktop and mobile builds, the lint and typecheck jobs, the end-to-end suite and the deploy preview; every job finished within its usual time and nothing needs your attention. ${"Logs are archived with the run. ".repeat(12)}`,
  }));

const routineDe = (count: number): ReadonlyArray<SummaryRun> =>
  Array.from({ length: count }, (_, index) => ({
    user: `Wie steht der Nightly-Build #${index + 1}?`,
    reply: `Nightly #${index + 1} ist grün. Web, Desktop und Mobile wurden gebaut, Lint und Typecheck liefen durch, und die End-to-End-Tests haben bestanden. ${"Die Protokolle liegen beim Lauf. ".repeat(12)}`,
  }));

export const cases: ReadonlyArray<SummaryCase> = [
  {
    id: "decision-in-the-middle",
    source:
      "T3B-50: a fresh conversation for a Bot Home carried runs 1 and 148-157 only; the decisions of runs 2-147 were lost.",
    runs: [
      {
        user: "You maintain the job queue of acme/app in /home/user/acme/app.",
        reply: "Understood. I will keep the job queue healthy and report here.",
      },
      {
        user: "Decision: the job queue uses Postgres advisory locks, not Redis, because operations will not run Redis.",
        reply: "Switched the queue design to Postgres advisory locks.",
      },
      {
        user: "Never force-push main. Open pull requests against release/next.",
        reply: "Noted: no force-pushes to main, and pull requests target release/next.",
      },
      {
        user: "Run the tests.",
        commands: [
          {
            input: "vp test run src/billing.test.ts",
            output:
              "FAIL src/billing.test.ts > charges once\nAssertionError: expected 2 to be 1\n    at Object.<anonymous> (/home/user/acme/app/src/billing.test.ts:41:11)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
          },
        ],
        reply:
          "The billing test fails: a retried charge is billed twice.\n```\nAssertionError: expected 2 to be 1\n    at Object.<anonymous> (/home/user/acme/app/src/billing.test.ts:41:11)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n```",
      },
      {
        user: "Fix the double charge.",
        reply: "Fixed the double charge in src/billing.ts; the billing tests pass now.",
      },
      {
        user: "After the 2.4 release, move the billing cron onto the job queue. Remind me when 2.4 is out.",
        reply: "Noted: the billing cron moves onto the job queue after the 2.4 release.",
      },
      ...routine(40, "nightly"),
    ],
    checks: [
      {
        label: "decision reaches the fresh conversation",
        pattern: /advisory lock/i,
        where: "handoff",
        present: true,
      },
      { label: "constraint is kept", pattern: /force-?push/i, where: "handoff", present: true },
      {
        label: "open item is listed",
        pattern: /billing cron/i,
        where: "Open items",
        present: true,
      },
      {
        label: "finished work is not open",
        pattern: /double|twice/i,
        where: "Open items",
        present: false,
      },
      {
        label: "no stack trace",
        pattern: /Object\.<anonymous>|processTicksAndRejections|:41:11/,
        where: "summary",
        present: false,
      },
    ],
  },
  {
    id: "update-previous-summary",
    source:
      "T3B-50: the next fresh start updates the previous summary instead of writing a new one.",
    previousSummary: [
      "## Decisions",
      "- Ship the CSV export behind the `export_v2` flag.",
      "",
      "## Open items",
      "- Add pagination to /api/reports.",
    ].join("\n"),
    runs: [
      {
        user: "You own the reports feature of acme/app.",
        reply: "Understood.",
      },
      {
        user: "Pagination for /api/reports is merged.",
        reply: "Confirmed: /api/reports pages its results now.",
      },
      {
        user: "Decision: drop the XLSX export, CSV only.",
        reply: "Removed the XLSX export; CSV is the only format.",
      },
      ...routine(40, "report job"),
    ],
    checks: [
      {
        label: "previous decision is kept",
        pattern: /export_v2/,
        where: "handoff",
        present: true,
      },
      { label: "new decision is added", pattern: /XLSX/i, where: "handoff", present: true },
      {
        label: "finished open item is closed",
        pattern: /pagination/i,
        where: "Open items",
        present: false,
      },
    ],
  },
  {
    id: "german-thread",
    source: "Control: Bot Homes are often German; the summary keeps the conversation's language.",
    runs: [
      {
        user: "Du betreust die Releases von acme/app.",
        reply: "Verstanden, ich kümmere mich um die Releases.",
      },
      {
        user: "Entscheidung: Releases gehen nur dienstags raus, nie freitags.",
        reply: "Notiert: Releases nur dienstags.",
      },
      ...routineDe(40),
    ],
    checks: [
      { label: "decision is kept", pattern: /dienstag/i, where: "handoff", present: true },
      {
        label: "written in German",
        pattern: /\b(und|nur|wird|werden|ist|sind)\b/i,
        where: "summary",
        present: true,
      },
    ],
  },
];
