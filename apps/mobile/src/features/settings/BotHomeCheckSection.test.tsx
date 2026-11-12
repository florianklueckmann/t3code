import {
  BotId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BotHomeCheckView,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Picker = { onValueChange: (event: unknown, selected: Date) => void };
const { Children, state } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  state: {
    view: null as BotHomeCheckView | null,
    allowed: true,
    picker: null as Picker | null,
    save: vi.fn(),
    alert: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, View: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  DateTimePicker: (props: Picker) => {
    state.picker = props;
    return null;
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.view, refresh: () => {} }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    botHomeCheck: () => ({}),
    configureBotHomeCheck: { permissionAtom: () => ({}) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("../bots/reportBotFailure", () => ({ reportBotFailure: vi.fn() }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsFormRows", () => ({
  PickerRow: (props: { label: string; value: string; disabled: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {`${props.label} ${props.value}`}
    </button>
  ),
}));

import { BotHomeCheckSection } from "./BotHomeCheckSection";

function setup() {
  const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  state.view = {
    botId: BotId.make("bot"),
    projectId: ProjectId.make("project"),
    homeThreadId: ThreadId.make("home"),
    revision: 3,
    enabled: true,
    timeOfDay: "08:00",
    unavailableReason: null,
    writable: true,
    lastCheck: null,
  };
  state.allowed = true;
  state.picker = null;
  state.save.mockReset();
  state.alert.mockReset();
  const onDraftChange = vi.fn<(unsaved: boolean) => void>();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(
        <BotHomeCheckSection
          environmentId={EnvironmentId.make("environment")}
          botId={BotId.make("bot")}
          projectId={ProjectId.make("project")}
          title="Home check"
          formLocked={false}
          onDraftChange={onDraftChange}
        />,
      ),
    );
  const row = () => container.querySelector("button")!;
  return {
    render,
    row,
    onDraftChange,
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

it("reports an iOS spinner time as unsaved until the picker closes and saves it", async () => {
  using screen = setup();
  screen.render();
  act(() => screen.row().click());
  expect(screen.onDraftChange).toHaveBeenLastCalledWith(false);
  act(() => state.picker!.onValueChange(null, new Date(2026, 10, 12, 7, 30)));
  expect(screen.onDraftChange).toHaveBeenLastCalledWith(true);

  state.allowed = false;
  screen.render();
  expect(screen.row().disabled).toBe(true);
  expect(screen.row().textContent).toContain("7:30");
  expect(screen.onDraftChange).toHaveBeenLastCalledWith(true);

  state.allowed = true;
  screen.render();
  state.save.mockResolvedValue(Exit.succeed({ _tag: "conflict" }));
  await act(async () => screen.row().click());
  expect(state.save).toHaveBeenCalledWith({
    environmentId: "environment",
    input: {
      botId: "bot",
      projectId: "project",
      baseRevision: 3,
      enabled: true,
      timeOfDay: "07:30",
    },
  });
  expect(screen.onDraftChange).toHaveBeenLastCalledWith(false);
  expect(state.alert).toHaveBeenCalledWith("Home check changed elsewhere", expect.any(String));
});
