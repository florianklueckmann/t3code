import { BOT_TASK_STATUS_LABELS } from "@t3tools/client-runtime/bots";
import type { BotTaskStatus } from "@t3tools/contracts";
import { Pressable } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

/** Status first, then supporting text such as when the run ended. */
export function BotTaskStatusLine(props: {
  readonly status: BotTaskStatus;
  readonly trailing: string;
  readonly numberOfLines?: number;
}) {
  return (
    <Text className="text-xs text-foreground-muted" numberOfLines={props.numberOfLines}>
      <Text
        className={cn(
          "font-t3-semibold",
          props.status === "failed"
            ? "text-danger-foreground"
            : props.status === "waiting"
              ? "text-warning-foreground"
              : "text-foreground",
        )}
      >
        {BOT_TASK_STATUS_LABELS[props.status]}
      </Text>
      {` · ${props.trailing}`}
    </Text>
  );
}

const ACTION_TONES = {
  primary: ["accent-primary-text", "font-t3-semibold text-primary-text"],
  neutral: ["accent-foreground-secondary", "text-foreground-secondary"],
  danger: ["accent-danger-foreground", "text-danger-foreground"],
} as const;

/** A compact text action with an icon, sized for touch inside a task row or sheet. */
export function BotTaskAction(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly tone: keyof typeof ACTION_TONES;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const [iconClassName, labelClassName] = ACTION_TONES[props.tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 flex-row items-center gap-1.5 active:opacity-70 disabled:opacity-50"
    >
      <SymbolView name={props.icon} size={15} tintColorClassName={iconClassName} />
      <Text className={cn("text-sm", labelClassName)}>{props.label}</Text>
    </Pressable>
  );
}
