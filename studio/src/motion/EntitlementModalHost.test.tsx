// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validProperties } from '../../../tracking/core';
import { omEvents } from '../../../tracking/events';
import { EntitlementModalHost } from './EntitlementModalHost';
import { markExternalCheckoutPending } from './entitlementModalBus';

const mocks = vi.hoisted(() => ({
  gatewayRequest: vi.fn(),
  trackMotion: vi.fn(),
}));

vi.mock('./gatewayClient', () => ({ gatewayRequest: mocks.gatewayRequest }));
vi.mock('./useProviderDirectory', () => ({ notifyProvidersChanged: vi.fn() }));
vi.mock('./tracking', () => ({ trackMotion: mocks.trackMotion }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function triggerWindowReturn() {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe('EntitlementModalHost checkout-return telemetry', () => {
  it('emits valid entitlement_refresh_result on successful plan refresh and rejects private fields', async () => {
    const entryId = '11111111-1111-4111-8111-111111111111';
    mocks.gatewayRequest.mockResolvedValueOnce({ billing: { plan: 'Go Plus', unavailable: false } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<EntitlementModalHost />));

    markExternalCheckoutPending('header_pricing', entryId);
    await triggerWindowReturn();

    expect(mocks.trackMotion).toHaveBeenCalledWith('entitlement_refresh_result', {
      outcome: 'success',
      hook_id: 'header_pricing',
      entry_id: entryId,
      plan_after: 'go_plus',
    });
    const payload = mocks.trackMotion.mock.calls[0][1];
    expect(validProperties(omEvents, 'entitlement_refresh_result', payload)).toBe(true);
    expect(validProperties(omEvents, 'entitlement_refresh_result', { ...payload, prompt: 'secret' })).toBe(false);
  });

  it('reports failure without placeholder plan_after when billing is unavailable', async () => {
    const entryId = '22222222-2222-4222-8222-222222222222';
    mocks.gatewayRequest.mockResolvedValueOnce({ billing: { plan: 'unknown', unavailable: true } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<EntitlementModalHost />));

    markExternalCheckoutPending('studio_free_gate', entryId);
    await triggerWindowReturn();

    expect(mocks.trackMotion).toHaveBeenCalledWith('entitlement_refresh_result', {
      outcome: 'failure',
      hook_id: 'studio_free_gate',
      entry_id: entryId,
    });
    const payload = mocks.trackMotion.mock.calls[0][1];
    expect(validProperties(omEvents, 'entitlement_refresh_result', payload)).toBe(true);
  });
});
