// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { setCachedCloudDisklessMode } from './cloudRuntime';
import {
  CLOUD_P1_FEATURES,
  isCloudFeatureEnabled,
  setCloudFeatureOverridesForTest,
  useCloudFeatureEnabled,
  type CloudFeatureKey,
} from './cloudFeatures';
import { useTranscriptServiceAvailable } from '../motion/useTranscriptServiceAvailable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  document.head.querySelector('meta[name="openmotion-runtime"]')?.remove();
  setCloudFeatureOverridesForTest(null);
  setCachedCloudDisklessMode(null);
});

const allFeatureKeys = Object.keys(CLOUD_P1_FEATURES) as CloudFeatureKey[];

describe('cloudFeatures', () => {
  it('enables all features by default in local/non-cloud mode', () => {
    setCachedCloudDisklessMode(false);
    for (const key of allFeatureKeys) {
      expect(isCloudFeatureEnabled(key)).toBe(true);
    }
  });

  it('disables all Cloud P1 deferred features when cloud-diskless mode is active', () => {
    setCachedCloudDisklessMode(true);
    for (const key of allFeatureKeys) {
      expect(isCloudFeatureEnabled(key)).toBe(false);
    }
  });

  it('reads cloud-diskless mode from the injected runtime meta tag', () => {
    const meta = document.createElement('meta');
    meta.name = 'openmotion-runtime';
    meta.content = 'cloud-diskless';
    document.head.append(meta);
    expect(isCloudFeatureEnabled('gameStudio')).toBe(false);
    expect(isCloudFeatureEnabled('workflows')).toBe(false);
    expect(isCloudFeatureEnabled('modelProviders')).toBe(false);
  });

  it('reacts to cloud-diskless updates and test overrides in React hooks', async () => {
    let asr = true;
    let transcriptAvailable = true;
    let workflows = true;

    function Probe() {
      asr = useCloudFeatureEnabled('asr');
      transcriptAvailable = useTranscriptServiceAvailable();
      workflows = useCloudFeatureEnabled('workflows');
      return <div data-asr={String(asr)} data-workflows={String(workflows)} />;
    }

    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    setCachedCloudDisklessMode(false);
    await act(async () => root!.render(<Probe />));
    expect(asr).toBe(true);
    expect(transcriptAvailable).toBe(true);
    expect(workflows).toBe(true);

    await act(async () => {
      setCachedCloudDisklessMode(true);
    });
    expect(asr).toBe(false);
    expect(transcriptAvailable).toBe(false);
    expect(workflows).toBe(false);

    setCloudFeatureOverridesForTest({ workflows: true });
    await act(async () => root!.render(<Probe />));
    expect(asr).toBe(false);
    expect(workflows).toBe(true);
  });
});
