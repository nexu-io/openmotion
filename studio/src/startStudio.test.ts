import { afterEach, expect, it, vi } from 'vitest';

const { loadExplorePage, importLocaleChunk } = vi.hoisted(() => ({
  loadExplorePage: vi.fn(async () => ({})),
  importLocaleChunk: vi.fn(() => new Promise(() => {})),
}));
vi.mock('./main', () => ({})); // The shell never mounts in this test.
vi.mock('./router/pageImports', () => ({ loadExplorePage }));
vi.mock('./i18n/localePreference', () => ({ readLocale: () => 'zh-CN' }));
vi.mock('./i18n/importLocaleChunk', () => ({ importLocaleChunk }));

async function start(url: string, saveData = false) {
  vi.resetModules();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', new URL(url, 'https://studio.test'));
  vi.stubGlobal('navigator', { connection: { saveData } });
  await import('./startStudio');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['/', '/?tracking_context=home', '/?page=explore', '/explore/', '/explore/creators?medium=video'])(
  'starts Explore on %s without waiting for the selected locale or shell mount', async url => {
    await start(url);
    expect(importLocaleChunk).toHaveBeenCalledWith('zh-CN');
    expect(loadExplorePage).toHaveBeenCalledOnce();
  },
);

it.each([
  '/editor/project-1', '/editor/project-1?page=explore', '/?project=project-1', '/#project/project-1',
  '/?session=abc', '/?page=editor', '/?page=assets', '/?page=api&project=abc', '/settings/account',
  '/?templates=1&embed=1', '/?hostChrome=1', '/explore?template=welcome', '/explore?page=skills',
  '/explore-more', '/explore/too/many/segments',
])('does not warm Explore on %s', async url => {
  await start(url);
  expect(loadExplorePage).not.toHaveBeenCalled();
});

it('leaves discovery to the normal lazy render when Save-Data is enabled', async () => {
  await start('/explore', true);
  expect(loadExplorePage).not.toHaveBeenCalled();
});

it('shares a pending route import and lets the lazy render retry a failed warm', async () => {
  const { cachedPageImport } = await vi.importActual<typeof import('./router/pageImports')>('./router/pageImports');
  const importer = vi.fn(async () => ({})).mockRejectedValueOnce(new Error('offline'));
  const load = cachedPageImport(importer);
  const warm = load();
  expect(load()).toBe(warm);
  await expect(warm).rejects.toThrow('offline');
  const retry = load();
  await retry;
  expect(load()).toBe(retry);
  expect(importer).toHaveBeenCalledTimes(2);
});
