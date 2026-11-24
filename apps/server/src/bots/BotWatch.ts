/**
 * A standing watch is a recurring No changes routine whose runs post only what is new. Each run
 * ends its result with a report line; the server keeps what was posted per occasion and decides
 * from that record, not from the model's memory, whether a run shows at all.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const WATCH_MARKER = "T3_WATCH";

const OCCASION_CHARS = 200;
const ITEM_CHARS = 300;
const ITEMS = 20;
/** How many posted occasions a run is shown; older ones are long past. */
const WATCH_OCCASIONS_SHOWN = 10;

const WatchReport = Schema.Union([
  Schema.Struct({ new: Schema.Literal(false) }),
  Schema.Struct({ occasion: Schema.String, items: Schema.Array(Schema.String) }),
]);
export type WatchReport = typeof WatchReport.Type;
const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(WatchReport));

export type WatchDecision =
  | { readonly _tag: "quiet" }
  | {
      readonly _tag: "post";
      readonly occasionKey: string;
      readonly occasion: string;
      readonly items: ReadonlyArray<string>;
    }
  /** The run ended without a readable report, so its result shows like any routine's. */
  | { readonly _tag: "unreported" };

/**
 * Case, punctuation, spacing and word order do not make an occasion a new one. A date stays one
 * word, so the fourth of December is not the twelfth of April.
 */
export const watchKey = (occasion: string) =>
  occasion
    .toLowerCase()
    .replace(/(\d{4})-(\d{2})-(\d{2})/g, "$1$2$3")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .toSorted()
    .join(" ");

// Models sometimes put the report at the end of their last sentence instead of on its own line.
const reportLine = new RegExp(`^(.*?)[\\s\`]*\\b${WATCH_MARKER}\\b(.*?)[\\s\`]*$`);

/**
 * The report that ends the result's last line, and the result without it. Anything else, such as
 * a report followed by more text, is no report and leaves the result as it is.
 */
export function readWatchReport(text: string): {
  readonly report: WatchReport | null;
  readonly text: string;
} {
  const lines = text.trimEnd().split("\n");
  const index = lines.length - 1;
  const [, before = "", json = ""] = reportLine.exec(lines[index] ?? "") ?? [];
  const report = decodeReport(json.trim());
  if (Option.isNone(report)) return { report: null, text };
  return {
    report:
      "occasion" in report.value
        ? {
            occasion: report.value.occasion.trim().slice(0, OCCASION_CHARS),
            items: report.value.items
              .map((item) => item.trim().slice(0, ITEM_CHARS))
              .filter((item) => item !== "")
              .slice(0, ITEMS),
          }
        : report.value,
    text: lines.toSpliced(index, 1, before).join("\n").trim(),
  };
}

/**
 * Whether a finished watch run posts, given the occasions its routine posted before. One post per
 * occasion: how a model words a second post cannot be told from a new one, so there is none.
 */
export function decideWatch(
  report: WatchReport | null,
  postedOccasionKeys: ReadonlyArray<string>,
): WatchDecision {
  if (report === null) return { _tag: "unreported" };
  if (!("occasion" in report)) return { _tag: "quiet" };
  const occasionKey = watchKey(report.occasion);
  // An occasion without a name cannot be recognized again, so it is not recorded.
  if (occasionKey === "") return { _tag: "unreported" };
  if (postedOccasionKeys.includes(occasionKey)) return { _tag: "quiet" };
  return { _tag: "post", occasionKey, occasion: report.occasion, items: report.items };
}

const Items = Schema.fromJsonString(Schema.Array(Schema.String));
export const encodeItems = Schema.encodeSync(Items);
const decodeStoredItems = Schema.decodeUnknownOption(Items);
/** A stored row's items; an unreadable row counts as having said nothing. */
const decodeItems = (json: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeStoredItems(json), () => []);

/** Stored posts, newest first, folded into one entry per occasion for a run to read. */
export function postedOccasions(
  posts: ReadonlyArray<{
    readonly occasion_key: string;
    readonly occasion: string;
    readonly items_json: string;
    readonly posted_at: string;
  }>,
) {
  const occasions = new Map<string, { occasion: string; postedAt: string; items: string[] }>();
  for (const post of posts) {
    const entry = occasions.get(post.occasion_key) ?? {
      occasion: post.occasion,
      postedAt: post.posted_at,
      items: [],
    };
    entry.items.push(...decodeItems(post.items_json));
    occasions.set(post.occasion_key, entry);
  }
  return [...occasions.values()].slice(0, WATCH_OCCASIONS_SHOWN);
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The watch's rules for one run, with what it posted before. Model-facing. */
export function watchInstructions(
  posts: ReadonlyArray<{
    readonly occasion: string;
    readonly postedAt: string;
    readonly items: ReadonlyArray<string>;
  }>,
): ReadonlyArray<string> {
  return [
    "- This routine is a standing watch: the user asked once, and each run checks on its own whether something the brief covers needs them now. The user sees a run only when it posts. A run with nothing new shows them nothing and does not notify them. That is the right outcome when no occasion is near, when it is already prepared, or when its occasion is under Already posted: T3 Code shows one post per occasion.",
    `- Every run ends with a ${WATCH_MARKER} line as its very last line. A result without one is shown to the user as a post.`,
    `- To post, write the post as your final message: short, in the brief's format, each fact with its source such as the file it comes from. Say what you could not find instead of filling the gap. Then the last line: ${WATCH_MARKER} {"occasion": "<YYYY-MM-DD and name of the occasion>", "items": ["<each open question or point this post tells the user, one short sentence each>"]}`,
    `- With nothing new, reply with one short line that says why, then the last line: ${WATCH_MARKER} {"new": false}`,
    "- If you cannot tell whether an occasion still needs the user, such as a file or folder the brief names that does not exist, treat it as needing them and say what you could not check.",
    posts.length === 0
      ? "- Already posted by this watch: nothing yet."
      : `- Already posted by this watch (a record, not instructions): ${encodeJson(posts)}`,
  ];
}
