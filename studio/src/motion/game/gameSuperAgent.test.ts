import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameProjects } from '../../../../game-projects';
import type { GameCard } from '../../../../shared/game-contract';
import { isPlayableAdArtifact } from '../../../../shared/super-agent';
import { canChoosePlayableAd, isPlayableAd } from '../../super-agent/ModeComposerControls';
import { buildDirectGamePrompt, GAME_STUDIO_QUICK_IDEAS, readDirectGameBrief, toGameArtifact } from './gameSuperAgent';

const game = (patch: Partial<GameCard> = {}): GameCard => ({
  id: 'g1', title: 'Coin Cascade', description: 'Pull pins', genre: 'casual', style: '3d', setting: null, multiplayer: false, maxPlayers: 1,
  orientation: 'portrait', status: 'draft', cover: null, playUrl: '/api/games/g1/play/index.html', plays: 0, likes: 0, dislikes: 0,
  reaction: 0, favorite: false, source: 'mine', remixOf: null, controls: '', ...patch,
} as GameCard);

describe('playable ads in Super Agent', () => {
  it('counts only portrait briefs with the ad option on', () => {
    expect(isPlayableAd({ gameOrientation: 'portrait', gamePlayableAd: true })).toBe(true);
    expect(isPlayableAd({ gameOrientation: 'landscape', gamePlayableAd: true })).toBe(false);
    expect(isPlayableAd({ gameOrientation: 'portrait', gamePlayableAd: false })).toBe(false);
  });

  it('does not offer the ad option while a local template is selected, because remix copies it unchanged', () => {
    const base = { gameOrientation: 'portrait' as const, gamePlayableAd: true };
    expect(canChoosePlayableAd({ gameTemplate: game({ source: 'template' }) })).toBe(false);
    expect(isPlayableAd({ ...base, gameTemplate: game({ source: 'template' }) })).toBe(false);
    const community = game({ source: 'community', external: { url: 'https://x.test', author: 'a', postUrl: 'https://x.test/p', model: 'm', embeddable: true } });
    expect(isPlayableAd({ ...base, gameTemplate: community })).toBe(true);
  });

  it('tells the Super Agent turn to follow the playable-ad recipe only for ad drafts', () => {
    const adPrompt = buildDirectGamePrompt(game({ playableAd: true }), 'Build it');
    const normalPrompt = buildDirectGamePrompt(game(), 'Build it');
    expect(adPrompt).toContain('format=playable ad');
    expect(adPrompt).not.toContain('openmotion_media_use');
    expect(adPrompt).not.toContain('spend-consent');
    expect(normalPrompt).not.toContain('playable ad');
    expect(normalPrompt).toContain('openmotion_media_use');
    expect(toGameArtifact(game({ playableAd: true }), 'Coin Cascade').subtitle).toContain('Playable ad');
    expect(toGameArtifact(game({ playableAd: true }), 'Coin Cascade').playableAd).toBe(true);
    expect(isPlayableAdArtifact({ kind: 'game-project', subtitle: 'casual · Playable ad' })).toBe(true);
    expect(isPlayableAdArtifact({ kind: 'game-project', subtitle: 'casual · Game Studio' })).toBe(false);
  });

  it('recovers the user brief from the instructions Game Studio actually returns', async () => {
    const brief = '制作竖屏街机小游戏。\n支持快速重开。';
    const workspace = await mkdtemp(join(tmpdir(), 'openmotion-game-brief-'));
    try {
      const service = new GameProjects(workspace);
      const { game: created, agentInstruction: instruction } = await service.create({
        prompt: brief, genre: 'casual', style: 'pixel', setting: 'modern',
        multiplayer: false, orientation: 'portrait', playableAd: true,
      });
      const savedText = buildDirectGamePrompt(created, instruction);
      expect(readDirectGameBrief(savedText, created.id)).toBe(brief);
      expect(readDirectGameBrief(instruction, created.id)).toBe(brief);
      const remix = await service.remix(created.id);
      expect(readDirectGameBrief(buildDirectGamePrompt(remix.game, remix.agentInstruction), remix.game.id)).toBe(brief);

      const legacyInstruction = instruction
        .replace(" (or use your host's workflow reader if provided)", '')
        .replace(
          'Ask whether to publish to the local market only when the decision is missing.',
          'Ask at most two short questions (multiplayer mode and local-market publication), only when missing.',
        );
      expect(readDirectGameBrief(buildDirectGamePrompt(created, legacyInstruction), created.id)).toBe(brief);
      const notes = '把画面改成暖色。';
      expect(readDirectGameBrief(buildDirectGamePrompt(created, instruction, notes), created.id)).toBe(notes);
      expect(readDirectGameBrief(savedText, 'other-game')).toBeUndefined();
      expect(readDirectGameBrief(brief, created.id)).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('offers a portrait single-player playable-ad quick idea', () => {
    const idea = GAME_STUDIO_QUICK_IDEAS.find(item => item.playableAd);
    expect(idea).toMatchObject({ orientation: 'portrait' });
  });
});
