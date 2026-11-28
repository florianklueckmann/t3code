import type { BotTaskAcceptance } from "@t3tools/contracts";

import { mayHaveClippedQuestions } from "./BotTaskAcceptance.ts";

export const STOP_UNANSWERED = "The stop got no response. Cancel again to force stop it.";

export const oneLine = (text: string) =>
  text
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/[“”]/g, '"');

export function dataValue(text: string, limit: number) {
  const value = oneLine(text);
  return `“${value.length > limit ? value.slice(0, limit - 1) + "…" : value}”`;
}

export function nativeQuestions(
  questions: ReadonlyArray<{
    readonly question: string;
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  }>,
) {
  return questions
    .map(({ question, options }) => {
      if (!options?.length) return question;
      return `${question} Choices: ${options.map((option) => (option.description ? `${option.label} (${option.description})` : option.label)).join("; ")}.`;
    })
    .join(" ");
}

export function questionValue(
  native: string | null,
  limit: number,
  reported: ReadonlyArray<string> = [],
) {
  const value = oneLine([...reported, native].filter(Boolean).join(" "));
  return !value || value.length > limit || mayHaveClippedQuestions(reported)
    ? "Full question not shown here. Open the task card for the question and choices."
    : dataValue(value, limit);
}

export function evidenceSummary(acceptance: BotTaskAcceptance, maxItems: number) {
  const items = acceptance.report?.evidence ?? [];
  if (!items.length) return "none cited";
  const labels = {
    found: "exists",
    missing: "could not verify",
    link: "unchecked link",
    unchecked: "unchecked",
  };
  const shown = items
    .slice(0, maxItems)
    .map((item) => `${labels[item.check]}: ${dataValue(item.text, 96)}`);
  if (items.length > maxItems) shown.push(`${items.length - maxItems} more in the task card`);
  return shown.join(", ");
}

export function reviewReason(acceptance: BotTaskAcceptance, limit: number) {
  // Missing citations are already listed with their saved check, including those in older records.
  const reasons = acceptance.missing.filter(
    (reason) =>
      !acceptance.report?.evidence.some(
        (item) =>
          item.check === "missing" &&
          (reason === `“${item.text}” does not exist.` ||
            reason === `Could not verify “${item.text}”.`),
      ),
  );
  return reasons.length ? dataValue(reasons.join(" "), limit) : null;
}
