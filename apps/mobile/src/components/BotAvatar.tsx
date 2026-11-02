import {
  BOT_FIGURE_VIEW_BOX,
  botFigureShapes,
  type BotFigureShape,
} from "@t3tools/client-runtime/bot-appearance";
import type { BotAppearance } from "@t3tools/contracts";
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg";

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
      return <Path d={shape.d} {...paint(shape)} />;
    case "circle":
      return <Circle cx={shape.cx} cy={shape.cy} r={shape.r} {...paint(shape)} />;
    case "ellipse":
      return <Ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...paint(shape)} />;
    case "rect":
      return (
        <Rect
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

/** Decorative: always show the Bot's name next to it. */
export function BotAvatar(props: { readonly appearance: BotAppearance; readonly size: number }) {
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox={BOT_FIGURE_VIEW_BOX}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {botFigureShapes(props.appearance, props.size).map((shape, index) => (
        // Shapes have no identity of their own; their order is the paint order.
        // oxlint-disable-next-line react/no-array-index-key
        <Shape key={index} shape={shape} />
      ))}
    </Svg>
  );
}
