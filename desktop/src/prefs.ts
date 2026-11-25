import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DesktopPreferenceValues } from '../../shared/desktop-contract.ts';

export type DesktopPreferences = {
  confirmBeforeQuit?: boolean;
  autoCheckUpdates?: boolean;
  hardwareAcceleration?: boolean;
  locale?: string;
  lastDownloadDir?: string;
};

export type DesktopPreferencesPatch = {
  [K in keyof DesktopPreferences]?: DesktopPreferences[K] | null;
};

const LOCALE_TAG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function sanitizePreferences(raw: unknown): DesktopPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const prefs: DesktopPreferences = {};
  if (typeof record.confirmBeforeQuit === 'boolean') {
    prefs.confirmBeforeQuit = record.confirmBeforeQuit;
  }
  if (typeof record.autoCheckUpdates === 'boolean') {
    prefs.autoCheckUpdates = record.autoCheckUpdates;
  }
  if (typeof record.hardwareAcceleration === 'boolean') {
    prefs.hardwareAcceleration = record.hardwareAcceleration;
  }
  if (
    typeof record.locale === 'string' &&
    record.locale.trim().length >= 2 &&
    record.locale.trim().length <= 32 &&
    LOCALE_TAG_RE.test(record.locale.trim())
  ) {
    prefs.locale = record.locale.trim();
  }
  if (
    typeof record.lastDownloadDir === 'string' &&
    record.lastDownloadDir.trim().length > 0 &&
    !/[\r\n\0]/.test(record.lastDownloadDir)
  ) {
    prefs.lastDownloadDir = record.lastDownloadDir.trim();
  }
  return prefs;
}

export function resolveDesktopPreferenceValues(
  raw: DesktopPreferences,
  options?: { openAtLogin?: boolean },
): DesktopPreferenceValues {
  return {
    confirmBeforeQuit: raw.confirmBeforeQuit !== false,
    openAtLogin: Boolean(options?.openAtLogin),
    autoCheckUpdates: raw.autoCheckUpdates !== false,
    hardwareAcceleration: raw.hardwareAcceleration !== false,
    locale: raw.locale ?? null,
    lastDownloadDir: raw.lastDownloadDir ?? null,
  };
}

export function readDesktopPreferences(filePath: string): DesktopPreferences {
  try {
    if (!existsSync(filePath)) return {};
    if (lstatSync(filePath).isSymbolicLink()) return {};
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return sanitizePreferences(parsed);
  } catch {
    return {};
  }
}

export function writeDesktopPreferences(filePath: string, prefs: DesktopPreferences): boolean {
  try {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
      return false;
    }
    const sanitized = sanitizePreferences(prefs);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    return false;
  }
}

export class DesktopPreferencesStore {
  private readonly filePath: string;
  private cached: DesktopPreferences;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.cached = readDesktopPreferences(filePath);
  }

  get(): DesktopPreferences {
    return { ...this.cached };
  }

  update(patch: DesktopPreferencesPatch): DesktopPreferences {
    const merged: Record<string, unknown> = { ...this.cached };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    const next = sanitizePreferences(merged);
    this.cached = next;
    writeDesktopPreferences(this.filePath, next);
    return { ...next };
  }

  reset(key?: keyof DesktopPreferences): DesktopPreferences {
    if (!key) {
      this.cached = {};
      writeDesktopPreferences(this.filePath, {});
      return {};
    }
    const nextRecord: Record<string, unknown> = { ...this.cached };
    delete nextRecord[key];
    const next = sanitizePreferences(nextRecord);
    this.cached = next;
    writeDesktopPreferences(this.filePath, next);
    return { ...next };
  }
}
