// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { orderedEditFixture } from '../../tests/orderedEditFixture';
import { I18nProvider } from '../i18n/I18n';
import { PreviewCanvasMenu } from './PreviewCanvasMenu';

const state = vi.hoisted(() => ({
  project: '', path: 'index.html', blocked: false, frame: null as HTMLIFrameElement | null,
  record: vi.fn(), toast: vi.fn(), reload: vi.fn(),
}));
vi.mock('../contexts/StudioContext', () => ({ useStudioShellContext: () => ({
  projectId: state.project, activeCompPath: state.path, compositionDimensions: { width: 1920, height: 1080 },
  writeBlockedReason: state.blocked ? 'Blocked' : null, renderQueue: { isRendering: false },
  previewIframeRef: { current: state.frame }, recordEdit: state.record, reloadPreview: state.reload, showToast: state.toast,
}) }));
vi.mock('../player/store/previewIframeStore', async importOriginal => ({
  ...await importOriginal<typeof import('../player/store/previewIframeStore')>(), useLivePreviewIframe: () => state.frame,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const source = '<html><head><style>#main{width:1920px;height:1080px}</style></head><body><div id="main" data-composition-id="scene" data-width="1920" data-height="1080" data-duration="5"><h1>Title</h1></div></body></html>';
let root: Root, host: HTMLElement;
const render = () => act(async () => root.render(<I18nProvider initialLocale="en"><PreviewCanvasMenu /></I18nProvider>));
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="Aspect ratio"]')!;
async function choose(label: string) {
  await act(async () => trigger().click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role=menuitemradio]')].find(el => el.textContent === label)!.click());
}
beforeEach(() => {
  setCachedCloudDisklessMode(true);
  state.project = crypto.randomUUID(); state.path = 'index.html'; state.blocked = false;
  state.record.mockReset().mockResolvedValue(undefined); state.toast.mockReset(); state.reload.mockReset();
  host = document.createElement('hyperframes-player');
  document.body.append(host);
  state.frame = document.createElement('iframe');
  host.attachShadow({ mode: 'open' }).append(state.frame);
  state.frame.contentDocument!.write(source); state.frame.contentDocument!.close();
  const panel = document.createElement('main'); document.body.append(panel); root = createRoot(panel);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); setCachedCloudDisklessMode(null); });

it('paints ratio and fit immediately and retains every gesture while the first save is pending', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = orderedEditFixture(state.project, { 'index.html': source }, () => gate);
  await render(); await choose('9:16');
  expect(trigger().textContent).toBe('9:16');
  expect(host.getAttribute('height')).toBe('1920');
  expect(state.frame!.contentDocument!.querySelector('style[data-openmotion-framing-preview]')?.textContent).toContain('scale(');
  await vi.waitFor(() => expect(server.packets).toHaveLength(1));
  await choose('Crop'); await choose('1:1'); await choose('Letterbox');
  expect(trigger().textContent).toBe('1:1');
  expect(host.getAttribute('height')).toBe('1080');
  expect(server.packets).toHaveLength(1);
  expect(server.files['index.html']).toBe(source);
  await act(async () => { release(); await vi.waitFor(() => expect(state.record).toHaveBeenCalledTimes(4)); });
  expect(server.packets.map(ops => ops.length)).toEqual([1, 3]);
  const second = server.packets[1]!;
  expect(second[1]!.files[0]!.baseVersion).toEqual({ after: second[0]!.id });
  expect(second[2]!.files[0]!.baseVersion).toEqual({ after: second[1]!.id });
  const stored = new DOMParser().parseFromString(server.files['index.html']!, 'text/html').querySelector('[data-composition-id]')!;
  expect([stored.getAttribute('data-width'), stored.getAttribute('data-height'), stored.getAttribute('data-canvas-fit')]).toEqual(['1080','1080','contain']);
  expect(state.toast).toHaveBeenCalledWith('Canvas updated', 'info');
});

it('undoes the tentative frame on a rejected write, then accepts a fresh edit', async () => {
  let reject = true;
  const server = orderedEditFixture(state.project, { 'index.html': source }, () => reject
    ? Response.json({ committed: [], failed: { id: server.packets.at(-1)![0]!.id, path: 'index.html', status: 409, code: 'VERSION_CONFLICT', message: 'File changed before this edit' } })
    : undefined);
  await render(); await choose('9:16');
  await act(async () => { await vi.waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.any(String), 'error')); });
  expect(trigger().textContent).toBe('16:9');
  expect(host.getAttribute('width')).toBe('1920');
  expect(state.frame!.contentDocument!.querySelector('style[data-openmotion-framing-preview]')).toBeNull();
  reject = false; await choose('9:16');
  await act(async () => { await vi.waitFor(() => expect(state.record).toHaveBeenCalledOnce()); });
  expect(server.files['index.html']).toContain('data-canvas-fit="contain"');
});

it('keeps an in-flight write scoped to its original composition when the user switches scenes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = orderedEditFixture(state.project, { 'index.html': source, 'other.html': source }, () => gate);
  await render(); await choose('9:16');
  state.path = 'other.html'; await render();
  await act(async () => { release(); await vi.waitFor(() => expect(state.record).toHaveBeenCalledOnce()); });
  expect(server.files['other.html']).toBe(source);
  expect(server.packets[0]?.[0]?.files[0]?.path).toBe('index.html');
  expect(state.toast).not.toHaveBeenCalled();
  state.blocked = true; await render(); expect(trigger().disabled).toBe(true);
});
