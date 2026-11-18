import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MacCalendar from "../../../calendar/MacCalendar.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, loadCaller } from "../../threadAccess.ts";
import { CalendarToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(CalendarToolkit, {
  list_events: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "list_events");
      // Only a run in progress reads; a provider process kept past its turn does not.
      yield* assertLiveCaller(yield* loadCaller());
      const calendar = yield* MacCalendar.MacCalendar;
      return yield* calendar
        .listEvents(
          { threadId: thread.thread.threadId, sealedLoad: thread.thread.sealedLoad === true },
          input,
        )
        .pipe(
          Effect.mapError(
            (error) => new OrchestratorMcpFailure({ code: error.code, message: error.message }),
          ),
        );
    }),
  ),
});
