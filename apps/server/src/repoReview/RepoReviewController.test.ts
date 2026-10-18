import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  type RepoReviewJobResult,
  type RepoReviewOwnerView,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { publicationMarker } from "./decisions.ts";
import * as RepoReviewController from "./RepoReviewController.ts";
import * as RepoReviewGitHub from "./RepoReviewGitHub.ts";
import * as RepoReviewStore from "./RepoReviewStore.ts";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_1 = "1".repeat(40);
const BASE_2 = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);
const PROJECT = ProjectId.make("project:widgets");
const PREFIX = "Hey, this is the review bot writing on behalf of reviewer.";

// ---------------------------------------------------------------------------
// Fakes. GitHub is stateful so writes are visible to later reads, as on github.com.
// ---------------------------------------------------------------------------

interface FakePullRequest {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  baseRef: string;
  updatedAt: string;
  mergeableState: string;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  events: RepoReviewGitHub.RepoReviewConversationEvent[];
  threads: RepoReviewGitHub.RepoReviewReviewThread[];
}

type Failure = {
  readonly error: RepoReviewGitHub.RepoReviewGitHubError;
  readonly landAnyway: boolean;
};

const WRITE_OPERATIONS = new Set(["createReviewComment", "createIssueComment", "approve", "merge"]);

const makeFakeGitHub = () => {
  const state = {
    viewer: "reviewer",
    permission: "admin" as RepoReviewGitHub.RepoReviewViewerPermission,
    branches: new Map([["main", BASE_1]]),
    prs: new Map<number, FakePullRequest>(),
    calls: [] as string[],
    failures: new Map<string, Failure[]>(),
    nextId: 5000,
  };
  const unavailable = (operation: string) =>
    new RepoReviewGitHub.RepoReviewGitHubError({ operation, outcome: "unavailable" });

  const run = <A>(
    operation: string,
    body: () => A,
  ): Effect.Effect<A, RepoReviewGitHub.RepoReviewGitHubError> =>
    Effect.suspend(() => {
      state.calls.push(operation);
      const failure = state.failures.get(operation)?.shift();
      if (failure === undefined) return Effect.sync(body);
      if (failure.landAnyway) body();
      return Effect.fail(failure.error);
    });
  const pr = (number: number) => {
    const found = state.prs.get(number);
    if (found === undefined) throw new Error(`no fake PR ${number}`);
    return found;
  };
  const addEvent = (
    number: number,
    input: Omit<
      RepoReviewGitHub.RepoReviewConversationEvent,
      "keys" | "githubId" | "url" | "createdAt"
    >,
  ) => {
    const id = String(state.nextId++);
    const event = {
      ...input,
      keys: [`gh:node${id}`, `gh:${id}`],
      githubId: id,
      url: `https://github.com/acme/widgets/pull/${number}#c${id}`,
      // After the import fixture's handover, so new activity is never mistaken for history.
      createdAt: `2026-10-19T12:00:${String(state.nextId % 60).padStart(2, "0")}Z`,
    };
    pr(number).events.push(event);
    pr(number).updatedAt = `${pr(number).updatedAt}+`;
    return { githubId: id, url: event.url };
  };

  const service = RepoReviewGitHub.RepoReviewGitHub.of({
    getViewerLogin: () => run("getViewerLogin", () => state.viewer),
    getRepository: () =>
      run("getRepository", () => ({
        id: "R_widgets",
        fullName: "acme/widgets",
        defaultBranch: "main",
        archived: false,
        viewerPermission: state.permission,
        allowedMergeMethods: ["merge" as const],
      })),
    listOpenPullRequests: () =>
      run("listOpenPullRequests", () =>
        [...state.prs.values()]
          .filter((candidate) => candidate.state === "open")
          .map((candidate) => ({
            number: candidate.number,
            headSha: candidate.headSha,
            updatedAt: candidate.updatedAt,
            draft: candidate.draft,
          })),
      ),
    getPullRequest: ({ number }) =>
      run("getPullRequest", () => {
        const found = pr(number);
        return {
          number,
          url: `https://github.com/acme/widgets/pull/${number}`,
          title: found.title,
          body: "Adds widgets.",
          state: found.state,
          draft: found.draft,
          authorLogin: "reviewer",
          headRef: `feature/${number}`,
          headSha: found.headSha,
          headRepository: "acme/widgets",
          baseRef: found.baseRef,
          githubBaseSha: state.branches.get(found.baseRef) ?? BASE_1,
          updatedAt: found.updatedAt,
          mergeable:
            found.mergeableState === "clean"
              ? true
              : found.mergeableState === "dirty"
                ? false
                : null,
          mergeableState: found.mergeableState,
          mergeCommitSha: found.mergeCommitSha,
          mergedBy: found.mergedBy,
        };
      }),
    getBranchSha: ({ branch }) => run("getBranchSha", () => state.branches.get(branch) ?? BASE_1),
    getMergeBase: () => run("getMergeBase", () => MERGE_BASE),
    listConversation: ({ number }) => run("listConversation", () => [...pr(number).events]),
    listReviewThreads: ({ number }) => run("listReviewThreads", () => [...pr(number).threads]),
    createReviewComment: ({ number, body }) =>
      run("createReviewComment", () =>
        addEvent(number, {
          kind: "review_comment",
          authorLogin: state.viewer,
          authorIsBot: false,
          body,
          reviewState: null,
          commitId: null,
        }),
      ),
    createIssueComment: ({ number, body }) =>
      run("createIssueComment", () =>
        addEvent(number, {
          kind: "issue_comment",
          authorLogin: state.viewer,
          authorIsBot: false,
          body,
          reviewState: null,
          commitId: null,
        }),
      ),
    approve: ({ number, body, commitId }) =>
      run("approve", () =>
        addEvent(number, {
          kind: "review",
          authorLogin: state.viewer,
          authorIsBot: false,
          body,
          reviewState: "APPROVED",
          commitId,
        }),
      ),
    merge: ({ number, sha }) =>
      Effect.suspend(() => {
        const found = pr(number);
        if (found.headSha !== sha) {
          state.calls.push("merge");
          return Effect.fail(
            new RepoReviewGitHub.RepoReviewGitHubError({
              operation: "merge",
              outcome: "rejected",
              status: 409,
            }),
          );
        }
        return run("merge", () => {
          found.state = "merged";
          found.mergedBy = state.viewer;
          found.mergeCommitSha = "9".repeat(40);
          return { mergeCommitSha: found.mergeCommitSha };
        });
      }),
  });

  return {
    state,
    service,
    unavailable,
    writes: () => state.calls.filter((call) => WRITE_OPERATIONS.has(call)),
    openPullRequest: (number: number, overrides: Partial<FakePullRequest> = {}) => {
      state.prs.set(number, {
        number,
        title: `PR ${number}`,
        state: "open",
        draft: false,
        headSha: HEAD_A,
        baseRef: "main",
        updatedAt: "2026-10-18T10:00:00Z",
        mergeableState: "clean",
        mergedBy: null,
        mergeCommitSha: null,
        events: [],
        threads: [],
        ...overrides,
      });
    },
    pr,
    authorComment: (number: number, body: string) =>
      addEvent(number, {
        kind: "issue_comment",
        authorLogin: "reviewer",
        authorIsBot: false,
        body,
        reviewState: null,
        commitId: null,
      }),
  };
};

type FakeGitHub = ReturnType<typeof makeFakeGitHub>;

interface FakeRun {
  id: string;
  status: string;
}

const makeFakeThreads = () => {
  const launches = new Map<string, ThreadId>();
  const runs = new Map<string, FakeRun[]>();
  const state = {
    launchCalls: 0,
    briefs: [] as string[],
    interrupts: [] as string[],
    /** Fail the next launch after the thread was created: an ambiguous answer. */
    failAfterCreate: 0,
  };
  const launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"] = (input) =>
    Effect.suspend(() => {
      state.launchCalls++;
      const threadId = launches.get(input.commandId) ?? input.threadId!;
      if (!launches.has(input.commandId)) {
        launches.set(input.commandId, threadId);
        runs.set(threadId, [{ id: `run:${threadId}:1`, status: "running" }]);
        state.briefs.push(input.initialMessage?.text ?? "");
      }
      if (state.failAfterCreate > 0) {
        state.failAfterCreate--;
        return Effect.die(new Error("connection reset after the command committed"));
      }
      return Effect.succeed({
        threadId,
        projection: { runs: runs.get(threadId) } as never,
        resumed: false,
      });
    });
  const threadManagement = {
    getThreadShell: (threadId: ThreadId) =>
      Effect.succeed(runs.has(threadId) ? ({ deletedAt: null } as never) : null),
    getThreadRecords: (threadId: ThreadId) =>
      Effect.succeed({ thread: {}, runs: runs.get(threadId) ?? [] } as never),
    interruptThread: (input: { readonly threadId: ThreadId }) =>
      Effect.sync(() => {
        state.interrupts.push(input.threadId);
        for (const run of runs.get(input.threadId) ?? []) run.status = "interrupted";
        return { type: "no_active_run" } as const;
      }),
  };
  return {
    state,
    launch,
    threadManagement,
    distinctThreads: () => launches.size,
    endRun: (threadId: string, status = "completed") => {
      for (const run of runs.get(threadId) ?? []) run.status = status;
    },
    addRun: (threadId: string) =>
      runs.get(threadId)?.push({ id: `run:${threadId}:2`, status: "running" }),
  };
};

type FakeThreads = ReturnType<typeof makeFakeThreads>;

const controllerLayer = (github: FakeGitHub, threads: FakeThreads) =>
  RepoReviewController.layer.pipe(
    Layer.provide(RepoReviewStore.layer),
    Layer.provide(Layer.succeed(RepoReviewGitHub.RepoReviewGitHub, github.service)),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch: threads.launch })),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)(
        threads.threadManagement as never,
      ),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repos/widgets" } as never)),
      }),
    ),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed({ canonicalKey: "github.com/acme/widgets" } as never),
      }),
    ),
    // Tests drive passes explicitly; no background clock races them.
    Layer.provide(
      Layer.succeed(Scheduler.Scheduler, Scheduler.Scheduler.of({ register: () => Effect.void })),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  );

const withController = <A, E, R>(
  github: FakeGitHub,
  threads: FakeThreads,
  body: (
    controller: RepoReviewController.RepoReviewController["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* RepoReviewController.RepoReviewController);
  }).pipe(Effect.provide(controllerLayer(github, threads)));

const modelSelection = { instanceId: "codex", model: "gpt-6.1-sol" } as never;

const startActive = (
  controller: RepoReviewController.RepoReviewController["Service"],
  policy: { approve?: boolean; merge?: boolean; postFindings?: boolean } = {},
) =>
  controller.start({
    projectId: PROJECT,
    repository: "acme/widgets",
    activate: true,
    policy: {
      modelSelection,
      approve: true,
      merge: true,
      commentPrefix: PREFIX,
      ...policy,
    },
  });

const view = (controller: RepoReviewController.RepoReviewController["Service"]) =>
  controller
    .status({ includeStopped: true })
    .pipe(Effect.map((status): RepoReviewOwnerView => status.owners[0]!));

const latestJob = (
  controller: RepoReviewController.RepoReviewController["Service"],
  pullRequest = 7,
) =>
  view(controller).pipe(
    Effect.map((owner) => owner.jobs.find((job) => job.pullRequest === pullRequest)!),
  );

const cleanResult = (
  job: { id: string; headSha: string; baseSha: string },
  overrides: Partial<RepoReviewJobResult> = {},
): RepoReviewJobResult => ({
  jobId: job.id as RepoReviewJobResult["jobId"],
  repository: "acme/widgets",
  pullRequest: 7,
  pins: { headSha: job.headSha, baseRef: "main", baseSha: job.baseSha, mergeBaseSha: MERGE_BASE },
  verdict: "clean",
  summary: "No findings.",
  findings: [],
  evidence: [
    { provenance: "fresh_reviewer_check", kind: "unit", description: "vp test", outcome: "passed" },
  ],
  coverage: {
    effectiveDiffInspected: true,
    filesInspected: 4,
    reusedUnchangedPaths: [],
    notes: "",
  },
  ...overrides,
});

const findingResult = (job: { id: string; headSha: string; baseSha: string }) =>
  cleanResult(job, {
    verdict: "findings",
    findings: [
      {
        status: "new",
        priority: "P2",
        title: "Widget count overflows",
        path: "src/widgets.ts",
        line: 12,
        scenario: "More than 255 widgets.",
        impact: "Count wraps to zero.",
        body: "Use a wider integer.",
      },
    ],
  });

const pollInterval = TestClock.adjust("301 seconds");

/** Launches the first review of PR 7 and returns its job. */
const launchFirstReview = (controller: RepoReviewController.RepoReviewController["Service"]) =>
  Effect.gen(function* () {
    yield* startActive(controller);
    yield* controller.runDueWork;
    return yield* latestJob(controller);
  });

describe("RepoReviewController", () => {
  it.effect(
    "reviews a new pull request once, lands it exactly once, and idles with zero model turns",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7);
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const job = yield* launchFirstReview(controller);
            assert.strictEqual(job.status, "running");
            assert.strictEqual(threads.state.launchCalls, 1);
            assert.include(threads.state.briefs[0]!, `\`${HEAD_A}\``);
            assert.include(threads.state.briefs[0]!, "repo_review_submit_result");

            const accepted = yield* controller.submitResult(job.threadId!, cleanResult(job));
            assert.strictEqual(accepted.jobStatus, "result_received");
            yield* controller.runDueWork;
            assert.deepStrictEqual(github.writes(), ["approve", "merge"]);
            const approval = github.pr(7).events.find((event) => event.kind === "review")!;
            assert.strictEqual(approval.commitId, HEAD_A);

            // Idle: the merged PR and an unchanged repository cost GitHub reads only.
            threads.endRun(job.threadId!);
            const before = github.state.calls.length;
            for (let tick = 0; tick < 4; tick++) {
              yield* pollInterval;
              yield* controller.runDueWork;
            }
            assert.strictEqual(threads.state.launchCalls, 1);
            assert.deepStrictEqual(github.writes(), ["approve", "merge"]);
            const idleCalls = new Set(github.state.calls.slice(before));
            for (const call of idleCalls) {
              assert.include(
                ["getViewerLogin", "getRepository", "listOpenPullRequests", "getPullRequest"],
                call,
              );
            }
            const owner = yield* view(controller);
            assert.deepStrictEqual(
              owner.jobs.map((candidate) => candidate.status),
              ["completed"],
            );
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "accepts a duplicate result delivery once and rejects stale, foreign or conflicting results",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7);
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const job = yield* launchFirstReview(controller);
            const wrongSha = yield* Effect.flip(
              controller.submitResult(job.threadId!, cleanResult({ ...job, headSha: HEAD_B })),
            );
            assert.strictEqual(wrongSha.code, "invalid_result");
            assert.include(wrongSha.message, `pins.headSha must be ${HEAD_A}`);

            const foreign = yield* Effect.flip(
              controller.submitResult(ThreadId.make("thread:somewhere-else"), cleanResult(job)),
            );
            assert.strictEqual(foreign.code, "not_found");

            const first = yield* controller.submitResult(job.threadId!, cleanResult(job));
            const again = yield* controller.submitResult(job.threadId!, cleanResult(job));
            assert.isFalse(first.duplicate);
            assert.isTrue(again.duplicate);
            const different = yield* Effect.flip(
              controller.submitResult(job.threadId!, findingResult(job)),
            );
            assert.strictEqual(different.code, "conflict");

            yield* controller.runDueWork;
            yield* controller.runDueWork;
            assert.deepStrictEqual(github.writes(), ["approve", "merge"]);
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "recovers an ambiguous launch with the same command id instead of starting a second agent",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7);
        threads.state.failAfterCreate = 1;
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const job = yield* launchFirstReview(controller);
            assert.strictEqual(job.status, "launching");
            // The thread id was bound before launching, so a result could already find its job.
            assert.strictEqual(job.threadId, `thread:repo-review:${job.id}`);
            yield* controller.runDueWork;
            const recovered = yield* latestJob(controller);
            assert.strictEqual(recovered.status, "running");
            assert.strictEqual(threads.state.launchCalls, 2);
            assert.strictEqual(threads.distinctThreads(), 1);
            assert.strictEqual(threads.state.briefs.length, 1);
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("fails a run that ends without a result and never relaunches it on its own", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          threads.endRun(job.threadId!, "failed");
          yield* controller.runDueWork;
          for (let tick = 0; tick < 3; tick++) {
            yield* pollInterval;
            yield* controller.runDueWork;
          }
          const owner = yield* view(controller);
          assert.strictEqual(owner.jobs[0]!.status, "failed");
          assert.strictEqual(threads.state.launchCalls, 1);
          assert.include(owner.pullRequests[0]!.blocker ?? "", "requeue");

          yield* controller.control(
            { ownerId: owner.owner.id, action: "requeue", pullRequest: 7 },
            undefined,
          );
          yield* controller.runDueWork;
          assert.strictEqual(threads.state.launchCalls, 2);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("confirms an ambiguous comment by read-back and never posts it twice", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      // The comment lands, but the answer is lost.
      github.state.failures.set("createReviewComment", [
        { error: github.unavailable("comment"), landAnyway: true },
      ]);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          yield* controller.submitResult(job.threadId!, findingResult(job));
          yield* controller.runDueWork;
          let owner = yield* view(controller);
          assert.strictEqual(owner.publications[0]!.status, "uncertain");
          yield* controller.runDueWork;
          owner = yield* view(controller);
          assert.strictEqual(owner.publications[0]!.status, "confirmed");
          assert.strictEqual(
            github.writes().filter((call) => call === "createReviewComment").length,
            1,
          );
          assert.isNotNull(owner.openFindings[0]!.url);
          // Our comment never counts as an author event.
          yield* pollInterval;
          yield* controller.runDueWork;
          assert.strictEqual(threads.state.launchCalls, 1);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("retries a write that provably never landed only after the grace period", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      github.state.failures.set("createReviewComment", [
        { error: github.unavailable("comment"), landAnyway: false },
      ]);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          yield* controller.submitResult(job.threadId!, findingResult(job));
          yield* controller.runDueWork;
          yield* controller.runDueWork;
          assert.strictEqual((yield* view(controller)).publications[0]!.status, "uncertain");
          yield* TestClock.adjust("11 minutes");
          yield* controller.runDueWork; // absent after grace → planned again
          yield* controller.runDueWork; // posted
          const comments = github.pr(7).events.filter((event) => event.kind === "review_comment");
          assert.strictEqual(comments.length, 1);
          assert.strictEqual((yield* view(controller)).publications[0]!.status, "confirmed");
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("turns writes interrupted by a restart into read-back reconciliation", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      const sql = yield* SqlClient.SqlClient;
      const publicationId = yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          yield* controller.submitResult(job.threadId!, findingResult(job));
          // Apply the result (plans the comment) while GitHub writes fail definitively, then
          // simulate a crash right after the write was claimed.
          github.state.failures.set("createReviewComment", [
            {
              error: new RepoReviewGitHub.RepoReviewGitHubError({
                operation: "comment",
                outcome: "rate_limited",
              }),
              landAnyway: false,
            },
          ]);
          yield* controller.runDueWork;
          const owner = yield* view(controller);
          return owner.publications[0]!.id;
        }),
      );
      // The crash: the comment was sent and the process died before recording the answer.
      github.authorComment(7, `${PREFIX}\n\nposted ${publicationMarker(publicationId)}`);
      yield* sql`UPDATE repo_review_publications SET status = 'attempting' WHERE publication_id = ${publicationId}`;

      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* view(controller)).publications[0]!.status, "uncertain");
          yield* controller.runDueWork;
          assert.strictEqual((yield* view(controller)).publications[0]!.status, "confirmed");
          assert.deepStrictEqual(github.writes(), ["createReviewComment"]);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "authorizes nothing from a result whose head moved, and reviews the new head instead",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7);
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const job = yield* launchFirstReview(controller);
            yield* controller.submitResult(job.threadId!, cleanResult(job));
            github.pr(7).headSha = HEAD_B;
            github.pr(7).updatedAt = "2026-10-18T13:00:00Z";
            yield* controller.runDueWork;
            let owner = yield* view(controller);
            assert.strictEqual(
              owner.jobs.find((candidate) => candidate.id === job.id)!.status,
              "stale",
            );
            assert.deepStrictEqual(github.writes(), []);
            yield* pollInterval;
            yield* controller.runDueWork;
            owner = yield* view(controller);
            const next = owner.jobs.find((candidate) => candidate.round === 2)!;
            assert.strictEqual(next.headSha, HEAD_B);
            assert.strictEqual(next.trigger, "new_head");
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("rejects the late result of a superseded job and keeps the newer round", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const first = yield* launchFirstReview(controller);
          github.pr(7).headSha = HEAD_B;
          github.pr(7).updatedAt = "2026-10-18T13:00:00Z";
          yield* pollInterval;
          yield* controller.runDueWork;
          assert.include(threads.state.interrupts, first.threadId!);
          const late = yield* Effect.flip(
            controller.submitResult(first.threadId!, cleanResult(first)),
          );
          assert.strictEqual(late.code, "conflict");
          const second = (yield* view(controller)).jobs.find((candidate) => candidate.round === 2)!;
          assert.strictEqual(second.status, "running");
          yield* controller.submitResult(second.threadId!, cleanResult(second));
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), ["approve", "merge"]);
          assert.strictEqual(
            github.pr(7).events.find((event) => event.kind === "review")!.commitId,
            HEAD_B,
          );
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("re-reviews instead of landing when the base moved after a clean review", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          yield* controller.submitResult(job.threadId!, cleanResult(job));
          github.state.branches.set("main", BASE_2);
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), []);
          const owner = yield* view(controller);
          assert.strictEqual(
            owner.publications.find((publication) => publication.kind === "approval")!.status,
            "blocked",
          );
          const integration = owner.jobs.find(
            (candidate) => candidate.trigger === "integration_change",
          )!;
          assert.strictEqual(integration.baseSha, BASE_2);
          yield* controller.runDueWork;
          const running = yield* latestJob(controller);
          yield* controller.submitResult(running.threadId!, cleanResult(running));
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), ["approve", "merge"]);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("imports an existing exact-head approval and holds merges GitHub blocks", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7, { mergeableState: "blocked" });
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          github.pr(7).events.push({
            keys: ["gh:PRR_1", "gh:77"],
            kind: "review",
            githubId: "77",
            authorLogin: "reviewer",
            authorIsBot: false,
            createdAt: "2026-10-18T12:00:00Z",
            url: "https://github.com/acme/widgets/pull/7#pullrequestreview-77",
            body: "LGTM",
            reviewState: "APPROVED",
            commitId: HEAD_A,
          });
          yield* controller.submitResult(job.threadId!, cleanResult(job));
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), []);
          const owner = yield* view(controller);
          const approval = owner.publications.find(
            (publication) => publication.kind === "approval",
          )!;
          assert.strictEqual(approval.status, "confirmed");
          assert.strictEqual(
            approval.url,
            "https://github.com/acme/widgets/pull/7#pullrequestreview-77",
          );
          const merge = owner.publications.find((publication) => publication.kind === "merge")!;
          assert.strictEqual(merge.status, "blocked");
          assert.include(merge.detail ?? "", "blocked");

          // Checks went green: the blocked merge is re-evaluated on the next poll.
          github.pr(7).mergeableState = "clean";
          threads.endRun(job.threadId!);
          yield* pollInterval;
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), ["merge"]);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "starts one review per material author reply, never for its own comments or mergeability noise",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7);
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const job = yield* launchFirstReview(controller);
            yield* controller.submitResult(job.threadId!, findingResult(job));
            yield* controller.runDueWork;
            threads.endRun(job.threadId!);
            // Mergeability churn and a stale conflict state on the same head.
            github.pr(7).mergeableState = "dirty";
            github.pr(7).updatedAt = "2026-10-18T14:00:00Z";
            yield* pollInterval;
            yield* controller.runDueWork;
            assert.strictEqual(threads.state.launchCalls, 1);

            // The author (same account as the reviewer) replies; that is material.
            github.authorComment(7, "Fixed in the next push? No — this is intended, see the spec.");
            yield* pollInterval;
            yield* controller.runDueWork;
            assert.strictEqual(threads.state.launchCalls, 2);
            const second = yield* latestJob(controller);
            assert.strictEqual(second.trigger, "author_event");
            assert.include(threads.state.briefs[1]!, "this is intended");
            // The same reply delivered again is a duplicate.
            threads.endRun(second.threadId!, "failed");
            yield* controller.runDueWork;
            yield* pollInterval;
            yield* controller.runDueWork;
            assert.strictEqual(threads.state.launchCalls, 2);
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("pause blocks launches and writes; resume publishes after a fresh check", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      github.openPullRequest(8, { headSha: HEAD_B });
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          yield* startActive(controller, {});
          // Capacity one: PR 7 runs, PR 8 waits in the queue.
          const ownerId = (yield* view(controller)).owner.id;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE repo_review_owners SET policy_json = json_set(policy_json, '$.maxConcurrentJobs', 1)`;
          yield* controller.runDueWork;
          const job = yield* latestJob(controller, 7);
          yield* controller.control({ ownerId, action: "pause" }, undefined);
          yield* controller.submitResult(job.threadId!, findingResult(job));
          const callsBefore = github.state.calls.filter(
            (call) => call === "listOpenPullRequests",
          ).length;
          for (let tick = 0; tick < 3; tick++) {
            yield* pollInterval;
            yield* controller.runDueWork;
          }
          assert.deepStrictEqual(github.writes(), []);
          assert.strictEqual(threads.state.launchCalls, 1);
          assert.strictEqual(
            github.state.calls.filter((call) => call === "listOpenPullRequests").length,
            callsBefore,
          );
          const paused = yield* view(controller);
          assert.strictEqual(paused.owner.status, "paused");
          assert.strictEqual(paused.publications[0]!.status, "planned");

          yield* controller.control({ ownerId, action: "resume" }, undefined);
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), ["createReviewComment"]);
          assert.strictEqual(threads.state.launchCalls, 2);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "pause_after_round lets the admitted review publish, then pauses without starting queued work",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7);
        github.openPullRequest(8, { headSha: HEAD_B });
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            yield* startActive(controller, { approve: false, merge: false });
            const ownerId = (yield* view(controller)).owner.id;
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE repo_review_owners SET policy_json = json_set(policy_json, '$.maxConcurrentJobs', 1)`;
            yield* controller.runDueWork;
            const job = yield* latestJob(controller, 7);
            yield* controller.control({ ownerId, action: "pause_after_round" }, undefined);
            assert.strictEqual((yield* view(controller)).owner.status, "pausing");
            yield* controller.runDueWork;
            assert.strictEqual((yield* view(controller)).owner.status, "pausing");
            yield* controller.submitResult(job.threadId!, findingResult(job));
            yield* controller.runDueWork;
            const owner = yield* view(controller);
            assert.deepStrictEqual(github.writes(), ["createReviewComment"]);
            assert.strictEqual(owner.owner.status, "paused");
            assert.strictEqual(threads.state.launchCalls, 1);
            assert.strictEqual(
              owner.jobs.find((candidate) => candidate.pullRequest === 8)!.status,
              "queued",
            );
            // Late events cannot restart a paused owner.
            github.authorComment(7, "ping");
            yield* pollInterval;
            yield* controller.runDueWork;
            assert.strictEqual((yield* view(controller)).owner.status, "paused");
            assert.strictEqual(threads.state.launchCalls, 1);
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("pauses itself when write access is revoked or the credential changes", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          yield* startActive(controller);
          github.state.permission = "read";
          yield* controller.runDueWork;
          let owner = yield* view(controller);
          assert.strictEqual(owner.owner.status, "paused");
          assert.include(owner.owner.statusReason ?? "", "revoked");
          assert.strictEqual(threads.state.launchCalls, 0);

          github.state.permission = "admin";
          github.state.viewer = "someone-else";
          yield* controller.control({ ownerId: owner.owner.id, action: "resume" }, undefined);
          yield* controller.runDueWork;
          owner = yield* view(controller);
          assert.strictEqual(owner.owner.status, "paused");
          assert.include(owner.owner.statusReason ?? "", "someone-else");
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("fails closed on unreadable GitHub without changing state", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      github.state.failures.set("listOpenPullRequests", [
        { error: github.unavailable("list"), landAnyway: false },
      ]);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          yield* startActive(controller);
          yield* controller.runDueWork;
          const owner = yield* view(controller);
          assert.strictEqual(owner.jobs.length, 0);
          assert.isNotNull(owner.owner.lastPollError);
          assert.strictEqual(owner.owner.status, "active");
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("stop cancels in-flight work, interrupts its thread and refuses its late result", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          const ownerId = (yield* view(controller)).owner.id;
          yield* controller.control({ ownerId, action: "stop" }, undefined);
          assert.include(threads.state.interrupts, job.threadId!);
          const late = yield* Effect.flip(controller.submitResult(job.threadId!, cleanResult(job)));
          assert.strictEqual(late.code, "conflict");
          const resume = yield* Effect.flip(
            controller.control({ ownerId, action: "resume" }, undefined),
          );
          assert.strictEqual(resume.code, "conflict");
          // A stopped owner frees the repository for a new owner.
          yield* startActive(controller);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("allows exactly one owner per repository and keeps review jobs from steering it", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          const second = yield* Effect.flip(startActive(controller));
          assert.strictEqual(second.code, "conflict");
          const ownerId = (yield* view(controller)).owner.id;
          const steered = yield* Effect.flip(
            controller.control({ ownerId, action: "resume" }, job.threadId!),
          );
          assert.strictEqual(steered.code, "invalid_request");
          // Only the job's own run may answer: a later message in the thread cannot.
          threads.addRun(job.threadId!);
          const later = yield* Effect.flip(
            controller.submitResult(job.threadId!, cleanResult(job)),
          );
          assert.strictEqual(later.code, "conflict");
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("RepoReviewController landing and recovery edges", () => {
  const rateLimited = (count: number): Failure[] =>
    Array.from({ length: count }, () => ({
      error: new RepoReviewGitHub.RepoReviewGitHubError({
        operation: "x",
        outcome: "rate_limited",
      }),
      landAnyway: false,
    }));

  it.effect("never lets an older clean round merge while a newer round is under way", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7, { mergeableState: "blocked" });
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const first = yield* launchFirstReview(controller);
          yield* controller.submitResult(first.threadId!, cleanResult(first));
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), ["approve"]);
          threads.endRun(first.threadId!);

          // The author replies, and checks turn green while that reply is reviewed.
          github.authorComment(7, "One more thing: the overflow case is intended.");
          yield* pollInterval;
          yield* controller.runDueWork;
          const second = yield* latestJob(controller);
          assert.strictEqual(second.trigger, "author_event");
          github.pr(7).mergeableState = "clean";
          yield* pollInterval;
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), ["approve"]);

          yield* controller.submitResult(second.threadId!, findingResult(second));
          yield* controller.runDueWork;
          const owner = yield* view(controller);
          assert.strictEqual(
            owner.publications.find((publication) => publication.kind === "merge")!.status,
            "cancelled",
          );
          assert.deepStrictEqual(github.writes(), ["approve", "createReviewComment"]);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("does not loop integration reviews after one fails", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          yield* controller.submitResult(job.threadId!, cleanResult(job));
          github.state.branches.set("main", BASE_2);
          yield* controller.runDueWork; // blocked, integration review queued
          yield* controller.runDueWork; // launched
          const integration = yield* latestJob(controller);
          assert.strictEqual(integration.trigger, "integration_change");
          threads.endRun(integration.threadId!, "failed");
          for (let tick = 0; tick < 4; tick++) {
            yield* pollInterval;
            yield* controller.runDueWork;
          }
          assert.strictEqual(threads.state.launchCalls, 2);
          assert.deepStrictEqual(github.writes(), []);
          const owner = yield* view(controller);
          assert.strictEqual(
            owner.publications.find((publication) => publication.kind === "approval")!.status,
            "cancelled",
          );
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "binds a replayed launch to the brief's run and accepts its result before the ack",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7);
        threads.state.failAfterCreate = 1;
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const job = yield* launchFirstReview(controller);
            assert.strictEqual(job.status, "launching");
            // The agent already runs and submits before the launch acknowledgement is recorded.
            const accepted = yield* controller.submitResult(job.threadId!, cleanResult(job));
            assert.strictEqual(accepted.jobStatus, "result_received");
            yield* controller.runDueWork;
            assert.deepStrictEqual(github.writes(), ["approve", "merge"]);
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("fails a job when its own run ends, even if a later run in its thread is live", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      threads.state.failAfterCreate = 1;
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          threads.endRun(job.threadId!);
          threads.addRun(job.threadId!);
          yield* controller.runDueWork; // replays the launch, binds run 1
          yield* controller.runDueWork; // run 1 ended without a result
          assert.strictEqual((yield* latestJob(controller)).status, "failed");
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("drops a waiting report once a later review withdraws it", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      github.state.failures.set("createReviewComment", rateLimited(20));
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const first = yield* launchFirstReview(controller);
          yield* controller.submitResult(first.threadId!, findingResult(first));
          yield* controller.runDueWork;
          threads.endRun(first.threadId!);
          github.authorComment(7, "That count can never exceed 10, see the schema.");
          yield* pollInterval;
          yield* controller.runDueWork;
          const second = yield* latestJob(controller);
          const finding = (yield* view(controller)).openFindings[0]!;
          yield* controller.submitResult(
            second.threadId!,
            cleanResult(second, {
              findings: [
                { canonicalId: finding.id, status: "withdrawn", evidence: "Schema caps it." },
              ],
            }),
          );
          github.state.failures.delete("createReviewComment");
          yield* controller.runDueWork;
          yield* controller.runDueWork;
          // Rate-limited attempts were refused; nothing was ever posted.
          assert.isFalse(github.pr(7).events.some((event) => event.kind === "review_comment"));
          const owner = yield* view(controller);
          assert.strictEqual(
            owner.publications.find((publication) => publication.kind === "finding_comment")!
              .status,
            "cancelled",
          );
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("checks the posting account before a finding is written", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          github.state.viewer = "someone-else";
          yield* controller.submitResult(job.threadId!, findingResult(job));
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), []);
          assert.strictEqual((yield* view(controller)).owner.status, "paused");
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("merges a clean draft once it is marked ready, without another review", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7, { draft: true });
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          yield* controller.submitResult(job.threadId!, cleanResult(job));
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), ["approve"]);
          threads.endRun(job.threadId!);
          github.pr(7).draft = false;
          github.pr(7).updatedAt = "2026-10-18T15:00:00Z";
          yield* pollInterval;
          yield* controller.runDueWork;
          assert.deepStrictEqual(github.writes(), ["approve", "merge"]);
          assert.strictEqual(threads.state.launchCalls, 1);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "holds landing for an author reply that arrived during the review, and reviews it first",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7);
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const first = yield* launchFirstReview(controller);
            github.authorComment(7, "Note: the parser change also affects imports.");
            yield* controller.submitResult(first.threadId!, cleanResult(first));
            yield* controller.runDueWork;
            assert.deepStrictEqual(github.writes(), []);
            threads.endRun(first.threadId!);
            yield* controller.runDueWork; // the requested poll starts the follow-up round
            const second = yield* latestJob(controller);
            assert.strictEqual(second.trigger, "author_event");
            assert.include(threads.state.briefs[1]!, "also affects imports");
            yield* controller.submitResult(second.threadId!, cleanResult(second));
            yield* controller.runDueWork;
            assert.deepStrictEqual(github.writes(), ["approve", "merge"]);
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("cancels a merge whose approval GitHub refused, so pause_after_round can finish", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      github.state.failures.set("approve", [
        {
          error: new RepoReviewGitHub.RepoReviewGitHubError({
            operation: "approve",
            outcome: "rejected",
            status: 422,
          }),
          landAnyway: false,
        },
      ]);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          const ownerId = (yield* view(controller)).owner.id;
          yield* controller.control({ ownerId, action: "pause_after_round" }, undefined);
          yield* controller.submitResult(job.threadId!, cleanResult(job));
          yield* controller.runDueWork;
          yield* controller.runDueWork;
          const owner = yield* view(controller);
          assert.strictEqual(
            owner.publications.find((publication) => publication.kind === "approval")!.status,
            "failed",
          );
          assert.strictEqual(
            owner.publications.find((publication) => publication.kind === "merge")!.status,
            "cancelled",
          );
          assert.strictEqual(owner.owner.status, "paused");
          assert.notInclude(github.writes(), "merge");
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("lets a newer round adopt an approval whose first attempt is still unconfirmed", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7, { mergeableState: "blocked" });
      github.state.failures.set("approve", [
        { error: github.unavailable("approve"), landAnyway: false },
      ]);
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const first = yield* launchFirstReview(controller);
          yield* controller.submitResult(first.threadId!, cleanResult(first));
          yield* controller.runDueWork;
          threads.endRun(first.threadId!);
          github.authorComment(7, "Also checked the import path.");
          yield* pollInterval;
          yield* controller.runDueWork;
          const second = yield* latestJob(controller);
          yield* controller.submitResult(second.threadId!, cleanResult(second));
          yield* controller.runDueWork;
          github.pr(7).mergeableState = "clean";
          yield* TestClock.adjust("11 minutes");
          yield* controller.runDueWork; // absent after grace → planned under round 2
          yield* controller.runDueWork; // approve, then merge
          yield* pollInterval;
          yield* controller.runDueWork;
          assert.strictEqual(github.pr(7).state, "merged");
          assert.strictEqual(
            github.pr(7).events.filter((event) => event.reviewState === "APPROVED").length,
            1,
          );
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "approves again when the account's own later change request replaced its approval",
    () =>
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        github.openPullRequest(7, { mergeableState: "blocked" });
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const first = yield* launchFirstReview(controller);
            yield* controller.submitResult(first.threadId!, cleanResult(first));
            yield* controller.runDueWork;
            assert.deepStrictEqual(github.writes(), ["approve"]);
            threads.endRun(first.threadId!);
            // The maintainer withdraws the approval by hand with a change request.
            github.pr(7).events.push({
              keys: ["gh:PRR_manual", "gh:900"],
              kind: "review",
              githubId: "900",
              authorLogin: "reviewer",
              authorIsBot: false,
              createdAt: "2026-10-19T13:00:00Z",
              url: "https://github.com/acme/widgets/pull/7#pullrequestreview-900",
              body: "Hold on.",
              reviewState: "CHANGES_REQUESTED",
              commitId: HEAD_A,
            });
            const ownerId = (yield* view(controller)).owner.id;
            yield* controller.control({ ownerId, action: "requeue", pullRequest: 7 }, undefined);
            yield* controller.runDueWork;
            const second = yield* latestJob(controller);
            yield* controller.submitResult(second.threadId!, cleanResult(second));
            github.pr(7).mergeableState = "clean";
            yield* controller.runDueWork;
            assert.deepStrictEqual(github.writes(), ["approve", "approve", "merge"]);
          }),
        );
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("settles a write left attempting by a failed settlement without a restart", () =>
    Effect.gen(function* () {
      const github = makeFakeGitHub();
      const threads = makeFakeThreads();
      github.openPullRequest(7);
      github.state.failures.set("createReviewComment", rateLimited(1));
      const sql = yield* SqlClient.SqlClient;
      yield* withController(github, threads, (controller) =>
        Effect.gen(function* () {
          const job = yield* launchFirstReview(controller);
          yield* controller.submitResult(job.threadId!, findingResult(job));
          yield* controller.runDueWork;
          const publicationId = (yield* view(controller)).publications[0]!.id;
          // GitHub accepted the comment, then recording the answer failed.
          github.authorComment(7, `${PREFIX}\n\n${publicationMarker(publicationId)}`);
          yield* sql`UPDATE repo_review_publications SET status = 'attempting' WHERE publication_id = ${publicationId}`;
          yield* controller.runDueWork;
          assert.strictEqual((yield* view(controller)).publications[0]!.status, "confirmed");
          assert.deepStrictEqual(github.writes(), ["createReviewComment"]);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("RepoReviewController import", () => {
  const ledger = (overrides: Record<string, unknown> = {}) => ({
    schema: 1,
    repository: "acme/widgets",
    account: "reviewer",
    parentThreadId: "old-owner",
    status: "stopped",
    paused: true,
    resumable: true,
    stoppedAt: "2026-10-18T16:30:45Z",
    permissions: { review: true, post: true, approve: true, merge: true, codeChanges: false },
    discovery: { enabled: false },
    pullRequests: {
      "6": {
        number: 6,
        url: "https://github.com/acme/widgets/pull/6",
        state: "merged",
        draft: false,
        headRef: "feature/6",
        headSha: HEAD_B,
        baseRef: "main",
        actualBaseSha: BASE_1,
        round: 1,
        reviewStatus: "clean",
        findings: [],
        approval: {
          id: 600,
          state: "APPROVED",
          headSha: HEAD_B,
          url: "https://github.com/acme/widgets/pull/6#pullrequestreview-600",
          readbackVerified: true,
        },
        merge: {
          verified: true,
          mergeCommit: "9".repeat(40),
          expectedHead: HEAD_B,
          method: "merge",
        },
      },
      "7": {
        number: 7,
        url: "https://github.com/acme/widgets/pull/7",
        title: "Add widgets",
        state: "open",
        draft: false,
        headRef: "feature/7",
        headSha: HEAD_A,
        baseRef: "main",
        actualBaseSha: BASE_1,
        mergeBaseSha: MERGE_BASE,
        round: 2,
        reviewStatus: "findings",
        reviewedHeadSha: HEAD_A,
        reviewedBaseSha: BASE_1,
        taskId: "node:delegated-task:old-round-2",
        childThreadId: "thread:delegated-task:old-round-2",
        handledAuthorEventIds: [4307743890],
        findings: [
          {
            priority: "P1",
            rootCause: "Verify the pressed window's identity",
            path: "Sources/WindowAccess.swift",
            line: 527,
            url: "https://github.com/acme/widgets/pull/7#discussion_r4307701944",
            commentId: 4307701944,
            threadId: "PRRT_1",
            disposition: "fixed",
          },
          {
            priority: "P2",
            rootCause: "Cancel pending unslots on mouse-up",
            path: "Sources/DragSnap.swift",
            line: 227,
            url: "https://github.com/acme/widgets/pull/7#discussion_r4307776791",
            commentId: 4307776791,
            threadId: "PRRT_2",
            disposition: "open",
          },
        ],
        roundHistory: [
          { round: 1, taskId: "node:delegated-task:old-round-1", result: { headSha: HEAD_B } },
        ],
      },
    },
    ...overrides,
  });

  const writeLedger = (content: unknown) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/ledger.json`;
      yield* fs.writeFileString(path, JSON.stringify(content, null, 2));
      return path;
    });

  it.effect(
    "previews without writing, imports paused with canonical ids, and replays nothing on resume",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const github = makeFakeGitHub();
          const threads = makeFakeThreads();
          github.openPullRequest(7, {
            events: [
              {
                keys: ["gh:PRRC_old", "gh:4307776791"],
                kind: "review_comment",
                githubId: "4307776791",
                authorLogin: "reviewer",
                authorIsBot: false,
                createdAt: "2026-10-18T16:25:00Z",
                url: "https://github.com/acme/widgets/pull/7#discussion_r4307776791",
                body: "Hey, this is GPT writing on behalf of reviewer. [P2] Cancel pending unslots…",
                reviewState: null,
                commitId: null,
              },
              {
                keys: ["gh:IC_author_reply", "gh:4307743890"],
                kind: "review_comment",
                githubId: "4307743890",
                authorLogin: "reviewer",
                authorIsBot: false,
                createdAt: "2026-10-18T16:00:00Z",
                url: "https://github.com/acme/widgets/pull/7#discussion_r4307743890",
                body: "Fixed at fd612c0.",
                reviewState: null,
                commitId: null,
              },
              {
                // Before the handover, but never marked handled by the previous owner.
                keys: ["gh:IC_unhandled", "gh:4307790000"],
                kind: "issue_comment",
                githubId: "4307790000",
                authorLogin: "reviewer",
                authorIsBot: false,
                createdAt: "2026-10-18T16:28:00Z",
                url: "https://github.com/acme/widgets/pull/7#issuecomment-4307790000",
                body: "QA: grip still fails on the second display.",
                reviewState: null,
                commitId: null,
              },
            ],
          });
          const path = yield* writeLedger(ledger());
          const sql = yield* SqlClient.SqlClient;
          yield* withController(github, threads, (controller) =>
            Effect.gen(function* () {
              const preview = yield* controller.importLedger({
                ledgerPath: path,
                projectId: PROJECT,
              });
              assert.isTrue(preview.dryRun);
              assert.deepStrictEqual(preview.blockers, []);
              assert.deepStrictEqual(preview.openPullRequests, [7]);
              assert.deepStrictEqual(
                preview.openFindings.map((finding) => [finding.id, finding.url]),
                [
                  [
                    "gh:4307776791",
                    "https://github.com/acme/widgets/pull/7#discussion_r4307776791",
                  ],
                ],
              );
              assert.strictEqual(preview.approvals, 1);
              assert.strictEqual(preview.merges, 1);
              const owners = yield* sql<{
                readonly count: number;
              }>`SELECT COUNT(*) AS count FROM repo_review_owners`;
              assert.strictEqual(owners[0]?.count, 0);

              const applied = yield* controller.importLedger({
                ledgerPath: path,
                projectId: PROJECT,
                dryRun: false,
                policy: {
                  modelSelection,
                  commentPrefix: "Hey, this is GPT writing on behalf of reviewer.",
                },
              });
              assert.isNotNull(applied.ownerId);
              const again = yield* controller.importLedger({
                ledgerPath: path,
                projectId: PROJECT,
                dryRun: false,
                policy: { modelSelection },
              });
              assert.isTrue(again.alreadyImported);
              assert.strictEqual(again.ownerId, applied.ownerId);

              let owner = yield* view(controller);
              assert.strictEqual(owner.owner.status, "paused");
              assert.deepStrictEqual(
                owner.jobs
                  .filter((job) => job.pullRequest === 7)
                  .map((job) => [job.round, job.status]),
                [
                  [2, "imported"],
                  [1, "imported"],
                ],
              );
              assert.deepStrictEqual(
                owner.openFindings.map((finding) => finding.id),
                ["gh:4307776791"],
              );
              const approval = owner.publications.find(
                (publication) => publication.kind === "approval",
              )!;
              assert.strictEqual(approval.status, "confirmed");

              // Paused: nothing is polled. Then activation: the reviewed head and handled history
              // produce no review, no comment, no approval.
              yield* controller.runDueWork;
              assert.deepStrictEqual(github.state.calls, []);
              yield* controller.control({ ownerId: owner.owner.id, action: "resume" }, undefined);
              for (let tick = 0; tick < 3; tick++) {
                yield* controller.runDueWork;
                yield* pollInterval;
              }
              assert.strictEqual(threads.state.launchCalls, 0);
              assert.deepStrictEqual(github.writes(), []);
              owner = yield* view(controller);
              assert.strictEqual(owner.pullRequests[0]!.lastReviewedHeadSha, HEAD_A);
              // Inherited activity starts nothing, but stays visible for a person to requeue.
              assert.include(owner.pullRequests[0]!.blocker ?? "", "before the handover");

              // A genuinely new author reply after the handover is material.
              github.authorComment(7, "Pushed a fix for the mouse-up case.");
              yield* controller.runDueWork;
              assert.strictEqual(threads.state.launchCalls, 1);
              const job = yield* latestJob(controller);
              assert.strictEqual(job.round, 3);
              assert.include(threads.state.briefs[0]!, "gh:4307776791");
              assert.notInclude(threads.state.briefs[0]!, "grip still fails");

              // Requeue is how the inherited activity gets reviewed.
              threads.endRun(job.threadId!, "failed");
              yield* controller.runDueWork;
              yield* controller.control(
                { ownerId: owner.owner.id, action: "requeue", pullRequest: 7 },
                undefined,
              );
              yield* controller.runDueWork;
              assert.include(threads.state.briefs[1]!, "grip still fails");
            }),
          );
        }),
      ).pipe(Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer))),
  );

  it.effect("refuses to import while the previous owner is still active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const github = makeFakeGitHub();
        const threads = makeFakeThreads();
        const path = yield* writeLedger(
          ledger({ status: "watching", discovery: { enabled: true } }),
        );
        yield* withController(github, threads, (controller) =>
          Effect.gen(function* () {
            const preview = yield* controller.importLedger({
              ledgerPath: path,
              projectId: PROJECT,
            });
            assert.deepStrictEqual(preview.blockers, [
              "Previous owner status is watching; stop it first.",
              "Previous owner's discovery is not disabled.",
            ]);
            const apply = yield* Effect.flip(
              controller.importLedger({
                ledgerPath: path,
                projectId: PROJECT,
                dryRun: false,
                policy: { modelSelection },
              }),
            );
            assert.strictEqual(apply.code, "conflict");
          }),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer))),
  );
});
