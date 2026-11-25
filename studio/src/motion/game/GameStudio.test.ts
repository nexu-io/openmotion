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

describe('gameCatalog multi-file detection & internal tags', () => {
  it('detects sibling scripts, stylesheets, and chunked assets while keeping self-contained HTML inline', () => {
    expect(needsGameService('<script>fetch("./app.part0.js")</script>')).toBe(true);
    expect(needsGameService('<link rel="stylesheet" href="./styles.css">')).toBe(true);
    expect(needsGameService('<script src="./src/system.bundle.js"></script>')).toBe(true);
    expect(needsGameService('<!doctype html><script>console.log("solo")</script>')).toBe(false);
  });

  it('preserves internal top赚钱 tags on the 3 new 3D web templates', () => {
    for (const id of ['vice-beach-golf-club', 'kazehane', 'shanghai-vice']) {
      const card = bundledGames.find((g) => g.id === id);
      expect(card, `expected bundled template ${id}`).toBeDefined();
      expect(card?.tags).toContain('top赚钱');
    }
  });
});
