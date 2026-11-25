import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type WindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

export type PersistedWindowState = {
  version: 1;
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
};

export type DisplayWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowStateDefaults = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

const MIN_VISIBLE_OVERLAP_PX = 80;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function overlapsWorkArea(bounds: Required<WindowBounds>, area: DisplayWorkArea): boolean {
  const overlapX =
    Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const overlapY =
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return overlapX >= MIN_VISIBLE_OVERLAP_PX && overlapY >= MIN_VISIBLE_OVERLAP_PX;
}

/**
 * Resolves safe window bounds from persisted state, clamping size to minimums
 * and display dimensions, and discarding off-screen coordinates (e.g. after
 * disconnecting an external display).
 */
export function resolveRestoredWindowBounds(
  saved: Partial<PersistedWindowState> | null | undefined,
  workAreas: readonly DisplayWorkArea[],
  defaults: WindowStateDefaults,
): { bounds: WindowBounds; maximized: boolean } {
  const rawWidth = isFiniteNumber(saved?.width) ? Math.round(saved.width) : defaults.width;
  const rawHeight = isFiniteNumber(saved?.height) ? Math.round(saved.height) : defaults.height;
  const minClampedWidth = Math.max(defaults.minWidth, rawWidth);
  const minClampedHeight = Math.max(defaults.minHeight, rawHeight);
  const maximized = Boolean(saved?.maximized);

  if (isFiniteNumber(saved?.x) && isFiniteNumber(saved?.y) && workAreas.length > 0) {
    const candidate: Required<WindowBounds> = {
      x: Math.round(saved.x),
      y: Math.round(saved.y),
      width: minClampedWidth,
      height: minClampedHeight,
    };
    const matchingArea = workAreas.find(area => overlapsWorkArea(candidate, area));
    if (matchingArea) {
      const clampedWidth = Math.min(minClampedWidth, Math.max(defaults.minWidth, matchingArea.width));
      const clampedHeight = Math.min(minClampedHeight, Math.max(defaults.minHeight, matchingArea.height));
      const minX = matchingArea.x;
      const maxX = Math.max(minX, matchingArea.x + matchingArea.width - clampedWidth);
      const minY = matchingArea.y;
      const maxY = Math.max(minY, matchingArea.y + matchingArea.height - clampedHeight);
      return {
        bounds: {
          x: Math.min(Math.max(candidate.x, minX), maxX),
          y: Math.min(Math.max(candidate.y, minY), maxY),
          width: clampedWidth,
          height: clampedHeight,
        },
        maximized,
      };
    }
  }

  let width = minClampedWidth;
  let height = minClampedHeight;
  const primary = workAreas[0];
  if (primary) {
    width = Math.min(width, Math.max(defaults.minWidth, primary.width));
    height = Math.min(height, Math.max(defaults.minHeight, primary.height));
  }

  return {
    bounds: { width, height },
    maximized,
  };
}

export function readWindowState(filePath: string): PersistedWindowState | null {
  try {
    if (!existsSync(filePath)) return null;
    if (lstatSync(filePath).isSymbolicLink()) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return null;
    if (!isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) return null;
    return {
      version: 1,
      width: Math.round(raw.width),
      height: Math.round(raw.height),
      ...(isFiniteNumber(raw.x) ? { x: Math.round(raw.x) } : {}),
      ...(isFiniteNumber(raw.y) ? { y: Math.round(raw.y) } : {}),
      maximized: Boolean(raw.maximized),
    };
  } catch {
    return null;
  }
}

export function writeWindowState(filePath: string, state: PersistedWindowState): boolean {
  try {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
      return false;
    }
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}
