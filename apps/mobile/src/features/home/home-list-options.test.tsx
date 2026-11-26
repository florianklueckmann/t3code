import type { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ saved: [] as unknown[] }));

vi.mock("../../state/preferences", () => ({ updateMobilePreferencesAtom: {} }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomSet: () => (value: unknown) => harness.saved.push(value),
}));

import { HomeListOptionsProvider, useHomeListOptions } from "./home-list-options";

const ENVIRONMENT = "env-1" as EnvironmentId;
const AVAILABLE = new Set([ENVIRONMENT]);

it("saves the scope from every update made in one event", async () => {
  harness.saved = [];
  let controls: ReturnType<typeof useHomeListOptions> | undefined;
  function Probe() {
    const result = useHomeListOptions(AVAILABLE);
    useLayoutEffect(() => {
      controls = result;
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <HomeListOptionsProvider projectGroupingMode="repository">
        <Probe />
      </HomeListOptionsProvider>,
    ),
  );
  act(() => {
    controls!.setSelectedEnvironmentId(ENVIRONMENT);
    controls!.setSelectedProjectKey("env-1:project-1");
  });

  expect(harness.saved.at(-1)).toEqual({
    threadListFilters: {
      environmentId: ENVIRONMENT,
      projectKey: "env-1:project-1",
      areaScope: null,
    },
  });
  expect(controls!.options.selectedEnvironmentId).toBe(ENVIRONMENT);
  expect(controls!.options.selectedProjectKey).toBe("env-1:project-1");

  // An area and a single project replace each other.
  act(() => controls!.setSelectedArea("Work"));
  expect(harness.saved.at(-1)).toEqual({
    threadListFilters: {
      environmentId: ENVIRONMENT,
      projectKey: null,
      areaScope: { area: "Work" },
    },
  });
  act(() => controls!.setSelectedArea(null));
  expect(controls!.options.selectedArea).toEqual({ area: null });
  act(() => controls!.setSelectedProjectKey(null));
  expect(controls!.options.selectedArea).toBeNull();
  expect(harness.saved.at(-1)).toEqual({
    threadListFilters: { environmentId: ENVIRONMENT, projectKey: null, areaScope: null },
  });
  act(() => root.unmount());
});
