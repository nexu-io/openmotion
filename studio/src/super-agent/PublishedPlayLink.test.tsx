// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { SimpleMarkdown, isPublishedPlayLink } from './SimpleMarkdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const PLAY = 'https://open-design.app/artifact/0f3c9a52-7b1e-4c55-9d0a-8e2f6b1a4c77/index.html?kind=game';

describe('published OpenDesign play links in Agent messages', () => {
  it('recognises published play links only', () => {
    expect(isPublishedPlayLink(PLAY)).toBe(true);
    expect(isPublishedPlayLink('https://play.opendesign.app/g/abc')).toBe(true);
    expect(isPublishedPlayLink('https://open-design.app/pricing')).toBe(false);
    expect(isPublishedPlayLink('https://mp.weixin.qq.com/')).toBe(false);
  });

  it('shows a bare or self-labelled play link as "Open", keeps other links as written', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const content = `试玩链接：${PLAY}\n\n[${PLAY}](${PLAY})\n\n公众平台：https://mp.weixin.qq.com/`;
    await act(async () => { root.render(createElement(SimpleMarkdown, { content })); });
    expect(host.textContent).not.toContain('open-design.app');
    const links = [...host.querySelectorAll('a')];
    expect(links.filter(link => link.getAttribute('href') === PLAY).map(link => link.textContent)).toEqual(['Open', 'Open']);
    expect(host.textContent).toContain('https://mp.weixin.qq.com/');
    await act(async () => { root.unmount(); });
  });
});
