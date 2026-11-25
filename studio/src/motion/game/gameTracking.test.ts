// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import type { GameCard } from '../../../../shared/game-contract';
import { validProperties } from '../../../../tracking/core.ts';
import { studioEvents } from '../../../../tracking/events.ts';

const sent: { event: string; properties: Record<string, unknown> }[] = [];
vi.mock('../tracking', () => ({ trackMotion: vi.fn(async (event: string, properties: Record<string, unknown>) => { sent.push({ event, properties }); return 'queued'; }) }));

const tracking = await import('./gameTracking');
await (await import('../reporting')).loadReportingTransport();

const card = (patch: Partial<GameCard> = {}): GameCard => ({
  id: 'tennis-go-wild', title: 'Secret Title', description: 'A private brief', genre: 'casual', style: 'pixel', setting: 'modern', multiplayer: false,
  maxPlayers: 1, status: 'published', cover: null, playUrl: '/motion-api/games/tennis-go-wild/play', plays: 3, likes: 0, dislikes: 0,
  reaction: 0, favorite: false, source: 'template', createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z', ...patch,
} as GameCard);

const of = (event: string) => sent.filter(row => row.event === event).map(row => row.properties);
function expectAdmitted() {
  for (const row of sent) expect(validProperties(studioEvents, row.event, row.properties), `${row.event} ${JSON.stringify(row.properties)}`).toBe(true);
  expect(JSON.stringify(sent)).not.toMatch(/Secret Title|private brief|\/motion-api\//);
}

beforeEach(() => { sent.length = 0; });

it('reports the Game Studio funnel with catalogue ids and fixed categories only', () => {
  const template = card();
  const mine = card({ id: '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b', source: 'mine', status: 'draft', orientation: 'portrait', title: 'Make a Secret Title' });
  tracking.reportGameClick('game_composer', 'game_option', null, { game_option_kind: 'genre', selected: true, filter_value: 'shooter' });
  tracking.reportGameClick('game_composer', 'submit_game');
  tracking.reportGameCreate('brief', { game: mine, handoff: 'super_agent' },
    { brief: { genre: 'shooter', style: 'pixel', setting: null, orientation: 'portrait', multiplayer: false, playableAd: true, hasPrompt: true } });
  tracking.reportGameClick('game_market', 'open_game', template, { position: 2 });
  tracking.reportGameAction('play', 'success', template);
  tracking.reportGameClick('game_detail', 'remix_game', template);
  tracking.reportGameCreate('remix', { error: 'service_unavailable' }, { source: template });
  tracking.reportGameAction('copy_link', 'unavailable', mine);

  expect(of('game_create_result')).toEqual([
    expect.objectContaining({ page_name: 'creative_studio', studio_id: 'game', create_route: 'brief', outcome: 'success', handoff: 'super_agent',
      game_id: mine.id, game_source: 'mine', game_status: 'draft', game_orientation: 'portrait', game_style: 'pixel', playable_ad: true, has_prompt: true }),
    expect.objectContaining({ create_route: 'remix', outcome: 'failure', error_kind: 'service_unavailable', source_game_id: 'tennis-go-wild', source_game_source: 'template' }),
  ]);
  expect(of('game_create_result')[0]).not.toHaveProperty('game_setting');
  expect(of('game_action_result')).toEqual([
    expect.objectContaining({ action: 'play', outcome: 'success', game_id: 'tennis-go-wild', game_genre: 'casual', game_source: 'template' }),
    expect.objectContaining({ action: 'copy_link', outcome: 'unavailable', game_source: 'mine' }),
  ]);
  expect(of('ui_click').map(row => row.element)).toEqual(['game_option', 'submit_game', 'open_game', 'remix_game']);
  expectAdmitted();
});

it('labels external community games and drops ids the schema cannot admit', () => {
  tracking.reportGameAction('play', 'failure', card({ id: 'has spaces/and slashes', source: 'community', external: { postUrl: 'https://x.com/a', author: 'a', model: 'm', embeddable: false } } as Partial<GameCard>));
  expect(of('game_action_result')[0]).toMatchObject({ game_source: 'community', outcome: 'failure' });
  expect(of('game_action_result')[0]).not.toHaveProperty('game_id');
  expectAdmitted();
});

it('admits every cloud-share result shape', () => {
  const entryId = crypto.randomUUID();
  for (const properties of [
    { publish_target: 'game', action: 'publish', outcome: 'success', copied: true, publish_attempt_id: crypto.randomUUID() },
    { publish_target: 'design', action: 'resume', outcome: 'failure', error_kind: 'auth_required', publish_attempt_id: crypto.randomUUID() },
    { publish_target: 'html', action: 'sign_in', outcome: 'cancelled', publish_attempt_id: crypto.randomUUID() },
    { publish_target: 'game', action: 'sign_in', outcome: 'success', publish_attempt_id: crypto.randomUUID(), hook_id: 'game_publish_signin', entry_id: entryId },
  ]) expect(validProperties(studioEvents, 'web_publish_result', properties)).toBe(true);
  expect(validProperties(studioEvents, 'web_publish_result', { publish_target: 'game', action: 'publish', outcome: 'success', publish_attempt_id: crypto.randomUUID(), url: 'https://example.com' })).toBe(false);
  expect(validProperties(studioEvents, 'ui_click', { page_name: 'creative_studio', area: 'web_publish', element: 'open_publish', publish_target: 'motion' })).toBe(true);
  expect(validProperties(studioEvents, 'surface_view', { page_name: 'creative_studio', area: 'entitlement_gate', element: 'gate_card', hook_id: 'game_publish_signin', publish_target: 'game' })).toBe(true);
  expect(validProperties(studioEvents, 'entitlement_refresh_result', { page_name: 'settings', hook_id: 'settings_subscription', entry_id: entryId, outcome: 'success', plan_changed: true })).toBe(true);
});

it('reports Game detail/handoff exposures, trailer actions, and Assets game entries', () => {
  const mine = card({ id: '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b', source: 'mine', status: 'ready' });
  tracking.reportGameDetailShown(mine);
  tracking.reportGameHandoffShown(mine);
  tracking.reportGameClick('game_detail', 'create_trailer', mine);
  tracking.reportGameAction('start_trailer', 'success', mine);
  tracking.reportGameClick('game_detail', 'regenerate_trailer', mine);
  tracking.reportGameAction('regenerate_trailer', 'failure', mine);
  tracking.reportGameClick('game_detail', 'open_trailer_project', mine);
  tracking.reportGameAction('open_trailer_project', 'success', mine);
  tracking.reportGameAssetClick('open_game', mine);
  tracking.reportGameAssetClick('view_all_games');
  tracking.reportGameAssetClick('open_game_studio');
  const searchId = crypto.randomUUID();
  tracking.reportGameSearch(searchId, '  snake  ', 0, 'arcade');
  tracking.reportGameSearch(crypto.randomUUID(), '   ', 10, 'all');

  expect(of('surface_view')).toEqual([
    expect.objectContaining({ page_name: 'creative_studio', studio_id: 'game', area: 'game_detail', element: 'detail', game_id: mine.id }),
    expect.objectContaining({ page_name: 'creative_studio', studio_id: 'game', area: 'game_handoff', element: 'handoff', game_id: mine.id }),
  ]);
  expect(of('game_search_result')).toEqual([
    expect.objectContaining({ page_name: 'creative_studio', studio_id: 'game', area: 'game_market', search_id: searchId, search_keyword: 'snake', query_length: 5, result_count: 0, outcome: 'success', filter_value: 'arcade' }),
  ]);
  expect(of('game_action_result').map(row => [row.action, row.outcome])).toEqual([
    ['start_trailer', 'success'],
    ['regenerate_trailer', 'failure'],
    ['open_trailer_project', 'success'],
  ]);
  expect(of('ui_click').filter(row => row.page_name === 'assets').map(row => row.element)).toEqual([
    'open_game', 'view_all_games', 'open_game_studio',
  ]);
  expectAdmitted();
});
