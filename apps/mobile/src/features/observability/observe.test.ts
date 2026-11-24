import { afterEach, expect, it, vi } from "vite-plus/test";

const { configure, dispatchEvents, loadPreferences } = vi.hoisted(() => ({
  configure: vi.fn(),
  dispatchEvents: vi.fn(async () => undefined),
  loadPreferences: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { relay: { url: "https://relay.example.test" } } } },
}));
vi.mock("expo-observe", () => ({
  Observe: { configure, dispatchEvents, reportError: () => undefined },
}));
vi.mock("../../persistence/imperative", () => ({ loadPreferences }));

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  { setting: "unset", preferences: {}, sends: false },
  { setting: "on", preferences: { crashReportsEnabled: true }, sends: true },
  { setting: "off", preferences: { crashReportsEnabled: false }, sends: false },
])("sends crash reports only when the setting is on: $setting", async ({ preferences, sends }) => {
  vi.resetModules();
  configure.mockClear();
  dispatchEvents.mockClear();
  vi.stubGlobal("__DEV__", true);
  loadPreferences.mockResolvedValue(preferences);

  await import("./observe");

  // Off before the setting loads, so a fresh install or an upgrade sends nothing in between.
  expect(configure.mock.calls[0]?.[0]).toMatchObject({ dispatchingEnabled: false });
  await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
  expect(configure).toHaveBeenLastCalledWith(
    expect.objectContaining({ dispatchingEnabled: sends }),
  );
  // A dispatch pass while sending is off would drop the last session's crash.
  expect(dispatchEvents).not.toHaveBeenCalled();
});
