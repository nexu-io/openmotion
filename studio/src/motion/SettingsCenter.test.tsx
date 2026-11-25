// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import readme from '../../../README.md?raw';
import chineseReadme from '../../../README.zh-CN.md?raw';
import { I18nProvider } from '../i18n/I18n';
import { SettingsCenter } from './SettingsCenter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { locale: 'zh-CN', heading: '社群', labels: ['飞书群', 'Discord'], document: chineseReadme, platforms: ['飞书群', 'Discord'] },
  { locale: 'en', heading: 'Community', labels: ['Discord', 'Feishu group'], document: readme, platforms: ['Discord', 'Feishu'] },
] as const)('offers both README invitations in locale order from Help in $locale', ({ locale, heading, labels, document, platforms }) => {
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <SettingsCenter section="help" onSection={() => {}} openConnections={() => {}} />
    </I18nProvider>,
  );
  const page = new DOMParser().parseFromString(html, 'text/html');
  const section = page.querySelector('section[aria-labelledby="om-community-heading"]');
  expect(section?.querySelector('h2')?.textContent).toBe(heading);
  const links = Array.from(section!.querySelectorAll('a'));
  expect(links.map(link => link.textContent)).toEqual(labels);
  for (const [index, link] of links.entries()) {
    expect(document).toContain(`[${platforms[index]}](${link.href})`);
    expect(link.target).toBe('_blank');
    expect(link.relList.contains('noopener')).toBe(true);
  }
});

it('guides users to check account & plan in Default models when no media models are available', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('models/catalog')) {
      return Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: {}, models: [] });
    }
    return Response.json({
      providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: false }],
      routes: {},
    });
  }));
  const onSection = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <I18nProvider initialLocale="zh-CN">
      <SettingsCenter section="models" onSection={onSection} openConnections={() => {}} />
    </I18nProvider>,
  ));
  const emptyGuide = host.querySelector('[data-empty-models="true"]');
  expect(emptyGuide).not.toBeNull();
  expect(emptyGuide?.textContent).toContain('当前暂无可用媒体模型');
  expect(host.textContent).toContain('暂无可用模型');
  const accountBtn = [...emptyGuide!.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.trim() === '查看账户与订阅方案')!;
  expect(accountBtn).toBeTruthy();
  await act(async () => accountBtn.click());
  expect(onSection).toHaveBeenCalledWith('subscription');
});
