// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import englishReadme from '../../../README.md?raw';
import chineseReadme from '../../../README.zh-CN.md?raw';
import { I18nProvider, type Locale } from '../i18n/I18n';
import { McpConnectionPage } from './McpConnectionPage';

vi.mock('./useWorkspace', () => ({ motionApi: async (path: string, options: RequestInit) => {
  const response = await fetch('/motion-api' + path, options);
  if (!response.ok) throw new Error('Unavailable');
  return response.json();
} }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const info = { name: 'OpenMotion', version: '1.2.3', previewUrl: 'http://127.0.0.1:4567', dataDirectory: '/fixture/data', templateSource: 'repository',
  transport: { type: 'stdio', command: 'node', args: ['/fixture/mcp.ts'], cwd: '/fixture', env: { MOTION_DATA_DIR: '/fixture/data' } }, tools: [{ name: 'openmotion_media_use', description: 'Media Use' }] };
const template = { id: 'fixture-film', title: 'Fixture film', description: 'Editable typography', subtitle: 'Launch', posterUrl: '/poster.png' };
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') || node.textContent?.trim()) === name)!;
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(node => node.textContent === name)!;
async function mount(locale: Locale = 'en') {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const openLibrary = vi.fn(), openProviders = vi.fn();
  await act(async () => root!.render(<I18nProvider initialLocale={locale}><McpConnectionPage openLibrary={openLibrary} openProviders={openProviders} /></I18nProvider>));
  return { openLibrary, openProviders };
}

it.each(['en', 'zh-CN'] as const)('explains native reference cards and a separately streamed welcome in %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  await mount(locale);
  const faq = [...document.querySelectorAll<HTMLDetailsElement>('.om-mcp-faq details')]
    .find(item => item.querySelector('summary')?.textContent?.includes(locale === 'en' ? 'Can I see templates' : '看模板'))!;
  expect(faq).toBeDefined();
  await act(async () => faq.querySelector('summary')!.click());
  expect(faq.open).toBe(true);
  expect(faq.textContent).toContain(locale === 'en' ? 'native MCP Apps' : '原生 MCP Apps');
  expect(faq.textContent).toContain(locale === 'en' ? 'streams the welcome separately' : '单独流式输出欢迎文案');
  expect(faq.textContent).toContain(locale === 'en' ? 'Builtin examples' : '内置示例');
});

it.each(['zh-CN', 'en', 'ja'] as const)('links the FAQ and footer to the README community for %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [template] } : info)));
  await mount(locale);
  const readme = locale === 'zh-CN' ? chineseReadme : englishReadme;
  const channel = locale === 'zh-CN' ? '飞书群' : 'Discord';
  for (const selector of ['.om-mcp-contact', '.om-mcp-footer-intro']) {
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>(`${selector} a`)).find(item => item.textContent?.includes(channel));
    expect(link).toBeDefined();
    expect(readme).toContain(`[${channel}](${link!.href})`);
    expect(link!.target).toBe('_blank');
  }
});

it('switches client-specific setup, copies exact template instructions and performs no mutations', async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [template] } : info));
  vi.stubGlobal('fetch', fetcher);
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const { openLibrary, openProviders } = await mount();
  expect(document.querySelector('h1')?.textContent).toContain('Codex');
  await act(async () => tab('Claude Code').click());
  expect(document.querySelector('h1')?.textContent).toContain('Claude Code');
  await act(async () => tab('Manual setup').click());
  expect(document.querySelector('pre')?.textContent).toContain('claude mcp add');
  expect(document.querySelector('a[download]')?.getAttribute('href')).toBe('/connect/config?host=claude');
  await act(async () => button('Copy template prompt').click());
  expect(copy).toHaveBeenCalledWith(expect.stringContaining('fixture-film'));
  expect(copy.mock.calls[0][0]).toContain('Claude Code');
  expect(copy.mock.calls[0][0]).toContain('https://github.com/nexu-io/openmotion#quick-start');
  expect(copy.mock.calls[0][0]).not.toContain('127.0.0.1');
  expect(document.querySelector('.motion-feedback-layer [role=status]')?.textContent).toContain('Copied to clipboard');
  expect(document.querySelector('.om-mcp-content [role=status]')).toBeNull();
  await act(async () => button('View all templates').click()); expect(openLibrary).toHaveBeenCalledOnce();
  await act(async () => button('Manage providers').click()); expect(openProviders).toHaveBeenCalledOnce();
  await act(async () => tab('ChatGPT').click());
  expect(document.body.textContent).toContain('Remote connection unavailable');
  expect(button('Copy template prompt').disabled).toBe(true);
  expect(document.querySelector('a[download]')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) expect(init?.method ?? 'GET').toBe('GET');
});

it('contains unavailable setup and catalogue independently, retries and reserves failed poster geometry', async () => {
  let broken = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => broken ? Response.json({}, { status: 503 }) : Response.json(url.includes('template-catalog') ? { items: [template] } : info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount();
  expect(button('Copy connection instruction').disabled).toBe(false);
  await act(async () => button('Copy connection instruction').click());
  expect(copy).toHaveBeenCalledWith(expect.stringContaining('https://github.com/nexu-io/openmotion#quick-start'));
  expect(copy.mock.calls[0][0]).not.toContain('127.0.0.1');
  await act(async () => tab('Manual setup').click());
  expect(document.body.textContent).toContain('Could not load settings');
  expect(document.querySelector('a[download]')).toBeNull();
  expect(document.body.textContent).toContain('Templates could not be loaded');
  expect(document.body.textContent).toContain('Your visual MCP guide');
  broken = false;
  for (const retry of [...document.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent === 'Retry')) await act(async () => retry.click());
  await act(async () => tab('Let your Agent set it up').click());
  expect(button('Copy connection instruction').disabled).toBe(false);
  expect(document.body.textContent).toContain('Fixture film');
  const poster = document.querySelector('.om-gallery-poster')!;
  act(() => poster.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(poster.querySelector('img')).toBeNull();
  expect(poster.textContent).toBe('Fixture film');
});

it('aborts pending setup and template reads when leaving the page', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => { signals.push(init.signal!); return new Promise(() => {}); }));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount(); expect(signals).toHaveLength(2);
  expect(button('Copy connection instruction').disabled).toBe(false);
  await act(async () => button('Copy connection instruction').click());
  expect(copy).toHaveBeenCalledWith(expect.stringContaining('https://github.com/nexu-io/openmotion#quick-start'));
  expect(document.querySelector('a[download]')).toBeNull();
  act(() => root!.unmount()); root = undefined;
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

class PreviewObserver {
  static latest: PreviewObserver;
  elements: Element[] = [];
  constructor(private callback: IntersectionObserverCallback) { PreviewObserver.latest = this; }
  observe(element: Element) { this.elements.push(element); }
  disconnect() {}
  emit(ratio: number) { this.callback(this.elements.map(target => ({ target, isIntersecting: ratio > 0, intersectionRatio: ratio }) as IntersectionObserverEntry), this as unknown as IntersectionObserver); }
}

it('filters the full catalogue, autoplays only visible cards and hands off the exact template', async () => {
  const first = { ...template, author: 'Designer', previewUrl: '/first.mp4', uses: ['Product launch'] };
  const second = { ...first, id: 'brand-film', title: 'Brand film', previewUrl: '/second.mp4', uses: ['Brand promotion'] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(!url.includes('template-catalog') ? info : url.includes('offset=60') ? { items: [second], next: null } : { items: [first], next: 60 })));
  vi.stubGlobal('IntersectionObserver', PreviewObserver);
  const preference = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => preference);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const { openLibrary } = await mount();
  expect(document.querySelectorAll('video[src]')).toHaveLength(0);
  await act(async () => PreviewObserver.latest.emit(1));
  expect(document.querySelectorAll('video[src]')).toHaveLength(2);
  await act(async () => { preference.matches = true; preference.dispatchEvent(new Event('change')); });
  expect(document.querySelectorAll('video[src]')).toHaveLength(0);
  await act(async () => { preference.matches = false; preference.dispatchEvent(new Event('change')); });
  expect(document.querySelectorAll('video[src]')).toHaveLength(2);
  await act(async () => tab('Brand & company films').click());
  expect(document.querySelectorAll('[data-template-id]')).toHaveLength(1);
  expect(document.querySelector('[data-template-id]')?.getAttribute('data-template-id')).toBe('brand-film');
  await act(async () => PreviewObserver.latest.emit(1));
  expect(document.querySelector('video[src]')?.getAttribute('src')).toBe('/second.mp4');
  await act(async () => button('Preview template Brand film').click());
  expect(openLibrary).toHaveBeenCalledWith(expect.any(HTMLButtonElement), 'brand-film');
  await act(async () => PreviewObserver.latest.emit(0));
  expect(document.querySelectorAll('video[src]')).toHaveLength(0);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});

it.each(['en', 'zh-CN'] as const)('copies the complete media onboarding flow in %s', async locale => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('template-catalog') ? { items: [] } : info)));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  await mount(locale);
  const card = [...document.querySelectorAll('article')].find(node => node.querySelector('h3')?.textContent === (locale === 'en' ? 'Generate images, video, music and voice' : '生成图片、视频、音乐与配音'))!;
  await act(async () => card.querySelector('button')!.click());
  const instruction = copy.mock.calls[0][0];
  expect(instruction).toContain('target=providers');
  expect(instruction).not.toContain('install.md');
  expect(instruction).not.toContain('quick-start');
  expect(instruction).toContain(locale === 'en' ? 'inspect again' : '再次检查配置');
  expect(instruction).toContain(locale === 'en' ? 'original request' : '原来的需求');
  expect(document.querySelector('.motion-feedback-layer [role=status]')?.textContent).toContain(locale === 'en' ? 'Copied to clipboard' : '已复制');
});
