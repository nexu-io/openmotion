import { preloadableComponent } from "../utils/preloadableComponent";
import { warmModule } from "../utils/chunkLoadRecovery";

export const { Component: TranscriptPanel, load: loadTranscript } = preloadableComponent(
  () => import("../motion/TranscriptPanel").then(m => ({ default: m.TranscriptPanel })),
);
export const { Component: RenderQueuePanel, load: loadRenderQueue } = preloadableComponent(
  () => import("./renders/RenderQueuePanel").then(m => ({ default: m.RenderQueuePanel })),
);

export function warmStudioPanel(id?: string) {
  switch (id) {
    case "transcript": return warmModule(loadTranscript);
    case "renders": return warmModule(loadRenderQueue);
  }
}
