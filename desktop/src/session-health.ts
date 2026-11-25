/**
 * Release health: one Sentry session per launch.
 *
 * A launch reports that it started. How it ended is only known for certain at
 * the next launch (a crashed or killed process cannot report its own end), so
 * the outcome is kept in a small local record and reported then:
 *
 *   exited   - the app quit normally
 *   crashed  - a renderer crashed, or the launch left a crash dump behind
 *   abnormal - the process disappeared without either (force quit, power loss)
 *
 * The install id is a random value that only groups sessions into "users" for
 * the crash-free-users rate. It exists only while the user shares usage data.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DesktopSentrySessionUpdate } from './sentry.ts';

type SessionRecord = {
  sid: string;
  startedAt: number;
  release: string;
  errors: number;
  crashed: boolean;
  /** Set on a normal quit; its absence at the next launch means the process disappeared. */
  endedAt?: number;
};

export type SessionTracker = {
  /** Reports how the previous launch ended, then opens this launch's session. */
  start: () => void;
  /** Returns the random per-install UUID while sharing is enabled, or undefined when off. */
  getInstallId: () => string | undefined;
  noteError: () => void;
  noteCrash: () => void;
  /** Marks a normal quit. Synchronous: the process is about to exit. */
  end: () => void;
  /** Removes the session record and the install id (the user stopped sharing). */
  forget: () => void;
};

export function hasCrashDumpSince(dir: string, sinceMs: number, depth = 2): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && hasCrashDumpSince(full, sinceMs, depth - 1)) return true;
      continue;
    }
    if (!entry.name.endsWith('.dmp')) continue;
    try {
      if (statSync(full).mtimeMs >= sinceMs) return true;
    } catch {
      // Removed while scanning (uploaded and pruned): not evidence either way.
    }
  }
  return false;
}

export function createSessionTracker(options: {
  /** Directory for `session.json` and `install-id`. */
  dir: string;
  release: string;
  isEnabled: () => boolean;
  send: (update: DesktopSentrySessionUpdate) => unknown;
  hasCrashDumpSince?: (sinceMs: number) => boolean;
  now?: () => number;
}): SessionTracker {
  const now = options.now ?? (() => Date.now());
  const recordPath = path.join(options.dir, 'session.json');
  const installIdPath = path.join(options.dir, 'install-id');
  let current: SessionRecord | null = null;
  let cachedInstallId: string | undefined;

  const readRecord = (): SessionRecord | null => {
    try {
      const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as Partial<SessionRecord>;
      if (
        typeof parsed.sid !== 'string' ||
        typeof parsed.startedAt !== 'number' ||
        typeof parsed.release !== 'string'
      ) {
        return null;
      }
      return {
        sid: parsed.sid,
        startedAt: parsed.startedAt,
        release: parsed.release,
        errors: typeof parsed.errors === 'number' ? parsed.errors : 0,
        crashed: parsed.crashed === true,
        ...(typeof parsed.endedAt === 'number' ? { endedAt: parsed.endedAt } : {}),
      };
    } catch {
      return null;
    }
  };

  const writeFile = (filePath: string, content: string): void => {
    try {
      mkdirSync(options.dir, { recursive: true });
      writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Health reporting must never break the shell.
    }
  };

  const persist = (): void => {
    if (current) writeFile(recordPath, JSON.stringify(current));
  };

  const installId = (): string => {
    if (cachedInstallId) return cachedInstallId;
    try {
      const existing = readFileSync(installIdPath, 'utf8').trim();
      if (/^[0-9a-f-]{36}$/.test(existing)) {
        cachedInstallId = existing;
        return existing;
      }
    } catch {
      // First launch, or the user re-enabled sharing.
    }
    const created = randomUUID();
    writeFile(installIdPath, created);
    cachedInstallId = created;
    return created;
  };

  const getInstallId = (): string | undefined => {
    if (!options.isEnabled()) return undefined;
    return installId();
  };

  const forget = (): void => {
    current = null;
    cachedInstallId = undefined;
    for (const filePath of [recordPath, installIdPath]) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Nothing to remove.
      }
    }
  };

  return {
    getInstallId,
    start() {
      if (!options.isEnabled()) {
        forget();
        return;
      }
      const previous = readRecord();
      const did = installId();
      if (previous) {
        const quitNormally = previous.endedAt !== undefined;
        const crashed =
          previous.crashed ||
          (!quitNormally && (options.hasCrashDumpSince?.(previous.startedAt) ?? false));
        options.send({
          sid: previous.sid,
          did,
          init: false,
          startedAt: previous.startedAt,
          // When the process disappeared, the moment it did is unknown.
          timestamp: previous.endedAt ?? now(),
          status: crashed ? 'crashed' : quitNormally ? 'exited' : 'abnormal',
          errors: previous.errors,
          ...(previous.endedAt !== undefined
            ? { durationSeconds: Math.max(0, (previous.endedAt - previous.startedAt) / 1000) }
            : {}),
          // The session belongs to the build that started it, which an update may have replaced.
          release: previous.release,
        });
      }
      const startedAt = now();
      current = { sid: randomUUID(), startedAt, release: options.release, errors: 0, crashed: false };
      persist();
      options.send({
        sid: current.sid,
        did,
        init: true,
        startedAt,
        timestamp: startedAt,
        status: 'ok',
        errors: 0,
        release: options.release,
      });
    },
    noteError() {
      if (!current) return;
      current.errors += 1;
      persist();
    },
    noteCrash() {
      if (!current) return;
      current.crashed = true;
      persist();
    },
    end() {
      if (!current) return;
      current.endedAt = now();
      persist();
    },
    forget,
  };
}
