import type { BrowserWindowConstructorOptions } from 'electron';
import {
  resolveDesktopChrome,
  type DesktopChromeInsets,
  type DesktopPlatform,
} from '../../shared/platform-host.ts';
import type { WindowBounds } from './window-state.ts';

export { resolveDesktopChrome, type DesktopChromeInsets, type DesktopPlatform };

export const DEFAULT_MAIN_WINDOW_BOUNDS = {
  width: 1440,
  height: 920,
  minWidth: 480,
  minHeight: 480,
} as const;

export function normalizeDesktopPlatform(
  raw: NodeJS.Platform = process.platform,
): DesktopPlatform {
  if (raw === 'darwin' || raw === 'win32') return raw;
  return 'linux';
}

export function getWindowsTitleBarOverlay(theme: 'light' | 'dark' = 'dark') {
  if (theme === 'light') {
    return {
      color: '#f8f8f6',
      symbolColor: '#1b1d20',
      height: 46,
    };
  }
  return {
    color: '#141517',
    symbolColor: '#e6e8ec',
    height: 46,
  };
}

export function getDesktopWindowBackgroundColor(theme: 'light' | 'dark' = 'dark'): string {
  return theme === 'light' ? '#f8f8f6' : '#141517';
}

export function buildMainWindowOptions(input: {
  platform?: DesktopPlatform;
  theme?: 'light' | 'dark';
  linuxCustomTitleBar?: boolean;
  preloadPath: string;
  iconPath?: string;
  bounds?: Partial<WindowBounds>;
  partition?: string;
  title?: string;
}): BrowserWindowConstructorOptions {
  const platform = input.platform ?? normalizeDesktopPlatform();
  const theme = input.theme ?? 'dark';
  const chrome = resolveDesktopChrome({
    platform,
    linuxCustomTitleBar: input.linuxCustomTitleBar,
  });

  const width =
    typeof input.bounds?.width === 'number' && Number.isFinite(input.bounds.width)
      ? Math.max(DEFAULT_MAIN_WINDOW_BOUNDS.minWidth, Math.round(input.bounds.width))
      : DEFAULT_MAIN_WINDOW_BOUNDS.width;
  const height =
    typeof input.bounds?.height === 'number' && Number.isFinite(input.bounds.height)
      ? Math.max(DEFAULT_MAIN_WINDOW_BOUNDS.minHeight, Math.round(input.bounds.height))
      : DEFAULT_MAIN_WINDOW_BOUNDS.height;

  const base: BrowserWindowConstructorOptions = {
    width,
    height,
    ...(typeof input.bounds?.x === 'number' && Number.isFinite(input.bounds.x)
      ? { x: Math.round(input.bounds.x) }
      : {}),
    ...(typeof input.bounds?.y === 'number' && Number.isFinite(input.bounds.y)
      ? { y: Math.round(input.bounds.y) }
      : {}),
    minWidth: DEFAULT_MAIN_WINDOW_BOUNDS.minWidth,
    minHeight: DEFAULT_MAIN_WINDOW_BOUNDS.minHeight,
    show: false,
    title: input.title || 'OpenDesign',
    backgroundColor: getDesktopWindowBackgroundColor(theme),
    ...(input.iconPath ? { icon: input.iconPath } : {}),
    webPreferences: {
      preload: input.preloadPath,
      ...(input.partition ? { partition: input.partition } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: 'bypassHeatCheck',
      backgroundThrottling: true,
    },
  };

  if (chrome.platform === 'darwin') {
    return {
      ...base,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 17 },
      roundedCorners: true,
    };
  }

  if (chrome.platform === 'win32') {
    return {
      ...base,
      titleBarStyle: 'hidden',
      titleBarOverlay: getWindowsTitleBarOverlay(theme),
    };
  }

  return {
    ...base,
    frame: !chrome.customWindowControls,
  };
}

/**
 * Generates shell-injected CSS that enforces safe traffic-light / caption-overlay
 * insets and drag regions before first paint. Works identically on legacy cloud
 * Studio builds (that do not yet bind `__OPENMOTION_HOST__`), current Studio
 * builds (zero FOUC), promo banners, and non-Studio fallback pages.
 */
export function buildDesktopChromeCss(chrome: DesktopChromeInsets): string {
  if (chrome.titleBarStyle === 'native') {
    return '';
  }

  const insetLeft = Math.max(0, Math.round(chrome.insetLeft));
  const insetRight = Math.max(0, Math.round(chrome.insetRight));
  const titleBarHeight = Math.max(0, Math.round(chrome.titleBarHeight));
  const safeTop = Math.max(
    0,
    Math.round(
      typeof chrome.safeTop === 'number'
        ? chrome.safeTop
        : !chrome.fullscreen && (insetLeft > 0 || insetRight > 0 || chrome.customWindowControls)
          ? titleBarHeight
          : 0,
    ),
  );
  const hasOverlayControls = safeTop > 0;

  const rules = [
    `:root {`,
    `  --om-desktop-inset-left: ${insetLeft}px;`,
    `  --om-desktop-inset-right: ${insetRight}px;`,
    `  --om-desktop-titlebar-height: ${titleBarHeight}px;`,
    `  --om-desktop-safe-top: ${safeTop}px;`,
    `}`,
    `html[data-motion-studio] .om-app-header {`,
    `  -webkit-app-region: drag;`,
    `  user-select: none;`,
    `  -webkit-user-select: none;`,
    `  min-height: ${titleBarHeight}px;`,
    `  height: ${titleBarHeight}px;`,
    `  padding-inline-start: calc(var(--motion-space-8, 8px) + ${insetLeft}px);`,
    `  padding-inline-end: calc(var(--motion-space-8, 8px) + ${insetRight}px);`,
    `}`,
    `html[data-motion-studio] .om-app-header :is(button, a, input, select, [role="button"], [role="menuitem"], .om-nav-item, .om-app-header-actions, .om-desktop-window-controls) {`,
    `  -webkit-app-region: no-drag;`,
    `}`,
    `html[data-motion-studio] .om-app-header :is(a, button, img, svg) {`,
    `  -webkit-user-drag: none;`,
    `}`,
    `html[data-motion-studio] .om-app-header :is(input, textarea, [contenteditable="true"]) {`,
    `  user-select: text;`,
    `  -webkit-user-select: text;`,
    `}`,
    `html[data-om-resizing="true"],`,
    `html[data-om-resizing="true"] *,`,
    `html[data-om-resizing="true"] *::before,`,
    `html[data-om-resizing="true"] *::after {`,
    `  transition-duration: 0s !important;`,
    `  scroll-behavior: auto !important;`,
    `}`,
    `html[data-om-resizing="true"] body {`,
    `  pointer-events: none !important;`,
    `}`,
  ];

  if (hasOverlayControls) {
    rules.push(
      `html[data-motion-studio] .om-application {`,
      `  display: flex;`,
      `  flex-direction: column;`,
      `}`,
      `html[data-motion-studio] .om-application > .om-app-header {`,
      `  flex: 0 0 ${titleBarHeight}px;`,
      `  order: 0;`,
      `}`,
      `html[data-motion-studio] .om-application > :not(.om-app-header):not(.motion-workspace) {`,
      `  flex: 0 0 auto;`,
      `  order: 1;`,
      `}`,
      `html[data-motion-studio] .om-application > .motion-workspace {`,
      `  flex: 1 1 0;`,
      `  min-height: 0;`,
      `  order: 2;`,
      `}`,
      `html[data-motion-studio] :is(.om-gallery-surface:not([data-workspace-gallery]), .om-media-detail-surface, .om-design-tpl-detail-popup, .om-game-project, .om-gen-lightbox) {`,
      `  top: ${safeTop}px;`,
      `  height: calc(100dvh - ${safeTop}px);`,
      `}`,
      `html[data-motion-studio] :is(.motion-sidebar-drawer, .motion-sidebar-backdrop) {`,
      `  top: ${safeTop}px;`,
      `}`,
      `html[data-motion-studio] :is(.om-settings-dialog, .om-design-dialog-popup, .om-scenario-history-dialog, .om-scenario-preview-dialog, .om-scenario-picker-dialog) {`,
      `  top: calc(50% + ${safeTop}px / 2);`,
      `  max-height: calc(100dvh - ${safeTop}px - 32px);`,
      `}`,
      `@media (max-width: 860px) {`,
      `  html[data-motion-studio] .om-app-header {`,
      `    gap: var(--motion-space-8, 8px);`,
      `  }`,
      `  html[data-motion-studio] .om-app-header .om-creative-strip {`,
      `    justify-content: flex-start;`,
      `  }`,
      `  html[data-motion-studio] .om-app-header-links {`,
      `    display: none;`,
      `  }`,
      `  html[data-motion-studio] .om-app-header-actions {`,
      `    gap: var(--motion-space-4, 4px);`,
      `    margin-left: auto;`,
      `  }`,
      `}`,
      `@media (max-width: 620px) {`,
      `  html[data-motion-studio] .om-app-header {`,
      `    gap: var(--motion-space-4, 4px);`,
      `    padding-inline-start: calc(var(--motion-space-4, 4px) + ${insetLeft}px);`,
      `    padding-inline-end: calc(var(--motion-space-4, 4px) + ${insetRight}px);`,
      `  }`,
      `  html[data-motion-studio] .om-app-header .om-app-brand {`,
      `    padding-inline: var(--motion-space-4, 4px);`,
      `  }`,
      `  html[data-motion-studio] .om-app-header-actions {`,
      `    gap: var(--motion-space-2, 2px);`,
      `  }`,
      `}`,
      `html:not([data-motion-studio]) {`,
      `  -webkit-app-region: drag;`,
      `}`,
      `html:not([data-motion-studio]) body {`,
      `  box-sizing: border-box;`,
      `  padding-top: ${safeTop}px;`,
      `  min-height: 100dvh;`,
      `}`,
      `html:not([data-motion-studio]) body * {`,
      `  -webkit-app-region: no-drag;`,
      `}`,
    );
  }

  return rules.join('\n');
}
