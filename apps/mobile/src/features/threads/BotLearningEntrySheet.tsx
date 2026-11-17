import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { BotId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { BotLearningSection } from "../settings/BotLearningSection";

type BotLearningEntryTarget = {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  /** The Home's project, used when the entry no longer exists. */
  readonly projectId: ProjectId;
  readonly entryId: string;
  readonly revision: number;
};

/** One learning entry with the Bot settings' own actions, opened from a Home notice. */
export function BotLearningEntrySheet({ route }: StaticScreenProps<BotLearningEntryTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const detail = useEnvironmentQuery(
    serverEnvironment.botDetail({
      environmentId: target.environmentId,
      input: { botId: target.botId },
    }),
  );
  const entry = detail.data?.learning.find((candidate) => candidate.id === target.entryId);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Lesson" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          <BotLearningSection
            environmentId={target.environmentId}
            botId={target.botId}
            // The entry's scope now, which a later change may have moved to all projects.
            projectId={entry === undefined ? target.projectId : entry.projectId}
            title={entry?.projectId === null ? "All projects" : "This project"}
            disabled={detail.data?.archivedAt != null}
            focus={{ entryId: target.entryId, revision: target.revision }}
          />
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
