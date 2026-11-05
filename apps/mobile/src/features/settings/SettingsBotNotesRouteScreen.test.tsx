import {
  BotId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BotContinuationView,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type DialogButton = { text: string; onPress?: () => void; style?: string };
type Field = { label: string; value: string; disabled: boolean; onChange: (value: string) => void };
const { Children, state } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  state: {
    view: null as BotContinuationView | null,
    allowed: true,
    fields: new Map<string, Field>(),
    preventRemove: false,
    onPrevent: (_event: { data: { action: { type: string } } }) => {},
    header: { gestureEnabled: true },
    dispatch: vi.fn(),
    save: vi.fn(),
    alert: vi.fn<(title: string, message: string, buttons?: DialogButton[]) => void>(),
  },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, View: Children, Pressable: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ isFocused: () => true, dispatch: state.dispatch, goBack: () => {} }),
  usePreventRemove: (enabled: boolean, callback: typeof state.onPrevent) => {
    state.preventRemove = enabled;
    state.onPrevent = callback;
  },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: ({ options }: { options: typeof state.header }) => {
    state.header = options;
    return null;
  },
}));
vi.mock("../layout/native-glass-header-items", () => ({
  withNativeGlassHeaderItem: (value: unknown) => value,
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({ environment: { capabilities: { botContinuation: true } } }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.view, error: null, refresh: () => {} }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    botContinuation: () => ({}),
    botContinuationHistory: () => ({}),
    saveBotContinuation: { permissionAtom: () => ({}) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "save-id" }));
vi.mock("../bots/reportBotFailure", () => ({ reportBotFailure: vi.fn() }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => () => {},
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./BotContinuationSection", () => ({ BotNoteSections: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsFormRows", () => ({
  FormField: (props: Field) => {
    state.fields.set(props.label, props);
    return (
      <textarea
        aria-label={props.label}
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    );
  },
}));

import { SettingsBotNotesRouteScreen } from "./SettingsBotNotesRouteScreen";

function setup() {
  const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  state.view = {
    botId: BotId.make("bot"),
    projectId: ProjectId.make("project"),
    homeThreadId: ThreadId.make("home"),
    revision: 1,
    note: {
      requests: [],
      waiting: [],
      decided: [],
      context: [{ text: "Original", refs: [{ kind: "user", revision: 1 }] }],
    },
    updatedBy: { kind: "user" },
    updatedAt: "2026-11-05T10:00:00.000Z",
    restoredFrom: null,
    coverage: null,
    basis: null,
    writable: true,
    newerInputs: { count: 0, firstOrdinal: null, lastOrdinal: null },
    sources: [],
    moreSources: 0,
    activeTasks: [],
    moreActiveTasks: 0,
  };
  state.allowed = true;
  state.fields.clear();
  state.preventRemove = false;
  state.dispatch.mockReset();
  state.save.mockReset();
  state.alert.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(
        <SettingsBotNotesRouteScreen
          route={{
            params: {
              environmentId: EnvironmentId.make("environment"),
              botId: BotId.make("bot"),
              projectId: ProjectId.make("project"),
            },
          }}
        />,
      ),
    );
  return {
    container,
    render,
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

it("keeps a dirty draft protected and inspectable when live activity or write permission changes", async () => {
  using screen = setup();
  screen.render();
  act(() => state.fields.get("Context")!.onChange("Unsaved draft"));
  expect(state.preventRemove).toBe(true);
  state.view = { ...state.view!, writable: false };
  screen.render();
  expect(state.preventRemove).toBe(true);
  expect(state.header.gestureEnabled).toBe(false);
  expect(state.fields.get("Context")).toMatchObject({ value: "Unsaved draft", disabled: true });
  act(() => state.onPrevent({ data: { action: { type: "GO_BACK" } } }));
  expect(state.alert).toHaveBeenLastCalledWith(
    "Discard changes?",
    expect.any(String),
    expect.any(Array),
  );
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  state.view = { ...state.view!, revision: 7, writable: true };
  screen.render();
  expect(state.fields.get("Context")).toMatchObject({ value: "Unsaved draft", disabled: false });
  state.save.mockResolvedValue(
    Exit.succeed({ _tag: "conflict", reason: "revision", current: state.view }),
  );
  await act(async () => {
    const save = [...screen.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save notes",
    );
    expect(save).toBeDefined();
    save!.click();
  });
  expect(state.save).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        baseRevision: 1,
        note: expect.objectContaining({ context: [{ text: "Unsaved draft" }] }),
      }),
    }),
  );
  state.allowed = false;
  screen.render();
  expect(state.preventRemove).toBe(true);
  expect(state.fields.get("Context")).toMatchObject({ value: "Unsaved draft", disabled: true });
  act(() => state.onPrevent({ data: { action: { type: "GO_BACK" } } }));
  const discard = state.alert.mock.calls
    .at(-1)?.[2]
    ?.find((button) => button.text === "Discard changes");
  act(() => discard?.onPress?.());
  expect(state.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
});
