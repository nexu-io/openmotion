import { useEffect, useState } from "react";
import { isolatedPreviewOrigin } from "../player/lib/previewLease";
import { studioApiFetch } from "./studioApiFetch";

let cachedCloudMode: boolean | null = null;
let inflightDetection: Promise<boolean> | null = null;
const listeners = new Set<(cloud: boolean) => void>();

function notify(cloud: boolean): void {
  for (const listener of listeners) {
    try {
      listener(cloud);
    } catch {
      // Ignore subscriber errors.
    }
  }
}

/** Synchronous result of shell detection or the legacy config probe. */
export function getCachedCloudDisklessMode(): boolean {
  return cachedCloudMode ?? (typeof document !== "undefined" && Boolean(
    isolatedPreviewOrigin()
    || document.head.querySelector('meta[name="openmotion-runtime"][content="cloud-diskless"]')
    || (typeof window !== "undefined"
      && (window as { __OPENMOTION_OBSERVABILITY__?: { deploymentMode?: unknown } })
        .__OPENMOTION_OBSERVABILITY__?.deploymentMode === "cloud-container"),
  ));
}

/**
 * Resolve cloud-diskless mode synchronously when known, or await an already
 * in-flight startup config probe (from `warmCloudDisklessMode()`) without
 * initiating an unrequested fetch.
 */
export function resolvePendingCloudDisklessMode(): Promise<boolean> {
  if (cachedCloudMode !== null) return Promise.resolve(cachedCloudMode);
  if (getCachedCloudDisklessMode()) return Promise.resolve(true);
  if (inflightDetection) return inflightDetection;
  return Promise.resolve(false);
}

/** Explicitly mark cloud mode (used by tests or when a project response already confirmed cloud-diskless). */
export function setCachedCloudDisklessMode(value: boolean | null): void {
  cachedCloudMode = value;
  inflightDetection = null;
  if (value !== null) notify(value);
}

/** Prefer the cloud shell declaration. Older and native shells use the config probe. */
export function ensureCloudDisklessMode(): Promise<boolean> {
  if (cachedCloudMode !== null) return Promise.resolve(cachedCloudMode);
  if (getCachedCloudDisklessMode()) {
    setCachedCloudDisklessMode(true);
    return Promise.resolve(true);
  }
  if (inflightDetection) return inflightDetection;
  if (typeof window === "undefined" || typeof fetch !== "function") {
    cachedCloudMode = false;
    return Promise.resolve(false);
  }
  inflightDetection = studioApiFetch("/__hyperframes_config")
    .then(async (res) => {
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as { mode?: unknown; diskless?: unknown } | null;
      return Boolean(data && (data.mode === "cloud-diskless" || data.diskless === true));
    })
    .catch(() => false)
    .then((isCloud) => {
      cachedCloudMode = isCloud;
      inflightDetection = null;
      notify(isCloud);
      return isCloud;
    });
  return inflightDetection;
}

/** Kick off config detection lazily without blocking callers. */
export function warmCloudDisklessMode(): void {
  if (cachedCloudMode === null && !inflightDetection) {
    void ensureCloudDisklessMode();
  }
}

export function subscribeCloudDisklessMode(listener: (cloud: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook returning current cloud-diskless status synchronously from cache and updating if config confirms cloud. */
export function useCloudDisklessMode(): boolean {
  const [isCloud, setIsCloud] = useState<boolean>(() => getCachedCloudDisklessMode());
  useEffect(() => {
    if (cachedCloudMode !== null) {
      setIsCloud(cachedCloudMode);
    }
    return subscribeCloudDisklessMode((next) => setIsCloud(next));
  }, []);
  return isCloud;
}
