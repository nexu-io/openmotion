import type { PreviewChange } from './preview-timing.ts';

/** A move may extend the containing timeline. The bridge also checks that the duration target is its root. */
export function isLiveMediaMove(changes: PreviewChange[]): boolean {
  let audio = false;
  let root = false;
  if (!Array.isArray(changes) || !changes.length) return false;
  for (const change of changes) {
    if (!change || change.styles || change.text || !Array.isArray(change.attributes) || change.attributes.length !== 1) return false;
    const attr = change.attributes[0]?.[0];
    if (change.tag === 'audio' && attr === 'data-start') audio = true;
    else if (!root && change.compositionId && attr === 'data-duration') root = true;
    else return false;
  }
  return audio;
}

/** One audio window and, if content end changed, its containing root's duration. */
export function isLiveAudioTrim(changes: PreviewChange[]): boolean {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 2) return false;
  let audio = false;
  for (const c of changes) {
    if (!c || c.text || c.styles || c.group || c.insert || c.removeFromComposition || c.captureOriginalTranslate !== undefined ||
        !Array.isArray(c.attributes) || !c.attributes.every(a => Array.isArray(a) && a.length === 3)) return false;
    const duration = c.attributes.find(([name]) => name === 'data-duration');
    if (!duration || !(Number(duration[1]) > 0 && Number(duration[2]) > 0)) return false;
    if (c.tag !== 'audio') {
      if (!c.compositionId || c.attributes.length !== 1) return false;
      continue;
    }
    if (audio || c.compositionId) return false;
    audio = true;
    const names = new Set(c.attributes.map(([name]) => name));
    if (names.size !== c.attributes.length || (names.has('data-media-start') && names.has('data-playback-start')) ||
        c.attributes.some(([name]) => !['data-duration', 'data-start', 'data-media-start', 'data-playback-start'].includes(name))) return false;
  }
  return audio;
}
