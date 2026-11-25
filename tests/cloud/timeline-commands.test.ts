import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSourceDocument } from '@hyperframes/studio-server/source-mutation';
import { applyTimelineCommand as apply } from '../../packages/edit-core/timeline-commands.ts';

const source =
  '<div data-composition-id="scene" data-duration="10"><video id="v" data-hf-id="v" src="v.mp4" data-start="1" data-duration="4" data-track-index="1" data-media-start="2" data-playback-rate="2"></video><audio id="b" data-hf-id="b" data-start="7" data-duration="3" data-track-index="1"></audio><script>const tl=gsap.timeline();tl.to("#v",{duration:1,x:10},2);tl.to("#b",{duration:1,x:20},7.5);</script></div>';
const root = (s: string) => parseSourceDocument(s).document;
test('trim derives the media in point, animation scale and sibling timing from stored source', () => {
  const after = apply(source, { kind: 'trimClips', changes: [{ hfId: 'v', start: 2, duration: 2 }] });
  assert.equal(root(after).querySelector('#v')?.getAttribute('data-media-start'), '4');
  assert.match(after, /duration:0.5,x:10\},2.5/);
  assert.match(after, /duration:1,x:20\},7.5/);
});
test('moves, cuts, links, ripple deletion, track flags and gap closing are atomic source edits', () => {
  const moved = apply(source, {
    kind: 'moveClips',
    changes: [
      { hfId: 'v', start: 2, track: 3 },
      { hfId: 'b', start: 8 },
    ],
  });
  assert.equal(root(moved).querySelector('#v')?.getAttribute('data-track-index'), '3');
  assert.match(moved, /duration:1,x:20\},8.5/);
  const cut = root(apply(source, { kind: 'splitClips', hfIds: ['v'], at: 3 }));
  assert.equal(cut.querySelector('#v-split')?.getAttribute('data-media-start'), '6');
  const linked = apply(source, { kind: 'linkClips', hfIds: ['v', 'b'] });
  assert.equal(root(linked).querySelectorAll('[data-link]').length, 2);
  assert.equal(
    root(apply(linked, { kind: 'unlinkClips', hfIds: ['b'] })).querySelectorAll('[data-link]').length,
    0,
  );
  const removed = apply(linked, { kind: 'deleteClips', hfIds: ['v'], rippleTrack: 1 });
  assert.equal(root(removed).querySelector('#b')?.getAttribute('data-start'), '3');
  assert.equal(root(removed).querySelectorAll('[data-link]').length, 0);
  const compacted = apply(source, { kind: 'closeTrackGaps', track: 1 });
  assert.equal(root(compacted).querySelector('#b')?.getAttribute('data-start'), '4');
  const locked = apply(source, { kind: 'setClipState', state: 'locked', enabled: true, hfIds: ['b'] });
  assert.throws(
    () =>
      apply(locked, {
        kind: 'moveClips',
        changes: [
          { hfId: 'v', start: 2 },
          { hfId: 'b', start: 5 },
        ],
      }),
    /Unlock/,
  );
});

test('headless detach, linked move, resync and merge use the authored media', () => {
  const detached = apply(source, { kind: 'detachAudio', hfId: 'v' });
  assert.equal(apply(source, { kind: 'detachAudio', hfId: 'v' }), detached);
  const audioId = root(detached).querySelector('audio[data-link]')!.getAttribute('data-hf-id')!;
  const moved = apply(detached, {
    kind: 'moveClips',
    changes: [{ hfId: 'v', start: 3 }],
    includeLinked: true,
  });
  assert.equal(root(moved).querySelector('audio[data-link]')!.getAttribute('data-start'), '3');
  const drift = apply(moved, { kind: 'moveClips', changes: [{ hfId: audioId, start: 4 }] });
  const synced = apply(drift, { kind: 'moveIntoSync', hfId: audioId });
  assert.equal(root(synced).querySelector('audio[data-link]')!.getAttribute('data-start'), '3');
  const merged = apply(synced, { kind: 'mergeAudio', videoId: 'v', audioId });
  assert.equal(root(merged).querySelector('[data-sync-origin]'), null);
  assert.equal(root(merged).querySelector('#v')!.hasAttribute('muted'), false);
});

test('speed preserves the media in point and respects the occupied lane and ripple setting', () => {
  const speed = { kind: 'setClipSpeed' as const, hfId: 'v', rate: 1 };
  const lane = source.replace('<audio id="b"', '<video id="b"').replace('</audio>', '</video>');
  const limited = root(apply(lane, speed)).querySelector('#v')!;
  assert.equal(limited.getAttribute('data-duration'), '6');
  assert.equal(limited.getAttribute('data-media-start'), '2');
  const ripple = root(apply(lane, { ...speed, ripple: true }));
  assert.equal(ripple.querySelector('#v')?.getAttribute('data-duration'), '8');
  assert.equal(ripple.querySelector('#b')?.getAttribute('data-start'), '11');
  assert.equal(ripple.querySelector('#v')?.getAttribute('data-playback-rate'), '1');
});

test('a headless cut uses measured media length only when the file has no authored duration', () => {
  const media =
    '<div data-composition-id="s" data-duration="6"><video id="v" data-hf-id="v" data-start="0" src="a.mp4"></video></div>';
  const split = root(
    apply(media, {
      kind: 'splitClips',
      hfIds: ['v'],
      at: 2,
      measured: [{ hfId: 'v', start: 0, duration: 6, track: 3 }],
    }),
  );
  assert.equal(split.querySelector('#v-split')?.getAttribute('data-duration'), '4');
  assert.equal(split.querySelector('#v-split')?.getAttribute('data-track-index'), '3');
});

test('moving unclocked root text materializes its original composition window', () => {
  const html =
    '<div data-composition-id="s" data-duration="4"><p id="title" data-hf-id="title">Title</p></div>';
  const moved = root(apply(html, { kind: 'moveClips', changes: [{ hfId: 'title', start: 2 }] }));
  assert.equal(moved.querySelector('#title')?.getAttribute('data-start'), '2');
  assert.equal(moved.querySelector('#title')?.getAttribute('data-duration'), '4');
  assert.equal(moved.querySelector('[data-composition-id]')?.getAttribute('data-duration'), '6');
});

test('moving and trimming an untimed root canvas clip inherits the composition duration', () => {
  const html =
    '<div data-composition-id="hyper-world" data-duration="47.2"><canvas id="hyper-canvas" data-hf-id="hf-yeey" width="1546" height="870"></canvas></div>';
  const moved = root(apply(html, { kind: 'moveClips', changes: [{ hfId: 'hf-yeey', start: 2, track: 0 }] }));
  assert.equal(moved.querySelector('#hyper-canvas')?.getAttribute('data-start'), '2');
  assert.equal(moved.querySelector('#hyper-canvas')?.getAttribute('data-duration'), '47.2');
  assert.equal(moved.querySelector('[data-composition-id]')?.getAttribute('data-duration'), '49.2');

  const trimmed = root(
    apply(html, { kind: 'trimClips', changes: [{ hfId: 'hf-yeey', start: 5, duration: 20 }] }),
  );
  assert.equal(trimmed.querySelector('#hyper-canvas')?.getAttribute('data-start'), '5');
  assert.equal(trimmed.querySelector('#hyper-canvas')?.getAttribute('data-duration'), '20');
});

test('splitting a script-driven canvas element or canvas wrapper directly is rejected', () => {
  const bareCanvas =
    '<div data-composition-id="hyper-world" data-duration="47.2"><canvas id="hyper-canvas" data-hf-id="hf-yeey" data-start="0" data-duration="47.2"></canvas></div>';
  assert.throws(
    () => apply(bareCanvas, { kind: 'splitClips', hfIds: ['hf-yeey'], at: 15 }),
    /Canvas layers cannot be split directly/,
  );

  const canvasWrapper =
    '<div data-composition-id="lark-magic-share" data-duration="36.6"><div id="magic-world" data-hf-id="hf-z4ka" class="clip" data-start="0" data-duration="36.6"><canvas id="magic-canvas" data-hf-id="hf-y5hb" width="1280" height="720"></canvas></div></div>';
  assert.throws(
    () => apply(canvasWrapper, { kind: 'splitClips', hfIds: ['hf-z4ka'], at: 4.1 }),
    /Canvas layers cannot be split directly/,
  );

  const subCompHost =
    '<div data-composition-id="main" data-duration="10"><div id="welcome-gallery" data-hf-id="hf-gal" data-composition-id="welcome-gallery" data-composition-src="compositions/gallery.html" data-start="0" data-duration="10"></div></div>';
  const splitSubComp = root(apply(subCompHost, { kind: 'splitClips', hfIds: ['hf-gal'], at: 5 }));
  assert.ok(splitSubComp.querySelector('#welcome-gallery-split'));
});

test('a headless lane move updates paint order and time atomically, refusing a locked paint target', () => {
  const html =
    '<div data-composition-id="s" data-duration="6"><div id="a" data-hf-id="a" data-start="0" data-duration="4" data-track-index="2" style="z-index:1"></div><div id="b" data-hf-id="b" data-start="0" data-duration="4" data-track-index="1" style="z-index:5"></div></div>';
  const move = {
    kind: 'moveClips' as const,
    changes: [{ hfId: 'a', start: 1, track: 0 }],
    stacking: { hfId: 'a', direction: 'up' as const },
  };
  const moved = root(apply(html, move)).querySelector('#a') as HTMLElement;
  assert.equal(moved.getAttribute('data-start'), '1');
  assert.ok(Number(moved.style.getPropertyValue('z-index')) > 5);
  const locked = html.replace('id="b" data-hf-id', 'id="b" data-timeline-locked data-hf-id');
  assert.throws(() => apply(locked, { ...move, stacking: { ranks: [{ hfId: 'b', zIndex: 1 }] } }), /Unlock/);
});

test('locked track controls toggle mute and visibility without releasing the edit lock', () => {
  const clip = (source: string) => root(source).querySelector('#b')!;
  let html = apply(source, { kind: 'setClipState', state: 'locked', enabled: true, hfIds: ['b'] });
  for (const [state, attr] of [['muted', 'muted'], ['hidden', 'data-hidden']] as const) {
    for (const enabled of [true, false]) {
      html = apply(html, { kind: 'setClipState', state, enabled, hfIds: ['b'] });
      assert.equal(clip(html).hasAttribute(attr), enabled);
      assert.ok(clip(html).hasAttribute('data-timeline-locked'));
    }
  }
  assert.throws(() => apply(html, { kind:'deleteClips', hfIds:['b'] }), /Unlock/);
  const unlocked = apply(html, { kind: 'setClipState', state: 'locked', enabled: false, hfIds: ['b'] });
  assert.equal(clip(unlocked).hasAttribute('data-timeline-locked'), false);
});
