import type { ModelSelection } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SealedRefusalReason = Schema.Literals([
  "codex_required",
  "instance_unavailable",
  "provider_signed_out",
  "codex_version_unsupported",
  "selected_model_unavailable",
  "option_unsupported",
]);
export type SealedRefusalReason = typeof SealedRefusalReason.Type;

export const SealedDiscardReason = Schema.Literals([
  "tool_attempt",
  "server_request",
  "model_mismatch",
  "config_changed",
  "turn_failed",
  "usage_limited",
  "invalid_output",
  "output_too_large",
  "timeout",
  "cancelled",
  "process_exit",
]);
export type SealedDiscardReason = typeof SealedDiscardReason.Type;

/** No model ran. */
export class SealedGenerationRefused extends Schema.TaggedError<SealedGenerationRefused>()(
  "SealedGenerationRefused",
  { reason: SealedRefusalReason },
) {
  override get message(): string {
    return `Sealed generation refused: ${this.reason}`;
  }
}

/** A model may have run; its output was thrown away. */
export class SealedGenerationDiscarded extends Schema.TaggedError<SealedGenerationDiscarded>()(
  "SealedGenerationDiscarded",
  { reason: SealedDiscardReason },
) {
  override get message(): string {
    return `Sealed generation discarded: ${this.reason}`;
  }
}

export type SealedGenerationFailure = SealedGenerationRefused | SealedGenerationDiscarded;

export interface SealedGenerationInput<S extends Schema.Top> {
  readonly selection: ModelSelection;
  readonly instructions: string;
  readonly packet: string;
  readonly schema: S;
}

/** One bounded, tool-free, ephemeral model call on exactly the selected instance and model. */
export interface SealedGeneration {
  /** Reads the instance snapshot only; starts no process and runs no model. */
  readonly availability: (selection: ModelSelection) => Effect.Effect<SealedRefusalReason | null>;
  readonly generate: <S extends Schema.Top>(
    input: SealedGenerationInput<S>,
  ) => Effect.Effect<
    { readonly value: S["Type"]; readonly model: string },
    SealedGenerationFailure,
    S["DecodingServices"]
  >;
}
