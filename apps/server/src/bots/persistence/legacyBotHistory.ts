import { migrationManifest } from "../../persistence/Migrations.ts";

const names = [
  "Bots",
  "BotAppearance",
  "BotTasks",
  "BotLearning",
  "DropOrchestrationEventCorrelationIndex",
  "BotRoutineChanges",
];

export function legacyBotMigrationHead(
  history: ReadonlyArray<{ readonly id: number; readonly name: string }>,
): number | undefined {
  const suffix = history.filter((row) => row.id >= 78).toSorted((a, b) => a.id - b.id);
  if (
    suffix.length === 0 ||
    suffix.some((row, index) => row.id !== 78 + index || row.name !== names[index])
  )
    return undefined;
  const prefix = new Map(history.map((row) => [row.id, row.name]));
  if (migrationManifest.some(([id, name]) => id >= 55 && id < 78 && prefix.get(id) !== name))
    return undefined;
  return suffix.at(-1)?.id;
}
