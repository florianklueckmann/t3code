import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RepoReviewJobId,
  type RepoReviewJobResult,
  type RepoReviewOwner,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as RepoReviewController from "../../../repoReview/RepoReviewController.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as RepoReviewHandlers from "./handlers.ts";
import { RepoReviewToolkit } from "./tools.ts";

const jobThread = ThreadId.make("thread:repo-review:owner:pr-7:r1");
const environmentId = EnvironmentId.make("environment-repo-review-test");
const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider-session",
  thread: {
    threadId: jobThread,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const readOnlyClientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Outside agent", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "repo-review-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "repo-review-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const result: RepoReviewJobResult = {
  jobId: RepoReviewJobId.make("owner:pr-7:r1"),
  repository: "acme/widgets",
  pullRequest: 7,
  pins: {
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
  },
  verdict: "clean",
  summary: "No findings.",
  findings: [],
  evidence: [],
  coverage: {
    effectiveDiffInspected: true,
    filesInspected: 1,
    reusedUnchangedPaths: [],
    notes: "",
  },
};

const makeLayer = () => {
  const calls: Array<{ readonly method: string; readonly threadId: ThreadId | undefined }> = [];
  const owner = {} as RepoReviewOwner;
  const controller = Layer.mock(RepoReviewController.RepoReviewController)({
    status: () => Effect.succeed({ owners: [] }),
    control: (_input, callerThreadId) =>
      Effect.sync(() => {
        calls.push({ method: "control", threadId: callerThreadId });
        return owner;
      }),
    submitResult: (callerThreadId) =>
      Effect.sync(() => {
        calls.push({ method: "submitResult", threadId: callerThreadId });
        return {
          jobId: result.jobId,
          duplicate: false,
          jobStatus: "result_received",
          message: "ok",
        };
      }),
  });
  const layer = McpHttpServer.toolkitRegistration(RepoReviewToolkit, RepoReviewHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(controller),
  );
  return { calls, layer };
};

const call = (name: string, args: unknown, scope: McpInvocationContext.McpInvocationScope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args as never })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect(
  "binds a submitted result to the calling thread, never to a thread named in arguments",
  () => {
    const { calls, layer } = makeLayer();
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name)).toEqual(
        expect.arrayContaining([
          "repo_review_status",
          "repo_review_start",
          "repo_review_control",
          "repo_review_import",
          "repo_review_submit_result",
        ]),
      );
      const submitted = yield* call(
        "repo_review_submit_result",
        { ...result, threadId: "thread:other" },
        threadScope,
      );
      expect(submitted.isError).toBeFalsy();
      expect(calls).toEqual([{ method: "submitResult", threadId: jobThread }]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "refuses owner control from read-only clients and results from callers outside a thread",
  () => {
    const { calls, layer } = makeLayer();
    return Effect.gen(function* () {
      const control = yield* call(
        "repo_review_control",
        { ownerId: "repo-review:owner", action: "resume" },
        readOnlyClientScope,
      );
      expect(control.isError).toBe(true);
      const submitted = yield* call("repo_review_submit_result", result, readOnlyClientScope);
      expect(submitted.isError).toBe(true);
      expect(calls).toEqual([]);

      // A thread caller reaches the service with its own thread, which refuses review jobs.
      yield* call(
        "repo_review_control",
        { ownerId: "repo-review:owner", action: "pause" },
        threadScope,
      );
      expect(calls).toEqual([{ method: "control", threadId: jobThread }]);
      const status = yield* call("repo_review_status", {}, readOnlyClientScope);
      expect(status.isError).toBeFalsy();
    }).pipe(Effect.provide(layer));
  },
);
