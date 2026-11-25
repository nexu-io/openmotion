// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GalleryTemplate } from '../../../shared/catalog';
import { I18nProvider } from '../i18n/I18n';
import { MotionTemplateShelf } from './MotionTemplateShelf';
import { send } from './reporting';

const template = (id: string, brand?: string, uses = ['Product launch']) =>
  ({ id, title: id, description: '', tags: [], brand, uses, industries: [] }) as unknown as GalleryTemplate;
const catalog = [template('a1', 'Acme'), template('a2', 'Acme'), template('b1', 'Beta'), template('plain')];

vi.mock('./useCoveredTemplates', () => ({ useCoveredTemplates: () => ({ catalog, firstPage: null, failed: false, retry: vi.fn() }) }));
vi.mock('./useTemplatePlayback', () => ({ useTemplatePlayback: () => new Set<string>() }));
vi.mock('./WorkspaceChromeContext', () => ({ useWorkspaceChrome: () => ({ openLibrary: vi.fn(), workspace: { create: vi.fn() }, switchingDisabled: false }) }));
vi.mock('./reporting', () => ({ send: vi.fn(), optionId: (value: string) => ({ option_id: value }) }));
vi.mock('./exploreTracking', () => ({ reportCreativeClick: vi.fn() }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn() }));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

test('Motion templates offer a TOP 100 brands category with one work per brand', async () => {
  await act(async () => root.render(<I18nProvider initialLocale="en"><MotionTemplateShelf root={createRef()} active /></I18nProvider>));
  const pills = [...host.querySelectorAll<HTMLButtonElement>('.om-filter-pill')];
  expect(pills.map(pill => pill.getAttribute('aria-label')).slice(0, 2)).toEqual(['All', 'TOP 100 brands']);
  expect(host.textContent).toContain('4 templates');

  await act(async () => pills[1]!.click());
  expect(pills[1]!.getAttribute('aria-pressed')).toBe('true');
  expect(send).toHaveBeenCalledWith('ui_click', expect.objectContaining({ element: 'category_select', filter_group: 'brand', option_id: 'top-100-brands' }));
  expect(host.textContent).toContain('2 templates');
  const titles = [...host.querySelectorAll('.om-gallery-card:not([data-new-project]) h3, .om-gallery-card:not([data-new-project]) strong')].map(node => node.textContent);
  expect(titles.join(' ')).not.toContain('plain');
});

test('Motion templates load the next batch when the shelf end scrolls into view, without a More button', async () => {
  const many = Array.from({ length: 40 }, (_, index) => template(`t${index}`));
  catalog.splice(0, catalog.length, ...many);
  const observers: { callback: IntersectionObserverCallback; node?: Element }[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    entry: { callback: IntersectionObserverCallback; node?: Element };
    constructor(callback: IntersectionObserverCallback) { this.entry = { callback }; observers.push(this.entry); }
    observe(node: Element) { this.entry.node = node; }
    disconnect() {}
    unobserve() {}
  });
  const cards = () => host.querySelectorAll('.om-gallery-card:not([data-new-project])').length;
  await act(async () => root.render(<I18nProvider initialLocale="en"><MotionTemplateShelf root={createRef()} active /></I18nProvider>));
  expect(cards()).toBe(16);
  expect(host.textContent).not.toContain('More templates');
  const scrollToEnd = async () => {
    const last = observers.at(-1)!;
    await act(async () => last.callback([{ isIntersecting: true, target: last.node! } as IntersectionObserverEntry], {} as IntersectionObserver));
  };
  await scrollToEnd();
  expect(cards()).toBe(32);
  await scrollToEnd();
  expect(cards()).toBe(40);
  expect(host.querySelector('.om-shelf-sentinel')).toBeNull();
});

test('without IntersectionObserver the Motion shelf keeps a More button instead of rendering every template', async () => {
  catalog.splice(0, catalog.length, ...Array.from({ length: 40 }, (_, index) => template(`n${index}`)));
  vi.stubGlobal('IntersectionObserver', undefined);
  const cards = () => host.querySelectorAll('.om-gallery-card:not([data-new-project])').length;
  await act(async () => root.render(<I18nProvider initialLocale="en"><MotionTemplateShelf root={createRef()} active /></I18nProvider>));
  expect(cards()).toBe(16);
  const more = [...host.querySelectorAll('button')].find(node => node.textContent === 'More templates')!;
  await act(async () => more.click());
  expect(cards()).toBe(32);
});
