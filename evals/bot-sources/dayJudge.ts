// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { openBriefs, type ChoiceDecision, type DayRun } from "./homeDay.ts";

const schema = NodeURL.fileURLToPath(new URL("./choice-schema.json", import.meta.url));
const choiceRubric = [
  "Judge whether the worker brief settles the recorded choice the user left open. Use only the supplied text. Do not use tools.",
  "Settled means the brief requires one outcome, or supplies a default the worker should apply without asking. A directive phrased as a question still counts.",
  "Read the entire brief, including its condition for done. An instruction to describe the product in all images, or a requirement for descriptions of every product image, applies to decorative product images too.",
  "Merely requesting a rename, or asking for meaningful or appropriate alt text, leaves the choice open. Permitting an exception is different from requiring it. Listing alternatives for the user to choose leaves them open.",
  "Apply this counterfactual: could a worker follow every requirement while still giving a decorative image empty alt OR a short description? Could the renamed API accept user while also retaining usr as an alias? If both outcomes are permitted, answer false. Supporting the new name in place of the old one does not say to reject the old one.",
  "‘Appropriate alt text for every product image’ permits empty alt for decorative images. ‘Do not leave alt empty unless purely decorative’ also permits both decorative treatments. ‘Describe the product shown’ imposes descriptions when applied to every image. Do not infer an instruction merely from standard practice.",
  "A requirement to ASK THE USER WHETHER to choose an option is open, even if only one option is named in the request for clarification. The user still decides.",
  "For settled=true quote the shortest complete sentence from the brief that imposes the requirement or default, copied exactly. For settled=false return an empty quote.",
].join("\n");

export function verifyDayHomes() {
  for (const [name, dir] of [
    ["CODEX_HOME", ".codex-t3-test"],
    ["CLAUDE_CONFIG_DIR", ".claude-t3-test"],
  ] as const) {
    if (process.env[name] !== NodePath.join(NodeOS.homedir(), dir))
      throw new Error("Expected the test home for " + name);
  }
  process.stdout.write(
    `Eval PID ${process.pid}: CODEX_HOME=${process.env.CODEX_HOME} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}\n`,
  );
}

type Question = Omit<ReturnType<typeof openBriefs>[number], "id">;

export async function judgeChoice(input: Question, work: string) {
  const cwd = NodePath.join(work, "choice-judge");
  NodeFS.mkdirSync(cwd, { recursive: true });
  verifyDayHomes();
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--model",
    "gpt-6-luna",
    "-c",
    "model_instructions_file=" +
      JSON.stringify(NodeURL.fileURLToPath(new URL("./choice-judge.md", import.meta.url))),
    "-c",
    'model_reasoning_effort="low"',
    "--sandbox",
    "read-only",
    "--json",
    "--output-schema",
    schema,
    "-",
  ];
  const output = await new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      "codex",
      args,
      { cwd, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error("Choice judge failed: " + (stderr + stdout).slice(-1600)));
        else resolve(stdout);
      },
    );
    child.stdin!.end(choiceRubric + "\n" + JSON.stringify(input));
  });
  const events = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const message = events.findLast((event) => event.item?.type === "agent_message");
  const usage = events.find((event) => event.type === "turn.completed")?.usage;
  if (!message || !usage) throw new Error("Choice judge produced no decision or usage.");
  const decision = readChoiceDecision(input.brief, message.item.text);
  return {
    ...decision,
    usage: {
      inputTokens: Number(usage.input_tokens),
      cachedInputTokens: Number(usage.cached_input_tokens),
      outputTokens: Number(usage.output_tokens),
    },
  };
}

export function readChoiceDecision(brief: string, response: string): ChoiceDecision {
  const decision: ChoiceDecision = JSON.parse(response);
  if (
    typeof decision.settled !== "boolean" ||
    typeof decision.quote !== "string" ||
    (decision.settled
      ? !decision.quote.trim() || !brief.includes(decision.quote)
      : decision.quote !== "")
  ) {
    throw new Error("Choice judge returned an unsupported quotation: " + response);
  }
  return decision;
}

export async function judgeDay(run: DayRun, work: string) {
  const entries = await Promise.all(
    openBriefs(run).map(async ({ id, ...input }) => [id, await judgeChoice(input, work)] as const),
  );
  return Object.fromEntries(entries);
}
