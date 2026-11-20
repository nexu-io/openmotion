// @vitest-environment happy-dom
import { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GenerationParameters, durationTicks, parameterInputImageRatio, requestParameters, shotParameters, type ParameterDraft } from './GenerationParameters';
import { generationOptions } from '../../../shared/generation-options';
import type { Model } from '../../../shared/gateway';
import { toastErrorMessage } from '../components/ui/toastErrorMessage';
import { languages, translate } from '../i18n/messages';
import { ResizablePane, readPaneWidth } from './ResizablePane';
vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }));
it('merges advanced JSON and explicit typed controls, preserving native booleans and numbers', () => {
  expect(requestParameters({ advanced: '{"duration":8,"generate_audio":false,"seed":42}', values: { duration: 5 } })).toEqual({ duration: 5, generate_audio: false, seed: 42 });
  expect(() => requestParameters({ advanced: '[]', values: {} })).toThrow();
  expect(() => requestParameters({ advanced: '{', values: {} })).toThrow();
});
const firstFrameModel: Model = { id: 'opendesign:wan-2.7', provider: 'opendesign', modelId: 'wan-2.7', label: 'Wan', modality: 'video', mode: 'text-to-video', source: 'live', maxInputImages: 1, defaults: { ratio: '16:9' } };
it('preserves inactive quick values but rejects explicit JSON ratio even if a quick override would hide it', () => {
  const draft = { advanced: '{"seed":7}', values: { ratio: '9:16' } };
  expect(requestParameters(draft, firstFrameModel, true)).toEqual({ seed: 7 });
  expect(draft.values.ratio).toBe('9:16');
  expect(requestParameters(draft, firstFrameModel, false)).toEqual({ seed: 7, ratio: '9:16' });
  expect(() => requestParameters({ advanced: '{"ratio":"16:9"}', values: { ratio: 'adaptive' } }, firstFrameModel, true)).toThrow('First-frame video follows the input image ratio.');
  expect(requestParameters({ advanced: '{"ratio":"adaptive"}', values: { ratio: '9:16' } }, firstFrameModel, true)).toEqual({ ratio: 'adaptive' });
  expect(requestParameters(draft, { ...firstFrameModel, modality: 'image' }, true)).toEqual({ seed: 7, ratio: '9:16' });
  expect(requestParameters(draft, { ...firstFrameModel, provider: 'atlascloud' }, true)).toEqual({ seed: 7, ratio: '9:16' });
});
it('keeps first-frame guidance visible for provider-native inputs and while editing invalid JSON', () => {
  expect(parameterInputImageRatio(firstFrameModel, { advanced: '{"images":[{"role":"first_frame","url":"https://example.test/a.png"}]}', values: {} }, false)).toBe(true);
  expect(parameterInputImageRatio(firstFrameModel, { advanced: '{', values: {} }, true)).toBe(true);
  expect(parameterInputImageRatio(firstFrameModel, { advanced: '{}', values: {} }, false)).toBe(false);
});
it('keeps the first-frame conflict actionable through Toast sanitization and localization', () => {
  const message = 'First-frame video follows the input image ratio. Remove parameters.ratio or set it to "adaptive".';
  expect(toastErrorMessage(message)).toBe(message);
  for (const { locale } of languages) {
    const localized = translate(locale, message);
    expect(localized).toContain('ratio');
    expect(localized).toContain('adaptive');
    if (locale !== 'en') expect(localized).not.toBe(message);
  }
});
it('resizes with keyboard, bounds the pane, remembers width and resets on double click', async () => {
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.append(container);
  Object.defineProperty(container, 'clientWidth', { value: 1400 });
  const root = createRoot(container);
  const render = () => root.render(<ResizablePane className="test-pane" storageKey="test-width" initial={460} min={340} max={800} edge="left" label="Resize creator"><div>Content</div></ResizablePane>);
  try {
    await act(async () => render());
    const separator = container.querySelector('[role="separator"]')!;
    await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(container.querySelector<HTMLElement>('.test-pane')!.style.width).toBe('476px');
    expect(localStorage.getItem('test-width')).toBe('476');
    await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(container.querySelector<HTMLElement>('.test-pane')!.style.width).toBe('800px');
    await act(async () => separator.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(localStorage.getItem('test-width')).toBe('460');
    localStorage.setItem('test-width', 'Infinity'); expect(readPaneWidth('test-width', 460, 340, 800)).toBe(460);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it('builds clean duration ticks and applies shotPreferences to bounded number duration fields', () => {
  expect(durationTicks(4, 30)).toEqual([4, 10, 15, 20, 30]);
  expect(durationTicks(2, 15)).toEqual([2, 5, 10, 15]);
  const base: Model = {
    id: 'account:doubao-seedance-2-5-260628', provider: 'account', modelId: 'doubao-seedance-2-5-260628',
    label: 'doubao-seedance-2-5-260628', modality: 'video', mode: 'text-to-video', source: 'live',
    nativeOptions: {
      durations: { values: [5, 4, ...Array.from({ length: 25 }, (_, i) => i + 6)], default: 5 },
      ratios: { values: ['16:9', '9:16'], default: '16:9' },
    },
  };
  const seedance: Model = { ...base, generationOptions: generationOptions(base) };
  expect(shotParameters(seedance, { aspect: '9:16', duration: 15 })).toEqual({
    values: { ratio: '9:16', duration: 15 },
    advanced: '{}',
  });
  expect(shotParameters(seedance, { aspect: '9:16', duration: 99 })).toEqual({
    values: { ratio: '9:16' },
    advanced: '{}',
  });
});

it('renders image quick parameter cards with sparse-profile resolution locking and legacy size/ratio pickers', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const gptImageBase: Model = {
    id: 'opendesign:gpt-image-2', provider: 'opendesign', modelId: 'gpt-image-2', label: 'gpt-image-2',
    modality: 'image', mode: 'text-to-image', source: 'live', supportsImageReference: true, maxInputImages: 5,
    nativeOptions: {
      quality: { values: ['low', 'medium', 'high'], default: 'low' },
      profiles: {
        generations: {
          profiles: [
            { aspect_ratio: '1:1', resolution: '1K' },
            { aspect_ratio: '1:1', resolution: '2K' },
            { aspect_ratio: '16:9', resolution: '2K' },
          ],
          default: { aspect_ratio: '1:1', resolution: '1K' },
        },
        edits: {
          profiles: [
            { aspect_ratio: '1:1', resolution: '1K' },
            { aspect_ratio: '1:1', resolution: '2K' },
          ],
          default: { aspect_ratio: '1:1', resolution: '2K' },
        },
      },
    },
  };
  const gptImage: Model = { ...gptImageBase, generationOptions: generationOptions(gptImageBase) };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let latestDraft: ParameterDraft = { values: {}, advanced: '{}' };
  function Harness({ model, hasInputImage = false }: { model: Model; hasInputImage?: boolean }) {
    const [draft, setDraft] = useState<ParameterDraft>({ values: {}, advanced: '{}' });
    latestDraft = draft;
    return <GenerationParameters model={model} draft={draft} hasInputImage={hasInputImage} onChange={setDraft} />;
  }
  try {
    await act(async () => root.render(<Harness model={gptImage} />));
    const card = (label: string) => container.querySelector<HTMLElement>(`.om-param-card[aria-label="${label}"]`)!;
    expect(card('Aspect ratio').textContent).toContain('1:1');
    expect(card('Resolution').tagName).toBe('BUTTON');
    expect(card('Resolution').textContent).toContain('1K');
    expect(card('Quality').textContent).toContain('low');
    // Image models keep full popover fields available for canvas mode instead of compacting to "Advanced parameters".
    expect(container.querySelector('.om-generation-summary')?.textContent).not.toBe('Advanced parameters');

    // Selecting 16:9 locks Resolution to a static 2K card because only (16:9, 2K) exists in profiles.
    await act(async () => card('Aspect ratio').click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.om-option-tile')].find(b => b.textContent?.includes('16:9'))!.click());
    expect(card('Aspect ratio').textContent).toContain('16:9');
    expect(card('Resolution').tagName).toBe('DIV');
    expect(card('Resolution').classList.contains('om-param-card-static')).toBe(true);
    expect(card('Resolution').textContent).toContain('2K');

    // Switching back to 1:1 inside the open ratio popover restores the interactive 1K/2K pill picker.
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.om-option-tile')].find(b => b.textContent?.includes('1:1'))!.click());
    expect(card('Resolution').tagName).toBe('BUTTON');
    await act(async () => card('Aspect ratio').click());
    await act(async () => card('Resolution').click());
    expect([...document.querySelectorAll<HTMLButtonElement>('.om-option-pill')].map(b => b.textContent?.trim())).toEqual(['1K', '2K']);

    // Quality quick card emits selected tier.
    await act(async () => card('Resolution').click());
    await act(async () => card('Quality').click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.om-option-pill')].find(b => b.textContent?.trim() === 'high')!.click());
    expect(latestDraft.values.quality).toBe('high');

    // Seedream 5.5 (only 1:1 ratio, 1K/2K resolutions) locks Aspect ratio to static 1:1 while keeping Resolution interactive.
    const seedream55Base: Model = {
      id: 'opendesign:seedream-5.5', provider: 'opendesign', modelId: 'seedream-5.5', label: 'seedream-5.5',
      modality: 'image', mode: 'text-to-image', source: 'live', supportsImageReference: true, maxInputImages: 1,
      nativeOptions: {
        profiles: {
          generations: {
            profiles: [{ aspect_ratio: '1:1', resolution: '1K' }, { aspect_ratio: '1:1', resolution: '2K' }],
            default: { aspect_ratio: '1:1', resolution: '2K' },
          },
        },
      },
    };
    const seedream55: Model = { ...seedream55Base, generationOptions: generationOptions(seedream55Base) };
    await act(async () => root.render(<GenerationParameters model={seedream55} draft={{ values: {}, advanced: '{}' }} onChange={() => {}} />));
    expect(card('Aspect ratio').classList.contains('om-param-card-static')).toBe(true);
    expect(card('Aspect ratio').textContent).toContain('1:1');
    expect(card('Resolution').tagName).toBe('BUTTON');

    // Legacy `size` field (without profiles) and `fal:fal-ai/flux/schnell` (`image_size` ratio tiles) also surface quick cards.
    const legacySizeBase: Model = {
      id: 'account:seedream-5.5', provider: 'account', modelId: 'seedream-5.5', label: 'seedream-5.5',
      modality: 'image', mode: 'text-to-image', source: 'live',
      nativeOptions: { sizes: { values: ['1K', '2K'], default: '2K' } },
    };
    const legacySize: Model = { ...legacySizeBase, generationOptions: generationOptions(legacySizeBase) };
    await act(async () => root.render(<GenerationParameters model={legacySize} draft={{ values: {}, advanced: '{}' }} onChange={() => {}} />));
    expect(card('Image size').tagName).toBe('BUTTON');
    expect(card('Image size').textContent).toContain('2K');

    const falBase: Model = { id: 'fal:fal-ai/flux/schnell', provider: 'fal', modelId: 'fal-ai/flux/schnell', label: 'FLUX', modality: 'image', mode: 'text-to-image', source: 'builtin' };
    const falModel: Model = { ...falBase, generationOptions: generationOptions(falBase) };
    await act(async () => root.render(<GenerationParameters model={falModel} draft={{ values: {}, advanced: '{}' }} onChange={() => {}} />));
    expect(card('Image size').tagName).toBe('BUTTON');
    expect(card('Image size').textContent).toContain('4:3');
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});

it('sanitizes stale quick-picker image choices between generations and edits while preserving explicit JSON errors', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const base: Model = {
    id: 'opendesign:gpt-image-2', provider: 'opendesign', modelId: 'gpt-image-2', label: 'gpt-image-2',
    modality: 'image', mode: 'text-to-image', source: 'live', supportsImageReference: true, maxInputImages: 5,
    nativeOptions: {
      profiles: {
        generations: {
          profiles: [
            { aspect_ratio: '1:1', resolution: '1K' },
            { aspect_ratio: '16:9', resolution: '2K' },
          ],
          default: { aspect_ratio: '1:1', resolution: '1K' },
        },
        edits: {
          profiles: [
            { aspect_ratio: '1:1', resolution: '1K' },
            { aspect_ratio: '4:3', resolution: '1K' },
          ],
          default: { aspect_ratio: '1:1', resolution: '1K' },
        },
      },
    },
  };
  const model: Model = { ...base, generationOptions: generationOptions(base) };
  // shotParameters checks active edit choices when hasInputImage is true.
  expect(shotParameters(model, { aspect: '16:9' }, false)).toEqual({ values: { aspect_ratio: '16:9' }, advanced: '{}' });
  expect(shotParameters(model, { aspect: '16:9' }, true)).toEqual({ values: {}, advanced: '{}' });

  // Quick-picker 16:9 / 2K from generation mode drops cleanly under edit mode and restores when edits are cleared.
  const draft: ParameterDraft = { values: { aspect_ratio: '16:9', resolution: '2K' }, advanced: '{}' };
  expect(requestParameters(draft, model, false)).toEqual({ aspect_ratio: '16:9', resolution: '2K' });
  expect(requestParameters(draft, model, true)).toEqual({});
  expect(draft.values).toEqual({ aspect_ratio: '16:9', resolution: '2K' });
  expect(requestParameters(draft, model, false)).toEqual({ aspect_ratio: '16:9', resolution: '2K' });

  // Explicit invalid JSON remains strict so manual JSON mistakes are never silently swallowed.
  expect(() => requestParameters({ values: {}, advanced: '{"aspect_ratio":"16:9","resolution":"1K"}' }, model, true)).toThrow(/16:9|available/);

  // Quick cards display sanitized active values when hasInputImage is true rather than stale 16:9 / 2K.
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<GenerationParameters model={model} draft={draft} hasInputImage={true} onChange={() => {}} />));
    expect(container.querySelector('.om-param-card[aria-label="Aspect ratio"]')?.textContent).toContain('1:1');
    expect(container.querySelector('.om-param-card[aria-label="Resolution"]')?.textContent).toContain('1K');
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
