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

it('shows one comparison image and no example switcher in the Image edit guide', async () => {
  await act(async () => root.render(<StudioIdeas destination={mediaEditorDestination('image-edit')} onPrompt={vi.fn()} />));
  expect(container.querySelectorAll('.om-scene-comparison img')).toHaveLength(1);
  expect(container.querySelector('.om-scene-hero-examples')).toBeNull();
});

it('renders X-hosted remix video templates in a referrer-safe iframe without a redundant remix button', async () => {
  const clip = 'https://video.twimg.com/amplify_video/12345/vid/avc1/1280x720/sample.mp4';
  await act(async () => root.render(
    <StudioIdeas
      destination={mediaEditorDestination('text-to-video')}
      onPrompt={vi.fn()}
      featuredExample={{
        title: 'Bridge Twin Supercar Drift',
        prompt: 'Twin supercars drifting in sync across a twilight suspension bridge.',
        poster: 'https://pbs.twimg.com/amplify_video_thumb/12345/img/poster.jpg',
        clip,
        posterAspect: 16 / 9,
      }}
    />,
  ));
  const iframe = container.querySelector<HTMLIFrameElement>('iframe.om-hub-lightbox-video')!;
  expect(iframe).not.toBeNull();
  expect(iframe.getAttribute('srcdoc')).toContain('no-referrer');
  expect(iframe.getAttribute('srcdoc')).toContain(clip);
  expect(container.querySelector('.om-canvas-idea-prompt')).toBeNull();
});
