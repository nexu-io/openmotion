// The player owns the markup and scripts from which a parked scene will mount.
// A DOM edit to the empty placeholder would be lost on the next seek.
export const PREVIEW_PARKED_SCENE = `
  let applyingSceneUpdate = null;
  function uniqueSceneHost(path) {
    const hosts = Array.from(document.querySelectorAll('[data-hf-scene][data-composition-file]'))
      .filter(el => el.getAttribute('data-composition-file') === path);
    return hosts.length === 1 ? hosts[0] : null;
  }

  // The runtime keeps the compiled HTML in a private cache and replaces the scene host
  // when parking or remounting it. Reapply only confirmed position deltas to a fresh host.
  const scenePlacements = new Map();
  let placementObserver;
  function forgetScenePlacement(path) {
    scenePlacements.delete(path);
    if (!scenePlacements.size) placementObserver?.disconnect();
  }
  function advanceScenePlacements(path, before, after) {
    const file = scenePlacements.get(path);
    if (!file) return;
    if (file.version === before) file.version = after;
    else forgetScenePlacement(path);
  }
  function restoreScenePlacements(records) {
    for (const record of records) for (const host of record.addedNodes) {
      if (host.nodeType !== 1 || host.hasAttribute('data-hf-parked-scene')) continue;
      const scene = host.getAttribute('data-hf-scene');
      if (!scene || !Array.from(record.removedNodes).some(old =>
        old.nodeType === 1 && old.hasAttribute('data-hf-parked-scene') && old.getAttribute('data-hf-scene') === scene)) continue;
      const paths = new Set([host, ...host.querySelectorAll('[data-composition-file],[data-composition-src]')]
        .map(el => el.getAttribute('data-composition-file') || el.getAttribute('data-composition-src')));
      for (const path of paths) {
        const file = scenePlacements.get(path);
        if (!file) continue;
        const pending = !sourceVersions[path] && pendingForSource(path)[0];
        if ((sourceVersions[path] || pending?.confirmedVersion || pending?.sha256) !== file.version) continue;
        for (const [selector, {tag, styles}] of file.targets) {
          const nodes = Array.from(host.querySelectorAll(selector)).filter(node =>
            node.localName === tag && sourceFileForElement(node) === path);
          if (nodes.length !== 1) continue;
          const node = nodes[0];
          for (const [name, [from, to]] of styles) {
            const style = node.style;
            if (style.getPropertyValue(name) !== from || (typeof style.getPropertyPriority === 'function' && style.getPropertyPriority(name))) continue;
            if (to) style.setProperty(name, to);
            else style.removeProperty(name);
          }
        }
      }
    }
  }
  function rememberScenePlacement(node, path, selector, change, version) {
    if (typeof window.__hfParkedSceneMarkup !== 'function' || !node.parentElement?.closest('[data-hf-scene]')) return;
    if (!scenePlacements.size) {
      placementObserver ??= new MutationObserver(restoreScenePlacements);
      for (const host of document.querySelectorAll('[data-hf-scene][data-composition-file]')) {
        if (host.parentElement && !host.parentElement.closest('[data-hf-scene]')) placementObserver.observe(host.parentElement, {childList:true});
      }
    }
    const file = scenePlacements.get(path) || {version, targets:new Map()};
    const target = file.targets.get(selector) || {tag:change.tag, styles:new Map()};
    for (const [name, from, to] of change.styles) {
      const first = target.styles.get(name)?.[0] ?? from;
      if (first === to) target.styles.delete(name);
      else target.styles.set(name, [first, to]);
    }
    if (target.styles.size) file.targets.set(selector, target);
    else file.targets.delete(selector);
    if (file.targets.size) scenePlacements.set(path, file);
    else forgetScenePlacement(path);
  }

  function sceneParts(doc) {
    return JSON.parse(doc.querySelector('meta[name="hf-scene-parts"]')?.getAttribute('content') || 'null');
  }

  function sameOtherEntries(before, after, changed) {
    return !!before && !!after && Object.keys(before).length === Object.keys(after).length &&
      Object.keys(before).every(key => Object.hasOwn(after, key) && (changed.has(key) || before[key] === after[key]));
  }

  async function refreshParkedScene(message) {
    const {expiresAt} = message;
    if (compositionPath !== 'index.html' || !styleDocumentId || message.documentId !== styleDocumentId ||
        !Number.isFinite(expiresAt) || expiresAt <= Date.now() || typeof window.__hfSwapScenes !== 'function') return false;
    const files = message.files ?? [[message.path, message.fileVersion]];
    if (!Array.isArray(files) || !files.length) return false;
    const targets = new Map(), scenes = new Set();
    for (const entry of files) {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [path, version] = entry;
      if (typeof path !== 'string' || typeof version !== 'string' || targets.has(path) ||
          !Object.hasOwn(sourceVersions, path) || !sourceVersions[path]) return false;
      const host = uniqueSceneHost(path), scene = host?.getAttribute('data-hf-scene');
      if (!scene || scenes.has(scene) || (message.parkedOnly && !host.hasAttribute('data-hf-parked-scene'))) return false;
      targets.set(path, {base:sourceVersions[path], host, version});
      scenes.add(scene);
    }
    const current = () => !drag && !pendingDrags.size && !inlineText && Date.now() < expiresAt &&
      Array.from(targets).every(([path, target]) => sourceVersions[path] === target.base && uniqueSceneHost(path) === target.host);
    if (!current()) return false;
    const signal = AbortSignal.timeout(Math.min(5000, expiresAt - Date.now()));
    const url = new URL(location.href);
    // One file needs just its fragment. A batch must compare and mount scenes from the same compilation.
    if (files.length === 1) url.searchParams.set('sceneFile', files[0][0]);
    const response = await fetch(url.href, { cache: 'no-cache', redirect: 'error', signal });
    if (!response.ok) return false;
    const html = await response.text();
    const next = new DOMParser().parseFromString(html, 'text/html');
    const bridges = next.querySelectorAll('script[data-openmotion-preview]');
    if (bridges.length !== 1) return false;
    const incoming = JSON.parse(bridges[0].getAttribute('data-openmotion-preview'));
    const versions = incoming?.sourceVersions;
    if (incoming?.projectId !== projectId || incoming.compositionPath !== compositionPath ||
        incoming.canRebindTiming !== settings.canRebindTiming || JSON.stringify(incoming.liveEdits) !== JSON.stringify(settings.liveEdits) ||
        JSON.stringify(incoming.htmlSources) !== JSON.stringify(settings.htmlSources) ||
        !sameOtherEntries(sourceVersions, versions, targets) ||
        !files.every(([path, version]) => sourceIdentity(versions[path]).fileVersion === version)) return false;
    const oldParts = sceneParts(document), newParts = sceneParts(next);
    if (!oldParts || !newParts || oldParts.shared !== newParts.shared ||
        !sameOtherEntries(oldParts.scenes, newParts.scenes, scenes) ||
        !Array.from(scenes).every(key => Object.hasOwn(oldParts.scenes, key)) || !current()) return false;
    if (applyingSceneUpdate) return false;
    const confirm = () => {
      if (!Array.from(targets).every(([path, target]) => sourceVersions[path] === target.base)) return false;
      for (const [path] of files) {
        forgetScenePlacement(path);
        confirmCanvasVersion(path, versions[path]);
      }
      return true;
    };
    if (!Array.from(scenes).some(key => newParts.scenes[key] !== oldParts.scenes[key])) return confirm();
    const update = {targets, versions, ready: null};
    applyingSceneUpdate = update;
    let expire;
    const expired = new Promise(resolve => { expire = () => resolve(false); });
    signal.addEventListener('abort', expire, { once: true });
    try {
      const swapped = Promise.resolve(window.__hfSwapScenes(html, signal)).then(() => !signal.aborted && confirm());
      update.ready = Promise.race([swapped, expired]).catch(() => false);
      return await update.ready;
    } finally {
      signal.removeEventListener('abort', expire);
      applyingSceneUpdate = null;
    }
  }
`;
