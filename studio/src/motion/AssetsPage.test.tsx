// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssetDraft } from './AssetComposer';
import { AssetsPage } from './AssetsPage';
import { assetRequest, uploadLibraryAsset } from './assetClient';
import { AssetUploadError } from './assetUploadError';
import type { LibraryAsset } from '../../../shared/asset-library';

vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string, values?: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key) => String(values?.[key] ?? match)), formatDate: () => 'Nov 15' }) }));
vi.mock('./WorkspaceFrame', () => ({ useWorkspaceChrome: () => ({ openModelSettings: vi.fn() }) }));
vi.mock('./ResizablePane', () => ({ ResizablePane: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('./AssetComposer', () => ({ AssetComposer: ({ onReference, draft }: { onReference: () => void; draft: AssetDraft }) => <><input aria-label="Creation draft" data-draft={JSON.stringify(draft)} /><button onClick={onReference}>References</button></> }));
vi.mock('./AssetTaskHistory', () => ({ AssetTaskMenu: () => null }));
vi.mock('./assetClient', () => ({ assetRequest: vi.fn(), uploadLibraryAsset: vi.fn() }));
vi.mock('./gatewayClient', () => ({ gatewayRequest: async () => ({ conversations: [] }) }));

function fixture(id: string): LibraryAsset {
  return { id, name: `Picture ${id}`, modality: 'image', createdAt: 1, updatedAt: 1, currentVersionId: `${id}-v1`, versions: [{ id: `${id}-v1`, createdAt: 1, source: 'upload', filename: `${id}.png`, mimeType: 'image/png', bytes: 1024, sha256: id, references: [] }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let root: Root, container: HTMLDivElement, records: Map<string, LibraryAsset>;
let pendingWrite: ReturnType<typeof deferred<void>> | undefined;
let pendingRead: ReturnType<typeof deferred<{ asset: LibraryAsset }>> | undefined;
let pendingList: ReturnType<typeof deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>> | undefined;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); pendingWrite = undefined; pendingRead = undefined; pendingList = undefined;
  records = new Map(['A', 'B'].map(id => [id, fixture(id)]));
  vi.mocked(assetRequest).mockImplementation(async args => {
    if (args.action === 'voice') return { voices: [] };
    if (args.action === 'jobs') return { jobs: [] };
    if (args.action === 'list') {
      if (pendingList) { const current = pendingList; pendingList = undefined; return current.promise; }
      const assets = [...records.values()].filter(asset => Boolean(asset.trashedAt) === Boolean(args.trash) && (!args.modality || asset.modality === args.modality));
      return { assets: structuredClone(assets), total: assets.length, nextOffset: null };
    }
    if (args.action === 'get') {
      if (pendingRead) { const current = pendingRead; pendingRead = undefined; return current.promise; }
      return { asset: structuredClone(records.get(String(args.assetId))!) };
    }
    if (args.action === 'update') {
      if (pendingWrite) { const current = pendingWrite; pendingWrite = undefined; await current.promise; }
      const asset = structuredClone(records.get(String(args.assetId))!);
      const changes = args.changes as { trashed?: boolean };
      if (changes.trashed) asset.trashedAt = 10;
      if (changes.trashed === false) delete asset.trashedAt;
      asset.updatedAt++;
      records.set(asset.id, asset);
      return { asset: structuredClone(asset) };
    }
    throw new Error(`Unexpected action ${args.action}`);
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function render(active = true) { await act(async () => root.render(<AssetsPage active={active} />)); await flush(); }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text || node.getAttribute('aria-label') === text)!;
async function click(text: string) { await act(async () => button(text).click()); await flush(); }
const previewName = () => container.querySelector('.om-asset-workspace-header strong')?.textContent;
const updates = () => vi.mocked(assetRequest).mock.calls.map(([args]) => args).filter(args => args.action === 'update');

async function uploadBatch(count: number) {
  const input = container.querySelector<HTMLInputElement>('input[type=file][multiple]')!;
  const files = Array.from({ length: count }, (_, i) => new File(['data'], `file-${i}.png`));
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); await flush();
}
it('summarizes four failures and one success once and displays the successful asset in the library', async () => {
  await render();
  vi.mocked(uploadLibraryAsset).mockRejectedValue(new AssetUploadError('rejected', 'size'))
    .mockImplementationOnce(async () => { const asset = fixture('uploaded'); records.set(asset.id, asset); return asset; });
  await uploadBatch(5);
  const notices = document.querySelectorAll('[role=alert], [role=status]');
  expect(notices).toHaveLength(1);
  expect(notices[0].textContent).toBe('Uploaded 1, not uploaded 4. Known issue: files exceed the size limit. Compress or replace those files.');
  expect(container.querySelector('[aria-label="Picture uploaded"]')).not.toBeNull();
  expect(vi.mocked(uploadLibraryAsset)).toHaveBeenCalledTimes(5);
  expect([...notices[0].querySelectorAll('button')].map(b => b.getAttribute('aria-label'))).toEqual(['Dismiss error']);
  await act(async () => vi.advanceTimersByTimeAsync(2999));
  expect(document.querySelector('[role=alert]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(161));
  expect(document.querySelector('[role=alert]')).toBeNull();
  expect(container.querySelector('[aria-label="Picture uploaded"]')).not.toBeNull();
});
it('combines only observed causes and keeps unknown results out of the failure count', async () => {
  await render();
  vi.mocked(uploadLibraryAsset).mockRejectedValueOnce(new AssetUploadError('rejected', 'unreadable'))
    .mockRejectedValueOnce(new AssetUploadError('rejected', 'unsupported'))
    .mockRejectedValueOnce(new AssetUploadError('unknown'));
  await uploadBatch(3);
  const text = document.querySelector('[role=alert]')?.textContent;
  expect(text).toBe('Uploaded 0, not uploaded 2, awaiting confirmation 1. Known issues: unreadable files and unsupported formats. Re-export, convert or replace those files. Check the asset library before uploading unconfirmed files again.');
  expect(text).not.toContain('oversized');
  expect(vi.mocked(uploadLibraryAsset)).toHaveBeenCalledTimes(3);
});
it('refreshes the library after an unconfirmed response without resubmitting or inventing success', async () => {
  await render();
  vi.mocked(uploadLibraryAsset).mockImplementationOnce(async () => { records.set('uncertain', fixture('uncertain')); throw new AssetUploadError('unknown'); });
  await uploadBatch(1);
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Uploaded 0, awaiting confirmation 1. Check the asset library before uploading unconfirmed files again.');
  expect(container.querySelector('[aria-label="Picture uncertain"]')).not.toBeNull();
  expect(vi.mocked(uploadLibraryAsset)).toHaveBeenCalledOnce();
});
it('shows one short success summary and no notice for an empty selection', async () => {
  await render(); vi.mocked(uploadLibraryAsset).mockResolvedValue(fixture('uploaded'));
  await uploadBatch(0); expect(document.querySelector('[role=status]')).toBeNull();
  await uploadBatch(2); expect(document.querySelector('[role=status]')?.textContent).toBe('Uploaded 2.');
  await act(async () => vi.advanceTimersByTimeAsync(3160));
  expect(document.querySelector('[role=status]')).toBeNull();
});
it('reports a definite rejection with no invented cause', async () => {
  await render(); vi.mocked(uploadLibraryAsset).mockRejectedValue(new AssetUploadError('rejected'));
  await uploadBatch(2);
  expect(document.querySelector('[role=alert]')?.textContent).toBe('Uploaded 0, not uploaded 2.');
});

it('switches between the narrow gallery and creator without remounting the draft or losing gallery state', async () => {
  await render(); await click('AI Create');
  const draft = container.querySelector<HTMLInputElement>('[aria-label="Creation draft"]')!;
  draft.value = 'Keep this draft';
  const gallery = container.querySelector<HTMLElement>('.om-assets-main')!;
  gallery.scrollTop = 240;
  const listCount = vi.mocked(assetRequest).mock.calls.filter(([args]) => args.action === 'list').length;
  const switcher = container.querySelector('.om-assets-view-switch')!;
  await act(async () => switcher.querySelectorAll('button')[0].click());
  expect(container.querySelector('.om-assets-page')?.getAttribute('data-mobile-view')).toBe('library');
  await act(async () => switcher.querySelectorAll('button')[1].click());
  expect(container.querySelector('.om-assets-page')?.getAttribute('data-mobile-view')).toBe('create');
  expect(container.querySelector('[aria-label="Creation draft"]')).toBe(draft);
  expect(draft.value).toBe('Keep this draft');
  expect(gallery.scrollTop).toBe(240);
  expect(vi.mocked(assetRequest).mock.calls.filter(([args]) => args.action === 'list')).toHaveLength(listCount);
});

it('keeps the existing combined filters and ordering when using the gallery toolbar and returning from preview', async () => {
  await render();
  const choose = async (menu: string, label: string) => {
    await click(menu);
    const option = [...document.querySelectorAll<HTMLElement>('[role=menuitemradio]')].find(node => node.textContent === label)!;
    expect(option).toBeDefined();
    await act(async () => option.click()); await flush();
  };
  const latestList = () => vi.mocked(assetRequest).mock.calls.map(([args]) => args).filter(args => args.action === 'list').at(-1);
  await click('Images');
  await choose('Source', 'Local upload');
  await choose('Sort', 'Name');
  const input = container.querySelector<HTMLInputElement>('input[type=search]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Picture'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(180); }); await flush();
  expect(latestList()).toMatchObject({ modality: 'image', source: 'upload', sort: 'name', query: 'Picture', trash: false });
  await click('Picture A'); await click('All assets');
  expect(button('Images').getAttribute('aria-current')).toBe('page');
  expect(button('Source').textContent).toBe('Local upload');
  expect(button('Sort').textContent).toBe('Name');
  expect(container.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe('Picture');
  await click('Clear filters');
  expect(latestList()).toMatchObject({ modality: 'image', sort: 'name', query: '', trash: false });
  expect(latestList()).not.toHaveProperty('source');
  await click('Trash');
  expect(latestList()).toMatchObject({ sort: 'name', trash: true });
  expect(latestList()).not.toHaveProperty('modality');
  await click('All');
  expect(latestList()).toMatchObject({ sort: 'name', trash: false });
  expect(latestList()).not.toHaveProperty('modality');
});

it('extracts a gallery video cover from the current immutable version using the editor frame timing', async () => {
  const asset = fixture('video');
  asset.modality = 'video';
  Object.assign(asset.versions[0], { filename: 'clip.mov', mimeType: 'video/quicktime', duration: 24 });
  records = new Map([[asset.id, asset]]);
  const createElement = document.createElement.bind(document), videos: HTMLVideoElement[] = [];
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options);
    if (tag === 'video') {
      videos.push(element as HTMLVideoElement);
      Object.defineProperties(element, { duration: { value: 24 }, videoWidth: { value: 640 }, videoHeight: { value: 360 } });
    }
    return element;
  }) as typeof document.createElement);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');

  await render();
  expect(videos).toHaveLength(1);
  expect(videos[0].getAttribute('src')).toBe('/motion-api/assets/video/versions/video-v1/file');
  await act(async () => videos[0].dispatchEvent(new Event('loadedmetadata')));
  expect(videos[0].currentTime).toBe(2);
  await act(async () => videos[0].dispatchEvent(new Event('seeked')));
  expect(drawImage).toHaveBeenCalledWith(videos[0], 0, 0);
  expect(container.querySelector('.om-asset-preview img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  expect(container.querySelector('.om-asset-preview')?.textContent).toContain('00:24');
  expect(videos[0].getAttribute('src')).toBe('');
});

function prepareGalleryVideos() {
  for (const asset of records.values()) {
    asset.modality = 'video';
    Object.assign(asset.versions[0], { filename: `${asset.id}.mp4`, mimeType: 'video/mp4', duration: 10 });
  }
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  return { pause, play };
}
async function hoverCard(name: string, pointerType = 'mouse') {
  await act(async () => button(name).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType })));
}
const hoverVideo = () => container.querySelector<HTMLVideoElement>('.om-asset-hover-video');

it('plays one silent gallery hover preview over the retained poster and preserves click-to-open', async () => {
  const { play, pause } = prepareGalleryVideos();
  await render();
  expect(hoverVideo()).toBeNull();
  expect(play).not.toHaveBeenCalled();
  const poster = button('Picture A').querySelector('[data-thumbnail-loading]');
  await hoverCard('Picture A');
  const first = hoverVideo()!;
  expect(first.src).toContain('/motion-api/assets/A/versions/A-v1/file');
  expect(first.muted).toBe(true);
  expect(first.loop).toBe(true);
  expect(first.hasAttribute('playsinline')).toBe(true);
  expect(first.controls).toBe(false);
  expect(first.style.visibility).toBe('hidden');
  await act(async () => first.dispatchEvent(new Event('playing')));
  expect(first.style.visibility).toBe('visible');
  expect(button('Picture A').querySelector('[data-thumbnail-loading]')).toBe(poster);
  await hoverCard('Picture B');
  expect(container.querySelectorAll('.om-asset-hover-video')).toHaveLength(1);
  expect(first.getAttribute('src')).toBeNull();
  expect(pause.mock.instances).toContain(first);
  const second = hoverVideo()!;
  await act(async () => button('Picture B').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })));
  expect(hoverVideo()).toBeNull();
  expect(second.getAttribute('src')).toBeNull();
  await hoverCard('Picture A');
  const clicked = hoverVideo()!;
  await click('Picture A');
  expect(previewName()).toBe('Picture A');
  expect(clicked.getAttribute('src')).toBeNull();
  expect(hoverVideo()).toBeNull();
  expect(container.querySelector('video[controls]')?.getAttribute('src')).toContain('/A/versions/A-v1/file');
  await hoverCard('Picture B');
  expect(hoverVideo()).toBeNull();
});

it('releases gallery hover media on scrolling, backgrounding and leaving the Assets surface', async () => {
  prepareGalleryVideos();
  await render();
  await hoverCard('Picture A');
  const scrolling = hoverVideo()!;
  await act(async () => container.querySelector('.om-assets-main')!.dispatchEvent(new Event('scroll')));
  expect(hoverVideo()).toBeNull();
  expect(scrolling.getAttribute('src')).toBeNull();
  await hoverCard('Picture A');
  const backgrounded = hoverVideo()!;
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(hoverVideo()).toBeNull();
  expect(backgrounded.getAttribute('src')).toBeNull();
  await hoverCard('Picture A');
  expect(hoverVideo()).toBeNull();
  hidden.mockReturnValue(false);
  await hoverCard('Picture A');
  const inactive = hoverVideo()!;
  await render(false);
  expect(hoverVideo()).toBeNull();
  expect(inactive.getAttribute('src')).toBeNull();
  await render(true);
  expect(hoverVideo()).toBeNull();
});

it('keeps gallery posters on touch, reduced motion and failed hover playback', async () => {
  const { play } = prepareGalleryVideos();
  await render();
  await hoverCard('Picture A', 'touch');
  expect(hoverVideo()).toBeNull();
  const preference = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  await hoverCard('Picture A');
  expect(hoverVideo()).toBeNull();
  preference.mockRestore();
  play.mockRejectedValueOnce(new Error('Playback unavailable'));
  await hoverCard('Picture A');
  expect(hoverVideo()?.getAttribute('src')).toBeNull();
  expect(hoverVideo()?.style.visibility).toBe('hidden');
  expect(button('Picture A').querySelector('[data-thumbnail-loading]')).not.toBeNull();
  await hoverCard('Picture B');
  const failed = hoverVideo()!;
  await act(async () => failed.dispatchEvent(new Event('playing')));
  await act(async () => failed.dispatchEvent(new Event('error')));
  expect(failed.getAttribute('src')).toBeNull();
  expect(failed.style.visibility).toBe('hidden');
  await hoverCard('Picture A');
  const stalled = hoverVideo()!;
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(stalled.getAttribute('src')).toBeNull();
  expect(stalled.style.visibility).toBe('hidden');
});

it('shows the complete card title on hover only while it overflows, including after resizing', async () => {
  const observers: ResizeObserverStub[] = [];
  class ResizeObserverStub {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  const name = 'A complete asset filename that needs more room.mp4';
  records.get('A')!.name = name;
  await render();
  const title = container.querySelector<HTMLElement>('.om-asset-tile-caption strong')!;
  let width = 400;
  Object.defineProperties(title, { clientWidth: { get: () => width }, scrollWidth: { get: () => 300 } });
  const observer = observers.find(item => item.targets.has(title))!;
  const resize = () => observer.callback([], observer as unknown as ResizeObserver);
  const hover = async () => {
    await act(async () => {
      title.parentElement!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, composed: true }));
      title.parentElement!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, composed: true }));
      title.parentElement!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
      await vi.advanceTimersByTimeAsync(250);
    });
  };
  await act(async () => resize()); await hover();
  expect(document.querySelector('[role=tooltip]')).toBeNull();
  await act(async () => { width = 120; resize(); }); await hover();
  expect(document.querySelector('[role=tooltip]')?.textContent).toBe(name);
  await act(async () => { width = 400; resize(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(document.querySelector('[role=tooltip]')).toBeNull();
  expect(title.hasAttribute('aria-describedby')).toBe(false);
});

it('removes only the selected asset, exits its preview and restores the exact asset with Undo', async () => {
  await render(); await click('Picture A'); await click('Move to trash');
  expect(previewName()).toBeUndefined();
  expect(container.querySelector('[aria-label="Picture A"]')).toBeNull();
  expect(container.querySelector('[aria-label="Picture B"]')).not.toBeNull();
  expect(container.textContent).toContain('1 assets');
  expect(document.querySelector('[role=status]')?.textContent).toContain('Asset removed');
  expect(updates()).toEqual([{ action: 'update', assetId: 'A', changes: { trashed: true } }]);
  await click('Picture B'); await click('Undo');
  expect(previewName()).toBe('Picture B');
  expect(records.get('A')?.trashedAt).toBeUndefined();
  expect(records.get('B')?.trashedAt).toBeUndefined();
  expect(container.querySelector('[aria-label="Picture A"]')).not.toBeNull();
  expect(container.textContent).toContain('2 assets');
  expect(updates()[1]).toEqual({ action: 'update', assetId: 'A', changes: { trashed: false } });
});

it('does not change a later selection when a pending trash write finishes and blocks duplicate writes', async () => {
  await render(); await click('Picture A');
  const write = deferred<void>(); pendingWrite = write;
  await click('Move to trash'); await click('Move to trash');
  expect(updates()).toHaveLength(1);
  await click('Picture B');
  expect(button('Move to trash').disabled).toBe(false);
  await act(async () => write.resolve()); await flush();
  expect(previewName()).toBe('Picture B');
  expect(container.querySelector('[aria-label="Picture A"]')).toBeNull();
  expect(records.get('B')?.trashedAt).toBeUndefined();
});

it('keeps the selected asset on failure and allows a failed Undo to be retried once', async () => {
  await render(); await click('Picture A');
  const failure = deferred<void>(); pendingWrite = failure;
  await click('Move to trash');
  await act(async () => failure.reject(new Error('Failed to fetch'))); await flush();
  expect(previewName()).toBe('Picture A'); expect(records.get('A')?.trashedAt).toBeUndefined();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Connection lost');
  await click('Move to trash');
  const restore = deferred<void>(); pendingWrite = restore;
  await click('Undo'); await click('Undo');
  expect(updates()).toHaveLength(3);
  await act(async () => restore.reject(new Error('Failed to fetch'))); await flush();
  expect(records.get('A')?.trashedAt).toBeDefined(); expect(button('Undo').disabled).toBe(false);
  await click('Undo'); expect(updates()).toHaveLength(4); expect(records.get('A')?.trashedAt).toBeUndefined();
});

it('ignores stale detail and filmstrip reads after a successful trash operation', async () => {
  await render(); await click('Picture A'); await render(false);
  const read = deferred<{ asset: LibraryAsset }>(); pendingRead = read;
  const list = deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>(); pendingList = list;
  await render(); await click('Move to trash');
  await act(async () => { read.resolve({ asset: fixture('A') }); list.resolve({ assets: [fixture('A'), fixture('B')], total: 2, nextOffset: null }); }); await flush();
  expect(previewName()).toBeUndefined();
  expect(container.querySelector('[aria-label="Picture A"]')).toBeNull();
  expect(container.querySelector('[aria-label="Picture B"]')).not.toBeNull();
  expect(container.textContent).toContain('1 assets');
});

it('reuses the loaded collection when entering and leaving preview, preserving filters and scroll', async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>('input[type=search]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Picture'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(180); }); await flush();
  const lists = () => vi.mocked(assetRequest).mock.calls.filter(([args]) => args.action === 'list');
  const before = lists().length;
  container.querySelector<HTMLElement>('.om-assets-main')!.scrollTop = 240;
  await click('Picture A');
  expect(container.querySelector('.om-asset-loading-card')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe('Picture');
  await click('Picture B'); await click('All assets');
  expect(container.querySelector('.om-asset-loading-card')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe('Picture');
  expect(container.querySelector<HTMLElement>('.om-assets-main')?.scrollTop).toBe(240);
  expect(lists()).toHaveLength(before);
});

it('keeps the settled gallery visible while switching asset tabs', async () => {
  await render();
  expect(container.querySelector('.om-asset-loading-card')).toBeNull();
  const list = deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>(); pendingList = list;
  await click('Images');
  expect(container.querySelector('.om-asset-loading-card')).toBeNull();
  expect(container.querySelector('[aria-label="Picture A"]')).not.toBeNull();
  expect(container.querySelector('.om-asset-results')?.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('.om-asset-results')?.hasAttribute('inert')).toBe(true);
  await act(async () => list.resolve({ assets: [fixture('A')], total: 1, nextOffset: null })); await flush();
  expect(container.querySelector('.om-asset-loading-card')).toBeNull();
  expect(container.querySelector('[aria-label="Picture A"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Picture B"]')).toBeNull();
  expect(container.querySelector('.om-asset-results')?.getAttribute('aria-busy')).toBe('false');
  expect(container.querySelector('.om-asset-results')?.hasAttribute('inert')).toBe(false);
});

it('shows skeletons on the first load but retains the empty state on later tab loads', async () => {
  const initial = deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>(); pendingList = initial;
  await render();
  expect(container.querySelectorAll('.om-asset-loading-card')).toHaveLength(6);
  expect(container.querySelector('.om-asset-welcome')).toBeNull();
  await act(async () => initial.resolve({ assets: [], total: 0, nextOffset: null })); await flush();
  const next = deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>(); pendingList = next;
  await click('Videos');
  expect(container.querySelector('.om-asset-loading-card')).toBeNull();
  expect(container.querySelector('.om-asset-welcome')).not.toBeNull();
  await act(async () => next.resolve({ assets: [], total: 0, nextOffset: null })); await flush();
  expect(container.querySelector('.om-asset-results')?.getAttribute('aria-busy')).toBe('false');
});

it('ignores an older tab response after a newer tab finishes loading', async () => {
  await render();
  const older = deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>(); pendingList = older;
  await click('Images');
  const newer = deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>(); pendingList = newer;
  await click('Videos');
  expect(container.querySelector('.om-asset-loading-card')).toBeNull();
  await act(async () => newer.resolve({ assets: [], total: 0, nextOffset: null })); await flush();
  await act(async () => older.resolve({ assets: [fixture('A')], total: 1, nextOffset: null })); await flush();
  expect(container.querySelector('[aria-label="Picture A"]')).toBeNull();
  expect(container.querySelector('.om-asset-welcome')).not.toBeNull();
  expect(container.querySelector('.om-asset-results')?.getAttribute('aria-busy')).toBe('false');
});

it('replaces retained results with a usable retry on failure and recovers', async () => {
  await render();
  const failure = deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>(); pendingList = failure;
  await click('Videos');
  await act(async () => failure.reject(new Error('offline'))); await flush();
  expect(container.textContent).toContain('Could not load assets');
  expect(container.querySelector('.om-asset-results')?.hasAttribute('inert')).toBe(false);
  expect(container.querySelector('.om-asset-results')?.getAttribute('aria-busy')).toBe('false');
  const retry = deferred<{ assets: LibraryAsset[]; total: number; nextOffset: null }>(); pendingList = retry;
  await click('Retry');
  expect(container.querySelector('.om-asset-loading-card')).toBeNull();
  expect(container.querySelector('.om-asset-results')?.getAttribute('aria-busy')).toBe('true');
  await act(async () => retry.resolve({ assets: [], total: 0, nextOffset: null })); await flush();
  expect(container.textContent).not.toContain('Could not load assets');
  expect(container.querySelector('.om-asset-welcome')).not.toBeNull();
  expect(container.querySelector('.om-asset-results')?.hasAttribute('inert')).toBe(false);
});

it('restores from Trash without switching the filmstrip into the active library', async () => {
  records.get('A')!.trashedAt = 10;
  await render(); await click('Trash'); await click('Picture A'); await click('Restore asset');
  expect(previewName()).toBeUndefined();
  expect(container.textContent).toContain('Trash is empty');
  expect(document.querySelector('[role=status]')?.textContent).toContain('Asset restored');
  await click('All');
  expect(container.querySelector('[aria-label="Picture A"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Picture B"]')).not.toBeNull();
});

it('keeps Undo accessible inside the reference modal and refreshes both asset browsers', async () => {
  await render(); await click('Picture A'); await click('Move to trash');
  await click('AI Create'); await click('References');
  expect(document.querySelector('[data-feedback-layer]')?.closest('[role=dialog]')).not.toBeNull();
  await click('Undo');
  expect(document.querySelector('[role=dialog] [aria-label="Picture A"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Picture A"]')).not.toBeNull();
  expect(container.querySelector('.om-assets-page')?.getAttribute('data-creating')).toBe('true');
});

it('places saved voices and file assets in one gallery without a separate voice shelf', async () => {
  const original = vi.mocked(assetRequest).getMockImplementation()!;
  vi.mocked(assetRequest).mockImplementation(async args => args.action === 'voice' ? { voices: [{ id: 'voice-a', name: 'Channel voice', provider: 'fishaudio', externalId: 'channel', kind: 'cloned', description: '', revision: 1, createdAt: 1, updatedAt: 1, access: 'unchecked', connection: 'required' }] } : original(args));
  await render();
  expect(container.querySelectorAll('.om-assets-main .om-asset-grid')).toHaveLength(1);
  expect(container.querySelectorAll('.om-assets-main .om-asset-tile')).toHaveLength(3);
  expect(container.querySelector('.om-assets-main .om-asset-results > p')?.textContent).toBe('3 assets');
  expect(container.textContent).not.toContain('Your voice, in every video');
  await click('Voices');
  expect(container.querySelectorAll('.om-assets-main .om-asset-tile')).toHaveLength(1);
  await click('Channel voice');
  expect(container.querySelector('.om-asset-workspace-header strong')?.textContent).toBe('Channel voice');
});

it('editing generated speech creates a new audio version without treating the audio as an image reference', async () => {
  const audio = fixture('A'); audio.modality = 'audio'; audio.name = 'Narration';
  Object.assign(audio.versions[0], { filename: 'narration.mp3', mimeType: 'audio/mpeg', prompt: 'A script', model: 'minimax-speech-cn:speech-2.8-hd', result: { voice: { voiceId: 'saved-voice', revision: 2, name: 'Narrator' } } });
  records.set('A', audio);
  await render(); await click('Narration'); await click('Edit as new version');
  const draft = JSON.parse(container.querySelector<HTMLInputElement>('[aria-label="Creation draft"]')!.dataset.draft!);
  expect(draft.references).toEqual([]); expect(draft.target.versionId).toBe('A-v1');
  expect(draft.voiceRef).toEqual({ voiceId: 'saved-voice', revision: 2 });
  expect(draft.model).toBe('minimax-speech-cn:speech-2.8-hd');
});
