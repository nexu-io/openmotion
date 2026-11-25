// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CompactLink } from './WechatProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const URL = 'https://open-design.app/artifact/0f3c9a52-7b1e-4c55-9d0a-8e2f6b1a4c77/index.html?kind=game';

describe('CompactLink', () => {
  it('folds a published link to one line, shows it on demand and copies the full URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(CompactLink, { url: URL })); });
    expect(host.textContent).not.toContain(URL);
    expect(host.querySelector('a')?.getAttribute('href')).toBe(URL);
    expect(host.querySelector('a')?.getAttribute('title')).toBe(URL);
    const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
    await act(async () => { button('Copy link').click(); });
    expect(writeText).toHaveBeenCalledWith(URL);
    await act(async () => { button('Show link').click(); });
    expect(host.querySelector('code')?.textContent).toBe(URL);
    await act(async () => { button('Hide link').click(); });
    expect(host.querySelector('code')).toBeNull();
    await act(async () => { root.unmount(); });
  });
});
