// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GalleryTemplate } from '../../../shared/catalog';
import { I18nProvider } from '../i18n/I18n';
import { StudioTemplateShelf } from './StudioTemplateShelf';

const template = (id: string) => ({ id, title: id, description: '', tags: [] }) as unknown as GalleryTemplate;
const explore = { pages: [{ items: Array.from({ length: 8 }, (_, index) => template(`p0-${index}`)) }], loading: false, error: null as string | null, hasMore: true, retry: vi.fn(), loadMore: vi.fn() };

vi.mock('./ExploreTemplates', () => ({ useExploreTemplates: () => explore }));
vi.mock('./useTemplatePlayback', () => ({ useTemplatePlayback: () => new Set<string>() }));
vi.mock('./WorkspaceChromeContext', () => ({ useWorkspaceChrome: () => ({ openLibrary: vi.fn() }) }));

let host: HTMLDivElement, root: Root;
const observers: { callback: IntersectionObserverCallback; node?: Element }[] = [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class {
    entry: { callback: IntersectionObserverCallback; node?: Element };
    constructor(callback: IntersectionObserverCallback) { this.entry = { callback }; observers.push(this.entry); }
    observe(node: Element) { this.entry.node = node; }
    disconnect() {}
    unobserve() {}
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); observers.length = 0; });

const render = () => act(async () => root.render(<I18nProvider initialLocale="en"><StudioTemplateShelf studio="shorts" root={createRef()} active /></I18nProvider>));

test('studio templates request the next page when the shelf end scrolls into view, without a More button', async () => {
  await render();
  expect(host.textContent).not.toContain('More templates');
  const last = observers.at(-1)!;
  expect(last.node?.classList.contains('om-shelf-sentinel')).toBe(true);
  await act(async () => last.callback([{ isIntersecting: true, target: last.node! } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(explore.loadMore).toHaveBeenCalledTimes(1);
});

test('studio templates do not request another page while one is loading or after an error', async () => {
  explore.loadMore.mockClear();
  explore.loading = true;
  await render();
  expect(observers).toHaveLength(0);
  explore.loading = false; explore.error = 'failed';
  await render();
  expect(observers).toHaveLength(0);
  expect(host.textContent).toContain('Templates could not be loaded.');
  expect(explore.loadMore).not.toHaveBeenCalled();
});
