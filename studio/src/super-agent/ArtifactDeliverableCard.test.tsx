// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperAgentArtifact } from '../../../shared/super-agent';
import { I18nProvider } from '../i18n/I18n';
import { ArtifactDeliverableCard } from './ArtifactDeliverableCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function renderCard(artifact: SuperAgentArtifact, handlers: Partial<Parameters<typeof ArtifactDeliverableCard>[0]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onOpenArtifactId = handlers.onOpenArtifactId ?? vi.fn();
  const onCopyText = handlers.onCopyText ?? vi.fn();
  const onNotify = handlers.onNotify ?? vi.fn();
  const onOpenInDesignStudio = handlers.onOpenInDesignStudio ?? vi.fn();
  const onOpenInMotionStudio = handlers.onOpenInMotionStudio ?? vi.fn();
  const onOpenInAssets = handlers.onOpenInAssets ?? vi.fn();
  const onOpenInBrandKit = handlers.onOpenInBrandKit ?? vi.fn();

  act(() => {
    root.render(
      <I18nProvider>
        <ArtifactDeliverableCard
          artifact={artifact}
          onOpenArtifactId={onOpenArtifactId}
          onCopyText={onCopyText}
          onNotify={onNotify}
          onOpenInDesignStudio={onOpenInDesignStudio}
          onOpenInMotionStudio={onOpenInMotionStudio}
          onOpenInAssets={onOpenInAssets}
          onOpenInBrandKit={onOpenInBrandKit}
        />
      </I18nProvider>,
    );
  });

  return {
    container,
    root,
    onOpenArtifactId,
    onCopyText,
    onNotify,
    onOpenInDesignStudio,
    onOpenInMotionStudio,
    onOpenInAssets,
    onOpenInBrandKit,
  };
}

describe('ArtifactDeliverableCard', () => {
  it('renders Play, Cloud deploy, and Export ZIP for game-project without eager account fetches', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="voxel-musou.zip"',
        },
      }),
    );
    const createUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-game-zip');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const gameArtifact: SuperAgentArtifact = {
      id: 'game:g-42',
      kind: 'game-project',
      title: 'Voxel Musou',
      subtitle: '3D Action',
      projectId: 'g-42',
      url: '/motion-api/games/g-42/play/index.html',
      createdAt: 1,
      updatedAt: 2,
    };
    const { container, onOpenArtifactId, onNotify, root } = renderCard(gameArtifact);
    await flush();

    // Lazy WebPublishPopover must not fire background account/status fetches on card mount
    expect(fetchSpy).not.toHaveBeenCalled();

    const text = container.querySelector('.om-sa-deliverable-actions')?.textContent ?? '';
    expect(text).toContain('Play');
    expect(text).toContain('Share');
    expect(text).toContain('Export ZIP');

    // Primary Play button opens the artifact in the viewer
    const playBtn = container.querySelector<HTMLButtonElement>('.om-sa-deliverable-btn[data-primary]')!;
    await act(async () => playBtn.click());
    expect(onOpenArtifactId).toHaveBeenCalledWith('game:g-42');

    // Export ZIP hits /motion-api/games/g-42/export and notifies user
    const exportBtn = [...container.querySelectorAll<HTMLButtonElement>('.om-sa-deliverable-btn')].find(b =>
      b.textContent?.includes('Export ZIP'),
    )!;
    await act(async () => exportBtn.click());
    await flush();
    expect(fetchSpy).toHaveBeenCalledWith('/motion-api/games/g-42/export');
    expect(createUrlSpy).toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith('Exported voxel-musou.zip', 'info');

    act(() => root.unmount());
  });

  it('provides tailored share/export actions across design, motion, asset, brand-kit, and web artifacts', async () => {
    const cases: { artifact: SuperAgentArtifact; expected: string[] }[] = [
      {
        artifact: {
          id: 'design:d-1',
          kind: 'design-project',
          title: 'Launch Deck',
          scenario: 'deck',
          projectId: 'd-1',
          createdAt: 1,
          updatedAt: 2,
        },
        expected: ['Open editor', 'Share', 'Export'],
      },
      {
        artifact: {
          id: 'motion:m-1',
          kind: 'motion-project',
          title: 'Product Reel',
          projectId: 'm-1',
          createdAt: 1,
          updatedAt: 2,
        },
        expected: ['Open editor', 'Share'],
      },
      {
        artifact: {
          id: 'export:e-1',
          kind: 'motion-export',
          title: 'Product Reel.mp4',
          downloadUrl: '/api/exports/e-1/file',
          createdAt: 1,
          updatedAt: 2,
        },
        expected: ['Play', 'Download'],
      },
      {
        artifact: {
          id: 'asset:a-1',
          kind: 'asset-image',
          title: 'Hero Poster',
          assetId: 'a-1',
          versionId: 'v-1',
          url: '/motion-api/assets/a-1/versions/v-1/media',
          createdAt: 1,
          updatedAt: 2,
        },
        expected: ['Preview', 'Download', 'Open in Assets'],
      },
      {
        artifact: {
          id: 'brand:b-1',
          kind: 'brand-kit',
          title: 'OpenDesign Brand',
          kitId: 'b-1',
          createdAt: 1,
          updatedAt: 2,
        },
        expected: ['Preview', 'Export ZIP', 'Open in Brand Kit'],
      },
      {
        artifact: {
          id: 'web:w-1',
          kind: 'web',
          title: 'OpenDesign Docs',
          url: 'https://open-design.app/docs',
          createdAt: 1,
          updatedAt: 2,
        },
        expected: ['Preview', 'Copy link', 'Open in browser'],
      },
    ];

    for (const item of cases) {
      const { container, root } = renderCard(item.artifact);
      await flush();
      const actionText = container.querySelector('.om-sa-deliverable-actions')?.textContent ?? '';
      for (const label of item.expected) {
        expect(actionText).toContain(label);
      }
      if (item.artifact.kind === 'design-project') {
        expect(actionText).not.toContain('Edit in Studio');
      }
      if (item.artifact.kind === 'motion-project') {
        expect(actionText).not.toContain('Export video');
      }
      act(() => root.unmount());
      container.remove();
    }
  });
});
