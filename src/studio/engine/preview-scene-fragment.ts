import { parseHTMLContent } from '@hyperframes/core/compiler';

/** The runtime swaps one scene, but compares the fingerprints of the entire compiled film first. */
export function previewSceneFragment(compiled: string, file: string): string | null {
  const doc = parseHTMLContent(compiled);
  const hosts = Array.from(doc.querySelectorAll('[data-hf-scene][data-composition-file]'))
    .filter(el => el.getAttribute('data-composition-file') === file);
  if (hosts.length !== 1) return null;
  const host = hosts[0]!;
  const scene = host.getAttribute('data-hf-scene');
  const manifest = doc.querySelector('meta[name="hf-scene-parts"]');
  const settings = doc.querySelector('script[data-openmotion-preview]')?.getAttribute('data-openmotion-preview');
  if (!scene || !manifest || !settings) return null;

  // A data-only copy of the bridge settings lets the recipient verify all source
  // versions. Only this scene's authored scripts belong in the swap payload.
  const config = doc.createElement('script');
  config.type = 'application/json';
  config.setAttribute('data-openmotion-preview', settings);
  const parts = Array.from(doc.querySelectorAll('[data-hf-scene],style[data-hf-scene-fonts]'))
    .filter(el => el.getAttribute('data-hf-scene') === scene || el.hasAttribute('data-hf-scene-fonts'))
    .filter(el => el === host || !host.contains(el));
  return `<!doctype html><html><head>${manifest.outerHTML}${config.outerHTML}</head><body>${parts.map(el => el.outerHTML).join('')}</body></html>`;
}
