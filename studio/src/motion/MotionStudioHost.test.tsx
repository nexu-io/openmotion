// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MotionEditorFrame, MotionStudioHost } from './MotionStudioHost';
import englishReadme from '../../../README.md?raw';
import chineseReadme from '../../../README.zh-CN.md?raw';
import discordLogo from './community-discord.svg';
import feishuLogo from '../../../packages/design-system/brand/community-feishu.svg';
import { GITHUB_REPOSITORY } from './githubRepository';
import { StudioHeader } from '../components/StudioHeader';
import { useMotionHistoryOperation } from './MotionHistoryState';
import { trackMotion } from './tracking';
import { AssetImportMenu } from './AssetLibraryImport';
import { readFileSync } from 'node:fs';
vi.mock('./assetClient', () => ({ assetRequest: vi.fn(async () => ({ assets: [], total: 0, nextOffset: null })) }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
vi.mock('./AccountSettings', () => ({ useAccountSummary: () => ({ account: null }) }));
vi.mock('./SettingsCenter', () => ({ SettingsCenter: () => <section data-testid="settings-center">Settings</section> }));

const state = vi.hoisted(() => ({
  connectionError: '',
  workspaceBusy: false,
  renderQueue: { isRendering: false, ffmpegMissing: false },
  writeBlockedReason: null as string | null,
  open: vi.fn(), export: vi.fn(), setTab: vi.fn(), setCollapsed: vi.fn(),
  undo: vi.fn(), redo: vi.fn(), create: vi.fn(), home: vi.fn(), rename: vi.fn(),
  showToast: vi.fn(), status: { projectId: 'demo', historyRestoreError: null as { requestId: string; message: string } | null },
}));
vi.mock('./githubRepository', async importOriginal => ({ ...await importOriginal<typeof import('./githubRepository')>(), readRepositoryStars: vi.fn(async () => 9796) }));
vi.mock('../contexts/StudioContext', () => ({ useStudioShellContext: () => ({
  projectId: 'demo', renderQueue: state.renderQueue, writeBlockedReason: state.writeBlockedReason, waitForPendingDomEditSaves: async () => {},
  showToast: state.showToast,
}), useStudioShellContextOptional: () => ({
  editHistory: { canUndo: true, canRedo: true }, handleUndo: state.undo, handleRedo: state.redo,
}) }));
vi.mock('../contexts/PanelLayoutContext', () => ({ usePanelLayoutContext: () => ({
  rightCollapsed: false, setRightCollapsed: state.setCollapsed, setRightPanelTab: state.setTab,
}) }));
vi.mock('../components/renders/RenderQueuePanel', () => ({ RenderQueuePanel: () => <div>Export settings and jobs</div> }));
vi.mock('../components/dock/Dock', () => ({ Dock: { WindowMenu: () => <button>Window</button>, Panel: () => null } }));
vi.mock('./diagnostics', () => ({ recordBrowserDiagnostic: vi.fn(), browserDiagnostics: () => [], nextDiagnosticRequest: () => 'fixture-request', diagnosticsActive: () => false }));
vi.mock('../utils/studioTelemetry', () => ({ trackStudioEvent: vi.fn() }));
vi.mock('./MotionHistoryPanel', () => ({ MotionHistoryPanel: () => <div>History versions</div> }));
vi.mock('./useWorkspace', () => ({ useWorkspace: () => ({
  status: state.status, projects: [{ id: 'demo', title: 'Demo' }, { id: 'second', title: 'Second' }],
  busy: state.workspaceBusy, error: state.connectionError, errorSource: 'connection', clearError: vi.fn(), open: state.open, openSession: state.open, startSession: state.create, create: state.create, home: state.home, rename: state.rename,
}) }));
vi.mock('./ConnectionDialog', () => ({ ConnectionDialog: ({ open, section, busy, onOpen }: { open: boolean; section: string; busy: boolean; onOpen: (id: string) => void }) =>
  open ? <div role="dialog" aria-label="MCP connections" data-section={section}>
    <button disabled={busy} onClick={() => onOpen('product-promo')}>Open Product Promo</button>
  </div> : null }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let layoutStyle: HTMLStyleElement | undefined;
const originalWidth = window.innerWidth;
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
  window.happyDOM.settings.enableIframePageLoading = false;
  vi.clearAllMocks();
  localStorage.clear();
  state.connectionError = '';
  state.workspaceBusy = false;
  state.renderQueue.isRendering = false;
  state.writeBlockedReason = null;
  state.status = { projectId: 'demo', historyRestoreError: null };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); layoutStyle?.remove(); layoutStyle = undefined; Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth }); history.replaceState(null, '', '/'); });
function HistoryOperationState({ busy }: { busy: boolean }) {
  const { setBusy } = useMotionHistoryOperation();
  React.useEffect(() => setBusy(busy), [busy, setBusy]);
  return null;
}
function render(historyBusy = false, children?: React.ReactNode) {
  act(() => root.render(<MotionStudioHost><HistoryOperationState busy={historyBusy} /><MotionEditorFrame><StudioHeader captureFrameHref="/frame.png" captureFrameFilename="frame.png"
    handleCaptureFrameClick={vi.fn()} refreshCaptureFrameTime={vi.fn()} inspectorButtonActive={false}
    inspectorPanelActive={false} onExport={state.export} />{children}</MotionEditorFrame></MotionStudioHost>));
}
function openSidebar() {
  act(() => container.querySelector<HTMLButtonElement>('.om-app-rail [aria-label="首页"]')!.click());
}
const templates = () => container.querySelector<HTMLButtonElement>('.om-app-rail [aria-label="模板库"]')!;
const button = (text: string) => [...container.querySelectorAll('button')].find(el => el.textContent === text)!;

it('shows a restore failure once in its own project through the shared toast', () => {
  const message = 'VERSION_NOT_RESTORABLE: Historical files are missing, unreadable or corrupt: assets/music.wav';
  state.status = { projectId: 'second', historyRestoreError: { requestId: 'failed-restore', message } };
  render();
  expect(state.showToast).not.toHaveBeenCalled();
  state.status = { ...state.status, projectId: 'demo' };
  render(); render();
  expect(state.showToast).toHaveBeenCalledExactlyOnceWith(message, 'error');
  state.status = { projectId: 'demo', historyRestoreError: { requestId: 'new-attempt', message } };
  render();
  expect(state.showToast).toHaveBeenCalledTimes(2);
  state.status = { projectId: 'demo', historyRestoreError: { requestId: 'failed-restore', message } };
  render();
  expect(state.showToast).toHaveBeenCalledTimes(2);
});

it('keeps project switching, templates, history actions and native export in the MVP', () => {
  render();
  const header = container.querySelector('.motion-studio-header')!;
  expect(header.querySelector('.motion-workspace-menu')).toBeNull();
  expect(header.querySelector<HTMLInputElement>('[aria-label="项目名称"]')?.value).toBe('Demo');
  expect(container.querySelectorAll('[aria-label="项目名称"]')).toHaveLength(1);
  expect(container.querySelector('.om-app-project-title > svg')).toBeNull();
  expect(container.querySelector('.om-app-header [aria-label="项目名称"]')).toBeNull();
  openSidebar();
  const project = [...document.querySelectorAll<HTMLButtonElement>('.motion-session')].find(button => button.textContent === "Second")!;
  expect(header.contains(project)).toBe(false);
  expect(document.querySelector('.motion-session[aria-current="page"]')?.textContent).toContain('Demo');
  expect(header.contains(button('导出'))).toBe(true);
  expect(header.querySelector('[aria-label="模板库"]')).toBeNull();
  expect(templates()).not.toBeNull();
  expect(header.querySelector('.motion-header-project input')).not.toBeNull();
  expect(header.querySelector('.motion-header-leading [role="status"]')?.textContent).toBe('自动保存已开启');
  expect(container.querySelector('.motion-workspace-topbar')).toBeNull();
  for (const text of ['预览', '布局', '历史', '连接 Agent', '新建会话', '首页']) expect(button(text)).toBeUndefined();
  expect(container.querySelector('.motion-save-state')).toBeNull();
  expect(container.querySelector('a[download]')).toBeNull();
  expect(container.querySelector('.om-app-brand [role=img]')?.getAttribute('aria-label')).toBe('OpenMotion');
  expect(container.querySelector('.om-app-brand .motion-brand-lockup--responsive')).not.toBeNull();
  expect(container.querySelector('.om-app-rail [aria-label="模型供应商"]')).not.toBeNull();
  expect(container.querySelector('.om-app-rail [aria-label="设置"]')).not.toBeNull();
  expect(container.querySelector('.om-app-rail [aria-label="编辑器"]')).toBeNull();
  expect(container.querySelector('.om-app-rail [aria-label="展开或收起项目列表"]')).toBeNull();
  expect(header.querySelector('[aria-label="语言"]')).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.click());
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="重做"]')!.click());
  expect(state.undo).toHaveBeenCalledOnce();
  expect(state.redo).toHaveBeenCalledOnce();
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="版本历史"]')!.click());
  expect(document.querySelector('[data-testid="history-popover"]')?.textContent).toContain('History versions');
  act(() => document.querySelector<HTMLButtonElement>('[data-testid="history-popover"] [aria-label="关闭"]')!.click());
  act(() => button('导出').click());
  expect(state.setTab).not.toHaveBeenCalled();
  expect(state.setCollapsed).not.toHaveBeenCalled();
  expect(state.export).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="export-dialog"]')?.textContent).toContain('Export settings and jobs');
  act(() => document.querySelector<HTMLButtonElement>('[data-testid="export-dialog"] [aria-label="关闭"]')!.click());
  act(() => project.click());
  expect(state.open).toHaveBeenCalledWith('projects', 'second');
  expect(trackMotion).toHaveBeenCalledWith('ui_click', expect.objectContaining({ page_name: 'studio', area: 'workspace', element: 'open_project' }));
  act(() => templates().click());
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(container.querySelector('[role="dialog"]')!.getAttribute('data-section')).toBe('templates');
  act(() => button('Open Product Promo').click());
  expect(state.create).toHaveBeenCalledWith(undefined, 'product-promo');
});

it('keeps the project title visible without a generic status while the workspace is busy', () => {
  state.workspaceBusy = true;
  render();
  const input = container.querySelector<HTMLInputElement>('.motion-project-name-input')!;
  expect(input.value).toBe('Demo');
  expect(input.disabled).toBe(true);
  expect(container.querySelector('.motion-save-state')).toBeNull();
});

it('prevents project replacement during a native render', () => {
  state.renderQueue.isRendering = true;
  render();
  openSidebar();
  expect(document.querySelector<HTMLButtonElement>('.motion-session')!.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="新建项目"]')!.disabled).toBe(true);
  expect(templates().disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="header-export"]')!.disabled).toBe(false);
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="header-export"]')!.click());
  expect(document.querySelector('[data-testid="export-dialog"]')?.textContent).toContain('Export settings and jobs');
  expect(state.export).not.toHaveBeenCalled();
  expect(container.textContent).toContain('正在渲染…');
});

it('prevents switching projects or issuing competing header undo while a version operation is running', () => {
  render(true);
  openSidebar();
  expect(document.querySelector<HTMLButtonElement>('.motion-session')!.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="新建项目"]')!.disabled).toBe(true);
  expect(templates().disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="撤销"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="重做"]')!.disabled).toBe(true);
  expect(container.textContent).toContain('正在处理版本…');
});

it('searches projects in an overlay and closes it without removing the header brand', () => {
  render();
  expect(document.querySelector('.motion-sidebar-drawer')).toBeNull();
  expect(container.querySelector('.om-app-brand [role=img]')?.getAttribute('aria-label')).toBe('OpenMotion');
  expect(container.querySelector('.om-app-header input')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('.motion-studio-header input')?.value).toBe('Demo');
  openSidebar();
  const drawer = document.querySelector('.motion-sidebar-drawer')!;
  expect(container.contains(drawer)).toBe(false);
  const search = drawer.querySelector<HTMLInputElement>('[aria-label="搜索项目"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Second'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(drawer.querySelectorAll('.motion-session')).toHaveLength(1);
  expect(drawer.querySelector('.motion-session')?.textContent).toContain('Second');
  expect(drawer.querySelector('.motion-byok-entry')).toBeNull();
  act(() => drawer.querySelector<HTMLButtonElement>('[aria-label="关闭项目列表"]')!.click());
  expect(drawer.hasAttribute('data-closed')).toBe(true);
  expect(container.querySelector('.om-app-brand [role=img]')).not.toBeNull();
});

it('collapses the full desktop navigation in embeds while preserving the editor and previous project-list state', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  history.replaceState(null, '', '/?embed=1');
  render();
  expect(document.querySelector('.motion-sidebar-drawer')).toBeNull();
  expect(container.querySelector('.motion-sidebar')).not.toBeNull();
  const editor = container.querySelector('.motion-studio-header');
  const sidebar = container.querySelector('.om-project-navigation')!;
  const search = sidebar.querySelector<HTMLInputElement>('[aria-label="搜索项目"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Second'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  const toggle = container.querySelector<HTMLButtonElement>('.om-app-sidebar-toggle')!;
  act(() => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('.om-app-rail')?.hasAttribute('inert')).toBe(true);
  expect(container.querySelector('.om-app-rail')?.getAttribute('aria-hidden')).toBe('true');
  expect(sidebar.hasAttribute('inert')).toBe(true);
  expect(sidebar.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('.om-project-navigation')).toBe(sidebar);
  expect(localStorage.getItem('motion.workspace.navigation.v1')).toBe('collapsed');
  expect(container.querySelector('.motion-studio-header')).toBe(editor);
  act(() => toggle.click());
  expect(container.querySelector('.om-app-rail')?.hasAttribute('inert')).toBe(false);
  expect(sidebar.hasAttribute('inert')).toBe(false);
  expect(sidebar.querySelector('[aria-label="搜索项目"]')).toBe(search);
  expect(search.value).toBe('Second');
  expect(sidebar.querySelectorAll('.motion-session')).toHaveLength(1);
  act(() => sidebar.querySelector<HTMLButtonElement>('[aria-label="关闭项目列表"]')!.click());
  act(() => { toggle.click(); });
  act(() => { toggle.click(); });
  expect(sidebar.hasAttribute('inert')).toBe(true);
  expect(sidebar.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('.motion-studio-header')).toBe(editor);
});

it.each([true, false])('preserves the desktop sidebar when opening and dismissing asset import (expanded=%s)', async expanded => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  layoutStyle = document.createElement('style');
  layoutStyle.textContent = [
    '../../../packages/design-system/studio/application.css', './application.css',
  ].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  document.head.append(layoutStyle);
  render(false, <AssetImportMenu projectId="demo" importing={false} onUpload={vi.fn()} onImported={vi.fn()} />);
  if (!expanded) openSidebar();
  const sidebar = container.querySelector('.om-project-navigation')!;
  const editor = container.querySelector('.motion-studio-header');
  const assertLayout = () => {
    expect(container.querySelector('.om-project-navigation')).toBe(sidebar);
    expect(getComputedStyle(sidebar).flexBasis).toBe(expanded ? '200px' : '0px');
    expect(getComputedStyle(sidebar).visibility).not.toBe(expanded ? 'hidden' : 'visible');
    expect(sidebar.hasAttribute('inert')).toBe(!expanded);
    expect(container.querySelector('.motion-studio-header')).toBe(editor);
  };
  assertLayout();
  for (const dismissal of ['close', 'escape']) {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="导入媒体"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('从资产库导入'))!.click());
    const dialog = document.querySelector<HTMLElement>('.om-settings-dialog')!;
    expect(dialog.textContent).toContain('从资产库导入');
    assertLayout();
    await act(async () => {
      if (dismissal === 'close') dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click();
      else dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.om-settings-dialog')).toBeNull();
    expect(sidebar.getAttribute('aria-hidden') === 'true').toBe(!expanded);
    assertLayout();
  }
});

it.each([[1440, '返回首页'], [800, '返回首页'], [1440, '关闭设置'], [800, '关闭设置']] as const)('returns home from settings without replacing the current editor at %ipx via %s', async (width, closeLabel) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  render();
  const editor = container.querySelector('.motion-studio-header');
  const home = container.querySelector<HTMLButtonElement>('.om-app-rail [aria-label="首页"]')!;
  const openSettings = () => container.querySelector<HTMLButtonElement>('.om-app-rail [aria-label="设置"]')!.click();
  await act(async () => openSettings());
  expect(container.querySelector('[data-testid="settings-center"]')).not.toBeNull();
  expect(container.querySelector('.motion-workspace-content')?.hasAttribute('hidden')).toBe(true);
  expect(home.getAttribute('aria-pressed')).toBe('false');
  act(() => container.querySelector<HTMLButtonElement>(`[aria-label="${closeLabel}"]`)!.click());
  expect(container.querySelector('[data-testid="settings-center"]')).toBeNull();
  expect(container.querySelector('.motion-studio-header')).toBe(editor);
  expect(container.querySelector('.motion-workspace-content')?.hasAttribute('hidden')).toBe(false);
  expect(home.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelectorAll('.om-app-rail [aria-pressed="true"]')).toHaveLength(1);
  if (width < 1000) {
    expect(document.querySelector('.motion-sidebar-drawer:not([data-closed])')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('.motion-sidebar-drawer [aria-label="关闭项目列表"]')!.click());
  } else {
    act(() => home.click());
    expect(container.querySelector('.om-project-navigation')?.hasAttribute('inert')).toBe(true);
  }
  await act(async () => openSettings());
  act(() => home.click());
  expect(container.querySelector('[data-testid="settings-center"]')).toBeNull();
  expect(container.querySelector('.motion-studio-header')).toBe(editor);
  expect(state.open).not.toHaveBeenCalled();
  expect(state.home).not.toHaveBeenCalled();
});

async function hoverHome(pointerType = 'mouse') {
  const home = container.querySelector<HTMLButtonElement>('.om-app-rail [aria-label="首页"]')!;
  act(() => {
    home.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }));
    home.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    home.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
  return home;
}

it.each(['pinned', 'drawer', 'hover'] as const)('keeps the %s project list open when clicking the current project', async surface => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: surface === 'drawer' ? 800 : 1440 });
  await act(async () => render());
  const editor = container.querySelector('.motion-studio-header');
  if (surface !== 'pinned') openSidebar();
  if (surface === 'hover') await hoverHome();
  const selector = surface === 'pinned' ? '.om-project-navigation' : surface === 'drawer' ? '.motion-sidebar-drawer' : '.om-project-flyout';
  const sidebar = document.querySelector<HTMLElement>(selector)!;
  act(() => sidebar.querySelector<HTMLButtonElement>('.motion-session[aria-current="page"]')!.click());
  expect(sidebar.hasAttribute('inert')).toBe(false);
  expect(sidebar.hasAttribute('data-closed')).toBe(false);
  expect(sidebar.hasAttribute('data-ending-style')).toBe(false);
  expect(state.open).not.toHaveBeenCalled();
  expect(container.querySelector('.motion-studio-header')).toBe(editor);
  act(() => [...sidebar.querySelectorAll<HTMLButtonElement>('.motion-session')].find(button => button.textContent === "Second")!.click());
  expect(state.open).toHaveBeenCalledExactlyOnceWith('projects', 'second');
});

it('toggles Home and previews the searchable project list without expanding navigation or replacing the editor', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  render();
  const editor = container.querySelector('.motion-studio-header');
  const sidebar = container.querySelector('.om-project-navigation')!;
  const home = container.querySelector<HTMLButtonElement>('.om-app-rail [aria-label="首页"]')!;
  expect(home.getAttribute('aria-expanded')).toBe('true');
  act(() => home.click());
  expect(sidebar.hasAttribute('inert')).toBe(true);
  expect(home.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('.om-project-flyout')).toBeNull();
  await hoverHome();
  const preview = document.querySelector('.om-project-flyout')!;
  expect(preview).not.toBeNull();
  expect(sidebar.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('.motion-studio-header')).toBe(editor);
  expect(preview.contains(document.activeElement)).toBe(false);
  const search = preview.querySelector<HTMLInputElement>('[aria-label="搜索项目"]')!;
  act(() => {
    search.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Second');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(preview.querySelectorAll('.motion-session')).toHaveLength(1);
  act(() => home.click());
  expect(document.querySelector('.om-project-flyout:not([data-ending-style])')).toBeNull();
  expect(sidebar.hasAttribute('inert')).toBe(false);
  expect(sidebar.querySelector<HTMLInputElement>('[aria-label="搜索项目"]')?.value).toBe('Second');
  expect(container.querySelector('.motion-studio-header')).toBe(editor);
  act(() => home.click());
  expect(sidebar.hasAttribute('inert')).toBe(true);
  expect(state.open).not.toHaveBeenCalled();
});

it('dismisses the hover preview with Escape and preserves project switching guards', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  state.workspaceBusy = true;
  render();
  openSidebar();
  await hoverHome();
  const preview = document.querySelector('.om-project-flyout')!;
  expect(preview.querySelector<HTMLButtonElement>('.motion-session')!.disabled).toBe(true);
  expect(preview.querySelector<HTMLButtonElement>('[aria-label="新建项目"]')!.disabled).toBe(true);
  act(() => preview.querySelector<HTMLInputElement>('input')!.focus());
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.querySelector('.om-project-flyout:not([data-ending-style])')).toBeNull();
  expect(container.querySelector('.om-project-navigation')?.hasAttribute('inert')).toBe(true);
});

it.each(['panel', 'search'])('dismisses pointer departure unless the %s focus is an interactive control', async focus => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  render();
  openSidebar();
  await hoverHome();
  const preview = document.querySelector<HTMLElement>('.om-project-flyout')!;
  const focused = focus === 'search' ? preview.querySelector<HTMLElement>('input')! : preview;
  act(() => {
    preview.parentElement!.dispatchEvent(new MouseEvent('mouseenter'));
    focused.focus();
    preview.parentElement!.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  expect(document.querySelector('.om-project-flyout:not([data-ending-style])') !== null).toBe(focus === 'search');
  if (focus === 'search') {
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.click();
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(document.querySelector('.om-project-flyout:not([data-ending-style])')).toBeNull();
  }
});

it('does not preview projects for touch pointers, mobile drawers or settings', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  render();
  openSidebar();
  await hoverHome('touch');
  expect(document.querySelector('.om-project-flyout')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('.om-app-rail [aria-label="设置"]')!.click());
  await hoverHome();
  expect(document.querySelector('.om-project-flyout')).toBeNull();
});

it('keeps Home click-operated on narrow layouts', async () => {
  render();
  await hoverHome();
  expect(document.querySelector('.om-project-flyout')).toBeNull();
  expect(document.querySelector('.motion-sidebar-drawer')).toBeNull();
  openSidebar();
  expect(document.querySelector('.motion-sidebar-drawer:not([data-closed])')).not.toBeNull();
});

it('saves empty project names as Untitled while Escape cancels edits', async () => {
  state.rename.mockResolvedValue(true);
  render();
  const edit = () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="项目名称"]')!;
    act(() => input.focus());
    return input;
  };
  const change = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  let input = edit();
  expect(container.querySelector('[aria-label="保存项目名称"]')).toBeNull();
  change(input, ' Updated project ');
  await act(async () => input.blur());
  expect(state.rename).toHaveBeenCalledExactlyOnceWith('demo', 'Updated project');
  expect(container.querySelector('[aria-label="项目名称"]')).toBe(input);
  expect(input.value).toBe('Demo');
  input = edit();
  change(input, '   ');
  await act(async () => input.blur());
  expect(state.rename).toHaveBeenLastCalledWith('demo', '未命名');
  expect(state.rename).toHaveBeenCalledTimes(2);
  input = edit();
  change(input, 'Discard this');
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(state.rename).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[aria-label="项目名称"]')).toBe(input);
  expect(input.value).toBe('Demo');
  input = edit();
  change(input, 'Enter saves');
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(state.rename).toHaveBeenLastCalledWith('demo', 'Enter saves');
  expect(state.rename).toHaveBeenCalledTimes(3);
  input = edit();
  change(input, '');
  expect(input.placeholder).toBe('未命名');
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(state.rename).toHaveBeenLastCalledWith('demo', '未命名');
  expect(state.rename).toHaveBeenCalledTimes(4);
  expect(document.activeElement).not.toBe(input);
  expect(container.querySelector('[aria-label="项目名称"]')).toBe(input);
});

it('dismissing a write-blocking notice does not enable project creation', () => {
  state.writeBlockedReason = 'Auto-save is paused. Check your connection.';
  render();
  const close = container.querySelector<HTMLButtonElement>('.motion-error-notice-close')!;
  expect(close).not.toBeNull();
  act(() => close.click());
  expect(container.querySelector('.motion-error-notice')).toBeNull();
  openSidebar();
  expect(document.querySelector<HTMLButtonElement>('.motion-session-heading button')?.disabled).toBe(true);
});


it.each(['zh-CN', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt-BR', 'it', 'tr'])('keeps community and repository links beside the model selector with a localized label (%s)', locale => {
  localStorage.setItem('motion.studio.locale', locale);
  render();
  const link = container.querySelector<HTMLAnchorElement>('.motion-community-link')!;
  const readme = locale === 'zh-CN' ? chineseReadme : englishReadme;
  const channel = locale === 'zh-CN' ? '飞书群' : 'Discord';
  expect(readme).toContain(`[${channel}](${link.href})`);
  expect(link.target).toBe('_blank');
  expect(link.rel).toContain('noopener');
  expect(container.querySelector<HTMLAnchorElement>(`a[href="${GITHUB_REPOSITORY}"]`)?.target).toBe('_blank');
  expect(link.querySelector('img')?.getAttribute('src')).toBe(locale === 'zh-CN' ? feishuLogo : discordLogo);
  expect(link.getAttribute('aria-label')).toContain(channel);
  expect(link.getAttribute('aria-label')).toContain('OpenMotion');
  expect(container.querySelector('.om-app-header')?.contains(link)).toBe(true);
  expect(container.querySelector('.om-app-header')?.contains(container.querySelector(`a[href="${GITHUB_REPOSITORY}"]`))).toBe(true);
  expect(container.querySelector('.om-app-header .om-model-switcher')).not.toBeNull();
  expect(container.querySelector('.motion-studio-header')?.contains(link)).toBe(false);
  const exportButton = container.querySelector('[data-testid="header-export"]')!;
  expect(link.compareDocumentPosition(exportButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});


it('shows connection failure as a one-line reconnecting toast and removes it on recovery', () => {
  state.connectionError = 'Failed to fetch /private/project';
  render();
  const toast = document.querySelector('[data-testid="motion-connection-toast"]')!;
  expect(toast.textContent).toContain('连接已断开');
  expect(toast.querySelector('.sr-only')?.textContent).toBe('重连中…');
  expect(toast.querySelector('[aria-hidden="true"]')?.textContent).toBe('重连中...');
  expect(toast.querySelectorAll('.hf-toast-progress-dots > span')).toHaveLength(3);
  expect(toast.querySelector('.truncate')).not.toBeNull();
  expect(container.querySelector('.motion-error-notice')).toBeNull();
  expect(toast.textContent).not.toMatch(/private|details|详情/);
  expect(toast.querySelector('button')).toBeNull();
  render();
  expect(document.querySelectorAll('[data-testid="motion-connection-toast"]')).toHaveLength(1);
  state.connectionError = '';
  state.workspaceBusy = false;
  render();
  expect(document.querySelector('[data-testid="motion-connection-toast"]')).toBeNull();
});
