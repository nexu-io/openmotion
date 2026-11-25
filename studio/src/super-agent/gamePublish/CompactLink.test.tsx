// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CompactLink } from './WechatProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const URL = 'https://open-design.app/artifact/0f3c9a52-7b1e-4c55-9d0a-8e2f6b1a4c77/index.html?kind=game';

describe('CompactLink', () => {
  it('shows a published link only as Open and Copy link, never as text, and copies the full URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(CompactLink, { url: URL })); });
    expect(host.textContent).not.toContain('open-design.app');
    expect(host.innerHTML.replace(/href="[^"]*"/, '')).not.toContain('open-design.app');
    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect([...host.querySelectorAll('button')].map(item => item.textContent)).toEqual(['Copy link']);
    await act(async () => { host.querySelector('button')!.click(); });
    expect(writeText).toHaveBeenCalledWith(URL);
    await act(async () => { root.unmount(); });
  });
});
