// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Model } from '../../../shared/gateway';
import { I18nProvider, type Locale } from '../i18n/I18n';
import { MotionApp } from './MotionApp';
import { sceneExamples } from './sceneShowcase';
import { savePersistedStudioDraft } from './authRecoveryStore';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const music: Model = { id: 'opendesign:elevenlabs-music-v2', modelId: 'elevenlabs-music-v2', provider: 'opendesign',
  label: 'Eleven Music v2', modality: 'audio', mode: 'text-to-audio', source: 'live' };
const generate = vi.fn();
let root: Root, host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  generate.mockClear();
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url, location.origin);
    if (pathname.endsWith('/models/catalog')) return Response.json({ models: [music], defaults: {} });
    if (pathname.endsWith('/models/status')) return Response.json({ providers: [{ id: music.provider, available: true }], routes: {}, agents: [], capabilities: [] });
    if (pathname.endsWith('/phase1/call')) {
      const args = JSON.parse(String(init?.body)).arguments;
      if (args.action === 'generate') {
        generate(args);
        return Response.json({ job: { id: 'generated', modality: 'audio', model: music, state: 'completed', createdAt: 1, updatedAt: 1, assets: [] } });
      }
      return Response.json({ jobs: [], assets: [], total: 0, nextOffset: null });
    }
    if (pathname.endsWith('/projects')) return Response.json({ projects: [], sessions: [] });
    return Response.json({ state: 'signed-in', plan: 'pro', agents: [], defaults: {} });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

async function openPage(path: string, locale: Locale = 'en') {
  history.replaceState(null, '', path);
  await act(async () => root.render(<I18nProvider initialLocale={locale}><MotionApp /></I18nProvider>));
  await act(() => vi.dynamicImportSettled());
}

it.each([
  ['Notification chime', 'sfx'], ['Success sound', 'sfx'], ['Minimal product score', 'music'],
])('opens the %s template in the matching composer with its full prompt', async (title, tab) => {
  const template = sceneExamples.music.find(example => example.title === title)!;
  savePersistedStudioDraft(`sound/${tab}`, { modality: 'audio', references: [], prompt: 'Previous draft' });
  await openPage('/sound');
  const article = [...host.querySelectorAll('article')].find(card => card.querySelector('strong')?.textContent === title)!;
  await act(async () => [...article.querySelectorAll('button')].find(button => button.textContent === 'Use prompt')!.click());
  await act(() => vi.dynamicImportSettled());
  expect(location.pathname).toBe(`/audio/${tab}`);
  expect(host.querySelector('.om-sound-tab[aria-current="page"]')?.getAttribute('data-sound-tab')).toBe(tab);
  expect(host.querySelector<HTMLTextAreaElement>('.om-sound-textarea')?.value).toBe(template.prompt);
  const submit = host.querySelector<HTMLButtonElement>('.om-sound-submit button[data-primary]')!;
  expect(submit.textContent).toContain(tab === 'music' ? 'Generate music' : 'Generate sound effect');
  if (tab === 'sfx') expect(submit.disabled).toBe(true);
  expect(generate).not.toHaveBeenCalled();
});

it.each([
  ['en', 'Piano; room sound.\nA quiet ending.', 'Instrumental', 'instrumental, no vocals', 'Soft piano', 'soft piano'],
  ['zh-CN', '音乐标签验收。', '纯音乐', '纯音乐、无人声', '轻柔钢琴', '轻柔钢琴'],
] as const)('toggles compound %s prompt tags without changing neighbouring text or its punctuation', async (locale, original, label, phrase, piano, pianoPhrase) => {
  savePersistedStudioDraft('sound/music', { modality: 'audio', references: [], prompt: original });
  await openPage('/audio/music', locale);
  const tag = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.om-sound-tag')].find(button => button.textContent === label)!;
  const textarea = host.querySelector<HTMLTextAreaElement>('.om-sound-textarea')!;
  await act(async () => tag(label).click());
  expect(tag(label).getAttribute('aria-pressed')).toBe('true');
  expect(textarea.value).toBe(`${original} ${phrase}`);
  await act(async () => tag(piano).click());
  await act(async () => tag(label).click());
  expect(tag(label).getAttribute('aria-pressed')).toBe('false');
  expect(textarea.value).toBe(`${original} ${pianoPhrase}`);
  expect(tag(piano).getAttribute('aria-pressed')).toBe('true');
  await act(async () => tag(piano).click());
  expect(textarea.value).toBe(original);
});

it('corrects out-of-range music durations on blur and submits seconds in the model unit', async () => {
  savePersistedStudioDraft('sound/music', { modality: 'audio', references: [], prompt: 'A short instrumental' });
  await openPage('/audio/music');
  const input = host.querySelector<HTMLInputElement>('[aria-label="Custom duration (seconds)"]')!;
  const prompt = host.querySelector<HTMLTextAreaElement>('.om-sound-textarea')!;
  const edit = async (text: string) => { await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }); };
  await edit('2');
  await act(async () => prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
  expect(generate).not.toHaveBeenCalled();
  await act(async () => input.blur());
  expect(input.value).toBe('3');
  await edit('601');
  await act(async () => input.blur());
  expect(input.value).toBe('600');
  await edit('4');
  await act(async () => host.querySelector<HTMLButtonElement>('.om-sound-submit button[data-primary]')!.click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: music.id, parameters: { music_length_ms: 4000 } }));
});
