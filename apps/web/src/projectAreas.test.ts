import { describe, expect, it } from "vite-plus/test";

import { buildProjectAreaMenu } from "./projectAreas";

describe("buildProjectAreaMenu", () => {
  it("checks the current area and maps each row back to its choice", () => {
    const menu = buildProjectAreaMenu({ areas: ["Home", "Work"], current: ["Work"] });
    expect(
      menu.item.children?.map((child) => [child.label, child.checked ?? false] as const),
    ).toEqual([
      ["Home", false],
      ["Work", true],
      ["New area…", false],
      ["No area", false],
    ]);
    expect(menu.choiceFor("area:0")).toEqual({ kind: "set", area: "Home" });
    expect(menu.choiceFor("area:new")).toEqual({ kind: "new" });
    expect(menu.choiceFor("area:none")).toEqual({ kind: "clear" });
    expect(menu.choiceFor("project-settings")).toBeNull();
  });
});
