// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { requestParameters } from './GenerationParameters';
import { ResizablePane, readPaneWidth } from './ResizablePane';
vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }));
it('merges advanced JSON and explicit typed controls, preserving native booleans and numbers', () => {
  expect(requestParameters({ advanced: '{"duration":8,"generate_audio":false,"seed":42}', values: { duration: 5 } })).toEqual({ duration: 5, generate_audio: false, seed: 42 });
  expect(() => requestParameters({ advanced: '[]', values: {} })).toThrow();
  expect(() => requestParameters({ advanced: '{', values: {} })).toThrow();
});
it('resizes with keyboard, bounds the pane, remembers width and resets on double click', async () => {
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.append(container);
  Object.defineProperty(container, 'clientWidth', { value: 1400 });
  const root = createRoot(container);
  const render = () => root.render(<ResizablePane className="test-pane" storageKey="test-width" initial={460} min={340} max={800} edge="left" label="Resize creator"><div>Content</div></ResizablePane>);
  try {
    await act(async () => render());
    const separator = container.querySelector('[role="separator"]')!;
    await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(container.querySelector<HTMLElement>('.test-pane')!.style.width).toBe('476px');
    expect(localStorage.getItem('test-width')).toBe('476');
    await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(container.querySelector<HTMLElement>('.test-pane')!.style.width).toBe('800px');
    await act(async () => separator.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(localStorage.getItem('test-width')).toBe('460');
    localStorage.setItem('test-width', 'Infinity'); expect(readPaneWidth('test-width', 460, 340, 800)).toBe(460);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
