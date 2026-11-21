import { useEffect, useState } from "react";

interface PreviewEntry {
  url: string;
  isObjectUrl: boolean;
}

const previews = new Map<string, PreviewEntry>();
const listeners = new Set<() => void>();

function previewKey(projectId: string, assetPath: string): string {
  return `${projectId}\0${assetPath.replace(/^\/+/, "")}`;
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors.
    }
  }
}

export function setLocalUploadPreview(
  projectId: string,
  assetPath: string,
  url: string,
  isObjectUrl = url.startsWith("blob:"),
): void {
  const key = previewKey(projectId, assetPath);
  const existing = previews.get(key);
  if (existing && existing.url !== url && existing.isObjectUrl) {
    try {
      URL.revokeObjectURL(existing.url);
    } catch {
      // Ignore revoke errors.
    }
  }
  previews.set(key, { url, isObjectUrl });
  notify();
}

export function getLocalUploadPreview(projectId: string, assetPath: string): string | null {
  return previews.get(previewKey(projectId, assetPath))?.url ?? null;
}

export function clearLocalUploadPreview(projectId: string, assetPath: string): void {
  const key = previewKey(projectId, assetPath);
  const existing = previews.get(key);
  if (!existing) return;
  previews.delete(key);
  if (existing.isObjectUrl) {
    try {
      URL.revokeObjectURL(existing.url);
    } catch {
      // Ignore revoke errors.
    }
  }
  notify();
}

export function useLocalUploadPreview(projectId: string, assetPath: string): string | null {
  const [url, setUrl] = useState<string | null>(() => getLocalUploadPreview(projectId, assetPath));
  useEffect(() => {
    setUrl(getLocalUploadPreview(projectId, assetPath));
    const onChange = () => setUrl(getLocalUploadPreview(projectId, assetPath));
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, [projectId, assetPath]);
  return url;
}

/**
 * Capture an instant zero-network local thumbnail from a browser `File` object right when
 * the user selects or drops media:
 * - Images: direct `URL.createObjectURL(file)` (instant 0ms)
 * - Videos: single-frame canvas JPEG (`<=320px` wide) with immediate blob URL revocation
 */
export async function captureLocalFilePreview(file: File): Promise<{ url: string; isObjectUrl: boolean } | null> {
  if (typeof window === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  const lower = file.name.toLowerCase();
  const isImage =
    file.type.startsWith("image/") || /\.(?:png|jpe?g|webp|gif|avif|svg)$/i.test(lower);
  if (isImage) {
    if (file.size <= 0 || file.size > 50 * 1024 * 1024) return null;
    return { url: URL.createObjectURL(file), isObjectUrl: true };
  }

  const isVideo = file.type.startsWith("video/") || /\.(?:mp4|mov|webm|m4v|mkv|avi)$/i.test(lower);
  if (!isVideo || typeof document === "undefined") return null;

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  return await new Promise<{ url: string; isObjectUrl: boolean } | null>((resolve) => {
    let settled = false;
    const finish = (result: { url: string; isObjectUrl: boolean } | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      video.src = "";
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Ignore revoke errors.
      }
      resolve(result);
    };

    const timer = window.setTimeout(() => finish(null), 1500);

    video.onloadedmetadata = () => {
      try {
        const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(0.25, video.duration * 0.1) : 0;
        if (target > 0) {
          video.currentTime = target;
        } else {
          video.currentTime = 0;
        }
      } catch {
        finish(null);
      }
    };

    video.onseeked = () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) {
          finish(null);
          return;
        }
        const scale = Math.min(320 / vw, 1);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(vw * scale));
        canvas.height = Math.max(1, Math.round(vh * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
        finish(dataUrl && dataUrl.startsWith("data:image/") ? { url: dataUrl, isObjectUrl: false } : null);
      } catch {
        finish(null);
      }
    };

    video.onerror = () => finish(null);
    video.src = objectUrl;
    video.load();
  });
}
