import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BotStartTaskInput } from "./bot.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);
const decodeBotStartTask = Schema.decodeUnknownEffect(BotStartTaskInput);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it("ModelSelection advertises instanceId or its provider alias as required", () => {
  const { schema } = Schema.toJsonSchemaDocument(ModelSelection);
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
  assert.deepStrictEqual(
    branches.map((branch) => branch.required),
    [
      ["instanceId", "model"],
      ["provider", "model"],
    ],
  );
});

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as a canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeModelSelection({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,

          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      });
      assert.deepStrictEqual(decoded.options, [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ]);
      const encoded = yield* encodeModelSelection(decoded);
      assert.deepStrictEqual(encoded.options, decoded.options);
    }),
);

it.effect("a requested task model refuses option members that stored selections would drop", () =>
  Effect.gen(function* () {
    const decodeTask = (modelSelection: unknown) =>
      decodeBotStartTask({ botId: "bot", projectId: "project", prompt: "Recap.", modelSelection });
    for (const options of [
      { reasoningEffort: 123 },
      { reasoningEffort: null },
      { reasoningEffort: { level: "low" } },
      { reasoningEffort: ["low"] },
      { reasoningEffort: "   " },
      { "  ": "low" },
    ]) {
      const exit = yield* Effect.exit(
        decodeTask({ instanceId: "codex", model: "gpt-5-codex", options }),
      );
      assert.isTrue(exit._tag === "Failure", JSON.stringify(options));
    }
    for (const options of [{}, []]) {
      const decoded = yield* decodeTask({ instanceId: "codex", model: "gpt-5-codex", options });
      assert.deepStrictEqual(decoded.modelSelection?.options, []);
    }
    const legacy = yield* decodeTask({
      provider: "codex",
      model: "gpt-5-codex",
      options: { reasoningEffort: " low ", fastMode: true },
    });
    assert.deepStrictEqual(legacy.modelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: true },
      ],
    });
    const colliding = yield* decodeTask({
      instanceId: "codex",
      model: "gpt-5-codex",
      options: { reasoningEffort: "low", " reasoningEffort ": "high" },
    });
    assert.deepStrictEqual(colliding.modelSelection?.options, [
      { id: "reasoningEffort", value: "low" },
      { id: "reasoningEffort", value: "high" },
    ]);
  }),
);
