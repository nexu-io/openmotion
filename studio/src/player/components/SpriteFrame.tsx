import { memo, type CSSProperties } from "react";
import type { ThumbnailValue } from "../lib/thumbnailScheduler";

export type SpriteThumbnailValue = Extract<ThumbnailValue, { kind: "sprite" }>;

export interface SpriteFrameProps {
  sprite: SpriteThumbnailValue;
  frameIndex: number;
  fit?: "cover" | "contain";
  /** Optional explicit container dimensions (CSS px) for distortion-free cover/contain sizing. */
  containerWidth?: number;
  containerHeight?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Compute zero-slice CSS background properties for one frame inside a packed sprite sheet.
 * Uses CSS `background-position` percentages so the browser decodes the sprite once and
 * never slices or re-encodes individual frames on a `<canvas>`.
 */
export function computeSpriteFrameBackground(
  sprite: Pick<SpriteThumbnailValue, "url" | "frameCount" | "cols" | "rows">,
  frameIndex: number,
): {
  clampedIndex: number;
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
  backgroundRepeat: "no-repeat";
} {
  const safeCount = Math.max(1, Math.floor(sprite.frameCount || 1));
  const safeCols = Math.max(1, Math.floor(sprite.cols || safeCount));
  const safeRows = Math.max(1, Math.floor(sprite.rows || Math.ceil(safeCount / safeCols)));
  const clampedIndex = Math.max(0, Math.min(safeCount - 1, Math.floor(frameIndex || 0)));
  const col = clampedIndex % safeCols;
  const row = Math.floor(clampedIndex / safeCols);
  const posX = safeCols > 1 ? (col / (safeCols - 1)) * 100 : 0;
  const posY = safeRows > 1 ? (row / (safeRows - 1)) * 100 : 0;
  return {
    clampedIndex,
    backgroundImage: `url("${sprite.url}")`,
    backgroundSize: `${safeCols * 100}% ${safeRows * 100}%`,
    backgroundPosition: `${posX}% ${posY}%`,
    backgroundRepeat: "no-repeat",
  };
}

function computeFittedFrameStyle(
  aspect: number,
  fit: "cover" | "contain",
  containerWidth?: number,
  containerHeight?: number,
): CSSProperties {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const hasBox =
    typeof containerWidth === "number" &&
    Number.isFinite(containerWidth) &&
    containerWidth > 0 &&
    typeof containerHeight === "number" &&
    Number.isFinite(containerHeight) &&
    containerHeight > 0;
  if (hasBox) {
    const scale =
      fit === "contain"
        ? Math.min(containerWidth / safeAspect, containerHeight)
        : Math.max(containerWidth / safeAspect, containerHeight);
    return {
      width: `${scale * safeAspect}px`,
      height: `${scale}px`,
      flexShrink: 0,
    };
  }
  if (fit === "contain") {
    return {
      width: `min(100cqw, calc(100cqh * ${safeAspect}))`,
      height: `min(100cqh, calc(100cqw / ${safeAspect}))`,
      flexShrink: 0,
    };
  }
  return {
    width: "100%",
    height: "100%",
    flexShrink: 0,
  };
}

/**
 * Zero-slice sprite frame renderer backed by a single shared object URL and CSS
 * `background-position`. Preserves exact frame aspect ratio for both `cover` (timeline tiles)
 * and `contain` (sidebar cards and preview posters).
 */
export const SpriteFrame = memo(function SpriteFrame({
  sprite,
  frameIndex,
  fit = "cover",
  containerWidth,
  containerHeight,
  className,
  style,
}: SpriteFrameProps) {
  const frameAspect =
    Number.isFinite(sprite.aspect) && sprite.aspect > 0
      ? sprite.aspect
      : sprite.frameWidth > 0 && sprite.frameHeight > 0
        ? sprite.frameWidth / sprite.frameHeight
        : 16 / 9;
  const bg = computeSpriteFrameBackground(sprite, frameIndex);
  const fittedStyle = computeFittedFrameStyle(frameAspect, fit, containerWidth, containerHeight);
  const needsContainerQuery =
    fit === "contain" && !(containerWidth && containerWidth > 0 && containerHeight && containerHeight > 0);

  return (
    <div
      className={`flex items-center justify-center overflow-hidden ${className ?? ""}`}
      style={{
        ...style,
        ...(needsContainerQuery ? { containerType: "size" as const } : null),
      }}
      data-sprite-frame={bg.clampedIndex}
      data-sprite-url={sprite.url}
      data-sprite-frames={sprite.frameCount}
      aria-hidden="true"
    >
      <div
        style={{
          ...fittedStyle,
          backgroundImage: bg.backgroundImage,
          backgroundSize: bg.backgroundSize,
          backgroundPosition: bg.backgroundPosition,
          backgroundRepeat: bg.backgroundRepeat,
        }}
      />
    </div>
  );
});
