// Game Studio reports: the try → remix/create → hand off → play → share funnel. Every report is
// page_name=creative_studio with studio_id=game, like the other creative studios. Titles, briefs, prompts,
// instructions and links never leave the browser; only catalogue ids, UUIDs and fixed categories do.
import type { GameCard } from '../../../../shared/game-contract';
import { newTrackingId, optionId, searchKeyword, send, slugField, type Fields } from '../reporting';

type Click = Fields<'ui_click'>;
type GameArea = Extract<Click['area'], `game_${string}`>;
type Action = Fields<'game_action_result'>['action'];
type Outcome = Fields<'game_action_result'>['outcome'];

const studio = { page_name: 'creative_studio', studio_id: 'game' } as const;
const gameId = /^[A-Za-z0-9_.-]{1,128}$/;
const gameSource = (game: GameCard) => game.external ? 'community' as const : game.source;

/** The bounded description of one game. A malformed id is left out rather than rewritten. */
export function gameFields(game: GameCard) {
  return {
    ...(gameId.test(game.id) ? { game_id: game.id } : {}),
    game_source: gameSource(game),
    ...slugField('game_genre', game.genre),
    game_status: game.status,
    game_orientation: game.orientation === 'portrait' ? 'portrait' as const : 'landscape' as const,
    multiplayer: Boolean(game.multiplayer),
  };
}

export function reportGameClick(area: GameArea, element: Click['element'], game?: GameCard | null,
  extra: Pick<Click, 'game_option_kind' | 'game_view' | 'selected' | 'position' | 'filter_value'> = {}) {
  send('ui_click', { ...studio, area, element, ...(game ? gameFields(game) : {}), ...extra });
}

export type GameBrief = { genre: string | null; style: string | null; setting: string | null; orientation: 'landscape' | 'portrait'; multiplayer: boolean; playableAd: boolean; hasPrompt: boolean };

/** One Start building or Remix attempt, reported once the local game service answered (or could not be reached). */
export function reportGameCreate(route: 'brief' | 'remix', result: { game: GameCard; handoff: 'super_agent' | 'detail' } | { error: 'service_unavailable' | 'rejected' },
  input: { brief?: GameBrief; source?: GameCard }) {
  const { brief, source } = input;
  send('game_create_result', {
    ...studio, create_attempt_id: newTrackingId(), create_route: route,
    ...('game' in result ? { outcome: 'success' as const, handoff: result.handoff, ...gameFields(result.game) } : { outcome: 'failure' as const, error_kind: result.error }),
    ...(brief ? {
      ...('game' in result ? {} : { ...slugField('game_genre', brief.genre ?? undefined), game_orientation: brief.orientation, multiplayer: brief.multiplayer }),
      ...slugField('game_style', brief.style ?? undefined), ...slugField('game_setting', brief.setting ?? undefined),
      has_prompt: brief.hasPrompt, playable_ad: brief.playableAd,
    } : {}),
    ...(source ? { ...(gameId.test(source.id) ? { source_game_id: source.id } : {}), source_game_source: gameSource(source) } : {}),
  });
}

export function reportGameAction(action: Action, outcome: Outcome, game: GameCard) {
  send('game_action_result', { ...studio, action, outcome, ...gameFields(game) });
}

export function reportGameDetailShown(game: GameCard) {
  send('surface_view', { ...studio, area: 'game_detail', element: 'detail', ...gameFields(game) });
}

export function reportGameHandoffShown(game: GameCard) {
  send('surface_view', { ...studio, area: 'game_handoff', element: 'handoff', ...gameFields(game) });
}

export function reportGameAssetClick(element: Extract<Click['element'], 'open_game' | 'view_all_games' | 'open_game_studio'>, game?: GameCard | null) {
  send('ui_click', { page_name: 'assets', area: 'assets_library', element, ...(game ? gameFields(game) : {}) });
}

export function reportGameSearch(searchId: string, query: string, resultCount: number, category?: string) {
  const keyword = searchKeyword(query);
  if (!keyword) return;
  send('game_search_result', {
    ...studio, area: 'game_market', search_id: searchId, search_keyword: keyword,
    query_length: query.trim().length, result_count: resultCount, outcome: 'success',
    ...(category && category !== 'all' ? optionId(category) : {}),
  });
}
