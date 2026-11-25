import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../shared/entry.ts';
import { resolveDesktopChrome } from '../shared/platform-host.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

type CssBlock = {
  selector: string;
  body: string;
  atContext: string[];
  line: number;
};

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
}

function parseCssRuleBlocks(rawSource: string): CssBlock[] {
  const source = stripCssComments(rawSource);
  const blocks: CssBlock[] = [];
  const stack: Array<{ kind: 'at' | 'rule'; header: string; startLine: number; bodyStart: number }> = [];
  let tokenStart = 0;
  let line = 1;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\n') {
      line += 1;
      continue;
    }
    if (ch === '{') {
      const header = source.slice(tokenStart, i).trim();
      const kind = header.startsWith('@') ? 'at' : 'rule';
      stack.push({ kind, header, startLine: line, bodyStart: i + 1 });
      tokenStart = i + 1;
    } else if (ch === '}') {
      const top = stack.pop();
      if (top && top.kind === 'rule') {
        const body = source.slice(top.bodyStart, i);
        const atContext = stack.filter(entry => entry.kind === 'at').map(entry => entry.header);
        blocks.push({ selector: top.header, body, atContext, line: top.startLine });
      }
      tokenStart = i + 1;
    } else if (ch === ';' && stack.every(entry => entry.kind === 'at')) {
      tokenStart = i + 1;
    }
  }
  return blocks;
}

async function listCssFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listCssFiles(rel)));
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      results.push(rel);
    }
  }
  return results;
}

function isExemptFixedSelector(selector: string, body: string): boolean {
  const lower = selector.toLowerCase();
  if (lower.includes('backdrop') || lower.includes('scrim') || lower.includes('toast')) {
    return true;
  }
  // Transparent pointer-through portal hosts (e.g., floating toast layers) do not paint over or block title bar controls.
  if (/\bpointer-events\s*:\s*none\b/.test(body) && /\bbackground\s*:\s*transparent\b/.test(body)) {
    return true;
  }
  // Dynamically positioned overlays/toolbars/popovers without hardcoded viewport-top anchoring.
  const anchorsViewportTop =
    /\binset\s*:\s*0(?:\s|;|$)/.test(body) ||
    /\binset\s*:\s*0\s+/.test(body) ||
    /\btop\s*:\s*0(?:px)?(?:\s|;|$)/.test(body) ||
    /\btop\s*:\s*50%/.test(body);
  return !anchorsViewportTop;
}

export async function checkLayout(): Promise<void> {
  // 1. Desktop chrome invariants: no Linux double-inset, fullscreen zero-insets, zoom DIP preservation.
  const macWin = resolveDesktopChrome({ platform: 'darwin', fullscreen: false });
  assert.equal(macWin.insetLeft, 78);
  assert.equal(macWin.insetRight, 0);
  assert.equal(macWin.safeTop, 46);

  const macFull = resolveDesktopChrome({ platform: 'darwin', fullscreen: true });
  assert.equal(macFull.insetLeft, 0);
  assert.equal(macFull.insetRight, 0);
  assert.equal(macFull.safeTop, 0);

  const winWin = resolveDesktopChrome({ platform: 'win32', fullscreen: false });
  assert.equal(winWin.insetLeft, 0);
  assert.equal(winWin.insetRight, 138);
  assert.equal(winWin.safeTop, 46);

  const winFull = resolveDesktopChrome({ platform: 'win32', fullscreen: true });
  assert.equal(winFull.insetRight, 0);
  assert.equal(winFull.safeTop, 0);

  const linuxCustom = resolveDesktopChrome({ platform: 'linux', linuxCustomTitleBar: true, fullscreen: false });
  assert.equal(linuxCustom.customWindowControls, true);
  assert.equal(
    linuxCustom.insetRight,
    0,
    'Linux custom window controls render in-flow inside .om-app-header and must keep insetRight=0 to prevent double inset.',
  );
  assert.equal(linuxCustom.safeTop, 46);

  for (const zoomFactor of [0.75, 1, 1.5]) {
    const macZoom = resolveDesktopChrome({ platform: 'darwin', fullscreen: false, zoomFactor });
    assert.ok(
      macZoom.insetLeft * zoomFactor >= 78,
      `macOS traffic-light clearance must hold at zoomFactor=${zoomFactor}`,
    );
    assert.ok(
      macZoom.titleBarHeight * zoomFactor >= 46,
      `macOS title bar height must stay >= 46 DIP at zoomFactor=${zoomFactor}`,
    );
    const winZoom = resolveDesktopChrome({ platform: 'win32', fullscreen: false, zoomFactor });
    assert.ok(
      winZoom.insetRight * zoomFactor >= 138,
      `Windows titleBarOverlay clearance must hold at zoomFactor=${zoomFactor}`,
    );
    assert.ok(
      winZoom.titleBarHeight * zoomFactor >= 46,
      `Windows title bar height must stay >= 46 DIP at zoomFactor=${zoomFactor}`,
    );
  }

  // 2. Shared safe-area CSS custom properties must live in packages/design-system/base.css.
  const baseCss = await readFile(path.join(root, 'packages/design-system/base.css'), 'utf8');
  for (const token of [
    '--om-desktop-inset-left',
    '--om-desktop-inset-right',
    '--om-desktop-safe-top',
    '--om-desktop-titlebar-height',
  ]) {
    assert.ok(
      baseCss.includes(token),
      `packages/design-system/base.css must declare default ${token} for cross-surface layout safety.`,
    );
  }

  // 3. .om-application must remain a flex column (never a fixed-row CSS Grid that breaks on banners).
  const appCss = await readFile(path.join(root, 'studio/src/motion/application.css'), 'utf8');
  const appBlocks = parseCssRuleBlocks(appCss);
  for (const block of appBlocks) {
    if (/(?:^|[\s,])\.om-application(?:\[[^\]]*\])?(?:$|[\s,])/.test(block.selector)) {
      assert.doesNotMatch(
        block.body,
        /\bgrid-template-rows\s*:/,
        `studio/src/motion/application.css:${block.line}: .om-application must use flex-column instead of fixed grid-template-rows so optional banners (promo/auth) stack cleanly.`,
      );
    }
  }

  const desktopPlatformTs = await readFile(path.join(root, 'desktop/src/platform.ts'), 'utf8');
  assert.doesNotMatch(
    desktopPlatformTs,
    /grid-template-rows\s*:/,
    'desktop/src/platform.ts: shell chrome CSS must use flex-column stacking on .om-application rather than brittle grid-template-rows.',
  );

  // 4. Scan Studio & design-system CSS for layout architecture violations.
  const cssFiles = [
    ...(await listCssFiles('studio/src')),
    ...(await listCssFiles('packages/design-system/studio')),
  ];

  const violations: string[] = [];

  for (const relPath of cssFiles) {
    const css = await readFile(path.join(root, relPath), 'utf8');
    const blocks = parseCssRuleBlocks(css);
    for (const block of blocks) {
      // 4a. .om-app-header is itself a size container; @container rules cannot style .om-app-header directly.
      const insideContainerQuery = block.atContext.some(at => at.startsWith('@container'));
      if (insideContainerQuery && /\.om-app-header\s*(?:,|$)/.test(block.selector)) {
        violations.push(
          `${relPath}:${block.line}: "${block.selector}" targets .om-app-header directly inside @container (invalid self-container query; use @media instead).`,
        );
      }

      // 4b. Fixed viewport overlays / centered modals must respect --om-desktop-safe-top and avoid raw vh units.
      if (!/\bposition\s*:\s*fixed\b/.test(block.body)) continue;
      if (isExemptFixedSelector(block.selector, block.body)) continue;

      const usesSafeVar =
        block.body.includes('--om-desktop-safe-top') ||
        block.body.includes('--om-workspace-top') ||
        block.body.includes('--om-viewport-height');

      if (!usesSafeVar) {
        violations.push(
          `${relPath}:${block.line}: fixed surface "${block.selector}" anchors to top/center of viewport without var(--om-desktop-safe-top, 0px) or var(--om-workspace-top), risking collision with native macOS traffic lights / Windows titleBarOverlay.`,
        );
      }

      if (/\b\d+vh\b/.test(block.body)) {
        violations.push(
          `${relPath}:${block.line}: fixed surface "${block.selector}" uses raw vh instead of dvh (use 100dvh with --om-desktop-safe-top clearance).`,
        );
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `Layout contract violations found:\n${violations.map(v => `  - ${v}`).join('\n')}`,
  );
}

if (isMain(import.meta.url)) {
  await checkLayout();
  console.log('Desktop chrome, safe-area overlay, flex shell, and responsive layout checks passed.');
}
