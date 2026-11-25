import { MAX_LAYER_ROWS } from '../../../shared/preview-layer.ts';

/** Document-scoped handles distinguish repeated composition instances and never leave the frame as DOM nodes. */
export const PREVIEW_LAYERS = `
  const layerMediaKinds = { img: 'image', picture: 'image', video: 'video', audio: 'audio', svg: 'vector' };
  const layerHandles = new WeakMap(), layerElements = new Map();
  const layerDocumentId = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  let nextLayerId = 0, layerObserver = null, layerTimer = null, layerSubscription = null;

  function collectPreviewLayers(limit) {
    const root = document.querySelector('[data-composition-id]') || document.body;
    const rows = [];
    layerElements.clear();
    if (!root) return rows;

    // Skip runtime scaffolding; a wrapper without an author identity is transparent in the tree.
    function visit(element, parent, stampedAncestor) {
      if (rows.length >= limit || element.matches('script,style,template,link,meta,base,br,source,track')) return;
      let row = parent;
      const file = element.getAttribute('data-composition-file') || element.getAttribute('data-composition-src');
      const stamped = element.hasAttribute('data-hf-id');
      // Legacy HTML can have class-only layers. In stamped source, unmarked
      // descendants include animation-generated letters, clones and particles.
      const editableLayer = stamped || element.id || file || element.hasAttribute('data-hf-group') ||
        (!stampedAncestor && element.classList.length);
      if (element !== root && editableLayer) {
        const tag = element.localName;
        const group = element.getAttribute('data-hf-group');
        const ownText = element.children.length === 0 ? (element.textContent || '').trim() : '';
        const key = layerHandles.get(element) || layerDocumentId + ':' + (++nextLayerId);
        layerHandles.set(element, key);
        layerElements.set(key, element);
        row = { key, depth: parent ? parent.depth + 1 : 0, childCount: 0, isCompHost: Boolean(file),
          label: (group || file || element.id || ownText || element.classList.item(0) || tag).slice(0, 100),
          draggable: Boolean((stamped || element.id) && tag !== 'audio' && !element.closest('[data-timeline-locked]')),
          kind: layerMediaKinds[tag] || (group || file ? 'group' : ownText ? 'text' : 'shape'),
          z: Number.parseInt(getComputedStyle(element).zIndex, 10) || 0 };
        rows.push(row);
        if (parent) { parent.childCount++; if (parent.kind === 'shape') parent.kind = 'group'; }
      }
      for (let child = element.firstElementChild; child && rows.length < limit; child = child.nextElementSibling) {
        visit(child, row, !file && (stamped || stampedAncestor));
      }
    }
    visit(root, null, false);
    return rows;
  }

  function closeLayerTree() {
    layerObserver?.disconnect();
    clearTimeout(layerTimer);
    layerObserver = layerTimer = layerSubscription = null;
    layerElements.clear();
  }

  function previewLayerTree(message) {
    if (message.close) {
      if (message.subscription === layerSubscription) closeLayerTree();
      return;
    }
    closeLayerTree();
    layerSubscription = message.subscription;
    const limit = Math.max(1, Math.min(${MAX_LAYER_ROWS}, Math.trunc(message.limit) || ${MAX_LAYER_ROWS}));
    const sendRows = () => {
      layerTimer = null;
      post('layer-tree', { subscription: layerSubscription, rows: collectPreviewLayers(limit) });
    };
    const root = document.body;
    if (root) {
      layerObserver = new MutationObserver(() => {
        if (layerTimer === null) layerTimer = setTimeout(sendRows, 100);
      });
      // Animation style writes do not change structure. Source updates promote a fresh frame.
      layerObserver.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['id','class','data-hf-id','data-hf-group','data-composition-src','data-composition-file'] });
    }
    sendRows();
  }

  function reportLayerSelection(element, detail, additive = false) {
    const key = layerHandles.get(element);
    picked = element;
    post('select-element', { inspect: true, ...(additive === true && { additive: true }), layerKey: layerElements.has(key) ? key : undefined, subscription: layerSubscription, selection: detail });
  }

  function resolvePreviewLayer(message) {
    if (message.key) return message.subscription === layerSubscription && layerElements.get(message.key);
    const { x, y } = message;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    const element = document.elementFromPoint(x * innerWidth, y * innerHeight)?.closest('[id],[data-hf-id]');
    return element !== document.body && element !== document.documentElement ? element : null;
  }

  function previewLayerFamily(message) {
    const element = resolvePreviewLayer(message);
    if (!element?.isConnected || !element.parentElement || element.matches('html,body,[data-composition-id]:not([data-composition-src])') ||
        element.closest('[data-timeline-locked]')) return null;
    if (!message.key) reportLayerSelection(element,describe(element));
    const target = element.getBoundingClientRect();
    const siblings = Array.from(element.parentElement.children).filter(el => !el.matches('audio,script,style,link,meta,template,noscript'));
    if (siblings.length > ${MAX_LAYER_ROWS}) return null;
    return siblings.map((el, domIndex) => {
      const style = getComputedStyle(el), sourceFile = sourceFileForElement(el);
      const box = el.getBoundingClientRect();
      const overlaps = box.left < target.right && box.right > target.left && box.top < target.bottom && box.bottom > target.top;
      return {element: layerHandles.get(el) || '@' + domIndex, domIndex, selected: el === element,
        stepCandidate: overlaps && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01, zIndex: Number.parseInt(style.zIndex,10) || 0,
        makeRelative: style.position === 'static', locked: !!el.closest('[data-timeline-locked]'),
        sourceFile, ...sourceIdentity(sourceVersions[sourceFile]), elementId: el.id || undefined, hfId: el.getAttribute('data-hf-id') || undefined};
    });
  }

  function selectPreviewLayer(message) {
    const element = resolvePreviewLayer(message);
    if (!element?.isConnected) return false;
    reportLayerSelection(element, describe(element), message.additive);
    return true;
  }
`;
