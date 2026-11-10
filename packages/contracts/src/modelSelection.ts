import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { NonBlankRecordKey, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderOptionSelection,
  ProviderOptionSelections,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Identity values stay Unknown so the wire schema owns validation; the union only advertises
// that `instanceId`, or its legacy alias `provider`, is required.
const modelSelectionFrom = <Options extends Schema.Top>(options: Options) => {
  const Source = Schema.Union([
    Schema.Struct({
      instanceId: Schema.Unknown,
      provider: Schema.optional(Schema.Unknown),
      model: Schema.Unknown,
      options: Schema.optional(options),
    }),
    Schema.Struct({
      provider: Schema.Unknown,
      model: Schema.Unknown,
      options: Schema.optional(options),
    }),
  ]);
  return Source.pipe(
    Schema.decodeTo(
      ModelSelectionWire,
      SchemaTransformation.transformEffect({
        decode: (raw) => {
          const instanceIdSource =
            "instanceId" in raw && raw.instanceId !== undefined
              ? raw.instanceId
              : typeof raw.provider === "string"
                ? raw.provider
                : undefined;
          const base: Record<string, unknown> = {
            instanceId: instanceIdSource,
            model: raw.model,
          };
          if (raw.options !== undefined) base.options = raw.options;
          return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
        },
        encode: (value) => {
          const base: Record<string, unknown> = {
            instanceId: value.instanceId,
            model: value.model,
          };
          if (value.options !== undefined) base.options = value.options;
          return Effect.succeed(base as typeof Source.Encoded);
        },
      }),
    ),
  );
};

/** Stored and historical selections: legacy option maps drop members they cannot use. */
export const ModelSelection = modelSelectionFrom(Schema.Unknown);
export type ModelSelection = typeof ModelSelection.Type;

/** Requests that start work: an option member the stored decoder would drop is refused instead. */
export const ModelSelectionInput = modelSelectionFrom(
  Schema.Union([
    Schema.Array(ProviderOptionSelection),
    // Untrimmed keys: trimming here would merge ` a ` into `a` before admission rejects the repeat.
    Schema.Record(NonBlankRecordKey, ProviderOptionSelectionValue),
  ]),
);
