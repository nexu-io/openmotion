// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mediaEditorDestination } from './creativeStudios';
import { sceneExamples } from './sceneShowcase';
import { StudioIdeas } from './StudioIdeas';

vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }));

let root: Root, container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('lets Image blend browse all three examples and use the selected one', async () => {
  const onPrompt = vi.fn();
  await act(async () => root.render(<StudioIdeas destination={mediaEditorDestination('image-blend')} onPrompt={onPrompt} />));
  const examples = sceneExamples['image-blend'];
  expect(examples).toHaveLength(3);
  const switcher = container.querySelector('.om-scene-hero-examples')!;
  expect(switcher.getAttribute('aria-label')).toBe('Try an idea');
  const thumbs = [...switcher.querySelectorAll<HTMLButtonElement>('button')];
  expect(thumbs.map(node => node.getAttribute('aria-label'))).toEqual(examples.map(example => example.title));
  expect(thumbs.map(node => node.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  expect(container.querySelector('.om-guide-heading h2')?.textContent).toBe(examples[0].title);

  await act(async () => thumbs[2].click());
  expect(thumbs.map(node => node.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
  expect(container.querySelector('.om-guide-heading h2')?.textContent).toBe(examples[2].title);
  await act(async () => container.querySelector<HTMLButtonElement>('.om-canvas-idea-prompt')!.click());
  expect(onPrompt).toHaveBeenCalledExactlyOnceWith(examples[2].prompt);
});

it('keeps single-example workbench scenes free of an example switcher', async () => {
  await act(async () => root.render(<StudioIdeas destination={mediaEditorDestination('image-edit')} onPrompt={vi.fn()} />));
  expect(container.querySelector('.om-scene-hero')).not.toBeNull();
  expect(container.querySelector('.om-scene-hero-examples')).toBeNull();
});
