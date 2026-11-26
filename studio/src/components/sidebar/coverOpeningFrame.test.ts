import { describe, expect, it } from "vitest";
import { isFrameVisuallyNonBlank, scoreFrameVisualVariance } from "./coverOpeningFrame";

function solidRgba(r: number, g: number, b: number, pixels = 48): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels * 4; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  return buf;
}

describe("coverOpeningFrame visual blank detection", () => {
  it("treats solid black, near-black, white, and flat color fade-ins as blank", () => {
    expect(isFrameVisuallyNonBlank(solidRgba(0, 0, 0))).toBe(false);
    expect(isFrameVisuallyNonBlank(solidRgba(20, 22, 20))).toBe(false);
    expect(isFrameVisuallyNonBlank(solidRgba(255, 255, 255))).toBe(false);
    expect(isFrameVisuallyNonBlank(solidRgba(220, 170, 130))).toBe(false);
    expect(scoreFrameVisualVariance(solidRgba(12, 12, 12))).toEqual({
      lumaStdDev: 0,
      colorSpread: 0,
    });
  });

  it("treats frames with visible UI, text, or color contrast as non-blank", () => {
    const withTitle = solidRgba(18, 20, 22);
    // Simulate a small bright title / logo patch across 4 of the 48 sampled cells
    for (let p = 20; p < 24; p++) {
      withTitle[p * 4] = 235;
      withTitle[p * 4 + 1] = 240;
      withTitle[p * 4 + 2] = 245;
    }
    expect(isFrameVisuallyNonBlank(withTitle)).toBe(true);

    const softGradient = solidRgba(100, 145, 210);
    softGradient[0] = 70;
    softGradient[1] = 120;
    softGradient[2] = 195;
    expect(isFrameVisuallyNonBlank(softGradient)).toBe(true);
  });
});
