import type { GameCard, GameGenre } from '../../../../shared/game-contract';
import { gameGenres } from '../../../../shared/game-contract';

/**
 * Top 100 money-making mini games (community/top100.json), ranked by their public revenue signal:
 * top-grossing charts, published revenue or official statements. They are references only:
 * 做同款 briefs a new original game with the same core loop and never reuses names, characters or art.
 */
export type TopGame = {
  rank: number; id: string; name: string; nameEn: string; platform: string; monetization: 'IAP' | 'IAA' | '混合' | string;
  genre: GameGenre; loop: string; loopEn: string; signal: string; signalEn: string; sourceUrl: string; sourceNote: string;
  webFeasible: 'high' | 'medium' | 'low'; orientation: 'portrait' | 'landscape'; templateBrief: string;
  /** The bundled original template with the same core loop, played from the card; null when none fits. */
  template?: string | null;
};

const files = import.meta.glob('./community/top100.json', { eager: true, import: 'default' }) as Record<string, TopGame[]>;
const genres = new Set<string>(gameGenres);
export const topGames: TopGame[] = (Object.values(files)[0] ?? [])
  .filter(game => game.id && game.name && genres.has(game.genre))
  .sort((a, b) => a.rank - b.rank);

/** Cards for the market grids, in chart order, and a lookup from card id back to the chart entry. */
export const topGameCards = (): GameCard[] => topGames.map(topGameCard);
export const topGameFor = (cardId: string) => cardId.startsWith('top100-') ? topGames.find(game => 'top100-' + game.id === cardId) ?? null : null;

/** The brief for 做同款: same core loop, original everything else. */
export function topGameRemixPrompt(game: TopGame) {
  return [
    `Make an original game in the spirit of "${game.nameEn || game.name}".`,
    'Keep only the core loop; invent your own name, characters, story, art and sound, and do not copy its code, assets or text.',
    `Core loop: ${game.loopEn || game.loop}`,
    game.templateBrief && `Brief: ${game.templateBrief}`,
    game.orientation === 'portrait' ? 'Portrait, one-thumb controls, playable in a phone browser.' : 'Landscape, playable with keyboard, mouse or touch.',
    'Sessions under three minutes, with a clear goal, a fail state, a score and one-click retry.',
  ].filter(Boolean).join('\n');
}

/** The tracking and create flow speak GameCard; a Top 100 entry becomes a community card that is never played here. */
export function topGameCard(game: TopGame): GameCard {
  const createdAt = '2026-11-24T00:00:00.000Z';
  return {
    id: 'top100-' + game.id, title: game.nameEn || game.name, description: game.loopEn || game.loop, genre: game.genre, style: null, setting: null,
    multiplayer: false, maxPlayers: 1, status: 'published', cover: null, playUrl: game.sourceUrl, plays: 0, likes: 0, dislikes: 0, reaction: 0, favorite: false,
    source: 'community', external: { url: game.sourceUrl, author: game.platform, postUrl: game.sourceUrl, model: 'Unknown', embeddable: false },
    remixOf: null, controls: '', createdAt, updatedAt: createdAt, orientation: game.orientation,
    i18n: { 'zh-CN': { title: game.name, description: game.loop } },
  };
}
