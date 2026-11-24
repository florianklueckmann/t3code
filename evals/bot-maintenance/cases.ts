import type { BotLearningKind } from "@t3tools/contracts";
import type * as Evidence from "../../apps/server/src/bots/BotMaintenanceEvidence.ts";

/**
 * One synthetic Bot in one project. Every case builds its packet through the engine's own
 * `buildBatch` from these rows, so the model sees exactly what a nightly pass would send.
 */
export const WORLD = {
  botId: "acme-helper",
  projectId: "acme-app",
  policy: "automatic",
  instructions: "Help maintain the Acme web app. Keep status updates short.",
  guidance: "Acme web app (acme/app), a TypeScript monorepo in /home/user/acme-app.",
} as const;

export interface LearningFixture {
  readonly id: string;
  readonly kind: BotLearningKind;
  readonly text: string;
  readonly origin: "instruction" | "correction";
  /** Another of the Bot's projects; the case's own project when absent. */
  readonly project?: string;
}

/** Matches an operation when every given field matches. */
export interface Where {
  /** Every pattern must match the lesson text. */
  readonly text?: ReadonlyArray<RegExp>;
  readonly kinds?: ReadonlyArray<BotLearningKind>;
  readonly op?: "add" | "replace" | "match";
  /** The learning entry id a replace or a match targets. */
  readonly target?: string;
  /** The other project's learning entry id a match names. */
  readonly matched?: string;
  /** The operation cites at least one of these source ids. */
  readonly cites?: ReadonlyArray<string>;
}

export type Check =
  | { readonly name: string; readonly expect: "some" | "none"; readonly where: Where }
  | { readonly name: string; readonly expect: "empty" };

export interface MaintenanceCase {
  readonly id: string;
  /** Where the expected behavior is specified. */
  readonly source: string;
  readonly sources: ReadonlyArray<Evidence.Source>;
  readonly learning?: ReadonlyArray<LearningFixture>;
  /** Suggestions the Bot already stored, as [suggested entry, matched entry]. */
  readonly suggestions?: ReadonlyArray<readonly [string, string]>;
  readonly checks: ReadonlyArray<Check>;
}

const OTHER_PROJECT = "acme-docs";
const subjectLine: LearningFixture = {
  id: "entry-subject-line",
  kind: "preference",
  text: "Commit subject lines stay under 50 characters and use the imperative mood.",
  origin: "correction",
};
const subjectLineElsewhere: LearningFixture = {
  id: "docs-subject-line",
  kind: "preference",
  text: "Write commit subjects in the imperative, 50 characters at most.",
  origin: "correction",
  project: OTHER_PROJECT,
};
const ordinary = [
  {
    kind: "home-input",
    id: "msg-9",
    text: "Thanks. Please rerun the flaky e2e job on PR 312 and tell me if it passes.",
  },
] as const;

const input = (id: string, text: string): Evidence.Source => ({ kind: "home-input", id, text });
const taskResult = (id: string, text: string): Evidence.Source => ({
  kind: "task-result",
  id,
  text,
});

export const CASES: ReadonlyArray<MaintenanceCase> = [
  {
    id: "correction-becomes-lesson",
    source: "T3B-20 closure row: correction; acceptance: a useful new lesson",
    sources: [
      input("msg-1", "Can you add the changelog entry for the login fix?"),
      input(
        "msg-2",
        "No, changelog entries don't go in CHANGELOG.md in this repo. Every user-visible change gets a file in .changeset/ created with `pnpm changeset`. Please redo it that way.",
      ),
    ],
    checks: [
      {
        name: "records the changeset lesson from the correction",
        expect: "some",
        where: { text: [/changeset/i], cites: ["msg-2"] },
      },
    ],
  },
  {
    id: "duplicate-no-new-lesson",
    source: "T3B-20 closure row: duplicate; ticket: merge duplicates",
    learning: [
      {
        id: "entry-changeset",
        kind: "fact",
        text: "Changelog entries are .changeset/ files created with `pnpm changeset`, not edits to CHANGELOG.md.",
        origin: "correction",
      },
    ],
    sources: [
      input(
        "msg-3",
        "Reminder: changelog entries go through `pnpm changeset`, not CHANGELOG.md. Can you add one for the avatar upload fix?",
      ),
    ],
    checks: [
      {
        name: "does not restate the changeset lesson",
        expect: "none",
        where: { text: [/changeset|changelog/i] },
      },
    ],
  },
  {
    id: "project-fact-stays-project",
    source: "T3B-20 closure row: unsafe generalization; ticket: project/Bot scope rules",
    sources: [
      input(
        "msg-4",
        "FYI for this repo: the staging database is Postgres 16 on port 5433, not the default 5432. Integration tests need DATABASE_URL pointed there.",
      ),
    ],
    checks: [
      {
        name: "records the port as a project fact",
        expect: "some",
        where: { text: [/5433/], kinds: ["fact"], cites: ["msg-4"] },
      },
      {
        name: "does not turn the database into a personal preference",
        expect: "none",
        where: { text: [/postgres|5433/i], kinds: ["preference"] },
      },
      {
        name: "does not claim it for other projects",
        expect: "none",
        where: {
          text: [/\b(all|every|other|any) (of (your|my|the) )?projects?\b|across projects/i],
        },
      },
    ],
  },
  {
    id: "conflict-replaces-not-adds",
    source:
      "T3B-20 closure row: conflicting add; ticket: identify conflicting or outdated learning",
    learning: [
      {
        id: "entry-previews",
        kind: "fact",
        text: "Deploy previews for pull requests run on Vercel.",
        origin: "correction",
      },
    ],
    sources: [
      input(
        "msg-5",
        "We moved deploy previews off Vercel last week. They run on Cloudflare Pages now, so look there for preview links.",
      ),
    ],
    checks: [
      {
        name: "replaces the outdated Vercel entry",
        expect: "some",
        where: { op: "replace", target: "entry-previews", text: [/cloudflare/i] },
      },
      {
        name: "does not add Cloudflare beside the Vercel entry",
        expect: "none",
        where: { op: "add", text: [/cloudflare/i] },
      },
    ],
  },
  {
    id: "failed-task-not-procedure",
    source:
      "T3B-20 acceptance: failed, cancelled or interrupted task results do not become confirmed successful procedures",
    sources: [
      taskResult(
        "task-1",
        "Tried to speed up CI by running `pnpm test --shard=4` in the GitHub workflow. Two shards failed with 'database is locked' errors and the run went red. I reverted the workflow change; CI is back on a single test job. Not resolved.",
      ),
      taskResult(
        "task-2",
        "Stopped before finishing: the user cancelled this task while I was rewriting the release script to use `release-it --ci`. The release script was not changed and nothing was run.",
      ),
    ],
    checks: [
      {
        name: "no procedure from the failed or cancelled work",
        expect: "none",
        where: { kinds: ["procedure"], cites: ["task-1", "task-2"] },
      },
      {
        name: "nothing learned from the untried release-it step",
        expect: "none",
        where: { text: [/release-it/i] },
      },
    ],
  },
  {
    id: "own-output-not-evidence",
    source:
      "T3B-20 ticket: maintenance output and previously injected memories must not become fresh evidence",
    learning: [
      {
        id: "entry-bullets",
        kind: "preference",
        text: "Status updates are three bullet points at most.",
        origin: "correction",
      },
    ],
    sources: [
      input(
        "msg-6",
        'Your last reply said: "Migrations in this repo are always squashed before a release." Where did that come from? Anyway, what is the status of the avatar upload fix?',
      ),
      taskResult(
        "task-3",
        "Following the project memory (status updates are three bullet points at most):\n- Avatar upload fix merged.\n- Tests green.\n- Nothing blocked.",
      ),
    ],
    checks: [
      {
        name: "does not learn the assistant's quoted claim",
        expect: "none",
        where: { text: [/squash/i] },
      },
      {
        name: "does not relearn the echoed memory",
        expect: "none",
        where: { text: [/bullet/i] },
      },
      { name: "proposes nothing", expect: "empty" },
    ],
  },
  {
    id: "ordinary-conversation-empty",
    source: "T3B-20 closure row: ordinary control",
    sources: [
      input("msg-7", "Morning! Can you summarize what changed in yesterday's PRs?"),
      input("msg-8", "Thanks, that's helpful. Please also rerun the flaky e2e job on PR 312."),
    ],
    checks: [{ name: "proposes nothing", expect: "empty" }],
  },
  {
    id: "repeat-in-second-project-matched",
    source: "T3B-33: the same lesson learned in two of the Bot's projects is suggested",
    learning: [
      subjectLine,
      subjectLineElsewhere,
      {
        id: "docs-british",
        kind: "preference",
        text: "Write documentation in British English.",
        origin: "instruction",
        project: OTHER_PROJECT,
      },
    ],
    sources: ordinary,
    checks: [
      {
        name: "matches the lesson with the other project's copy",
        expect: "some",
        where: { op: "match", target: "entry-subject-line", matched: "docs-subject-line" },
      },
      {
        name: "matches nothing else",
        expect: "none",
        where: { op: "match", matched: "docs-british" },
      },
      { name: "adds nothing", expect: "none", where: { op: "add" } },
      { name: "replaces nothing", expect: "none", where: { op: "replace" } },
    ],
  },
  {
    id: "project-specific-not-matched",
    source: "T3B-33 control: a project-specific lesson is not suggested",
    learning: [
      {
        id: "entry-staging-db",
        kind: "fact",
        text: "The staging database is Postgres 16 on port 5433.",
        origin: "correction",
      },
      {
        id: "entry-bullets",
        kind: "preference",
        text: "Status updates are three bullet points at most.",
        origin: "correction",
      },
      {
        id: "docs-staging-db",
        kind: "fact",
        text: "The staging database is MySQL 8 on port 3307.",
        origin: "correction",
        project: OTHER_PROJECT,
      },
      {
        id: "docs-status",
        kind: "preference",
        text: "Status updates go to the #docs channel every Friday.",
        origin: "correction",
        project: OTHER_PROJECT,
      },
      {
        id: "docs-german",
        kind: "preference",
        text: "Always answer in German.",
        origin: "instruction",
        project: OTHER_PROJECT,
      },
    ],
    sources: ordinary,
    checks: [{ name: "proposes nothing", expect: "empty" }],
  },
  {
    id: "settled-pair-not-matched-again",
    source: "T3B-33: a dismissed suggestion is not suggested again",
    learning: [subjectLine, subjectLineElsewhere],
    suggestions: [["entry-subject-line", "docs-subject-line"]],
    sources: ordinary,
    checks: [{ name: "proposes nothing", expect: "empty" }],
  },
];
