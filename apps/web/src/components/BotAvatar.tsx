import {
  BOT_FIGURE_VIEW_BOX,
  botFigureShapes,
  type BotFigureShape,
} from "@t3tools/client-runtime/bot-appearance";
import type { BotAppearance } from "@t3tools/contracts";

function paint(shape: BotFigureShape) {
  return {
    fill: shape.fill ?? "none",
    stroke: shape.stroke,
    strokeWidth: shape.strokeWidth,
    strokeLinecap: shape.stroke ? ("round" as const) : undefined,
    strokeLinejoin: shape.stroke ? ("round" as const) : undefined,
    opacity: shape.opacity,
  };
}

function Shape({ shape }: { readonly shape: BotFigureShape }) {
  switch (shape.kind) {
    case "path":
      return <path d={shape.d} {...paint(shape)} />;
    case "circle":
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} {...paint(shape)} />;
    case "ellipse":
      return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...paint(shape)} />;
    case "rect":
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.rx}
          {...paint(shape)}
        />
      );
  }
}

/** Decorative: always render the Bot's name next to it. */
export function BotAvatar({
  appearance,
  size,
  className,
}: {
  readonly appearance: BotAppearance;
  readonly size: number;
  readonly className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={BOT_FIGURE_VIEW_BOX}
      className={className}
      aria-hidden
      focusable={false}
    >
      {botFigureShapes(appearance, size).map((shape, index) => (
        // Shapes have no identity of their own; their order is the paint order.
        // oxlint-disable-next-line react/no-array-index-key
        <Shape key={index} shape={shape} />
      ))}
    </svg>
  );
}
