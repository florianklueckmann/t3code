import { assert, it } from "@effect/vitest";

import * as BotWatch from "./BotWatch.ts";

it("reads the report from the last line and keeps it out of the shown result", () => {
  const post = BotWatch.readWatchReport(
    'Recap (sessions/session-11.md): Ilvara fled.\n\nT3_WATCH {"occasion": "2026-12-04 Session 12", "items": ["Who hired Ilvara?"]}\n',
  );
  assert.deepEqual(post.report, {
    occasion: "2026-12-04 Session 12",
    items: ["Who hired Ilvara?"],
  });
  assert.equal(post.text, "Recap (sessions/session-11.md): Ilvara fled.");

  for (const quiet of [
    'Nothing is near.\n`T3_WATCH {"new": false}`',
    'Nothing is near. T3_WATCH {"new": false}',
  ]) {
    const read = BotWatch.readWatchReport(quiet);
    assert.deepEqual(read.report, { new: false });
    assert.equal(read.text, "Nothing is near.");
  }

  // Without a readable report on its last line, the result is shown whole rather than dropped.
  for (const text of [
    "A recap without a report.",
    "Recap.\nT3_WATCH {not json}",
    'T3_WATCH {"new": false}\nOne more thing: the session moved to Saturday.',
  ]) {
    assert.deepEqual(BotWatch.readWatchReport(text), { report: null, text });
  }
});

const SESSION_12 = BotWatch.watchKey("2026-12-04 Session 12");

it.each<{
  readonly name: string;
  readonly report: BotWatch.WatchReport | null;
  readonly posted: ReadonlyArray<string>;
  readonly expected: BotWatch.WatchDecision["_tag"];
}>([
  {
    name: "a first post on an occasion",
    report: { occasion: "2026-12-04 Session 12", items: ["Who hired Ilvara?"] },
    posted: [],
    expected: "post",
  },
  {
    // However the second post is worded, a posted occasion gets no other.
    name: "a posted occasion again with other questions",
    report: { occasion: "2026-12-04 Session 12", items: ["Is Toma fit to travel?"] },
    posted: [SESSION_12],
    expected: "quiet",
  },
  {
    name: "a posted occasion written another way",
    report: { occasion: "Session 12 (2026-12-04)", items: [] },
    posted: [SESSION_12],
    expected: "quiet",
  },
  {
    name: "the next occasion",
    report: { occasion: "2026-12-11 Session 13", items: ["Who hired Ilvara?"] },
    posted: [SESSION_12],
    expected: "post",
  },
  {
    name: "the same name on a date with month and day swapped",
    report: { occasion: "2026-04-12 Session 12", items: [] },
    posted: [SESSION_12],
    expected: "post",
  },
  { name: "nothing new", report: { new: false }, posted: [], expected: "quiet" },
  { name: "no report", report: null, posted: [], expected: "unreported" },
  {
    name: "an occasion without a name",
    report: { occasion: " - ", items: [] },
    posted: [],
    expected: "unreported",
  },
])("decides $name", ({ report, posted, expected }) => {
  assert.equal(BotWatch.decideWatch(report, posted)._tag, expected);
});
