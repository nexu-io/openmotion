// Embedded in the scoped preview, where the live composition ancestry is accessible.
export const PREVIEW_TIMELINE_MANIFEST = `
  function authoredTimelineClips(clips) {
    const candidates = new Map();
    for (const clip of clips) if (clip.id) candidates.set(clip.id, []);
    for (const node of document.querySelectorAll('[id],[data-hf-id],[data-composition-id]')) {
      const id = node.id || node.getAttribute('data-hf-id') || node.getAttribute('data-composition-id');
      candidates.get(id)?.push(node);
    }
    return clips.map(clip => {
      const possible = candidates.get(clip.id) || [];
      const matching = possible.filter(node => {
        if (clip.tagName && node.localName !== clip.tagName.toLowerCase()) return false;
        if (!Array.isArray(clip.compositionAncestors)) return true;
        let parent = node.parentElement?.closest('[data-composition-id]');
        for (let i = clip.compositionAncestors.length - 1; i >= 0; i--) {
          if (!parent || parent.getAttribute('data-composition-id') !== clip.compositionAncestors[i]) return false;
          parent = parent.parentElement?.closest('[data-composition-id]');
        }
        return !parent;
      });
      // Runtime labels and positions are not source identities. Ambiguous clips stay read-only.
      if (matching.length !== 1) return clip;
      const node = matching[0];
      const domId = node.id || undefined;
      const hfId = node.getAttribute('data-hf-id') || undefined;
      const sourceFile = sourceFileForElement(node);
      // The document knows its own project path even when its base version is unavailable.
      // Nested file markers still need to match a file that was included by the bundler.
      if ((!domId && !hfId) || (sourceFile !== compositionPath && !Object.hasOwn(sourceVersions, sourceFile))) return clip;
      // A composition's nested media belongs to its own timeline.
      const media = node.matches('audio,video,img,[data-composition-id],[data-composition-src],[data-composition-file]')
        ? node : node.querySelector('audio,video,img');
      const volume = Number.parseFloat(node.getAttribute('data-volume') ?? media?.getAttribute('data-volume'));
      const isExternalSubComp = node.matches('[data-composition-src],[data-composition-file]');
      const containsCanvas = !isExternalSubComp && (node.localName === 'canvas' || Boolean(node.querySelector('canvas')));
      return { ...clip, authored: { domId, hfId, sourceFile,
        hidden: node.hasAttribute('data-hidden'), timelineLocked: node.hasAttribute('data-timeline-locked'),
        muted: node.hasAttribute('muted') || !!media?.hasAttribute('muted'),
        hasAudioAttr: node.getAttribute('data-has-audio'), volume: Number.isFinite(volume) ? volume : undefined,
        ...(containsCanvas ? { containsCanvas: true } : {}) } };
    });
  }
`;
