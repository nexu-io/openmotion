// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { MotionStudioPage } from './MotionStudioPage';
import { TemplateLibraryDialog } from './TemplateLibraryDialog';
import { WorkspaceFrame } from './WorkspaceFrame';
import { WorkspaceChromeContext, type WorkspaceChrome } from './WorkspaceChromeContext';
import {
  clearAuthPendingDraft,
  consumeAuthCancelledFromUrl,
  readAuthPendingDraft,
  saveAuthPendingDraft,
} from './authRecoveryStore';
import type { GalleryTemplate } from '../../../shared/catalog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./useCoveredTemplates', () => ({
  readCachedCoveredTemplates: () => null,
  useCoveredTemplates: () => ({
    catalog: [],
    firstPage: { items: [], total: 0 },
    failed: false,
    retry: vi.fn(),
  }),
}));

const editableTemplate: GalleryTemplate = {
  id: 'custom-agents',
  title: 'Custom Agents.',
  description: 'Editable template',
  kind: 'builtin',
  collection: 'builtin',
  tags: [],
  duration: 10,
  width: 1920,
  height: 1080,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/motion');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearAuthPendingDraft();
  vi.restoreAllMocks();
});

describe('Guest creation entry points (OPEND-5648)', () => {
  it('keeps Open Motion Editor and New project enabled for guests and routes clicks into login intent', async () => {
    const startGuestSignIn = vi.fn();
    const onOpenEditor = vi.fn(() => startGuestSignIn({ action: 'open_editor' }));
    const create = vi.fn();

    const chrome = {
      workspace: {
        projects: [],
        activeProjectId: null,
        trashedProjects: [],
        sessions: [],
        session: undefined,
        status: null,
        authRequired: true,
        busy: false,
        actingRef: { current: false },
        navigationError: null,
        connectionError: '',
        error: '',
        errorSource: 'connection' as const,
        checkingConnection: false,
        retryConnection: vi.fn(),
        open: vi.fn(),
        followActiveProject: vi.fn(),
        create,
        home: vi.fn(),
        rename: vi.fn(),
        startSession: vi.fn(),
        openSession: vi.fn(),
        createArtifact: vi.fn(),
        renameSession: vi.fn(),
        clearError: vi.fn(),
      },
      switchingDisabled: false,
      guestMode: true,
      startGuestSignIn,
      saveState: '',
      openLibrary: vi.fn(),
      openConnections: vi.fn(),
      openModelSettings: vi.fn(),
      openHome: vi.fn(),
      openAssets: vi.fn(),
      assetsOpen: false,
      openSkills: vi.fn(),
      skillsOpen: false,
      toggleSidebar: vi.fn(),
      sidebarOpen: false,
      navigationCollapsed: true,
      registerEditor: vi.fn(),
      beforeViewChange: async () => {},
    } as unknown as WorkspaceChrome;

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="zh-CN">
          <WorkspaceChromeContext.Provider value={chrome}>
            <MotionStudioPage active editorDisabled={false} onOpenEditor={onOpenEditor} />
          </WorkspaceChromeContext.Provider>
        </I18nProvider>,
      );
    });

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
    const openEditorBtn = buttons.find(btn => btn.textContent?.includes('打开 Motion 编辑器'));
    const newProjectBtn = buttons.find(btn => btn.getAttribute('aria-label') === '新建项目');

    expect(openEditorBtn).toBeDefined();
    expect(openEditorBtn?.disabled).toBe(false);
    expect(newProjectBtn).toBeDefined();
    expect(newProjectBtn?.disabled).toBe(false);

    await act(async () => {
      openEditorBtn!.click();
    });
    expect(startGuestSignIn).toHaveBeenCalledWith({ action: 'open_editor' });

    await act(async () => {
      newProjectBtn!.click();
    });
    expect(startGuestSignIn).toHaveBeenCalledWith({ action: 'create_project' });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps Open and edit enabled on editable templates for guests and triggers guest login with an idempotency key', async () => {
    const onGuestTemplateSignIn = vi.fn();
    const onPrepareTemplate = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [editableTemplate], total: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="zh-CN">
          <TemplateLibraryDialog
            open
            detailOnly
            initialTemplate={editableTemplate}
            templateId={editableTemplate.id}
            busy={false}
            openingDisabled={false}
            guestMode
            onGuestTemplateSignIn={onGuestTemplateSignIn}
            onPrepareTemplate={onPrepareTemplate}
            error=""
            onClose={() => {}}
            onOpen={() => {}}
          />
        </I18nProvider>,
      );
    });

    const openEditBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find(btn =>
      btn.textContent?.includes('打开并编辑'),
    );
    expect(openEditBtn).toBeDefined();
    expect(openEditBtn?.disabled).toBe(false);

    await act(async () => {
      openEditBtn!.click();
    });

    expect(onGuestTemplateSignIn).toHaveBeenCalledTimes(1);
    const [templateId, requestId] = onGuestTemplateSignIn.mock.calls[0] as [string, string];
    expect(templateId).toBe('custom-agents');
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(8);
    expect(onPrepareTemplate).not.toHaveBeenCalled();
  });

  it('retains a single idempotencyKey for login resume and clears autoResume if login is cancelled', () => {
    const saved = saveAuthPendingDraft({
      action: 'use_template',
      templateId: 'custom-agents',
      returnTo: '/explore?template=custom-agents',
      autoResume: true,
    });
    expect(readAuthPendingDraft()?.autoResume).toBe(true);
    expect(readAuthPendingDraft()?.idempotencyKey).toBe(saved.idempotencyKey);

    window.history.replaceState(null, '', '/explore?template=custom-agents&auth_cancelled=1');
    expect(consumeAuthCancelledFromUrl()).toBe(true);
    expect(window.location.search).toBe('?template=custom-agents');
    expect(readAuthPendingDraft()).toBeNull();
  });

  it('waits for the project catalog before resuming open_editor so existing projects are opened instead of creating a duplicate blank project', async () => {
    window.history.replaceState(null, '', '/motion');
    saveAuthPendingDraft({
      action: 'open_editor',
      returnTo: '/motion',
      autoResume: true,
    });

    let resolveCatalog!: (response: Response) => void;
    const catalogPromise = new Promise<Response>((resolve) => {
      resolveCatalog = resolve;
    });
    const requests: Array<{ url: string; method: string }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      requests.push({ url, method });
      if (url.includes('/motion-api/project/status')) {
        return new Response(
          JSON.stringify({ projectId: 'proj-existing', projectTitle: 'Existing', revision: 'rev-1', exportJob: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/motion-api/projects') && method === 'GET') {
        return catalogPromise;
      }
      if (url.includes('/motion-api/projects/proj-existing/open') && method === 'POST') {
        return new Response(
          JSON.stringify({ projectId: 'proj-existing', projectTitle: 'Existing', revision: 'rev-1', exportJob: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const onNavigate = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <WorkspaceFrame waitForSaves={async () => {}} onNavigate={onNavigate}>
            <div>Editor</div>
          </WorkspaceFrame>
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    // Status has resolved, but catalog is still pending: pending intent must NOT be consumed or POST /projects.
    expect(readAuthPendingDraft()?.action).toBe('open_editor');
    expect(requests.some(r => r.url.endsWith('/motion-api/projects') && r.method === 'POST')).toBe(false);

    // Now resolve the delayed catalog containing an existing project.
    await act(async () => {
      resolveCatalog(
        new Response(
          JSON.stringify({
            activeId: 'proj-existing',
            projects: [{ id: 'proj-existing', title: 'Existing' }],
            sessions: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    expect(readAuthPendingDraft()).toBeNull();
    expect(requests.some(r => r.url.endsWith('/motion-api/projects') && r.method === 'POST')).toBe(false);
    expect(requests.some(r => r.url.includes('/motion-api/projects/proj-existing/open') && r.method === 'POST')).toBe(true);
  });
});
