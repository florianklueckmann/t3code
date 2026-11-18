import type { MacCalendarAvailability } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

/** The transport failed: no response was exchanged. Names no request or response content. */
export class MacCalendarHelperError extends Schema.TaggedError<MacCalendarHelperError>()(
  "MacCalendarHelperError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * The installed T3 Calendar Helper (native/calendar-helper). One LaunchServices launch per
 * request, so macOS attributes Calendar access to the helper; see docs/operations/development.md.
 * Callers bound each exchange with their own timeout and decode the response.
 */
export class MacCalendarHelper extends Context.Service<
  MacCalendarHelper,
  {
    readonly availability: Effect.Effect<MacCalendarAvailability>;
    /** The helper's response text, or undefined when it wrote none. */
    readonly exchange: (
      request: string,
    ) => Effect.Effect<string | undefined, MacCalendarHelperError>;
  }
>()("t3/calendar/MacCalendarHelper") {}

const APP_NAME = "T3 Calendar Helper.app";
export const APP_OVERRIDE_ENV = "T3CODE_CALENDAR_HELPER_APP";
const isHelperError = Schema.is(MacCalendarHelperError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const platform = yield* HostProcess.Platform;
  // Tests and evals point this at a fake helper app that speaks the same protocol.
  const app =
    (yield* HostProcess.Environment)[APP_OVERRIDE_ENV] ??
    path.join(yield* HostProcess.HomeDirectory, "Applications", APP_NAME);

  const availability = Effect.gen(function* () {
    if (platform !== "darwin") return "unsupported" as const;
    const installed = yield* fs
      .exists(path.join(app, "Contents", "Info.plist"))
      .pipe(Effect.orElseSucceed(() => false));
    return installed ? ("available" as const) : ("helper-missing" as const);
  }).pipe(Effect.withSpan("MacCalendarHelper.availability"));

  // The helper reads requests only from the per-user Darwin temp directory, not $TMPDIR.
  const tempRoot = yield* Effect.cached(
    spawner
      .string(
        ChildProcess.make("getconf", ["DARWIN_USER_TEMP_DIR"], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.map((output) => output.trim())),
  );

  const exchange = Effect.fn("MacCalendarHelper.exchange")(
    function* (request: string) {
      const root = yield* tempRoot;
      if (root === "") return yield* new MacCalendarHelperError({});
      const name = `t3-calendar.${(yield* random.uuidV4()).replaceAll("-", "")}`;
      const directory = path.join(root, name);
      return yield* Effect.acquireUseRelease(
        fs.makeDirectory(directory, { mode: 0o700 }),
        () =>
          Effect.gen(function* () {
            yield* fs.chmod(directory, 0o700);
            const requestPath = path.join(directory, "request.json");
            yield* fs.writeFileString(requestPath, request, { flag: "wx", mode: 0o600 });
            yield* fs.chmod(requestPath, 0o600);
            const exitCode = yield* spawner
              .spawn(
                ChildProcess.make("open", ["-n", "-W", "-g", "-a", app, "--args", name], {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }),
              )
              .pipe(
                Effect.flatMap((child) => child.exitCode),
                Effect.scoped,
              );
            if (Number(exitCode) !== 0) return yield* new MacCalendarHelperError({});
            const responsePath = path.join(directory, "response.json");
            if (!(yield* fs.exists(responsePath))) return undefined;
            return yield* fs.readFileString(responsePath);
          }),
        () => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isHelperError(cause) ? cause : new MacCalendarHelperError({ cause }),
        ),
      ),
  );

  return MacCalendarHelper.of({ availability, exchange });
});

export const layer = Layer.effect(MacCalendarHelper, make);
