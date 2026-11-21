import { useEffect, useState } from "react";
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

/** Synchronous cached value; returns `false` until `/__hyperframes_config` confirms `cloud-diskless`. */
export function getCachedCloudDisklessMode(): boolean {
  return cachedCloudMode === true;
}

/** Explicitly mark cloud mode (used by tests or when a project response already confirmed cloud-diskless). */
export function setCachedCloudDisklessMode(value: boolean | null): void {
  cachedCloudMode = value;
  inflightDetection = null;
  if (value !== null) notify(value);
}

/** Fetch `/__hyperframes_config` once and cache whether this Studio runs in `cloud-diskless` mode. */
export function ensureCloudDisklessMode(): Promise<boolean> {
  if (cachedCloudMode !== null) return Promise.resolve(cachedCloudMode);
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
