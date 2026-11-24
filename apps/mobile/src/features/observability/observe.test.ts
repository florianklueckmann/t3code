import { afterEach, expect, it, vi } from "vite-plus/test";

const { configure, loadPreferences } = vi.hoisted(() => ({
  configure: vi.fn(),
  loadPreferences: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { relay: { url: "https://relay.example.test" } } } },
}));
vi.mock("expo-observe", () => ({
  Observe: { configure, dispatchEvents: async () => undefined, reportError: () => undefined },
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
  vi.stubGlobal("__DEV__", true);
  loadPreferences.mockResolvedValue(preferences);

  await import("./observe");

  await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
  expect(configure).toHaveBeenCalledWith(expect.objectContaining({ dispatchingEnabled: sends }));
});
