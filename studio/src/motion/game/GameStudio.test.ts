import { describe, expect, it } from 'vitest';
import { trailerProjectHref } from './GameStudio';
import { bundledGames, needsGameService } from './gameCatalog';

describe('trailerProjectHref', () => {
  it('routes to the canonical /editor/:projectId URL instead of reusing the Game Studio pathname', () => {
    expect(trailerProjectHref('trailer-proj-1', '?game=space-shooter')).toBe(
      '/editor/trailer-proj-1#project/trailer-proj-1',
    );
  });

  it('preserves orthogonal presentation and tracking query params while dropping Game Studio params', () => {
    const trackingId = '11111111-2222-3333-4444-555555555555';
    expect(
      trailerProjectHref(
        'proj with space',
        `?game=space-shooter&embed=1&sidebar=0&conversation=0&tracking_context=${trackingId}`,
      ),
    ).toBe(
      `/editor/proj%20with%20space?embed=1&sidebar=0&conversation=0&tracking_context=${trackingId}#project/proj%20with%20space`,
    );
  });
});

describe('gameCatalog multi-file detection and internal tags', () => {
  it('requires the local game service for sibling assets, src bundles, and relative script/style files', () => {
    expect(needsGameService('<script src="src/system.bundle.js"></script>')).toBe(true);
    expect(needsGameService('<link rel="stylesheet" href="style.css">')).toBe(true);
    expect(needsGameService('<script>fetch("./assets/app.part0.js")</script>')).toBe(true);
    expect(needsGameService('<script>fetch("./app.part0.js")</script>')).toBe(true);
    expect(needsGameService('<!doctype html><script>console.log("inline")</script>')).toBe(false);
  });

  it('preserves internal top赚钱 tags on bundled templates for downstream category grouping', () => {
    const expected = [
      'arrow-out-3d',
      'catch-kitty-3d',
      'goods-sort-master',
      'kazehane',
      'parking-jam-hero',
      'piggy-escape-jam',
      'river-pals-sail',
      'rope-untangle-3d',
      'sand-tetris',
      'save-the-dog',
      'shanghai-vice',
      'vice-beach-golf-club',
      'water-sort-puzzle',
      'watermelon-merge-3d',
      'yarn-sort-color',
    ];
    for (const id of expected) {
      const card = bundledGames.find((g) => g.id === id);
      expect(card, `expected bundled template ${id}`).toBeDefined();
      expect(card?.tags).toContain('top赚钱');
    }
  });
});
