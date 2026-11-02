import {
  BOT_COLOR_OPTIONS,
  BOT_COLOR_PALETTE,
  BOT_FACE_OPTIONS,
  BOT_TOPPER_OPTIONS,
  defaultBotAppearance,
} from "@t3tools/client-runtime/bot-appearance";
import type { BotAppearance } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BotAvatar } from "../../components/BotAvatar";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useBotEditor } from "./bot-editor";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

/** Edits the look in the open Bot draft; the Bot form's save keeps it. */
export function BotLookRouteScreen() {
  const { draft, setDraft } = useBotEditor();
  const insets = useSafeAreaInsets();

  if (!draft) {
    return (
      <SettingsScreen title="Look">
        <Text className="p-5 text-base text-foreground-muted">Open a Bot form first.</Text>
      </SettingsScreen>
    );
  }

  const shown = draft.appearance ?? defaultBotAppearance(draft.botId);
  const set = (patch: Partial<BotAppearance>) =>
    setDraft((current) => ({
      ...current,
      appearance: { ...(current.appearance ?? defaultBotAppearance(current.botId)), ...patch },
    }));

  return (
    <SettingsScreen title="Look">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="items-center gap-1 py-2">
          <BotAvatar appearance={shown} size={88} />
          {draft.name.trim() ? (
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>
              {draft.name.trim()}
            </Text>
          ) : null}
        </View>
        <SettingsSection title="Color">
          <OptionRow>
            {BOT_COLOR_OPTIONS.map((option) => (
              <OptionButton
                key={option.value}
                label={option.label}
                checked={shown.color === option.value}
                round
                onPress={() => set({ color: option.value })}
              >
                <View
                  className="size-7 rounded-full border border-black/10"
                  style={{ backgroundColor: BOT_COLOR_PALETTE[option.value].body }}
                />
              </OptionButton>
            ))}
          </OptionRow>
        </SettingsSection>
        <SettingsSection title="Face">
          <OptionRow>
            {BOT_FACE_OPTIONS.map((option) => (
              <OptionButton
                key={option.value}
                label={option.label}
                checked={shown.face === option.value}
                onPress={() => set({ face: option.value })}
              >
                <BotAvatar
                  appearance={{ ...shown, face: option.value, topper: "none" }}
                  size={32}
                />
              </OptionButton>
            ))}
          </OptionRow>
        </SettingsSection>
        <SettingsSection title="Topper">
          <OptionRow>
            {BOT_TOPPER_OPTIONS.map((option) => (
              <OptionButton
                key={option.value}
                label={option.label}
                checked={shown.topper === option.value}
                onPress={() => set({ topper: option.value })}
              >
                <BotAvatar appearance={{ ...shown, topper: option.value }} size={32} />
              </OptionButton>
            ))}
          </OptionRow>
        </SettingsSection>
        <Button
          tone="secondary"
          fullWidth
          disabled={draft.appearance === null}
          onPress={() => setDraft((current) => ({ ...current, appearance: null }))}
          label="Reset to default"
        />
      </ScrollView>
    </SettingsScreen>
  );
}

function OptionRow(props: { readonly children: ReactNode }) {
  return <View className="flex-row flex-wrap gap-2 p-3">{props.children}</View>;
}

function OptionButton(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly round?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const shape = props.round ? "rounded-full" : "rounded-xl";
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.checked }}
      onPress={props.onPress}
      className={`size-12 items-center justify-center border-2 active:opacity-70 ${shape} ${
        props.checked ? "border-foreground" : "border-transparent"
      }`}
    >
      {props.children}
    </Pressable>
  );
}
