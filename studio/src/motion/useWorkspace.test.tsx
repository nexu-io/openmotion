// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { observeStudioSavedAt } from '../utils/studioSaveState';
import { useWorkspace } from './useWorkspace';
import { notifyProjectActivity } from './workspaceRefresh';
import { I18nProvider, useI18n } from '../i18n/I18n';
import { languages, translate } from '../i18n/messages';

const first = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const status = { revision: 'a'.repeat(64), projectId: first, projectTitle: 'First', exportJob: null };
let workspace: ReturnType<typeof useWorkspace>;
let root: Root;
let container: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
let navigate: ReturnType<typeof vi.spyOn>;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  history.replaceState(null, '', '/');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  navigate = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  fetcher = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === 'POST' ? { ...status, projectId: second } : url.endsWith('/projects') ? { activeId: first, projects: [{ id: first, title: 'First' }] } : status,
  )));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(wait: () => Promise<void>, projectId?: string, sessionId?: string, onNavigate?: (url: string, replace?: boolean) => void) {
  function Harness() { workspace = useWorkspace(wait, projectId, sessionId, onNavigate); return null; }
  await act(async () => root.render(<Harness />));
}
const writes = () => fetcher.mock.calls.filter(call => call[1]?.method === 'POST');

it('keeps drafts and mixed sessions in recent conversations but hides sessions with only trashed projects', async () => {
  const live = { id: first, title: 'Live' }, removed = { id: second, title: 'Removed', trashedAt: 10 };
  const other = { id: 'third', title: 'Also removed', trashedAt: 20 };
  const artifact = ({ id: projectId, title }: typeof live) => ({ id: projectId, projectId, title, kind: 'motion-project' });
  const sessions = [
    { id: 'mixed', title: 'Mixed', mode: 'motion', artifacts: [artifact(removed), artifact(live)], activeArtifactId: second },
    { id: 'hidden', title: 'Hidden', mode: 'motion', artifacts: [artifact(other)], activeArtifactId: other.id },
    { id: 'draft', title: 'Draft', mode: 'motion', artifacts: [] },
  ];
  let projects = [live, removed, other];
  fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/projects') ? { projects, sessions } : status));
  await mount(async () => {}, first, 'mixed');
  expect(workspace.sessions.map(session => session.id)).toEqual(['mixed', 'draft']);
  expect(workspace.session?.artifacts.map(item => item.projectId)).toEqual([first]);
  expect(workspace.session?.activeArtifactId).toBe(first);
  projects = [live, removed, { id: other.id, title: other.title, trashedAt: undefined }];
  await act(async () => workspace.retryConnection());
  expect(workspace.sessions.map(session => session.id)).toEqual(['mixed', 'hidden', 'draft']);
});

it('preserves the saved catalog order when project metadata changes', async () => {
  let projects = [
    { id: second, title: 'Second', createdAt: 200, openedAt: 200 },
    { id: first, title: 'First', createdAt: 200, openedAt: 100 },
    { id: 'project', title: 'Legacy project', openedAt: 9999 },
  ];
  fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/projects') ? { projects } : status));
  await mount(async () => {}, first);
  expect(workspace.projects.map(project => project.id)).toEqual([second, first, 'project']);
  projects = projects.map(project => ({ ...project, title: 'Renamed ' + project.title, openedAt: project.id === first ? 20000 : 1 }));
  await act(async () => workspace.retryConnection());
  expect(workspace.projects.map(project => project.id)).toEqual([second, first, 'project']);
  projects.unshift({ id: 'new', title: 'Newest', createdAt: 300, openedAt: 0 });
  await act(async () => workspace.retryConnection());
  expect(workspace.projects.map(project => project.id)).toEqual(['new', second, first, 'project']);
});

it('switches the default project label in all interface languages without saving or translating custom names', async () => {
  let locale: ReturnType<typeof useI18n>;
  let custom = false;
  fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/projects') ? {
    activeId: 'project', projects: [
      { id: 'project', title: 'OpenMotion 示例短片', titleKey: custom ? null : 'OpenMotion Sample Video' },
      { id: second, title: 'OpenMotion 示例短片' },
    ],
  } : { ...status, projectId: 'project' }));
  const wait = async () => {};
  function Harness() { locale = useI18n(); workspace = useWorkspace(wait, 'project'); return null; }
  await act(async () => root.render(<I18nProvider initialLocale="zh-CN"><Harness /></I18nProvider>));
  for (const { locale: language } of languages) {
    act(() => locale.setLocale(language));
    expect(workspace.projects[0].title).toBe(translate(language, 'OpenMotion Sample Video'));
    if (language !== 'en') expect(workspace.projects[0].title).not.toBe('OpenMotion Sample Video');
    expect(workspace.projects[1].title).toBe('OpenMotion 示例短片');
  }
  custom = true;
  await act(async () => workspace.retryConnection());
  act(() => locale.setLocale('en'));
  expect(workspace.projects[0].title).toBe('OpenMotion 示例短片');
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('reconnects with read requests only and clears a recovered polling failure', async () => {
  const original = fetcher.getMockImplementation()!;
  fetcher.mockRejectedValue(new TypeError('Failed to fetch'));
  await mount(async () => {}, first);
  expect(workspace.errorSource).toBe('connection');
  expect(workspace.error).toBe('Failed to fetch');
  fetcher.mockImplementation(original);
  await act(async () => workspace.retryConnection());
  expect(workspace.error).toBe('');
  expect(workspace.checkingConnection).toBe(false);
  expect(writes()).toHaveLength(0);
  expect(navigate).not.toHaveBeenCalled();
});

it('does not erase a failed operation when a later connection check succeeds', async () => {
  await mount(async () => { throw new Error('Unsaved edit'); }, first);
  await act(() => workspace.create());
  await act(async () => workspace.retryConnection());
  expect(workspace.error).toBe('Unsaved edit');
  expect(workspace.errorSource).toBe('operation');
  expect(writes()).toHaveLength(0);
});

it('keeps connection state independent of operation errors and clearing them', async () => {
  vi.useFakeTimers();
  try {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockRejectedValue(new TypeError('Failed to fetch'));
    await mount(async () => { throw new Error('Unsaved edit'); }, first);
    await act(async () => workspace.create());
    expect(workspace.errorSource).toBe('operation');
    expect(workspace.connectionError).toBe('Failed to fetch');
    act(() => workspace.clearError());
    expect(workspace.connectionError).toBe('Failed to fetch');
    await act(async () => workspace.create());
    fetcher.mockImplementation(original);
    await act(async () => vi.advanceTimersByTimeAsync(1800));
    expect(workspace.connectionError).toBe('');
    expect(workspace.error).toBe('Unsaved edit');
    expect(writes()).toHaveLength(0);
  } finally { vi.useRealTimers(); }
});

it('waits for saves, deduplicates rapid actions and opens the new project in a new document', async () => {
  let saved!: () => void;
  const pending = new Promise<void>(resolve => { saved = resolve; });
  await mount(() => pending, first);
  let operation!: Promise<boolean>;
  act(() => { operation = workspace.create(); });
  await act(async () => { await workspace.open('projects', second); });
  expect(writes()).toHaveLength(0);
  await act(async () => { saved(); await operation; });
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe(`/motion-api/projects?projectId=${first}`);
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ expectedRevision: status.revision, expectedProjectId: first });
  expect(navigate).toHaveBeenCalledWith(`/editor/${second}#project/${second}`);
});
it('save failures prevent creating, switching and leaving for home', async () => {
  await mount(async () => { throw new Error('Unsaved edit'); }, first);
  for (const action of [() => workspace.create(), () => workspace.open('projects', second), () => workspace.home()]) {
    await act(action);
    expect(workspace.busy).toBe(false);
    expect(workspace.error).toBe('Unsaved edit');
  }
  expect(writes()).toHaveLength(0);
  expect(navigate).not.toHaveBeenCalled();
});
it('a rejected switch stays in the original session and can be retried', async () => {
  await mount(async () => {}, first);
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { error: 'Revision changed' } : status), { status: init?.method === 'POST' ? 409 : 200 }));
  await act(() => workspace.open('projects', second));
  expect(workspace.error).toBe('Revision changed');
  expect(workspace.busy).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});
it('home stays home when another client switches the active project', async () => {
  const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  await mount(async () => {});
  expect(workspace.status?.projectId).toBe(first);
  expect(replace).not.toHaveBeenCalled();
  await act(() => workspace.home());
  expect(navigate).toHaveBeenCalledWith('/');
  expect(writes()).toHaveLength(0);
});
it('an existing project page polls its own project without following another client', async () => {
  const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/projects')
    ? { activeId: second, projects: [{ id: first }, { id: second }] }
    : new URL(url, location.origin).searchParams.get('projectId') === first ? status : { ...status, projectId: second }));
  await mount(async () => {}, first, first);
  expect(workspace.status?.projectId).toBe(first);
  expect(replace).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url]) => url === `/motion-api/project/status?view=summary&projectId=${first}`)).toBe(true);
});
it('an empty conversation opens its own first artifact even when another project is globally active', async () => {
  history.replaceState(null, '', '/editor?session=conversation');
  const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/projects')
    ? { projects: [], sessions: [{ id: 'conversation', artifacts: [{ id: 'artifact-a', projectId: first }], activeArtifactId: 'artifact-a' }] }
    : { ...status, projectId: second }));
  await mount(async () => {}, undefined, 'conversation');
  expect(replace).toHaveBeenCalledWith(`/editor/${first}?session=conversation&openArtifact=1#project/${first}`);
});
it('keeps a home request after failure and clears it only once the project was created with that request', async () => {
  await mount(async () => {});
  localStorage.setItem('motion.home.draft.v1', 'Make a launch video');
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Response(JSON.stringify({ error: 'Creation failed' }), { status: 503 }) : original(url, init));
  await act(() => workspace.create('Make a launch video'));
  expect(localStorage.getItem('motion.home.draft.v1')).toBe('Make a launch video');
  expect(navigate).not.toHaveBeenCalled();
  fetcher.mockImplementation(original);
  await act(() => workspace.create('Make a launch video'));
  expect(JSON.parse(writes()[1][1]!.body as string).instruction).toBe('Make a launch video');
  expect(localStorage.getItem('motion.home.draft.v1')).toBeNull();
  expect(navigate).toHaveBeenCalledWith(`/editor/${second}#project/${second}`);
});
it('creates the conversation before generating an artifact and retains it when generation fails', async () => {
  await mount(async () => {});
  localStorage.setItem('motion.home.draft.v1', 'New film');
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/motion-api/sessions' && init?.method === 'POST') return new Response(JSON.stringify({ sessionId: 'new-session' }));
    if (url.endsWith('/artifacts')) return new Response(JSON.stringify({ error: 'Generation failed' }), { status: 503 });
    return original(url, init);
  });
  await act(() => workspace.startSession('New film', 'product-promo'));
  expect(writes().map(call => call[0])).toEqual(['/motion-api/sessions', '/motion-api/sessions/new-session/artifacts']);
  expect(navigate).toHaveBeenCalledWith('/editor?session=new-session');
  expect(localStorage.getItem('motion.home.draft.v1')).toBeNull();
  expect(sessionStorage.getItem('opendesign.session-error:new-session')).toBe('Generation failed');
});
it('activates the viewer when an external Agent produces an artifact for an open empty conversation', async () => {
  history.replaceState(null, '', '/editor?session=conversation');
  const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith('/projects') ? new Response(JSON.stringify({ projects: [], sessions: [{ id: 'conversation', artifacts: [{ id: 'artifact', projectId: first }] }] })) : original(url, init));
  await mount(async () => {}, undefined, 'conversation');
  expect(replace).toHaveBeenCalledWith(`/editor/${first}?session=conversation&openArtifact=1#project/${first}`);
});

it.each([
  '/explore?session=conversation',
  '/motion?session=conversation',
  '/settings/providers?session=conversation',
  '/settings/mcp?session=conversation',
  '/model-hub/gemini-4?session=conversation',
  '/models/custom%3Aprovider%2Fmodel?session=conversation',
  '/mcp-setup?session=conversation&host=codex',
  '/brand-kit/mine?session=conversation',
  '/skills/manim?session=conversation',
  '/studios/3d?session=conversation',
  '/studios/3d/text-to-video?session=conversation',
  '/studios/game?session=conversation&game=done',
  '/scenarios?session=conversation',
  '/scenarios/black-friday?session=conversation',
  '/assets?session=conversation',
  '/assets/asset-1?session=conversation',
  '/design/prototype?session=conversation',
  '/design/projects/d-1?session=conversation',
  '/cinema?session=conversation',
  '/cinema/text-to-video?session=conversation',
  '/sound?session=conversation',
  '/sound/sfx?session=conversation',
  '/audio/music?session=conversation',
  '/create/text-to-image?session=conversation',
])('keeps migrated standalone path %s open when a retained session gains an artifact', async standaloneHref => {
  history.replaceState(null, '', standaloneHref);
  const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  const onNavigate = vi.fn();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith('/projects')
    ? new Response(JSON.stringify({ projects: [], sessions: [{ id: 'conversation', artifacts: [{ id: 'artifact', projectId: first }] }] }))
    : original(url, init));
  await mount(async () => {}, undefined, 'conversation', onNavigate);
  expect(replace).not.toHaveBeenCalled();
  expect(onNavigate).not.toHaveBeenCalled();
});

it('unlocks actions after an in-page switch and scopes subsequent polling to the next project', async () => {
  const onNavigate = vi.fn();
  await mount(async () => {}, first, first, onNavigate);
  await act(() => workspace.open('projects', second));
  expect(onNavigate).toHaveBeenCalledWith(`/editor/${second}#project/${second}`);
  expect(navigate).not.toHaveBeenCalled();
  expect(workspace.busy).toBe(false);
  fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/projects') ? { projects: [] } : { ...status, projectId: second }));
  await mount(async () => {}, second, second, onNavigate);
  expect(workspace.status?.projectId).toBe(second);
  expect(workspace.error).toBe('');
});

it.each([false, true])('guards browser history navigation before replacing the project (save failure=%s)', async failure => {
  const originalUrl = `/editor/${first}?session=${first}#project/${first}`;
  const targetUrl = `/editor/${second}?session=${second}#project/${second}`;
  history.replaceState(null, '', originalUrl);
  let finishSave!: () => void;
  const pending = new Promise<void>(resolve => { finishSave = resolve; });
  const onNavigate = vi.fn();
  await mount(async () => { await pending; if (failure) throw new Error('Unsaved edit'); }, first, first, onNavigate);
  await act(async () => {
    history.replaceState(null, '', targetUrl);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(onNavigate).not.toHaveBeenCalled();
  await act(async () => finishSave());
  if (failure) {
    expect(onNavigate).not.toHaveBeenCalled();
    expect(location.href).toBe(new URL(originalUrl, location.origin).href);
    expect(workspace.navigationError?.message).toBe('Unsaved edit');
  } else expect(onNavigate).toHaveBeenCalledWith(new URL(targetUrl, location.origin).href, true);
});

const countReads = () => ({
  status: fetcher.mock.calls.filter(([url]) => url.includes('/project/status?')).length,
  catalog: fetcher.mock.calls.filter(([url]) => url.endsWith('/projects')).length,
});
const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

it('discovers external projects within one minute without polling idle editor status', async () => {
  vi.useFakeTimers();
  try {
    await mount(async () => {}, first);
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith('/projects')
      ? Response.json({ projects: [{ id: first, title: 'First' }, { id: second, title: 'Created via MCP' }] })
      : original(url, init));
    await advance(60_000);
    expect(workspace.projects.map(project => project.id)).toEqual([first, second]);
    await advance(5000);
    expect(countReads()).toEqual({ status: 1, catalog: 2 });
    act(() => {
      observeStudioSavedAt(second, Date.now());
      observeStudioSavedAt(first, Date.now());
      observeStudioSavedAt(first, Date.now() + 1);
    });
    await advance(1800);
    expect(countReads()).toEqual({ status: 2, catalog: 2 });
  } finally { vi.useRealTimers(); }
});

it('pauses while hidden and coalesces foreground and online checks', async () => {
  vi.useFakeTimers();
  try {
    await mount(async () => {}, first);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(500);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(0);
    expect(countReads()).toEqual({ status: 1, catalog: 1 });
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(120_000);
    expect(countReads()).toEqual({ status: 1, catalog: 1 });
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await advance(0);
    expect(countReads()).toEqual({ status: 2, catalog: 2 });
  } finally { vi.useRealTimers(); }
});

it('refreshes only status for an active export and only the catalog for an empty session', async () => {
  vi.useFakeTimers();
  try {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => url.includes('/project/status?')
      ? Response.json({ ...status, exportJob: { id: 'render', state: 'running' } }) : original(url, init));
    await mount(async () => {}, first);
    await advance(5400);
    expect(countReads()).toEqual({ status: 4, catalog: 1 });
    fetcher.mockImplementation(original);
    fetcher.mockClear();
    history.replaceState(null, '', '/editor?session=waiting-session');
    await mount(async () => {}, undefined, 'waiting-session');
    await advance(5400);
    expect(countReads()).toEqual({ status: 1, catalog: 4 });
  } finally { vi.useRealTimers(); }
});

it('waits for in-flight reads before reconciling a foreground event', async () => {
  vi.useFakeTimers();
  try {
    const original = fetcher.getMockImplementation()!;
    let finish!: () => void;
    fetcher.mockImplementation((url: string, init?: RequestInit) => url.includes('/project/status?')
      ? new Promise<Response>(resolve => { finish = () => resolve(Response.json(status)); })
      : original(url, init));
    await mount(async () => {}, first);
    window.dispatchEvent(new Event('online'));
    await advance(1000);
    expect(countReads()).toEqual({ status: 1, catalog: 2 });
    fetcher.mockImplementation(original);
    await act(async () => finish());
    await advance(0);
    expect(countReads()).toEqual({ status: 2, catalog: 2 });
  } finally { vi.useRealTimers(); }
});

it('backs off only the failing endpoint and restores its idle cadence after recovery', async () => {
  vi.useFakeTimers();
  try {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/project/status?')) throw new TypeError('Disconnected');
      return original(url, init);
    });
    await mount(async () => {}, first);
    await advance(1800);
    await advance(3599);
    expect(countReads()).toEqual({ status: 2, catalog: 1 });
    expect(workspace.connectionError).toBe('Disconnected');
    fetcher.mockImplementation(original);
    await advance(1);
    expect(workspace.connectionError).toBe('');
    await advance(7200);
    expect(countReads()).toEqual({ status: 3, catalog: 1 });
  } finally { vi.useRealTimers(); }
});

it('reconciles matching render events and catches up both reads after project stream reconnection', async () => {
  vi.useFakeTimers();
  try {
    await mount(async () => {}, first);
    notifyProjectActivity(second, 'render-updated');
    await advance(1800);
    expect(countReads()).toEqual({ status: 1, catalog: 1 });
    notifyProjectActivity(first, 'render-updated');
    notifyProjectActivity(first, 'render-updated');
    await advance(1800);
    expect(countReads()).toEqual({ status: 2, catalog: 1 });
    notifyProjectActivity(first, 'reconnected');
    await advance(0);
    expect(countReads()).toEqual({ status: 3, catalog: 2 });
  } finally { vi.useRealTimers(); }
});

it('refreshes only the catalog when the server reports a workspace change', async () => {
  vi.useFakeTimers();
  try {
    await mount(async () => {}, first);
    notifyProjectActivity(first, 'catalog-changed');
    notifyProjectActivity(first, 'catalog-changed');
    await advance(0);
    expect(countReads()).toEqual({ status: 1, catalog: 2 });
  } finally { vi.useRealTimers(); }
});

it('reuses the workspace list across known projects and refreshes it on a catalog event', async () => {
  vi.useFakeTimers();
  try {
    const projects = [{ id: first, title: 'First' }, { id: second, title: 'Second' }];
    fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/projects')
      ? { activeId: first, projects }
      : { ...status, projectId: new URL(url, location.origin).searchParams.get('projectId') }));
    const wait = async () => {};
    function Editor({ id }: { id: string }) { workspace = useWorkspace(wait, id); return null; }
    for (const id of [first, second, first]) {
      await act(async () => root.render(<Editor id={id} />));
      expect(workspace.status?.projectId).toBe(id);
    }
    expect(countReads()).toEqual({ status: 3, catalog: 1 });
    notifyProjectActivity(first, 'catalog-changed');
    await advance(0);
    expect(countReads()).toEqual({ status: 3, catalog: 2 });
  } finally { vi.useRealTimers(); }
});

it('reconciles idle status even without a project stream and pauses reads while offline', async () => {
  vi.useFakeTimers();
  try {
    await mount(async () => {}, first);
    await advance(120_000);
    expect(countReads()).toEqual({ status: 2, catalog: 3 });
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await advance(120_000);
    expect(countReads()).toEqual({ status: 2, catalog: 3 });
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await advance(0);
    expect(countReads()).toEqual({ status: 3, catalog: 4 });
  } finally { vi.useRealTimers(); }
});

it('keeps finding artifacts for a long-idle empty conversation at a bounded slower cadence', async () => {
  vi.useFakeTimers();
  try {
    history.replaceState(null, '', '/editor?session=conversation');
    let artifacts: { id: string; projectId: string }[] = [];
    fetcher.mockImplementation(async (url: string) => Response.json(url.endsWith('/projects')
      ? { projects: [], sessions: [{ id: 'conversation', artifacts }] } : status));
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    await mount(async () => {}, undefined, 'conversation');
    await advance(31_000);
    const reads = countReads().catalog;
    await advance(14_000);
    expect(countReads().catalog).toBe(reads);
    artifacts = [{ id: 'artifact', projectId: first }];
    await advance(1000);
    expect(replace).toHaveBeenCalledWith(`/editor/${first}?session=conversation&openArtifact=1#project/${first}`);
  } finally { vi.useRealTimers(); }
});

it('falls back to unscoped status and reports a stale projectId on 404/400 when fallback is enabled', async () => {
  const staleId = '2b22bcca-8aca-45c4-808b-f7920af66a48';
  const onStaleProjectId = vi.fn();
  const seenUrls: string[] = [];
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    seenUrls.push(url);
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/projects') && !init?.method) {
      return Response.json({ activeId: first, projects: [{ id: first, title: 'First' }] });
    }
    if (parsed.pathname.endsWith('/project/status') && parsed.searchParams.get('projectId') === staleId) {
      return Response.json({ code: 'PROJECT_NOT_FOUND', error: 'Project was not found in this workspace.' }, { status: 404 });
    }
    if (init?.method === 'POST') return Response.json({ ...status, projectId: first });
    return Response.json(status);
  });
  function Harness() {
    workspace = useWorkspace(async () => {}, staleId, undefined, undefined, {
      allowUnscopedStatusFallback: true,
      onStaleProjectId,
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  expect(onStaleProjectId).toHaveBeenCalledWith(staleId);
  expect(workspace.status?.projectId).toBe(first);
  expect(workspace.connectionError).toBe('');
  expect(seenUrls).toContain(`/motion-api/project/status?view=summary&projectId=${staleId}`);
  expect(seenUrls).toContain('/motion-api/project/status?view=summary');

  seenUrls.length = 0;
  await act(() => workspace.open('projects', first));
  expect(seenUrls.some(url => url.includes(staleId))).toBe(false);
  expect(navigate).toHaveBeenCalledWith(`/editor/${first}#project/${first}`);
});

it('does not fall back on 404 status when editing an active project route', async () => {
  const staleId = '2b22bcca-8aca-45c4-808b-f7920af66a48';
  const onStaleProjectId = vi.fn();
  fetcher.mockImplementation(async (url: string) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/projects')) {
      return Response.json({ activeId: first, projects: [{ id: first, title: 'First' }] });
    }
    return Response.json({ code: 'PROJECT_NOT_FOUND', error: 'Project was not found in this workspace.' }, { status: 404 });
  });
  function Harness() {
    workspace = useWorkspace(async () => {}, staleId, undefined, undefined, {
      allowUnscopedStatusFallback: false,
      onStaleProjectId,
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  expect(onStaleProjectId).not.toHaveBeenCalled();
  expect(workspace.status).toBeNull();
  expect(workspace.connectionError).toContain('not found');
});

it('skips the unscoped /project/status probe for unauthenticated non-editor pages and resumes after sign-in', async () => {
  const seenUrls: string[] = [];
  let signedIn = false;
  fetcher.mockImplementation(async (url: string) => {
    seenUrls.push(url);
    const parsed = new URL(url, location.origin);
    if (!signedIn) {
      return Response.json(
        { code: 'UNAUTHORIZED', errorCode: 'auth_required', error: 'Authentication required' },
        { status: 401 },
      );
    }
    if (parsed.pathname.endsWith('/projects')) {
      return Response.json({ activeId: first, projects: [{ id: first, title: 'First' }], sessions: [] });
    }
    return Response.json(status);
  });
  function Harness() {
    workspace = useWorkspace(async () => {}, undefined, undefined, undefined, {
      allowUnscopedStatusFallback: true,
      deferUnscopedStatusUntilCatalog: true,
    });
    return null;
  }
  await act(async () => root.render(<Harness />));
  expect(workspace.authRequired).toBe(true);
  expect(seenUrls).toEqual(['/motion-api/projects']);

  // Signing in fires motion:account-changed, reloads /projects, and then loads /project/status.
  signedIn = true;
  seenUrls.length = 0;
  await act(async () => {
    window.dispatchEvent(new Event('motion:account-changed'));
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(workspace.authRequired).toBe(false);
  expect(workspace.status?.projectId).toBe(first);
  expect(seenUrls).toEqual(['/motion-api/projects', '/motion-api/project/status?view=summary']);
});
