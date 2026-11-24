import { isBotEditorSectionId } from "@t3tools/client-runtime/bots";
import { BotId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotsSettingsPanel } from "../components/settings/BotsSettings";

function SettingsBotsRoute() {
  const target = Route.useSearch();
  return <BotsSettingsPanel {...target} />;
}

export const Route = createFileRoute("/_chat/settings/bots")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.bot === "string" && raw.bot.trim() ? { bot: BotId.make(raw.bot) } : {}),
    ...(isBotEditorSectionId(raw.section) ? { section: raw.section } : {}),
  }),
  component: SettingsBotsRoute,
});
