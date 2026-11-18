// @effect-diagnostics globalDate:off -- Fixture days are the Mac's local calendar days.
// @effect-diagnostics nodeBuiltinImport:off - a standalone fixture process, not Effect code.
/**
 * A fake T3 Calendar Helper. `run.ts` wraps it in an app bundle that `open` launches like the real
 * helper, so the server's whole transport runs. It answers from a fixture, records each request,
 * and never touches a real calendar. Arguments: fixture file, call log, then the mailbox name.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface FixtureEvent {
  readonly title: string;
  readonly calendar: { readonly id: string; readonly title: string };
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly timeZone: string;
}
interface Fixture {
  readonly calendars: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly events: ReadonlyArray<FixtureEvent>;
}

const [fixturePath, callLog, ...rest] = process.argv.slice(2);
const mailbox = rest.at(-1);
if (fixturePath === undefined || callLog === undefined || mailbox === undefined) process.exit(2);
const root = NodeChildProcess.execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
  encoding: "utf8",
}).trim();
const directory = NodePath.join(root, mailbox);
const request = JSON.parse(
  NodeFS.readFileSync(NodePath.join(directory, "request.json"), "utf8"),
) as Record<string, unknown>;
NodeFS.appendFileSync(callLog, `${JSON.stringify(request)}\n`);
const fixture = JSON.parse(NodeFS.readFileSync(fixturePath, "utf8")) as Fixture;

// All-day bounds are local dates; compare them as local midnights, as the real helper does.
const instant = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`).getTime() : Date.parse(value);

const respond = (): unknown => {
  switch (request.command) {
    case "status":
    case "setup":
      return { status: { authorization: "fullAccess" } };
    case "list-calendars":
      return { calendars: { items: fixture.calendars } };
    case "list-events": {
      const ids = request.calendarIds as ReadonlyArray<string>;
      if (ids.some((id) => !fixture.calendars.some((calendar) => calendar.id === id))) {
        return { error: { code: "unknownCalendar" } };
      }
      const start = Date.parse(String(request.start));
      const end = Date.parse(String(request.end));
      const limit = typeof request.limit === "number" ? request.limit : 50;
      const items = fixture.events.filter(
        (event) =>
          ids.includes(event.calendar.id) &&
          instant(event.start) < end &&
          instant(event.end) > start,
      );
      return {
        events: {
          items: items.slice(0, limit).map((event) => ({ ...event, reference: "fixture" })),
          ...(items.length > limit ? { truncated: true } : {}),
        },
      };
    }
    default:
      return { error: { code: "invalidRequest" } };
  }
};

NodeFS.writeFileSync(NodePath.join(directory, "response.json"), JSON.stringify(respond()), {
  flag: "wx",
  mode: 0o600,
});
