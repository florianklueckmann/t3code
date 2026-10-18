import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";

/**
 * The GitHub reads and writes the repository review controller makes, and nothing more. The
 * controller depends on this port so tests can drive every race and failure with a fake, while
 * production goes through the shared `GitHubApi` client (credentials, quota, rate limits).
 */

export class RepoReviewGitHubError extends Schema.TaggedError<RepoReviewGitHubError>()(
  "RepoReviewGitHubError",
  {
    operation: Schema.String,
    /**
     * `unavailable`: no answer or a server error. A write may or may not have landed.
     * `rejected`: GitHub answered with a definite refusal; nothing was written.
     */
    outcome: Schema.Literals([
      "unavailable",
      "rejected",
      "not_found",
      "unauthorized",
      "rate_limited",
    ]),
    status: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub ${this.operation} failed (${this.outcome}${this.status === undefined ? "" : ` ${this.status}`}).`;
  }
}

export type RepoReviewViewerPermission =
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read"
  | "none";

export interface RepoReviewRepositoryInfo {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly archived: boolean;
  readonly viewerPermission: RepoReviewViewerPermission;
  readonly allowedMergeMethods: ReadonlyArray<"merge" | "squash" | "rebase">;
}

export interface RepoReviewPullRequestListItem {
  readonly number: number;
  readonly headSha: string;
  readonly updatedAt: string;
  readonly draft: boolean;
}

export interface RepoReviewPullRequestDetail {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly authorLogin: string;
  readonly headRef: string;
  readonly headSha: string;
  /** owner/name of the head branch's repository; differs from the base for forks. */
  readonly headRepository: string | null;
  readonly baseRef: string;
  /** The base SHA GitHub reports on the pull request; it may lag the branch. */
  readonly githubBaseSha: string;
  readonly updatedAt: string;
  readonly mergeable: boolean | null;
  /** REST `mergeable_state`: clean, has_hooks, unstable, blocked, behind, dirty, draft, unknown. */
  readonly mergeableState: string;
  readonly mergeCommitSha: string | null;
  readonly mergedBy: string | null;
}

export interface RepoReviewConversationEvent {
  /** Every id GitHub has for this event (node id and database id), as receipt keys. */
  readonly keys: ReadonlyArray<string>;
  readonly kind: "issue_comment" | "review_comment" | "review";
  readonly githubId: string;
  readonly authorLogin: string;
  readonly authorIsBot: boolean;
  readonly createdAt: string;
  readonly url: string;
  readonly body: string;
  /** Reviews only. */
  readonly reviewState: string | null;
  readonly commitId: string | null;
}

export interface RepoReviewReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  /** Database id of the thread's first comment, which identifies the finding it holds. */
  readonly rootCommentId: string | null;
}

export interface RepoReviewWriteResult {
  readonly githubId: string;
  readonly url: string;
}

interface RepositoryTarget {
  readonly host: string;
  readonly repository: string;
}

interface PullRequestTarget extends RepositoryTarget {
  readonly number: number;
}

export class RepoReviewGitHub extends Context.Service<
  RepoReviewGitHub,
  {
    readonly getViewerLogin: (host: string) => Effect.Effect<string, RepoReviewGitHubError>;
    readonly getRepository: (
      target: RepositoryTarget,
    ) => Effect.Effect<RepoReviewRepositoryInfo, RepoReviewGitHubError>;
    readonly listOpenPullRequests: (
      target: RepositoryTarget,
    ) => Effect.Effect<ReadonlyArray<RepoReviewPullRequestListItem>, RepoReviewGitHubError>;
    readonly getPullRequest: (
      target: PullRequestTarget,
    ) => Effect.Effect<RepoReviewPullRequestDetail, RepoReviewGitHubError>;
    readonly getBranchSha: (
      target: RepositoryTarget & { readonly branch: string },
    ) => Effect.Effect<string, RepoReviewGitHubError>;
    readonly getMergeBase: (
      target: RepositoryTarget & { readonly base: string; readonly head: string },
    ) => Effect.Effect<string, RepoReviewGitHubError>;
    readonly listConversation: (
      target: PullRequestTarget,
    ) => Effect.Effect<ReadonlyArray<RepoReviewConversationEvent>, RepoReviewGitHubError>;
    readonly listReviewThreads: (
      target: PullRequestTarget,
    ) => Effect.Effect<ReadonlyArray<RepoReviewReviewThread>, RepoReviewGitHubError>;
    readonly createReviewComment: (
      target: PullRequestTarget & {
        readonly commitId: string;
        readonly path: string;
        readonly line: number;
        readonly body: string;
      },
    ) => Effect.Effect<RepoReviewWriteResult, RepoReviewGitHubError>;
    readonly createIssueComment: (
      target: PullRequestTarget & { readonly body: string },
    ) => Effect.Effect<RepoReviewWriteResult, RepoReviewGitHubError>;
    readonly approve: (
      target: PullRequestTarget & { readonly commitId: string; readonly body: string },
    ) => Effect.Effect<RepoReviewWriteResult, RepoReviewGitHubError>;
    /** GitHub refuses the merge when the head is no longer `sha`. */
    readonly merge: (
      target: PullRequestTarget & {
        readonly sha: string;
        readonly method: "merge" | "squash" | "rebase";
      },
    ) => Effect.Effect<{ readonly mergeCommitSha: string }, RepoReviewGitHubError>;
  }
>()("t3/repoReview/RepoReviewGitHub") {}

// ---------------------------------------------------------------------------
// GitHubApi-backed implementation.
// ---------------------------------------------------------------------------

const Actor = Schema.Struct({
  login: Schema.String,
  type: Schema.optional(Schema.String),
});

const RepositoryJson = Schema.Struct({
  node_id: Schema.String,
  full_name: Schema.String,
  default_branch: Schema.String,
  archived: Schema.optional(Schema.Boolean),
  permissions: Schema.optional(
    Schema.Struct({
      admin: Schema.optional(Schema.Boolean),
      maintain: Schema.optional(Schema.Boolean),
      push: Schema.optional(Schema.Boolean),
      triage: Schema.optional(Schema.Boolean),
      pull: Schema.optional(Schema.Boolean),
    }),
  ),
  allow_merge_commit: Schema.optional(Schema.Boolean),
  allow_squash_merge: Schema.optional(Schema.Boolean),
  allow_rebase_merge: Schema.optional(Schema.Boolean),
});

const PullRequestRef = Schema.Struct({
  ref: Schema.String,
  sha: Schema.String,
  repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
});

const PullRequestListJson = Schema.Array(
  Schema.Struct({
    number: Schema.Int,
    updated_at: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    head: PullRequestRef,
  }),
);

const PullRequestJson = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  merged: Schema.optional(Schema.Boolean),
  draft: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.NullOr(Actor)),
  head: PullRequestRef,
  base: PullRequestRef,
  updated_at: Schema.String,
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.String),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  merged_by: Schema.optional(Schema.NullOr(Actor)),
});

const RefJson = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });

const CompareJson = Schema.Struct({
  merge_base_commit: Schema.Struct({ sha: Schema.String }),
});

const CommentJson = Schema.Struct({
  id: Schema.Int,
  node_id: Schema.String,
  user: Schema.optional(Schema.NullOr(Actor)),
  created_at: Schema.optional(Schema.String),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
  commit_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const CommentsJson = Schema.Array(CommentJson);

const WriteJson = Schema.Struct({ id: Schema.Int, html_url: Schema.String });
const MergeJson = Schema.Struct({ merged: Schema.Boolean, sha: Schema.String });
const ViewerJson = Schema.Struct({ login: Schema.String });

const ReviewThreadConnectionJson = Schema.Struct({
  pageInfo: Schema.Struct({
    hasNextPage: Schema.Boolean,
    endCursor: Schema.NullOr(Schema.String),
  }),
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      isResolved: Schema.Boolean,
      comments: Schema.Struct({
        nodes: Schema.Array(Schema.Struct({ databaseId: Schema.NullOr(Schema.Int) })),
      }),
    }),
  ),
});

const ReviewThreadsJson = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(Schema.Struct({ reviewThreads: ReviewThreadConnectionJson })),
      }),
    ),
  }),
});

const decodeReviewThreads = Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewThreadsJson));

const REVIEW_THREADS_QUERY = `query RepoReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

const PAGE_SIZE = 100;
/** Pages read before a listing is treated as unreadable rather than silently cut short. */
const MAX_PAGES = 30;

const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");

const toPortError = (operation: string, error: GitHubApi.GitHubApiError): RepoReviewGitHubError => {
  switch (error._tag) {
    case "GitHubApiNotFoundError":
      return new RepoReviewGitHubError({
        operation,
        outcome: "not_found",
        status: 404,
        cause: error,
      });
    case "GitHubApiAuthenticationError":
    case "GitHubCliMissingError":
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
      return new RepoReviewGitHubError({ operation, outcome: "unauthorized", cause: error });
    case "GitHubCliFailedError":
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return new RepoReviewGitHubError({ operation, outcome: "rate_limited", cause: error });
    case "GitHubApiResponseError":
      return new RepoReviewGitHubError({
        operation,
        outcome: error.status >= 500 ? "unavailable" : "rejected",
        status: error.status,
        cause: error,
      });
    case "GitHubApiRequestError":
      return new RepoReviewGitHubError({ operation, outcome: "unavailable", cause: error });
  }
};

const viewerPermission = (
  permissions: typeof RepositoryJson.Type.permissions,
): RepoReviewViewerPermission => {
  if (permissions === undefined) return "none";
  if (permissions.admin === true) return "admin";
  if (permissions.maintain === true) return "maintain";
  if (permissions.push === true) return "write";
  if (permissions.triage === true) return "triage";
  if (permissions.pull === true) return "read";
  return "none";
};

const isBot = (actor: typeof Actor.Type | null | undefined) =>
  actor?.type === "Bot" || (actor?.login.endsWith("[bot]") ?? false);

const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;

  const restJson = <S extends Schema.Top>(
    schema: S,
    input: Omit<GitHubApi.GitHubRestInput, "operation"> & { readonly operation: string },
  ) =>
    api.rest({ ...input, operation: `repoReview.${input.operation}` }).pipe(
      Effect.mapError((error) => toPortError(input.operation, error)),
      Effect.flatMap((response) =>
        response.truncated
          ? Effect.fail(
              new RepoReviewGitHubError({ operation: input.operation, outcome: "unavailable" }),
            )
          : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.body).pipe(
              Effect.mapError(
                (cause) =>
                  new RepoReviewGitHubError({
                    operation: input.operation,
                    outcome: "unavailable",
                    cause,
                  }),
              ),
            ),
      ),
    );

  const paged = <A>(
    operation: string,
    host: string,
    path: (page: number) => string,
    schema: Schema.Codec<ReadonlyArray<A>, unknown>,
  ) =>
    Effect.gen(function* () {
      const items: A[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = yield* restJson(schema, { host, operation, path: path(page) });
        items.push(...batch);
        if (batch.length < PAGE_SIZE) return items;
      }
      return yield* new RepoReviewGitHubError({ operation, outcome: "unavailable" });
    });

  const getViewerLogin: RepoReviewGitHub["Service"]["getViewerLogin"] = (host) =>
    restJson(ViewerJson, { host, operation: "viewer", path: "user" }).pipe(
      Effect.map((viewer) => viewer.login),
    );

  const getRepository: RepoReviewGitHub["Service"]["getRepository"] = ({ host, repository }) =>
    restJson(RepositoryJson, {
      host,
      operation: "repository",
      path: `repos/${encodePath(repository)}`,
    }).pipe(
      Effect.map((json) => ({
        id: json.node_id,
        fullName: json.full_name,
        defaultBranch: json.default_branch,
        archived: json.archived === true,
        viewerPermission: viewerPermission(json.permissions),
        allowedMergeMethods: [
          ...(json.allow_merge_commit === true ? (["merge"] as const) : []),
          ...(json.allow_squash_merge === true ? (["squash"] as const) : []),
          ...(json.allow_rebase_merge === true ? (["rebase"] as const) : []),
        ],
      })),
    );

  const listOpenPullRequests: RepoReviewGitHub["Service"]["listOpenPullRequests"] = ({
    host,
    repository,
  }) =>
    paged(
      "list-pull-requests",
      host,
      (page) =>
        `repos/${encodePath(repository)}/pulls?state=open&per_page=${PAGE_SIZE}&page=${page}`,
      PullRequestListJson,
    ).pipe(
      Effect.map((items) =>
        items.map((item) => ({
          number: item.number,
          headSha: item.head.sha,
          updatedAt: item.updated_at,
          draft: item.draft === true,
        })),
      ),
    );

  const getPullRequest: RepoReviewGitHub["Service"]["getPullRequest"] = ({
    host,
    repository,
    number,
  }) =>
    restJson(PullRequestJson, {
      host,
      operation: "pull-request",
      path: `repos/${encodePath(repository)}/pulls/${number}`,
    }).pipe(
      Effect.map((json) => ({
        number: json.number,
        url: json.html_url,
        title: json.title,
        body: json.body ?? "",
        state: json.merged === true ? "merged" : json.state === "open" ? "open" : "closed",
        draft: json.draft === true,
        authorLogin: json.user?.login ?? "",
        headRef: json.head.ref,
        headSha: json.head.sha,
        headRepository: json.head.repo?.full_name ?? null,
        baseRef: json.base.ref,
        githubBaseSha: json.base.sha,
        updatedAt: json.updated_at,
        mergeable: json.mergeable ?? null,
        mergeableState: json.mergeable_state ?? "unknown",
        mergeCommitSha: json.merge_commit_sha ?? null,
        mergedBy: json.merged_by?.login ?? null,
      })),
    );

  const getBranchSha: RepoReviewGitHub["Service"]["getBranchSha"] = ({
    host,
    repository,
    branch,
  }) =>
    restJson(RefJson, {
      host,
      operation: "branch-ref",
      path: `repos/${encodePath(repository)}/git/ref/heads/${encodePath(branch)}`,
    }).pipe(Effect.map((json) => json.object.sha));

  const getMergeBase: RepoReviewGitHub["Service"]["getMergeBase"] = ({
    host,
    repository,
    base,
    head,
  }) =>
    restJson(CompareJson, {
      host,
      operation: "merge-base",
      // per_page=1 keeps the commit list short; only the merge base is read.
      path: `repos/${encodePath(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
    }).pipe(Effect.map((json) => json.merge_base_commit.sha));

  const toEvent =
    (kind: RepoReviewConversationEvent["kind"]) =>
    (json: typeof CommentJson.Type): RepoReviewConversationEvent => ({
      keys: [`gh:${json.node_id}`, `gh:${json.id}`],
      kind,
      githubId: String(json.id),
      authorLogin: json.user?.login ?? "",
      authorIsBot: isBot(json.user),
      createdAt: json.submitted_at ?? json.created_at ?? "",
      url: json.html_url,
      body: json.body ?? "",
      reviewState: kind === "review" ? (json.state ?? null) : null,
      commitId: json.commit_id ?? null,
    });

  const listConversation: RepoReviewGitHub["Service"]["listConversation"] = ({
    host,
    repository,
    number,
  }) =>
    Effect.all(
      [
        paged(
          "issue-comments",
          host,
          (page) =>
            `repos/${encodePath(repository)}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`,
          CommentsJson,
        ).pipe(Effect.map((items) => items.map(toEvent("issue_comment")))),
        paged(
          "review-comments",
          host,
          (page) =>
            `repos/${encodePath(repository)}/pulls/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`,
          CommentsJson,
        ).pipe(Effect.map((items) => items.map(toEvent("review_comment")))),
        paged(
          "reviews",
          host,
          (page) =>
            `repos/${encodePath(repository)}/pulls/${number}/reviews?per_page=${PAGE_SIZE}&page=${page}`,
          CommentsJson,
        ).pipe(Effect.map((items) => items.map(toEvent("review")))),
      ],
      { concurrency: 3 },
    ).pipe(Effect.map((groups) => groups.flat()));

  const listReviewThreads: RepoReviewGitHub["Service"]["listReviewThreads"] = ({
    host,
    repository,
    number,
  }) =>
    Effect.gen(function* () {
      const [owner, name] = repository.split("/");
      const threads: RepoReviewReviewThread[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body: string = yield* api
          .graphql({
            host,
            operation: "repoReview.review-threads",
            query: REVIEW_THREADS_QUERY,
            variables: { owner, name, number, cursor },
          })
          .pipe(Effect.mapError((error) => toPortError("review-threads", error)));
        const json: typeof ReviewThreadsJson.Type = yield* decodeReviewThreads(body).pipe(
          Effect.mapError(
            (cause) =>
              new RepoReviewGitHubError({
                operation: "review-threads",
                outcome: "unavailable",
                cause,
              }),
          ),
        );
        const connection: typeof ReviewThreadConnectionJson.Type | undefined =
          json.data.repository?.pullRequest?.reviewThreads;
        if (connection === undefined) {
          return yield* new RepoReviewGitHubError({
            operation: "review-threads",
            outcome: "not_found",
          });
        }
        for (const node of connection.nodes) {
          const root = node.comments.nodes[0]?.databaseId;
          threads.push({
            id: node.id,
            isResolved: node.isResolved,
            rootCommentId: root === undefined || root === null ? null : String(root),
          });
        }
        if (!connection.pageInfo.hasNextPage) return threads;
        cursor = connection.pageInfo.endCursor;
      }
      return yield* new RepoReviewGitHubError({
        operation: "review-threads",
        outcome: "unavailable",
      });
    });

  const write = (
    operation: string,
    host: string,
    method: "POST" | "PUT",
    path: string,
    body: unknown,
  ) =>
    restJson(WriteJson, { host, operation, method, path, body, allowReserve: true }).pipe(
      Effect.map((json) => ({ githubId: String(json.id), url: json.html_url })),
    );

  const createReviewComment: RepoReviewGitHub["Service"]["createReviewComment"] = (input) =>
    write(
      "create-review-comment",
      input.host,
      "POST",
      `repos/${encodePath(input.repository)}/pulls/${input.number}/comments`,
      {
        body: input.body,
        commit_id: input.commitId,
        path: input.path,
        line: input.line,
        side: "RIGHT",
      },
    );

  const createIssueComment: RepoReviewGitHub["Service"]["createIssueComment"] = (input) =>
    write(
      "create-issue-comment",
      input.host,
      "POST",
      `repos/${encodePath(input.repository)}/issues/${input.number}/comments`,
      { body: input.body },
    );

  const approve: RepoReviewGitHub["Service"]["approve"] = (input) =>
    write(
      "approve",
      input.host,
      "POST",
      `repos/${encodePath(input.repository)}/pulls/${input.number}/reviews`,
      { commit_id: input.commitId, body: input.body, event: "APPROVE" },
    );

  const merge: RepoReviewGitHub["Service"]["merge"] = (input) =>
    restJson(MergeJson, {
      host: input.host,
      operation: "merge",
      method: "PUT",
      path: `repos/${encodePath(input.repository)}/pulls/${input.number}/merge`,
      body: { sha: input.sha, merge_method: input.method },
      allowReserve: true,
    }).pipe(
      Effect.flatMap((json) =>
        json.merged
          ? Effect.succeed({ mergeCommitSha: json.sha })
          : Effect.fail(new RepoReviewGitHubError({ operation: "merge", outcome: "rejected" })),
      ),
    );

  return RepoReviewGitHub.of({
    getViewerLogin,
    getRepository,
    listOpenPullRequests,
    getPullRequest,
    getBranchSha,
    getMergeBase,
    listConversation,
    listReviewThreads,
    createReviewComment,
    createIssueComment,
    approve,
    merge,
  });
});

export const layer = Layer.effect(RepoReviewGitHub, make);
