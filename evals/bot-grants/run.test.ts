import { expect, it } from "@effect/vitest";

import { CASES } from "./cases.ts";
import { gradeSample } from "./run.ts";

const passes = (id: string, calledAccounts: ReadonlyArray<string>) =>
  gradeSample(
    CASES.find((testCase) => testCase.id === id)!,
    {
      text: "",
      calledAccounts,
      tools: [],
    },
  ).every((check) => check.pass);

it("passes only a call on the named account, and no call when none is named", () => {
  expect(passes("private-mail", ["private", "private"])).toBe(true);
  expect(passes("private-mail", ["private", "work"])).toBe(false);
  expect(passes("private-mail", ["work"])).toBe(false);
  expect(passes("private-mail", [])).toBe(false);
  expect(passes("work-mail", ["work"])).toBe(true);
  expect(passes("unnamed-account", [])).toBe(true);
  expect(passes("unnamed-account", ["private"])).toBe(false);
});
