// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mediaEditorDestination } from './creativeStudios';
import { studioExamples } from './sceneShowcase';
import { StudioIdeas } from './StudioIdeas';

vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }));

let root: Root, container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('lets Create image browse examples and apply the selected prompt', async () => {
  const onPrompt = vi.fn();
  const destination = mediaEditorDestination('text-to-image');
  await act(async () => root.render(<StudioIdeas destination={destination} onPrompt={onPrompt} />));
  const examples = studioExamples(destination);
  expect(examples.length).toBeGreaterThan(1);
  const deck = container.querySelector('.om-canvas-deck')!;
  expect(deck.getAttribute('aria-label')).toBe('Try an idea');
  const thumbs = [...deck.querySelectorAll<HTMLButtonElement>('button')];
  expect(thumbs[0].getAttribute('aria-pressed')).toBe('true');

  await act(async () => thumbs[1].click());
  expect(thumbs[1].getAttribute('aria-pressed')).toBe('true');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-canvas-idea-prompt')!.click());
  expect(onPrompt).toHaveBeenCalledWith(examples[1].prompt);
});

it('shows one comparison image in the Remove background guide', async () => {
  await act(async () => root.render(<StudioIdeas destination={mediaEditorDestination('remove-background')} onPrompt={vi.fn()} />));
  expect(container.querySelectorAll('.om-scene-comparison img')).toHaveLength(1);
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

it('renders non-X remix image templates inside the featured remix guide', async () => {
  await act(async () => root.render(
    <StudioIdeas
      destination={mediaEditorDestination('text-to-image')}
      onPrompt={vi.fn()}
      featuredExample={{
        title: 'Iridescent Glass Sculpture',
        prompt: 'Minimalist sculptural ribbon of blown dichroic glass.',
        poster: 'https://example.com/glass.avif',
        posterAspect: 4 / 3,
      }}
    />,
  ));
  const guide = container.querySelector<HTMLElement>('[data-remix-guide="true"]')!;
  expect(guide).not.toBeNull();
  expect(guide.querySelector('h2')?.textContent).toBe('Iridescent Glass Sculpture');
  expect(guide.querySelector('img')?.getAttribute('src')).toBe('https://example.com/glass.avif');
  expect(container.querySelector('.om-canvas-idea-prompt')).toBeNull();
});
