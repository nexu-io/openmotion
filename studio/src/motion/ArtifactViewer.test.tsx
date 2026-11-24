// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtifactViewer } from './ArtifactViewer';
import { EditorOpeningGateHost } from './editorOpeningGate';
import { I18nProvider } from '../i18n/I18n';
import type { SessionArtifact } from '../../../shared/session';

const navigate = vi.fn();
let pendingSuspend: Promise<void> | null = null;

vi.mock('../App', () => ({ StudioApp: ({ resolvedProjectId }: { resolvedProjectId: string }) => {
  if (pendingSuspend) throw pendingSuspend;
  return <div>
    <header className="motion-studio-header"><button onClick={() => navigate(resolvedProjectId)}>Assets</button></header>
    <div className="hf-dock"><div className="dv-groupview"><div data-preview-pan-surface role="status">Loading preview</div><div data-studio-timeline /></div></div>
  </div>;
} }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  pendingSuspend = null;
  navigate.mockClear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { pendingSuspend = null; act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
const artifact = (projectId: string): SessionArtifact => ({ id: projectId, projectId, kind: 'motion-project', title: projectId });
async function render(projectId = 'first') {
  await act(async () => root.render(<I18nProvider><ArtifactViewer key={projectId} artifact={artifact(projectId)} /></I18nProvider>));
}
it('lets the user navigate the current project while its preview is loading', async () => {
  await render();
  await render('second');
  const editor = container.querySelector<HTMLElement>('.motion-project-editor')!;
  expect(editor.dataset.projectId).toBe('second');
  expect(editor.querySelector('[role="status"]')?.textContent).toBe('Loading preview');
  expect(container.querySelector('.motion-editor-loading')).toBeNull();
  const button = editor.querySelector('button')!;
  expect(button.closest('[inert], [aria-hidden="true"]')).toBeNull();
  act(() => button.click());
  expect(navigate).toHaveBeenCalledWith('second');
});

it('keeps the unified host opening cover active while the lazy editor suspends', async () => {
  let resolveEditor!: () => void;
  pendingSuspend = new Promise<void>((resolve) => {
    resolveEditor = () => {
      pendingSuspend = null;
      resolve();
    };
  });

  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <EditorOpeningGateHost shellLoading={false} suppressed={false} targetProjectId="first">
          <ArtifactViewer key="first" artifact={artifact('first')} />
        </EditorOpeningGateHost>
      </I18nProvider>,
    );
  });

  const cover = container.querySelector('[data-testid="editor-asset-loading-overlay"]');
  expect(cover?.getAttribute('data-visible')).toBe('true');
  expect(container.querySelectorAll('.motion-loading')).toHaveLength(1);
  expect(container.querySelector('.motion-editor-loading')).toBeNull();

  await act(async () => {
    resolveEditor();
  });

  expect(container.querySelector('.motion-project-editor')?.getAttribute('data-project-id')).toBe('first');
  expect(container.querySelector('[data-testid="editor-asset-loading-overlay"]')).toBeNull();
});
