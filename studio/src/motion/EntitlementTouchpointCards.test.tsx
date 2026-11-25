// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { exceedsResolutionCap, imageResolutionCap, isInsufficientBalanceError, type CloudAccountSummary } from './AccountSettings';
import { AssetGenerationCard } from './AssetCreationVisuals';
import type { GenerationJob } from '../../../shared/gateway';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function signedInAccount(plan: string): CloudAccountSummary {
  return { state: 'signed-in', consoleUrl: 'https://open-design.ai', plan };
}

describe('Plus resolution cap & insufficient balance helpers', () => {
  it('enforces Plus 1K (2K for GPT 2.0), Pro 2K, Max 4K caps', () => {
    expect(imageResolutionCap(signedInAccount('Plus'), 'seedream-5.5')).toBe('1K');
    expect(imageResolutionCap(signedInAccount('Go Plus'), 'gpt-image-2.0')).toBe('2K');
    expect(imageResolutionCap(signedInAccount('Pro'), 'seedream-5.5')).toBe('2K');
    expect(imageResolutionCap(signedInAccount('Max'), 'seedream-5.5')).toBe('4K');

    expect(exceedsResolutionCap('1.5K', '1K')).toBe(true);
    expect(exceedsResolutionCap('2K', '1K')).toBe(true);
    expect(exceedsResolutionCap('1K', '1K')).toBe(false);
    expect(exceedsResolutionCap('1536x1024', '1K')).toBe(true);
    expect(exceedsResolutionCap('1024x1024', '1K')).toBe(false);
    expect(exceedsResolutionCap('2048x2048', '1K')).toBe(true);
    expect(exceedsResolutionCap('2048x2048', '2K')).toBe(false);
    expect(exceedsResolutionCap('4K', '2K')).toBe(true);
    expect(exceedsResolutionCap('4K', '4K')).toBe(false);
  });

  it('matches insufficient balance errors and never triggers on 429/503/rate limits', () => {
    expect(isInsufficientBalanceError('Your OpenDesign balance is too low for this request. Top up in OpenDesign Console, then try again.')).toBe(true);
    expect(isInsufficientBalanceError('402 Payment Required: insufficient credits')).toBe(true);
    expect(isInsufficientBalanceError('可用余额不足，请充值')).toBe(true);
    expect(isInsufficientBalanceError('HTTP 503 Service Unavailable')).toBe(false);
    expect(isInsufficientBalanceError('429 Too Many Requests: rate limit exceeded')).toBe(false);
    expect(isInsufficientBalanceError('Request timed out')).toBe(false);
  });
});

describe('U6 insufficient balance failure CTA', () => {
  it('shows Add credits CTA on insufficient balance failure but not on 503', () => {
    const baseJob: GenerationJob = {
      id: 'job-1',
      modality: 'image',
      state: 'failed',
      prompt: 'A neon robot poster',
      model: { id: 'account:seedream', label: 'Seedream 5.5', provider: 'account', modelId: 'seedream', modality: 'image', mode: 'text-to-image' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: '402 insufficient credits',
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<I18nProvider locale="en"><AssetGenerationCard job={baseJob} onCancel={vi.fn()} onView={vi.fn()} /></I18nProvider>);
    });
    expect(host.textContent).toContain('Not enough credits to generate');
    expect(Array.from(host.querySelectorAll('button')).some(btn => btn.textContent?.includes('Add credits'))).toBe(true);

    act(() => {
      root!.render(<I18nProvider locale="en"><AssetGenerationCard job={{ ...baseJob, error: 'HTTP 503 Service Unavailable' }} onCancel={vi.fn()} onView={vi.fn()} /></I18nProvider>);
    });
    expect(host.textContent).not.toContain('Not enough credits to generate');

    act(() => {
      root!.render(<I18nProvider locale="en"><AssetGenerationCard job={{ ...baseJob, model: { ...baseJob.model, id: 'openai:gpt-image-1', provider: 'openai' }, error: 'insufficient_quota' }} onCancel={vi.fn()} onView={vi.fn()} /></I18nProvider>);
    });
    expect(host.textContent).not.toContain('Not enough credits to generate');
  });
});
