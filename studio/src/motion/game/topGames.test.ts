import { describe, expect, it } from 'vitest';
import { gameGenres } from '../../../../shared/game-contract';
import { topGameCard, topGameRemixPrompt, topGames } from './topGames';

describe('Top 100 money-making games', () => {
  it('ships 100 ranked entries with unique ids, valid genres and a source', () => {
    expect(topGames).toHaveLength(100);
    expect(topGames.map(game => game.rank)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(new Set(topGames.map(game => game.id)).size).toBe(100);
    for (const game of topGames) {
      expect(gameGenres).toContain(game.genre);
      expect(game.sourceUrl).toMatch(/^https?:\/\//);
      expect(topGameCard(game).id).toMatch(/^top100-[A-Za-z0-9_.-]+$/);
    }
  });

  it('briefs an original game and keeps the reference name out of the template brief', () => {
    for (const game of topGames) {
      expect(topGameRemixPrompt(game)).toMatch(/^Make an original game in the spirit of "/);
      expect(game.templateBrief.toLowerCase()).not.toContain(game.nameEn.toLowerCase());
      expect(game.templateBrief).not.toContain(game.name);
    }
  });
});
