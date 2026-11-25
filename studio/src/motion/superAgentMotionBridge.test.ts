// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  formatMotionSelectionLabel,
  formatTimeShort,
  hasRichMotionSelection,
  motionSnapshotToAttachment,
  type MotionSelectionSnapshot,
} from './superAgentMotionBridge';

function baseSnapshot(overrides: Partial<MotionSelectionSnapshot> = {}): MotionSelectionSnapshot {
  return {
    projectId: 'proj-motion-1',
    activeCompPath: 'index.html',
    editingFile: 'index.html',
    currentTime: 2.4,
    duration: 12,
    fps: 30,
    inPoint: null,
    outPoint: null,
    rangeSelection: null,
    domSelection: null,
    groupSelections: [],
    timelineClips: [],
    keyframeCount: 0,
    consoleErrors: [],
    ...overrides,
  };
}

describe('superAgentMotionBridge', () => {
  it('formats labels consistently across DOM, clip, range, in/out, and playhead selections', () => {
    expect(formatTimeShort(3.25)).toBe('3.3s');
    expect(formatMotionSelectionLabel(null)).toBe('Attach selection');

    expect(formatMotionSelectionLabel(baseSnapshot())).toBe('2.4s / 12.0s');

    expect(
      formatMotionSelectionLabel(
        baseSnapshot({ rangeSelection: { start: 1.5, end: 4.0 } }),
      ),
    ).toBe('1.5s–4.0s');

    expect(
      formatMotionSelectionLabel(
        baseSnapshot({ inPoint: 2, outPoint: 6 }),
      ),
    ).toBe('2.0s–6.0s');

    expect(
      formatMotionSelectionLabel(
        baseSnapshot({
          timelineClips: [{ id: 'c1', label: 'Hero Title', kind: 'text', start: 0.5, duration: 3 }],
        }),
      ),
    ).toBe('Hero Title · 0.5s–3.5s');

    expect(
      formatMotionSelectionLabel(
        baseSnapshot({
          timelineClips: [
            { id: 'c1', label: 'Clip A', start: 1, duration: 2 },
            { id: 'c2', label: 'Clip B', start: 2.5, duration: 3 },
          ],
        }),
      ),
    ).toBe('2 clips · 1.0s–5.5s');

    expect(
      formatMotionSelectionLabel(
        baseSnapshot({
          domSelection: { label: 'Headline', tagName: 'h1', selector: '#hero-h1' },
          groupSelections: [
            { label: 'Headline', tagName: 'h1', selector: '#hero-h1' },
            { label: 'Subhead', tagName: 'p', selector: '.hero-sub' },
          ],
        }),
      ),
    ).toBe('Headline (+1) · 2.4s');
  });

  it('detects rich selection state accurately', () => {
    expect(hasRichMotionSelection(null)).toBe(false);
    expect(hasRichMotionSelection(baseSnapshot())).toBe(false);
    expect(hasRichMotionSelection(baseSnapshot({ keyframeCount: 2 }))).toBe(true);
    expect(hasRichMotionSelection(baseSnapshot({ rangeSelection: { start: 1, end: 2 } }))).toBe(true);
    expect(
      hasRichMotionSelection(baseSnapshot({ timelineClips: [{ id: 'c1', label: 'Shot 1', start: 0, duration: 2 }] })),
    ).toBe(true);
    expect(
      hasRichMotionSelection(baseSnapshot({ domSelection: { label: 'Logo', tagName: 'svg', selector: 'svg.logo' } })),
    ).toBe(true);
  });

  it('converts motion selection, frame, and console snapshots into SuperAgent attachments', () => {
    const selectionAtt = motionSnapshotToAttachment({
      snapshot: baseSnapshot({
        activeCompPath: 'scenes/intro.html',
        editingFile: 'scenes/intro.html',
        inPoint: 1,
        outPoint: 5,
        keyframeCount: 3,
        domSelection: {
          label: 'CTA Pill',
          tagName: 'button',
          selector: 'button.cta',
          hfId: 'hf-btn-1',
          sourceFile: 'scenes/intro.html',
          text: 'Start now',
          rect: { x: 100, y: 200, width: 140, height: 40 },
        },
        timelineClips: [
          { id: 'c1', label: 'CTA Pill', kind: 'dom', start: 1, duration: 4, track: 1, sourceFile: 'scenes/intro.html' },
        ],
      }),
      artifactId: 'motion:proj-motion-1',
      artifactTitle: 'Launch Teaser',
      kind: 'selection',
      comment: 'Ease out the scale bounce',
    });

    expect(selectionAtt.kind).toBe('browser-annotation');
    expect(selectionAtt.title).toBe('CTA Pill · 2.4s');
    expect(selectionAtt.subtitle).toBe('Launch Teaser · scenes/intro.html');
    expect(selectionAtt.annotation?.mode).toBe('motion-selection');
    expect(selectionAtt.annotation?.projectId).toBe('proj-motion-1');
    expect(selectionAtt.annotation?.artifactKind).toBe('motion-project');
    expect(selectionAtt.annotation?.compositionPath).toBe('scenes/intro.html');
    expect(selectionAtt.annotation?.timeSec).toBe(2.4);
    expect(selectionAtt.annotation?.durationSec).toBe(12);
    expect(selectionAtt.annotation?.timeRange).toEqual({ start: 1, end: 5 });
    expect(selectionAtt.annotation?.keyframeCount).toBe(3);
    expect(selectionAtt.annotation?.comment).toBe('Ease out the scale bounce');
    expect(selectionAtt.annotation?.element?.selector).toBe('button.cta');
    expect(selectionAtt.annotation?.timelineClips?.length).toBe(1);

    const frameAtt = motionSnapshotToAttachment({
      snapshot: baseSnapshot({ currentTime: 4.5 }),
      artifactId: 'motion:proj-motion-1',
      artifactTitle: 'Launch Teaser',
      kind: 'frame',
      screenshotUrl: '/api/sa/shot-1.png',
      screenshotPath: '/tmp/shot-1.png',
    });
    expect(frameAtt.annotation?.mode).toBe('screenshot');
    expect(frameAtt.title).toBe('Frame @ 4.5s');
    expect(frameAtt.previewUrl).toBe('/api/sa/shot-1.png');

    const consoleAtt = motionSnapshotToAttachment({
      snapshot: baseSnapshot({ consoleErrors: ['TypeError: cannot read x', '404 logo.png'] }),
      artifactId: 'motion:proj-motion-1',
      artifactTitle: 'Launch Teaser',
      kind: 'console',
    });
    expect(consoleAtt.annotation?.mode).toBe('console');
    expect(consoleAtt.title).toBe('2 Motion console errors');
    expect(consoleAtt.annotation?.consoleErrors).toEqual(['TypeError: cannot read x', '404 logo.png']);
  });
});
