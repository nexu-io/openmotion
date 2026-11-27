import { needsPreparedSceneSwap } from '../../../shared/preview-scene-swap.ts';

// The player owns the markup and scripts from which a parked scene will mount.
// A DOM edit to the empty placeholder would be lost on the next seek.
export const PREVIEW_PARKED_SCENE = `
  const needsPreparedSceneSwap = ${needsPreparedSceneSwap.toString()};
  let applyingSceneUpdate = null;
  function uniqueSceneHost(path, root = document) {
    const hosts = Array.from(root.querySelectorAll('[data-hf-scene][data-composition-file]'))
      .filter(el => el.getAttribute('data-composition-file') === path);
    return hosts.length === 1 ? hosts[0] : null;
  }

  // The runtime keeps the compiled HTML in a private cache and replaces the scene host
  // when parking or remounting it. Reapply only confirmed geometry and literal captions to a fresh host.
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
  function applyRememberedPlacements(host, path) {
    const file = scenePlacements.get(path);
    if (!file) return;
    const pending = !sourceVersions[path] && pendingForSource(path)[0];
    if ((sourceVersions[path] || pending?.confirmedVersion || pending?.sha256) !== file.version) return;
    for (const [selector, {tag, styles, text, id}] of file.targets) {
      const nodes = Array.from(host.querySelectorAll(selector)).filter(node =>
        node.localName === tag && sourceFileForElement(node) === path);
      if (nodes.length !== 1) continue;
      if (text && (!id || nodes[0].id === id)) stageText(nodes[0], text, false)?.(true);
      for (const [name, [from, to]] of styles) {
        const style = nodes[0].style;
        if (style.getPropertyValue(name) !== from || (typeof style.getPropertyPriority === 'function' && style.getPropertyPriority(name))) continue;
        if (to) style.setProperty(name, to);
        else style.removeProperty(name);
      }
    }
  }
  // Validate a parked leaf against the player's own compiled markup and its accepted edits.
  function parkedPlacementSource(path) {
    const placeholder = uniqueSceneHost(path);
    if (!placeholder?.hasAttribute('data-hf-parked-scene')) return null;
    const host = window.__hfParkedSceneMarkup?.(placeholder);
    if (!host || host.isConnected || host.getAttribute('data-composition-file') !== path) return null;
    applyRememberedPlacements(host, path);
    return host;
  }
  function restoreScenePlacements(records) {
    for (const record of records) for (const host of record.addedNodes) {
      if (host.nodeType !== 1 || host.hasAttribute('data-hf-parked-scene')) continue;
      const scene = host.getAttribute('data-hf-scene');
      if (!scene || !Array.from(record.removedNodes).some(old =>
        old.nodeType === 1 && old.hasAttribute('data-hf-parked-scene') && old.getAttribute('data-hf-scene') === scene)) continue;
      const paths = new Set([host, ...host.querySelectorAll('[data-composition-file],[data-composition-src]')]
        .map(el => el.getAttribute('data-composition-file') || el.getAttribute('data-composition-src')));
      for (const path of paths) applyRememberedPlacements(host, path);
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
    for (const [name, from, to] of change.styles || []) {
      const first = target.styles.get(name)?.[0] ?? from;
      if (first === to) target.styles.delete(name);
      else target.styles.set(name, [first, to]);
    }
    if (change.text) {
      const first = target.text?.[0] ?? change.text[0], to = change.text[1];
      target.id = change.id;
      target.text = samePreviewText(first, to) ? undefined : [first, to];
    }
    if (target.styles.size || target.text) file.targets.set(selector, target);
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

  async function readSceneSnapshot(file, signal) {
    const url = new URL(location.href);
    url.searchParams.set('sceneFile', file);
    const response = await fetch(url.href, {cache:'no-cache', redirect:'error', signal});
    if (!response.ok) return null;
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const bridges = doc.querySelectorAll('script[data-openmotion-preview]');
    if (bridges.length !== 1) return null;
    const config = bridges[0].getAttribute('data-openmotion-preview');
    return { html, doc, config, settings: JSON.parse(config), parts: sceneParts(doc) };
  }

  // A separate receipt can arrive while its sibling's swap still owns the player.
  let sceneTail = Promise.resolve();
  // The compiled scene fingerprints do not change when a placement is painted in place.
  const appliedSceneVersions = new Map(Object.entries(sourceVersions));
  function refreshParkedScene(message) {
    const result = sceneTail.then(() => applySceneReceipt(message));
    sceneTail = result.catch(() => false);
    return result;
  }

  async function applySceneReceipt(message) {
    const {expiresAt} = message;
    if (compositionPath !== 'index.html' || !styleDocumentId || message.documentId !== styleDocumentId ||
        !Number.isFinite(expiresAt) || expiresAt <= Date.now() || typeof window.__hfSwapScenes !== 'function') return false;
    const files = message.files ?? [[message.path, message.fileVersion]];
    if (!Array.isArray(files) || !files.length) return false;
    const targets = new Map(), scenes = new Set();
    function addTarget(path, version) {
      if (typeof path !== 'string' || typeof version !== 'string' || targets.has(path) ||
          !Object.hasOwn(sourceVersions, path) || !sourceVersions[path]) return false;
      const host = uniqueSceneHost(path), scene = host?.getAttribute('data-hf-scene');
      if (!scene || scenes.has(scene) || (message.parkedOnly && !host.hasAttribute('data-hf-parked-scene'))) return false;
      targets.set(path, {base:sourceVersions[path], host, version, scene});
      scenes.add(scene);
      return true;
    }
    for (const entry of files) {
      if (!Array.isArray(entry) || entry.length !== 2 || !addTarget(entry[0], entry[1])) return false;
    }
    const current = () => !drag && !pendingDrags.size && !inlineText && Date.now() < expiresAt &&
      Array.from(targets).every(([path, target]) => sourceVersions[path] === target.base && uniqueSceneHost(path) === target.host);
    if (!current()) return false;
    if (files.every(([path, version]) => appliedSceneVersions.get(path) === sourceVersions[path] &&
        sourceIdentity(sourceVersions[path]).fileVersion === version)) return true;
    const signal = AbortSignal.timeout(Math.min(5000, expiresAt - Date.now()));
    const firstPath = files[0][0];
    const snapshot = await readSceneSnapshot(firstPath, signal);
    const incoming = snapshot?.settings, versions = incoming?.sourceVersions;
    if (incoming?.projectId !== projectId || incoming.compositionPath !== compositionPath ||
        incoming.canRebindTiming !== settings.canRebindTiming || JSON.stringify(incoming.liveEdits) !== JSON.stringify(settings.liveEdits) ||
        JSON.stringify(incoming.htmlSources) !== JSON.stringify(settings.htmlSources) ||
        JSON.stringify(incoming.independentSceneFiles) !== JSON.stringify(settings.independentSceneFiles) || !versions ||
        !files.every(([path, version]) => sourceIdentity(versions[path]).fileVersion === version)) return false;
    const oldParts = sceneParts(document), newParts = snapshot.parts;
    if (!oldParts || !newParts || oldParts.shared !== newParts.shared || !current()) return false;

    // A newer independent scene may already be in this compilation before its own SSE arrives.
    const siblings = Object.keys(versions).filter(path => !targets.has(path) && sourceVersions[path] !== versions[path]);
    for (const path of siblings) {
      if (path === compositionPath || typeof versions[path] !== 'string' ||
          !addTarget(path, sourceIdentity(versions[path]).fileVersion)) return false;
    }
    // A confirmed placement changes the mounted source, not the runtime's compiled
    // scene fingerprint. Bring its actual body into the swap; never exempt the hash.
    for (const [path, placement] of scenePlacements) {
      if (targets.has(path) || !settings.independentSceneFiles?.includes(path) ||
          placement.version !== versions[path] || placement.version !== sourceVersions[path]) continue;
      const scene = uniqueSceneHost(path)?.getAttribute('data-hf-scene');
      if (scene && newParts.scenes?.[scene] !== oldParts.scenes?.[scene] && !addTarget(path, sourceIdentity(versions[path]).fileVersion)) return false;
    }
    if (!sameOtherEntries(sourceVersions, versions, targets) || !sameOtherEntries(oldParts.scenes, newParts.scenes, scenes) ||
         !Array.from(scenes).every(key => Object.hasOwn(oldParts.scenes, key))) return false;
    if (targets.size > 1 && Array.from(targets.values()).some(t => t.host.parentElement?.closest('[data-hf-scene]'))) return false;
    const confirm = () => {
      if (!Array.from(targets).every(([path, target]) => sourceVersions[path] === target.base)) return false;
      for (const path of targets.keys()) {
        appliedSceneVersions.set(path, versions[path]);
        forgetScenePlacement(path);
        confirmCanvasVersion(path, versions[path]);
      }
      return true;
    };
    const changed = Array.from(targets).filter(([, target]) => oldParts.scenes[target.scene] !== newParts.scenes[target.scene]);
    // A swap skips equal fingerprints. If this live scene has drifted from its compilation,
    // only a verified inverse patch or a fresh document can restore it. Do not falsely ACK it.
    if (Array.from(targets).some(([path, target]) => oldParts.scenes[target.scene] === newParts.scenes[target.scene] &&
        appliedSceneVersions.get(path) !== target.base)) return false;
    if (!changed.length) return confirm();
    // A known visible restart needs a prepared player. Its first fragment and the live
    // scripts already establish that, so don't download the rest of a rejected batch.
    if (needsPreparedSceneSwap(document, snapshot.doc, oldParts.scenes, newParts.scenes)) return false;
    const fragments = await Promise.all(changed.map(([path]) => path === firstPath ? snapshot : readSceneSnapshot(path, signal)));
    const complete = snapshot.doc;
    for (const [i, [path, target]] of changed.entries()) {
      const fragment = fragments[i];
      // Never mix bodies from different compilations, even if the individual file version matches.
      if (!fragment || fragment.config !== snapshot.config || JSON.stringify(fragment.parts) !== JSON.stringify(newParts)) return false;
      const host = uniqueSceneHost(path, fragment.doc);
      if (host?.getAttribute('data-hf-scene') !== target.scene || host.parentElement !== fragment.doc.body) return false;
      if (path !== firstPath) for (const el of Array.from(fragment.doc.body.children)) {
        if (el.getAttribute('data-hf-scene') === target.scene) complete.body.append(complete.importNode(el, true));
      }
    }
    if (!current() || !sameOtherEntries(sourceVersions, versions, targets)) return false;
    // Visibility can change while reading siblings, and a sibling may introduce its first script.
    if (needsPreparedSceneSwap(document, complete, oldParts.scenes, newParts.scenes)) return false;
    const html = changed.length === 1 && changed[0][0] === firstPath ? snapshot.html : '<!doctype html>' + complete.documentElement.outerHTML;
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
