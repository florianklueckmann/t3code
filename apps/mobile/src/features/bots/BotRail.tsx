import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { resolveBotAppearance } from "@t3tools/client-runtime/bot-appearance";
import { rankBotConversations } from "@t3tools/client-runtime/bots";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { mayBeBotHomeThreadId, type BotSummary, type EnvironmentId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { BotAvatar } from "../../components/BotAvatar";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { startBotEditor } from "../settings/bot-editor";
import { openSettings } from "../settings/settings-navigation";
import {
  resolveThreadListV2Attention,
  threadListV2AttentionUrgency,
  type ThreadListV2Attention,
} from "../threads/threadListV2";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useConnectedBots } from "./bots-across-environments";

// Same colors as the thread row's status labels.
const ATTENTION_DOT_CLASS = {
  approval: "bg-warning-foreground",
  input: "bg-adaptive-indigo-600-300",
  request: "bg-adaptive-fuchsia-600-300",
  failed: "bg-danger-foreground",
  limited: "bg-warning-foreground",
  done: "bg-adaptive-emerald-700-300",
  working: "bg-adaptive-sky-600-400",
} as const satisfies Record<ThreadListV2Attention, string>;

const ATTENTION_LABEL = {
  approval: "Needs approval",
  input: "Needs input",
  request: "Has a request",
  failed: "Failed",
  limited: "Hit a usage limit",
  done: "Done",
  working: "Working",
} as const satisfies Record<ThreadListV2Attention, string>;

const threadUrgency = (thread: EnvironmentThreadShell) =>
  threadListV2AttentionUrgency(resolveThreadListV2Attention(thread));

/** The Bots above the thread list; each opens its home conversation that needs the user most. */
export function BotRail(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly pane: "screen" | "sidebar";
}) {
  const bots = useConnectedBots().filter(({ bot }) => bot.archivedAt === null);
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const { savedConnectionsById } = useSavedRemoteConnections();
  if (bots.length === 0) return null;

  const homeThreadByKey = new Map(
    props.threads.flatMap((thread) =>
      mayBeBotHomeThreadId(thread.id)
        ? [[scopedThreadKey(thread.environmentId, thread.id), thread] as const]
        : [],
    ),
  );
  const projectTitleByKey = new Map(
    props.projects.map((project) => [
      scopedProjectKey(project.environmentId, project.id),
      project.title,
    ]),
  );
  const showsEnvironment = new Set(bots.map(({ environmentId }) => environmentId)).size > 1;
  const sidebar = props.pane === "sidebar";

  const openBotSettings = (environmentId: EnvironmentId, bot: BotSummary) => {
    startBotEditor(environmentId, bot.id);
    openSettings(navigation, "SettingsBotEdit");
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerClassName={cn("gap-1 pb-2", sidebar ? "px-1" : "px-3")}
    >
      {bots.map(({ environmentId, bot }) => {
        const conversations = rankBotConversations(
          bot,
          (threadId) => homeThreadByKey.get(scopedThreadKey(environmentId, threadId)) ?? null,
          threadUrgency,
        ).map(({ context, thread }) => ({
          context,
          attention: thread === null ? null : resolveThreadListV2Attention(thread),
          title:
            projectTitleByKey.get(scopedProjectKey(environmentId, context.projectId)) ??
            "Unknown project",
        }));
        const attention = conversations[0]?.attention ?? null;
        const environmentLabel = showsEnvironment
          ? (savedConnectionsById[environmentId]?.environmentLabel ?? null)
          : null;
        const open = () => {
          const first = conversations[0];
          if (first === undefined) {
            openBotSettings(environmentId, bot);
            return;
          }
          selectDetail({
            name: "Thread",
            params: {
              environmentId: String(environmentId),
              threadId: String(first.context.homeThreadId),
            },
          });
        };
        const actions: MenuAction[] = [
          ...conversations.map(({ context, attention: projectAttention, title }) => ({
            id: `project:${context.projectId}`,
            title,
            ...(projectAttention === null ? {} : { subtitle: ATTENTION_LABEL[projectAttention] }),
          })),
          { id: "settings", title: "Bot settings", image: "gearshape" },
        ];
        const handleMenuAction = ({ nativeEvent }: { nativeEvent: { event: string } }) => {
          if (nativeEvent.event === "settings") {
            openBotSettings(environmentId, bot);
            return;
          }
          const conversation = conversations.find(
            ({ context }) => `project:${context.projectId}` === nativeEvent.event,
          );
          if (conversation === undefined) return;
          selectDetail({
            name: "Thread",
            params: {
              environmentId: String(environmentId),
              threadId: String(conversation.context.homeThreadId),
            },
          });
        };
        return (
          <Menu
            key={`${environmentId}:${bot.id}`}
            shouldOpenOnLongPress
            title={environmentLabel === null ? bot.name : `${bot.name} · ${environmentLabel}`}
            actions={actions}
            onPressAction={handleMenuAction}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={[
                bot.name,
                environmentLabel,
                attention === null ? null : ATTENTION_LABEL[attention],
              ]
                .filter(Boolean)
                .join(", ")}
              accessibilityHint="Opens the Bot's conversation. Long press to pick a project."
              onPress={open}
              className="w-16 items-center active:opacity-70"
            >
              <View className="h-12 w-12 items-center justify-center">
                <BotAvatar appearance={resolveBotAppearance(bot)} size={32} />
                {attention === null ? null : (
                  <View
                    className={cn(
                      "absolute top-1.5 right-1.5 h-3 w-3 rounded-full border-2",
                      sidebar ? "border-drawer" : "border-screen",
                      ATTENTION_DOT_CLASS[attention],
                    )}
                  />
                )}
              </View>
              <Text
                className={cn(
                  "w-full text-center text-xs",
                  sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {bot.name}
              </Text>
            </Pressable>
          </Menu>
        );
      })}
    </ScrollView>
  );
}
