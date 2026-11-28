// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export async function dayWorkerServer(dir: string, instanceId: string) {
  const results = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
  const resultFor = (taskId: string) => {
    let result = results.get(taskId);
    if (!result) {
      result = Promise.withResolvers<string>();
      results.set(taskId, result);
    }
    return result;
  };
  const server = NodeHttp.createServer((request, response) => {
    const session = request.headers["thread-id"];
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "userdata/statev2.sqlite"), {
      readOnly: true,
    });
    let taskId = "";
    try {
      const record = db
        .prepare(
          "SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') = ? AND json_extract(payload_json, '$.providerInstanceId') = ? AND thread_id LIKE 'bot-work:bot-task:%' LIMIT 1",
        )
        .get(typeof session === "string" ? session : "", instanceId);
      taskId = String(record?.thread_id ?? "").slice("bot-work:".length);
    } finally {
      db.close();
    }
    request.resume();
    if (
      !taskId.startsWith("bot-task:") ||
      request.method !== "POST" ||
      request.url !== "/v1/responses"
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    void resultFor(taskId).promise.then((text) => {
      if (response.destroyed) return;
      const item = {
        id: "msg_" + NodeCrypto.randomUUID(),
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const emit = (type: string, fields: object) =>
        response.write("data: " + JSON.stringify({ type, ...fields }) + "\n\n");
      emit("response.created", {
        response: { id: "resp_replay", status: "in_progress", output: [] },
      });
      emit("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      });
      emit("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", {
        response: { id: "resp_replay", status: "completed", output: [item] },
      });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Replay did not bind a TCP port.");
  return {
    server,
    port: address.port,
    release: (taskId: string, text: string) => resultFor(taskId).resolve(text),
  };
}

export const dayWorkerArgs = (port: number) =>
  [
    "-c",
    "'model_provider=\"day_replay\"'",
    "-c",
    "'model_providers.day_replay.name=\"Fixed worker\"'",
    "-c",
    `'model_providers.day_replay.base_url="http://127.0.0.1:${port}/v1"'`,
    "-c",
    "'model_providers.day_replay.wire_api=\"responses\"'",
  ].join(" ");
