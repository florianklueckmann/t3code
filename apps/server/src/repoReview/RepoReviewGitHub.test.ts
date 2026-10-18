import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as RepoReviewGitHub from "./RepoReviewGitHub.ts";

const HEAD = "a".repeat(40);

const response = (body: unknown): GitHubApi.GitHubRestResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
  truncated: false,
  invalidUtf8: false,
});

const pullRequest = (number: number) => ({
  number,
  updated_at: "2026-10-18T10:00:00Z",
  draft: false,
  head: { ref: `feature/${number}`, sha: HEAD },
});

/** Answers REST calls from `routes` by path, recording each request. */
const layerWith = (
  routes: (
    input: GitHubApi.GitHubRestInput,
  ) => Effect.Effect<GitHubApi.GitHubRestResponse, GitHubApi.GitHubApiError>,
) => {
  const requests: GitHubApi.GitHubRestInput[] = [];
  const layer = RepoReviewGitHub.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubApi.GitHubApi)({
        rest: (input) =>
          Effect.suspend(() => {
            requests.push(input);
            return routes(input);
          }),
      }),
    ),
  );
  return { requests, layer };
};

it.effect("reads every page of open pull requests and stops at a short page", () => {
  const { requests, layer } = layerWith((input) =>
    Effect.succeed(
      response(
        input.path.endsWith("page=1")
          ? Array.from({ length: 100 }, (_, index) => pullRequest(index + 1))
          : [pullRequest(101)],
      ),
    ),
  );
  return Effect.gen(function* () {
    const github = yield* RepoReviewGitHub.RepoReviewGitHub;
    const open = yield* github.listOpenPullRequests({
      host: "github.com",
      repository: "acme/widgets",
    });
    assert.strictEqual(open.length, 101);
    assert.deepStrictEqual(
      requests.map((request) => request.path),
      [
        "repos/acme/widgets/pulls?state=open&per_page=100&page=1",
        "repos/acme/widgets/pulls?state=open&per_page=100&page=2",
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("maps merged state, fork heads and the merging account from the pull request", () => {
  const { layer } = layerWith(() =>
    Effect.succeed(
      response({
        number: 7,
        html_url: "https://github.com/acme/widgets/pull/7",
        title: "Add widgets",
        body: null,
        state: "closed",
        merged: true,
        draft: false,
        user: { login: "octo" },
        head: { ref: "feature/7", sha: HEAD, repo: { full_name: "fork/widgets" } },
        base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
        updated_at: "2026-10-18T10:00:00Z",
        mergeable: null,
        mergeable_state: "unknown",
        merge_commit_sha: "c".repeat(40),
        merged_by: { login: "reviewer" },
      }),
    ),
  );
  return Effect.gen(function* () {
    const github = yield* RepoReviewGitHub.RepoReviewGitHub;
    const detail = yield* github.getPullRequest({
      host: "github.com",
      repository: "acme/widgets",
      number: 7,
    });
    assert.strictEqual(detail.state, "merged");
    assert.strictEqual(detail.headRepository, "fork/widgets");
    assert.strictEqual(detail.mergedBy, "reviewer");
    assert.strictEqual(detail.body, "");
  }).pipe(Effect.provide(layer));
});

it.effect("classifies GitHub failures so writes know whether they may have landed", () => {
  const failures: Record<string, GitHubApi.GitHubApiError> = {
    "/comments": new GitHubApi.GitHubApiResponseError({
      host: "github.com",
      operation: "x",
      status: 502,
    }),
    "/reviews": new GitHubApi.GitHubApiResponseError({
      host: "github.com",
      operation: "x",
      status: 422,
    }),
    "/merge": new GitHubApi.GitHubApiRequestError({
      host: "github.com",
      operation: "x",
      cause: "timeout",
    }),
  };
  const { requests, layer } = layerWith((input) => {
    const suffix = Object.keys(failures).find((key) => input.path.endsWith(key));
    return suffix === undefined ? Effect.succeed(response({})) : Effect.fail(failures[suffix]!);
  });
  return Effect.gen(function* () {
    const github = yield* RepoReviewGitHub.RepoReviewGitHub;
    const target = { host: "github.com", repository: "acme/widgets", number: 7 };
    const comment = yield* Effect.flip(github.createIssueComment({ ...target, body: "x" }));
    const approval = yield* Effect.flip(github.approve({ ...target, commitId: HEAD, body: "ok" }));
    const merge = yield* Effect.flip(github.merge({ ...target, sha: HEAD, method: "merge" }));
    assert.strictEqual(comment.outcome, "unavailable");
    assert.strictEqual(approval.outcome, "rejected");
    assert.strictEqual(merge.outcome, "unavailable");
    const mergeRequest = requests.find((request) => request.path.endsWith("/merge"))!;
    assert.strictEqual(mergeRequest.method, "PUT");
    assert.deepStrictEqual(mergeRequest.body, { sha: HEAD, merge_method: "merge" });
    const approvalRequest = requests.find((request) => request.path.endsWith("/reviews"))!;
    assert.deepStrictEqual(approvalRequest.body, { commit_id: HEAD, body: "ok", event: "APPROVE" });
  }).pipe(Effect.provide(layer));
});

it.effect("treats a merge GitHub reports as not merged as a refusal", () => {
  const { layer } = layerWith(() => Effect.succeed(response({ merged: false, sha: HEAD })));
  return Effect.gen(function* () {
    const github = yield* RepoReviewGitHub.RepoReviewGitHub;
    const refused = yield* Effect.flip(
      github.merge({
        host: "github.com",
        repository: "acme/widgets",
        number: 7,
        sha: HEAD,
        method: "merge",
      }),
    );
    assert.strictEqual(refused.outcome, "rejected");
  }).pipe(Effect.provide(layer));
});
