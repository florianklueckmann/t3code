import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const CalendarId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const Bound = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const Reference = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

const Range = Schema.Struct({
  start: Bound,
  end: Bound,
  time_zone: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});

const Target = Schema.Struct({
  calendar_id: CalendarId,
  reference: Reference,
  revision: Reference,
  event_start: Bound,
});

export const CreateEvent = Schema.Struct({ calendar_id: CalendarId, title: Title, range: Range });
export const UpdateEvent = Schema.Struct({
  target: Target,
  title: Schema.optionalKey(Title),
  range: Schema.optionalKey(Range),
});
export const DeleteEvent = Schema.Struct({ target: Target });

export type CalendarMutation =
  | { readonly kind: "create"; readonly input: typeof CreateEvent.Type }
  | { readonly kind: "update"; readonly input: typeof UpdateEvent.Type }
  | { readonly kind: "delete"; readonly input: typeof DeleteEvent.Type };
