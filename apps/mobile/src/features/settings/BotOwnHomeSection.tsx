import { useAtomValue } from "@effect/atom-react";
import {
  BOT_OWN_HOME_ACCESS_OPTIONS,
  BOT_OWN_HOME_DESCRIPTION,
  BOT_OWN_HOME_REMOVE_DESCRIPTION,
  botOwnHomeReadUnavailableLabel,
} from "@t3tools/client-runtime/bots";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { BotHomeAccess, BotId, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { BotContinuationSection } from "./BotContinuationSection";
import { BotLearningSection } from "./BotLearningSection";
import { SettingsSection } from "./components/SettingsSection";
import { SelectRow } from "./components/SettingsFormRows";

/**
 * The Bot's own Home above its projects: open or remove it, choose its access, and its working
 * notes and learning. Renders nothing on servers without it.
 */
export function BotOwnHomeSection(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly disabled: boolean;
}) {
  const { environmentId, botId } = props;
  const selectDetail = useSelectWorkspaceDetail();
  const config = useEnvironmentServerConfig(environmentId);
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const detail = useEnvironmentQuery(
    serverEnvironment.botDetail({ environmentId, input: { botId } }),
  );
  // Failures surface in this section's own alerts.
  const openHome = useAtomCommand(serverEnvironment.openBotHome, { reportFailure: false });
  const removeHome = useAtomCommand(serverEnvironment.removeBotHome, { reportFailure: false });
  const canOpen = useAtomValue(serverEnvironment.openBotHome.permissionAtom(environmentId));
  const canRemove = useAtomValue(serverEnvironment.removeBotHome.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const bot = bots.data?.bots.find((entry) => entry.id === botId);
  if (bot === undefined || bot.home === undefined) return null;
  const home = bot.home;
  const open = home !== null && home.detachedAt === null;
  const locked = props.disabled || busy;
  const readUnavailable = botOwnHomeReadUnavailableLabel({
    capabilities: detail.data?.capabilities,
    platformOs: config?.environment.platform.os,
  });

  const run = async (
    title: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(true);
    const result = await command();
    setBusy(false);
    if (result._tag === "Failure") reportBotFailure(title, result);
  };
  const setAccess = (access: BotHomeAccess) =>
    void run("Could not change the Home's access", () =>
      openHome({ environmentId, input: { botId, access } }),
    );
  const confirmRemoval = () =>
    Dialog.alert(`Remove ${bot.name}'s own Home?`, BOT_OWN_HOME_REMOVE_DESCRIPTION, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void run("Could not remove the Home", () =>
            removeHome({ environmentId, input: { botId } }),
          ),
      },
    ]);
  const access = BOT_OWN_HOME_ACCESS_OPTIONS.find((option) => option.value === home?.access);

  return (
    <>
      <SettingsSection
        title={home !== null && !open ? "Own Home · Removed" : "Own Home"}
        footer={
          open
            ? [access?.description, readUnavailable].filter(Boolean).join(" ")
            : home === null
              ? undefined
              : "Reopening restores its conversation with its history."
        }
      >
        <View className="min-h-14 gap-1 px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            {BOT_OWN_HOME_DESCRIPTION}
          </Text>
        </View>
        {open ? (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                selectDetail({
                  name: "Thread",
                  params: {
                    environmentId: String(environmentId),
                    threadId: String(home.homeThreadId),
                  },
                })
              }
              className="min-h-14 justify-center border-t border-border-subtle px-4 py-3 active:opacity-70"
            >
              <Text textRole="body" className="text-primary-text">
                Open conversation
              </Text>
            </Pressable>
            <SelectRow
              borderTop
              label="Access"
              value={access?.label ?? home.access}
              actions={
                locked || !canOpen
                  ? []
                  : BOT_OWN_HOME_ACCESS_OPTIONS.map((option) => ({
                      id: option.value,
                      title: option.label,
                      subtitle: option.description,
                      state: option.value === home.access ? ("on" as const) : ("off" as const),
                    }))
              }
              onSelect={(id) => {
                const option = BOT_OWN_HOME_ACCESS_OPTIONS.find((entry) => entry.value === id);
                if (option && option.value !== home.access) setAccess(option.value);
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: locked || !canRemove }}
              disabled={locked || !canRemove}
              onPress={confirmRemoval}
              className="min-h-14 justify-center border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
            >
              <Text textRole="body" className="text-danger-foreground">
                Remove Home
              </Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: locked || !canOpen, busy }}
            disabled={locked || !canOpen}
            onPress={() =>
              void run("Could not open the Home", () =>
                openHome({ environmentId, input: { botId } }),
              )
            }
            className="min-h-14 justify-center border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          >
            <Text textRole="body" className="text-primary-text">
              {home === null ? "Open Home" : "Reopen Home"}
            </Text>
          </Pressable>
        )}
      </SettingsSection>
      {open && config?.environment.capabilities.botContinuation === true ? (
        <BotContinuationSection
          environmentId={environmentId}
          botId={botId}
          projectId={home.projectId}
          title="Own Home · Working notes"
          disabled={props.disabled}
        />
      ) : null}
      {open ? (
        <BotLearningSection
          environmentId={environmentId}
          botId={botId}
          projectId={home.projectId}
          title="Own Home · Learning"
          disabled={props.disabled}
        />
      ) : null}
    </>
  );
}
