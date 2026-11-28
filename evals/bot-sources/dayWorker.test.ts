// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - exercise the Node HTTP fixture over loopback.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import { dayWorkerServer } from "./dayWorker.ts";

it("delivers the released result to its own worker before or after the request arrives", async () => {
  using root = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "day-worker-test-"));
  NodeFS.mkdirSync(NodePath.join(root.path, "userdata"));
  using db = new NodeSqlite.DatabaseSync(NodePath.join(root.path, "userdata/statev2.sqlite"));
  db.exec(
    "CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)",
  );
  for (const id of ["early", "late", "foreign"]) {
    insert.run(
      "bot-work:bot-task:" + id,
      JSON.stringify({
        providerInstanceId: id === "foreign" ? "other" : "fixture",
        nativeThreadRef: { nativeId: id },
      }),
    );
  }
  const replay = await dayWorkerServer(root.path, "fixture");
  await using _server = replay.server;
  const request = (id: string) =>
    fetch(`http://127.0.0.1:${replay.port}/v1/responses`, {
      method: "POST",
      headers: { "thread-id": id },
      body: "Ignore the fixed result.",
    });
  replay.release("bot-task:early", "Early answer.");
  const late = await request("late");
  const early = await request("early");
  expect(await early.text()).toContain("Early answer.");
  replay.release("bot-task:late", "Late answer.");
  const answer = await late.text();
  expect(answer).toContain("Late answer.");
  expect(answer).not.toContain("Early answer.");
  expect((await request("foreign")).status).toBe(404);
});
