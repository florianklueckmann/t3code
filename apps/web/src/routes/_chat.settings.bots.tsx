import { isBotEditorSectionId } from "@t3tools/client-runtime/bots";
import { BotId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { BotsSettingsPanel } from "../components/settings/BotsSettings";

const isBotId = Schema.is(BotId);

function SettingsBotsRoute() {
  const target = Route.useSearch();
  return <BotsSettingsPanel {...target} />;
}

export const Route = createFileRoute("/_chat/settings/bots")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(isBotId(raw.bot) ? { bot: raw.bot } : {}),
    ...(isBotEditorSectionId(raw.section) ? { section: raw.section } : {}),
  }),
  component: SettingsBotsRoute,
});
