import {
  BOT_APPEARANCE_COLORS,
  BOT_APPEARANCE_FACES,
  BOT_APPEARANCE_TOPPERS,
  type BotAppearance,
  type BotSummary,
} from "@t3tools/contracts";

type BotColor = BotAppearance["color"];
type BotFace = BotAppearance["face"];
type BotTopper = BotAppearance["topper"];

export const BOT_COLOR_OPTIONS: ReadonlyArray<{
  readonly value: BotColor;
  readonly label: string;
}> = BOT_APPEARANCE_COLORS.map((value) => ({ value, label: capitalize(value) }));

export const BOT_FACE_OPTIONS: ReadonlyArray<{ readonly value: BotFace; readonly label: string }> =
  BOT_APPEARANCE_FACES.map((value) => ({ value, label: capitalize(value) }));

export const BOT_TOPPER_OPTIONS: ReadonlyArray<{
  readonly value: BotTopper;
  readonly label: string;
}> = BOT_APPEARANCE_TOPPERS.map((value) => ({ value, label: capitalize(value) }));

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Fixed tints, so the face keeps its contrast on light and dark backgrounds alike. */
export const BOT_COLOR_PALETTE: Readonly<
  Record<BotColor, { readonly body: string; readonly edge: string; readonly ink: string }>
> = {
  teal: { body: "#5eead4", edge: "#14b8a6", ink: "#134e4a" },
  sky: { body: "#7dd3fc", edge: "#0ea5e9", ink: "#0c4a6e" },
  violet: { body: "#c4b5fd", edge: "#8b5cf6", ink: "#4c1d95" },
  pink: { body: "#f9a8d4", edge: "#ec4899", ink: "#831843" },
  orange: { body: "#fdba74", edge: "#f97316", ink: "#7c2d12" },
  amber: { body: "#fcd34d", edge: "#f59e0b", ink: "#78350f" },
  lime: { body: "#bef264", edge: "#84cc16", ink: "#365314" },
  gray: { body: "#d1d5db", edge: "#6b7280", ink: "#1f2937" },
};

function hashBotId(botId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < botId.length; index += 1) {
    hash ^= botId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The look of a Bot nobody customized. Every client derives the same one, so changing
 * this changes how existing Bots look everywhere.
 */
export function defaultBotAppearance(botId: string): BotAppearance {
  const hash = hashBotId(botId);
  return {
    color: BOT_APPEARANCE_COLORS[hash % BOT_APPEARANCE_COLORS.length]!,
    face: BOT_APPEARANCE_FACES[(hash >>> 3) % BOT_APPEARANCE_FACES.length]!,
    topper: BOT_APPEARANCE_TOPPERS[(hash >>> 7) % BOT_APPEARANCE_TOPPERS.length]!,
  };
}

function known<T extends string>(options: ReadonlyArray<T>, value: string, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

/**
 * The saved custom look with values this client does not know replaced field by field,
 * or null when the Bot uses its default.
 */
export function savedBotAppearance(
  bot: Pick<BotSummary, "id" | "appearance">,
): BotAppearance | null {
  if (bot.appearance == null) return null;
  const fallback = defaultBotAppearance(bot.id);
  return {
    color: known(BOT_APPEARANCE_COLORS, bot.appearance.color, fallback.color),
    face: known(BOT_APPEARANCE_FACES, bot.appearance.face, fallback.face),
    topper: known(BOT_APPEARANCE_TOPPERS, bot.appearance.topper, fallback.topper),
  };
}

export function resolveBotAppearance(bot: Pick<BotSummary, "id" | "appearance">): BotAppearance {
  return savedBotAppearance(bot) ?? defaultBotAppearance(bot.id);
}

export function sameBotAppearance(
  left: BotAppearance | null,
  right: BotAppearance | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.color === right.color &&
      left.face === right.face &&
      left.topper === right.topper)
  );
}

interface ShapePaint {
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly opacity?: number;
}

/** One SVG primitive in a 32 × 32 view box; web and mobile map these to their own elements. */
export type BotFigureShape =
  | ({ readonly kind: "path"; readonly d: string } & ShapePaint)
  | ({
      readonly kind: "circle";
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
    } & ShapePaint)
  | ({
      readonly kind: "ellipse";
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
    } & ShapePaint)
  | ({
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx: number;
    } & ShapePaint);

export const BOT_FIGURE_VIEW_BOX = "0 0 32 32";

/** Below this size cheeks and inner ears turn to noise, so the figure drops them. */
const DETAIL_MIN_SIZE = 20;

const BODY_PATH =
  "M16 7.5C23.6 7.5 27.2 11.4 27.2 18.2C27.2 24.6 23.2 27.8 16 27.8C8.8 27.8 4.8 24.6 4.8 18.2C4.8 11.4 8.4 7.5 16 7.5Z";
const EYE_Y = 17;
const LEFT_EYE = 12.2;
const RIGHT_EYE = 19.8;
const MOUTH_Y = 21;

function faceShapes(face: BotFace, ink: string): ReadonlyArray<BotFigureShape> {
  const line = (d: string): BotFigureShape => ({ kind: "path", d, stroke: ink, strokeWidth: 1.4 });
  const dot = (cx: number, r = 1.7): BotFigureShape => ({
    kind: "circle",
    cx,
    cy: EYE_Y,
    r,
    fill: ink,
  });
  const closedEye = (x: number) =>
    line(`M${x - 1.7} ${EYE_Y}Q${x} ${EYE_Y + 1.4} ${x + 1.7} ${EYE_Y}`);
  const caretEye = (x: number) =>
    line(`M${x - 1.6} ${EYE_Y + 0.9}L${x} ${EYE_Y - 0.9}L${x + 1.6} ${EYE_Y + 0.9}`);
  const smile = line(`M14 ${MOUTH_Y}Q16 ${MOUTH_Y + 1.8} 18 ${MOUTH_Y}`);
  switch (face) {
    case "happy":
      return [dot(LEFT_EYE), dot(RIGHT_EYE), smile];
    case "sleepy":
      return [
        closedEye(LEFT_EYE),
        closedEye(RIGHT_EYE),
        line(`M15 ${MOUTH_Y + 0.3}Q16 ${MOUTH_Y + 1} 17 ${MOUTH_Y + 0.3}`),
      ];
    case "wink":
      return [dot(LEFT_EYE), caretEye(RIGHT_EYE), smile];
    case "curious":
      return [
        dot(LEFT_EYE, 2),
        dot(RIGHT_EYE, 2),
        { kind: "circle", cx: 16, cy: MOUTH_Y + 0.6, r: 1, fill: ink },
      ];
    case "joy":
      return [
        caretEye(LEFT_EYE),
        caretEye(RIGHT_EYE),
        {
          kind: "path",
          d: `M13.6 ${MOUTH_Y - 0.6}H18.4Q18.4 ${MOUTH_Y + 2.2} 16 ${MOUTH_Y + 2.2}Q13.6 ${MOUTH_Y + 2.2} 13.6 ${MOUTH_Y - 0.6}Z`,
          fill: ink,
        },
      ];
    case "focused":
      return [
        {
          kind: "rect",
          x: LEFT_EYE - 1.7,
          y: EYE_Y - 0.9,
          width: 3.4,
          height: 1.8,
          rx: 0.9,
          fill: ink,
        },
        {
          kind: "rect",
          x: RIGHT_EYE - 1.7,
          y: EYE_Y - 0.9,
          width: 3.4,
          height: 1.8,
          rx: 0.9,
          fill: ink,
        },
        line(`M14.6 ${MOUTH_Y + 0.5}H17.4`),
      ];
  }
}

/** The figure as SVG primitives in paint order. `size` is the rendered size in pixels. */
export function botFigureShapes(
  appearance: BotAppearance,
  size: number,
): ReadonlyArray<BotFigureShape> {
  const palette = BOT_COLOR_PALETTE[appearance.color];
  const detailed = size >= DETAIL_MIN_SIZE;
  const shapes: BotFigureShape[] = [];

  if (appearance.topper === "ears") {
    for (const cx of [8.6, 23.4]) {
      shapes.push({
        kind: "circle",
        cx,
        cy: 10,
        r: 3.6,
        fill: palette.body,
        stroke: palette.edge,
        strokeWidth: 1,
      });
      if (detailed)
        shapes.push({ kind: "circle", cx, cy: 10, r: 1.6, fill: palette.edge, opacity: 0.45 });
    }
  }

  shapes.push({
    kind: "path",
    d: BODY_PATH,
    fill: palette.body,
    stroke: palette.edge,
    strokeWidth: size >= 40 ? 1 : 1.4,
  });

  if (detailed) {
    const cheek = appearance.color === "pink" ? "#e11d48" : "#fb7185";
    for (const cx of [9.4, 22.6]) {
      shapes.push({ kind: "ellipse", cx, cy: 20.6, rx: 1.6, ry: 1, fill: cheek, opacity: 0.45 });
    }
  }

  shapes.push(...faceShapes(appearance.face, palette.ink));

  switch (appearance.topper) {
    case "antenna":
      shapes.push(
        { kind: "path", d: "M16 7.5V3.8", stroke: palette.edge, strokeWidth: 1.5 },
        { kind: "circle", cx: 16, cy: 3.2, r: 2, fill: palette.edge },
      );
      break;
    case "sprout":
      shapes.push(
        { kind: "path", d: "M16 7.5V4.6", stroke: "#15803d", strokeWidth: 1.3 },
        {
          kind: "path",
          d: "M16 5C14.6 2.6 12.1 2.3 10.8 3.2C11.8 5.2 14 5.9 16 5Z",
          fill: "#22c55e",
        },
        {
          kind: "path",
          d: "M16 5C17.4 2.6 19.9 2.3 21.2 3.2C20.2 5.2 18 5.9 16 5Z",
          fill: "#22c55e",
        },
      );
      break;
    case "bow": {
      const pink = appearance.color === "pink";
      const ribbon = pink ? "#a78bfa" : "#f472b6";
      shapes.push(
        { kind: "path", d: "M22.6 8.4L19 5.8Q18.3 8.4 19 11Z", fill: ribbon },
        { kind: "path", d: "M22.6 8.4L26.2 5.8Q26.9 8.4 26.2 11Z", fill: ribbon },
        { kind: "circle", cx: 22.6, cy: 8.4, r: 1.4, fill: pink ? "#7c3aed" : "#db2777" },
      );
      break;
    }
    case "ears":
    case "none":
      break;
  }

  return shapes;
}
