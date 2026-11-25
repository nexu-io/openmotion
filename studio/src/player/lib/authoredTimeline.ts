import { isCompositionTemplate } from "@hyperframes/parsers/hf-ids";
import { buildProjectApiPath } from "../../utils/projectRouting";
import { getTimelineElementIdentity, parseTimelineFromDOM, readTimelineDurationFromDocument } from "./timelineDOM";

export function parseAuthoredTimeline(html: string, path: string, project: string | null, fallbackDuration = 0) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  try {
    return readAuthoredTimeline(doc, path, project, fallbackDuration);
  } finally {
    // Detach media so the browser releases its native playback callbacks and the temporary document.
    doc.replaceChildren();
  }
}

function readAuthoredTimeline(doc: Document, path: string, project: string | null, fallbackDuration: number) {
  for (const template of Array.from(doc.querySelectorAll("template")).filter(isCompositionTemplate)) template.replaceWith(template.content);
  const root = doc.querySelector("[data-composition-id]");
  if (!root) return null;
  root.setAttribute("data-composition-file", path);
  if (project && globalThis.location?.origin) {
    const base = new URL(buildProjectApiPath(project, `/preview/${path}`), location.origin);
    for (const media of doc.querySelectorAll("audio[src],video[src],img[src],source[src]")) {
      const src = media.getAttribute("src");
      if (!src) continue;
      try { media.setAttribute("src", new URL(src, base).href); }
      catch { return null; }
    }
  }
  const duration = readTimelineDurationFromDocument(doc) || fallbackDuration;
  const elements = parseTimelineFromDOM(doc, duration);
  const byKey = new Map(elements.map(element => [getTimelineElementIdentity(element), element]));
  // A dynamic/ambiguous source is left to the real runtime; never guess which duplicate a restore owns.
  return byKey.size === elements.length ? { elements, byKey, duration } : null;
}
