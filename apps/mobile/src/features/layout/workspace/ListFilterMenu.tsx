import { Pressable, View } from "react-native";
import { Chip } from "../../../components/ui/Chip";
import { Menu } from "../../../components/ui/Menu";
import type { MenuProps } from "../../../components/ui/Menu.types";
import { cn } from "../../../lib/cn";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";

export function ListFilterMenu(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly active?: boolean;
  readonly icon?: boolean;
  /** A status dot on the chip, as a background color class. */
  readonly dotClassName?: string | null;
  readonly actions: MenuProps["actions"];
  readonly onSelect: (id: string) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Menu
      title={props.accessibilityLabel}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ selected: Boolean(props.active) }}
        hitSlop={6}
      >
        <Chip
          label={props.label}
          selected={props.active}
          icon={props.icon ? "line.3.horizontal.decrease" : undefined}
          trailingIcon={props.icon ? undefined : "chevron.down"}
          glass
          colorScheme={themeAppearance}
        />
        {props.dotClassName ? (
          <View
            pointerEvents="none"
            className={cn(
              "absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-screen",
              props.dotClassName,
            )}
          />
        ) : null}
      </Pressable>
    </Menu>
  );
}
