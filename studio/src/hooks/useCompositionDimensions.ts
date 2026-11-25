import { useEffect, useState, type RefObject } from "react";
import { usePreviewIframeStore } from "../player/store/previewIframeStore";
import { readPreviewCompositionSize } from "../utils/previewCompositionSize";
import type { CompositionDimensions } from "../components/renders/RenderQueue";
import { acceptStudioRuntimeMessage } from "../player/lib/runtimeProtocol";

function readCompositionSizeMessage(data: unknown): CompositionDimensions | null {
  if (!isStageSizeMessage(data)) return null;
  const message = data;
  if (!acceptStudioRuntimeMessage(message)) return null;
  return readPositiveDimensions(message.width, message.height);
}

function isStageSizeMessage(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object") return false;
  if (value === null) return false;
  const message = value as Record<string, unknown>;
  return message.source === "hf-preview" && message.type === "stage-size";
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readPositiveDimensions(width: unknown, height: unknown): CompositionDimensions | null {
  const parsedWidth = readPositiveNumber(width);
  const parsedHeight = readPositiveNumber(height);
  if (parsedWidth === null || parsedHeight === null) return null;
  return { width: parsedWidth, height: parsedHeight };
}

export function useCompositionDimensions(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const [compositionDimensions, setCompositionDimensions] = useState<CompositionDimensions | null>(
    null,
  );

  useEffect(() => {
    const update = (dimensions: CompositionDimensions | null) => {
      if (dimensions) setCompositionDimensions(prev =>
        prev?.width === dimensions.width && prev.height === dimensions.height ? prev : dimensions);
    };
    // A promoted frame may have sent its stage-size already. Read the current frame
    // at notification time so the long-lived listener never retains a former project.
    const readLiveSize = () => update(readPreviewCompositionSize(usePreviewIframeStore.getState().iframe));
    const handleMessage = (e: MessageEvent) => {
      if (!e.source || e.source !== iframeRef.current?.contentWindow) return;
      update(readCompositionSizeMessage(e.data));
    };
    const unsubscribe = usePreviewIframeStore.subscribe(readLiveSize);
    window.addEventListener("message", handleMessage);
    readLiveSize();
    return () => {
      unsubscribe();
      window.removeEventListener("message", handleMessage);
    };
  }, [iframeRef]);

  return compositionDimensions;
}
