// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publish = vi.fn();
vi.mock('../../components/webPublishClient', () => {
  class WebPublishApiError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) { super(message); }
  }
  return { WebPublishApiError, webPublishClient: { publish: (...args: unknown[]) => publish(...args) } };
});

const wx = {
  state: vi.fn(),
  saveKey: vi.fn(),
};
vi.mock('./wechatClient', async importOriginal => ({ ...(await importOriginal<typeof import('./wechatClient')>()), wechatClient: wx }));
const handoff = vi.fn();
vi.mock('../../motion/superAgentHandoff', () => ({ queueSuperAgentHandoff: (payload: unknown) => handoff(payload) }));

const { WebPublishApiError } = await import('../../components/webPublishClient');
const { gamePublishActions, gamePublishSessionFor, gamePublishThreadFor, copyGamePublishLink, resetGamePublishStore } = await import('./gamePublishStore');
const { PLAYABLE_NETWORKS } = await import('./playableNetworks');
const { gamePublishPlatform } = await import('./platforms');

const GAME_HTML = '<!DOCTYPE html><html><head><title>Coin Jar</title><script src="game.js"></script></head><body><canvas></canvas><script>function openStore(id){window.open("https://example.com")}openStore("x")</script></body></html>';
const input = {
  artifactId: 'game:abc',
  chatId: 'chat-1',
  gameId: 'abc12345',
  gameTitle: 'Coin Jar',
  link: { targetId: 'abc12345', filePath: 'index.html', title: 'Coin Jar' },
};

function mockGameFiles() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/play/index.html')) return new Response(GAME_HTML, { headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/play/game.js')) return new Response('var game = 1;', { headers: { 'content-type': 'text/javascript' } });
    return new Response('missing', { status: 404 });
  }));
}

const KEYS = ['account', 'appid', 'key', 'ip', 'port', 'preview', 'upload', 'testers', 'category', 'review', 'filing', 'release'] as const;
/** A progress record as the local service reports it, with every step before `current` done. */
function wechatStatus(current: (typeof KEYS)[number] | null, extra: Record<string, unknown> = {}) {
  const at = current ? KEYS.indexOf(current) : KEYS.length;
  return {
    gameId: 'abc12345', appid: at > 1 ? 'wx0123456789abcdef' : null, hasKey: at > 2, current, preview: null,
    steps: KEYS.map((key, index) => ({ key, status: index < at ? 'done' : 'todo', later: index >= 8 })),
    ...extra,
  };
}

async function settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); }

describe('gamePublishStore', () => {
  beforeEach(() => {
    resetGamePublishStore();
    publish.mockReset();
    publish.mockResolvedValue({ url: 'https://play.opendesign.app/g/abc', updated: false, publication: {}, deployment: {} });
    mockGameFiles();
    for (const fn of Object.values(wx)) fn.mockReset();
    handoff.mockReset();
    wx.state.mockResolvedValue(wechatStatus('key'));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('OpenDesign is selected by default: picking a platform also publishes its link and tells the Agent', async () => {
    gamePublishActions.open(input);
    expect(gamePublishSessionFor(input.artifactId)?.linkToo).toBe(true);
    gamePublishActions.choose(input.artifactId, 'wechat');
    expect(publish).toHaveBeenCalledWith('game', 'abc12345', expect.objectContaining({ filePath: 'index.html', deployMode: 'publish' }));
    expect(handoff.mock.calls[0][0].hiddenInstructions).toContain('kept OpenDesign selected');
    // Picked while the link is still publishing: the Agent must not claim it is live yet.
    expect(handoff.mock.calls[0][0].hiddenInstructions).toContain('正在发布');
    expect(handoff.mock.calls[0][0].hiddenInstructions).not.toContain('已发布');
    await settle();
    // Whether the link is still publishing or already live, the Agent never gets the URL to repeat.
    expect(handoff.mock.calls[0][0].hiddenInstructions).not.toContain('play.opendesign.app');
    await settle();
    expect(gamePublishSessionFor(input.artifactId)?.linkUrl).toBe('https://play.opendesign.app/g/abc');
  });

  it('with OpenDesign unselected, picking a platform does not publish the link', async () => {
    gamePublishActions.open(input);
    gamePublishActions.setLinkToo(input.artifactId, false);
    gamePublishActions.choose(input.artifactId, 'wechat');
    await settle();
    expect(publish).not.toHaveBeenCalled();
    expect(handoff.mock.calls[0][0].hiddenInstructions).not.toContain('kept OpenDesign selected');
    expect(gamePublishSessionFor(input.artifactId)).toMatchObject({ view: 'step', platformId: 'wechat' });
    expect(gamePublishSessionFor(input.artifactId)?.linkUrl).toBeUndefined();
  });

  it('the OpenDesign link is published when the user picks it', async () => {
    gamePublishActions.open(input);
    await gamePublishActions.publishLink(input.artifactId);
    expect(publish).toHaveBeenCalledWith('game', 'abc12345', expect.objectContaining({ filePath: 'index.html', deployMode: 'publish' }));
    expect(gamePublishSessionFor(input.artifactId)?.linkUrl).toBe('https://play.opendesign.app/g/abc');
  });

  it('shows a failed publish as failed and can retry', async () => {
    publish.mockRejectedValueOnce(new WebPublishApiError('AUTH_REQUIRED', 'Sign in first', 401));
    gamePublishActions.open(input);
    await gamePublishActions.publishLink(input.artifactId);
    let session = gamePublishSessionFor(input.artifactId)!;
    expect(session.linkUrl).toBeUndefined();
    expect(session.linkError).toEqual({ message: 'Sign in first', authRequired: true });
    expect(gamePublishThreadFor('chat-1').some(entry => entry.kind === 'link-failed')).toBe(true);
    await gamePublishActions.publishLink(input.artifactId);
    session = gamePublishSessionFor(input.artifactId)!;
    expect(session.linkUrl).toBe('https://play.opendesign.app/g/abc');
    expect(session.linkError).toBeUndefined();
  });

  it('WeChat goes to the Agent in this conversation and adds no cards of its own', async () => {
    gamePublishActions.open(input);
    // OpenDesign off, so only WeChat's own entries would show (the link logs its own publishing).
    gamePublishActions.setLinkToo(input.artifactId, false);
    gamePublishActions.choose(input.artifactId, 'wechat');
    await settle();
    expect(handoff).toHaveBeenCalledTimes(1);
    const payload = handoff.mock.calls[0][0];
    expect(payload).toMatchObject({ prompt: '把「Coin Jar」上架到微信小游戏', mode: 'game', newChat: false, autoSend: true });
    expect(payload.hiddenInstructions).toContain('openmotion_game_wechat');
    expect(payload.hiddenInstructions).toContain('Game id: abc12345');
    expect(gamePublishThreadFor('chat-1')).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    expect(gamePublishSessionFor(input.artifactId)).toMatchObject({ view: 'step', platformId: 'wechat', wechat: { status: { current: 'key' } } });
  });

  it('WeChat progress follows the local service, not the conversation', async () => {
    vi.useFakeTimers();
    try {
      gamePublishActions.open(input);
      gamePublishActions.choose(input.artifactId, 'wechat');
      await vi.advanceTimersByTimeAsync(0);
      expect(gamePublishSessionFor(input.artifactId)?.wechat?.status?.current).toBe('key');
      wx.state.mockResolvedValue(wechatStatus('ip'));
      await vi.advanceTimersByTimeAsync(2600);
      expect(gamePublishSessionFor(input.artifactId)?.wechat?.status?.current).toBe('ip');
      // Hidden panel: no more reads.
      gamePublishActions.close(input.artifactId);
      const calls = wx.state.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(wx.state.mock.calls.length).toBe(calls);
      // Opening it again reads again.
      gamePublishActions.reopen(input.artifactId);
      await vi.advanceTimersByTimeAsync(0);
      expect(wx.state.mock.calls.length).toBe(calls + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('WeChat reports when the progress cannot be read', async () => {
    wx.state.mockRejectedValue(new Error('fetch failed'));
    gamePublishActions.open(input);
    gamePublishActions.choose(input.artifactId, 'wechat');
    await settle();
    expect(gamePublishSessionFor(input.artifactId)?.wechat).toMatchObject({ error: 'fetch failed', status: undefined });
  });

  it('the upload key goes from the file chooser to the local service only, then the progress is read again', async () => {
    gamePublishActions.open(input);
    gamePublishActions.choose(input.artifactId, 'wechat');
    await settle();
    wx.saveKey.mockResolvedValue({ appid: 'wx0123456789abcdef', hasKey: true, savedAt: 'now' });
    wx.state.mockResolvedValue(wechatStatus('ip'));
    await gamePublishActions.saveWechatKey(input.artifactId, ['-----BEGIN', 'RSA PRIVATE KEY-----x-----END', 'RSA PRIVATE KEY-----'].join(' '));
    expect(wx.saveKey).toHaveBeenCalledWith('wx0123456789abcdef', expect.stringContaining('PRIVATE KEY'));
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(handoff.mock.calls)).not.toContain('PRIVATE KEY');
    expect(gamePublishSessionFor(input.artifactId)?.wechat).toMatchObject({ keySaving: false, status: { current: 'ip' } });
  });

  it('a progress read answered after the user picked another platform is dropped', async () => {
    let answer!: (value: unknown) => void;
    wx.state.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    gamePublishActions.open(input);
    gamePublishActions.choose(input.artifactId, 'wechat');
    gamePublishActions.choose(input.artifactId, 'telegram');
    answer(wechatStatus('ip'));
    await settle();
    expect(gamePublishSessionFor(input.artifactId)?.wechat?.status).toBeUndefined();
  });

  it('other platforms hand the job to the Agent: no cards in the conversation, steps finish with a message to it', async () => {
    gamePublishActions.open(input);
    gamePublishActions.setLinkToo(input.artifactId, false); // only this platform's entries
    gamePublishActions.choose(input.artifactId, 'itch');
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ newChat: false, autoSend: true, mode: 'game', prompt: expect.stringContaining('Coin Jar') }));
    const guide = handoff.mock.calls[0][0].hiddenInstructions as string;
    expect(guide).toContain('abc12345');
    expect(guide).toContain('Step 1 of 2 · Download the HTML5 zip');
    expect(guide).toContain('"Downloaded"');
    expect(guide).toContain('One step per message');
    expect(guide).not.toContain('kept OpenDesign selected');
    await settle();
    gamePublishActions.completeStep(input.artifactId, { platformId: 'itch', stepIndex: 0 });
    expect(handoff).toHaveBeenLastCalledWith({ prompt: 'Done: Download the HTML5 zip', mode: 'game', newChat: false, autoSend: true });
    expect(gamePublishSessionFor(input.artifactId)?.stepIndex).toBe(1);
    // Only real work is logged in the conversation (the package build); there are no step cards or local user lines.
    expect(gamePublishThreadFor('chat-1').map(entry => entry.kind)).toEqual(['agent']);
  });

  it('copying the link reports a failed copy as a failure', async () => {
    const notify = vi.fn();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await copyGamePublishLink('play.opendesign.app/g/abc', notify, key => key);
    expect(writeText).toHaveBeenCalledWith('https://play.opendesign.app/g/abc');
    expect(notify).toHaveBeenCalledWith('Could not copy the link', 'error');
  });

  it('other platforms also publish the OpenDesign link by default and tell the Agent', async () => {
    gamePublishActions.open(input);
    gamePublishActions.choose(input.artifactId, 'itch');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0][0].hiddenInstructions).toContain('kept OpenDesign selected');
    await settle();
    expect(gamePublishSessionFor(input.artifactId)?.linkUrl).toBe('https://play.opendesign.app/g/abc');
  });

  it('a developer tool is asked for under the Agent message; "Later" goes back to the platform list', () => {
    gamePublishActions.open(input);
    gamePublishActions.setLinkToo(input.artifactId, false); // only this platform's entries
    gamePublishActions.choose(input.artifactId, 'qq');
    gamePublishActions.skipDevTool(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)).toMatchObject({ view: 'list', platformId: undefined, toolCheck: undefined });
    expect(gamePublishThreadFor('chat-1')).toEqual([]);
  });

  it('builds a real itch.io zip from the game files before the user can continue', async () => {
    gamePublishActions.open(input);
    gamePublishActions.choose(input.artifactId, 'itch');
    gamePublishActions.completeStep(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)?.stepProblem).toBe('The package is not ready yet.');
    await settle();
    const session = gamePublishSessionFor(input.artifactId)!;
    expect(session.package?.state).toBe('ready');
    expect(session.package?.result?.fileName).toBe('coin-jar-itch.zip');
    gamePublishActions.completeStep(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)?.stepIndex).toBe(1);
  });

  it('playable ad needs a network and a valid store link, then builds for that network', async () => {
    gamePublishActions.open(input);
    gamePublishActions.choose(input.artifactId, 'playable-ad');
    gamePublishActions.completeStep(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)?.stepProblem).toBe('Choose one first.');
    gamePublishActions.pick(input.artifactId, 'AppLovin');
    gamePublishActions.completeStep(input.artifactId);
    gamePublishActions.setInput(input.artifactId, 'iOS App Store link', 'apps.apple.com/app/id1');
    gamePublishActions.completeStep(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)?.stepProblem).toBe('Store links must start with https://');
    gamePublishActions.setInput(input.artifactId, 'iOS App Store link', 'https://apps.apple.com/app/id1');
    gamePublishActions.completeStep(input.artifactId);
    await settle();
    const session = gamePublishSessionFor(input.artifactId)!;
    expect(session.package?.result?.fileName).toBe('coin-jar-applovin.html');
    const html = await session.package!.result!.blob.text();
    expect(html).toContain('<script src="mraid.js"></script>');
    expect(html).toContain('var game = 1;');
    expect(html).toContain('https://apps.apple.com/app/id1');
    expect(html).not.toMatch(/window\.open\(/);
  });

  it.each(PLAYABLE_NETWORKS)('passes the selected $name network and both store links to the real exporter', async network => {
    gamePublishActions.open({ ...input, orientation: 'landscape' });
    gamePublishActions.setLinkToo(input.artifactId, false);
    gamePublishActions.choose(input.artifactId, 'playable-ad');
    gamePublishActions.pick(input.artifactId, network.name);
    gamePublishActions.completeStep(input.artifactId);
    gamePublishActions.setInput(input.artifactId, 'iOS App Store link', ' https://apps.apple.com/app/id1 ');
    gamePublishActions.setInput(input.artifactId, 'Google Play link', ' https://play.google.com/store/apps/details?id=test ');
    gamePublishActions.completeStep(input.artifactId);
    await settle();
    const session = gamePublishSessionFor(input.artifactId)!;
    const result = session.package!.result!;
    expect(session).toMatchObject({ stepIndex: 2, picked: network.name, package: { state: 'ready', target: 'playable' } });
    expect(result.fileName).toBe(`coin-jar-${network.id}.${['google', 'tiktok'].includes(network.id) ? 'zip' : 'html'}`);
    const content = await result.blob.text();
    expect(content).toContain(network.ctaCode);
    expect(content).toContain('"ios":"https://apps.apple.com/app/id1"');
    expect(content).toContain('"android":"https://play.google.com/store/apps/details?id=test"');
    if (network.id === 'google') expect(content).toContain('name="ad.orientation" content="landscape"');
    if (network.id === 'tiktok') expect(content).toContain('"playable_orientation":2');
    expect(publish).not.toHaveBeenCalled();
    gamePublishActions.completeStep(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)?.view).toBe('result');
  });

  it.each(['xiaohongshu', 'douyin', 'itch'] as const)('builds the package declared by the %s guide', async id => {
    gamePublishActions.open(input);
    gamePublishActions.setLinkToo(input.artifactId, false);
    gamePublishActions.choose(input.artifactId, id);
    await settle();
    expect(gamePublishSessionFor(input.artifactId)?.package).toMatchObject({ state: 'ready', target: gamePublishPlatform(id)!.steps[0].packageTarget, result: { fileName: `coin-jar-${id}.zip` } });
    gamePublishActions.completeStep(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)?.stepIndex).toBe(1);
  });

  it.each(['douyin-minigame', 'qq'] as const)('keeps %s as a manual port and does not fabricate an export', async id => {
    gamePublishActions.open(input);
    gamePublishActions.setLinkToo(input.artifactId, false);
    gamePublishActions.choose(input.artifactId, id);
    expect(gamePublishSessionFor(input.artifactId)?.toolCheck?.state).toBe('missing');
    gamePublishActions.confirmDevTool(input.artifactId);
    for (let step = 0; step < gamePublishPlatform(id)!.steps.length; step++) gamePublishActions.completeStep(input.artifactId);
    await settle();
    expect(gamePublishSessionFor(input.artifactId)).toMatchObject({ view: 'result', package: undefined });
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires a real OpenDesign link before proceeding to BotFather', async () => {
    gamePublishActions.open(input);
    gamePublishActions.setLinkToo(input.artifactId, false);
    gamePublishActions.choose(input.artifactId, 'telegram');
    gamePublishActions.completeStep(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)).toMatchObject({ stepIndex: 0, stepProblem: 'Publish the OpenDesign link first.', package: undefined });
    await gamePublishActions.publishLink(input.artifactId);
    gamePublishActions.completeStep(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)).toMatchObject({ stepIndex: 1, linkUrl: 'https://play.opendesign.app/g/abc' });
    expect(publish).toHaveBeenCalledWith('game', input.gameId, expect.objectContaining({ deployMode: 'publish' }));
  });

  it('controls left from another platform or step do nothing', () => {
    gamePublishActions.open(input);
    gamePublishActions.choose(input.artifactId, 'telegram');
    gamePublishActions.completeStep(input.artifactId, { platformId: 'wechat', stepIndex: 0 });
    expect(gamePublishSessionFor(input.artifactId)).toMatchObject({ platformId: 'telegram', view: 'step', stepIndex: 0 });
  });

  it('reopening returns to the step in progress', () => {
    gamePublishActions.open(input);
    gamePublishActions.choose(input.artifactId, 'douyin');
    gamePublishActions.close(input.artifactId);
    gamePublishActions.reopen(input.artifactId);
    expect(gamePublishSessionFor(input.artifactId)).toMatchObject({ open: true, view: 'step', platformId: 'douyin' });
  });
});
