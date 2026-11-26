// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { preloadAllWorkspacePages } from '../router/lazyPages';
import { setCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { resetAccountSummaryCacheForTest } from './AccountSettings';
import { readAuthPendingDraft } from './authRecoveryStore';
import { MotionApp } from './MotionApp';

vi.mock('./MotionProjectEditor', () => ({ preloadMotionProjectEditor: vi.fn() }));
vi.mock('./ArtifactViewer', () => ({ ArtifactViewer: ({ artifact }: { artifact: { projectId: string } }) => <div data-viewer-project={artifact.projectId} /> }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SAMPLE = '11111111-1111-1111-1111-111111111111';
const SAMPLE_SESSION = '44444444-4444-4444-4444-444444444444';
const CREATED = '22222222-2222-2222-2222-222222222222';
const TEMPLATE = { id: 'custom-agents', title: 'Custom Agents.', kind: 'builtin', tags: [], author: 'OpenMotion', hasHtmlProject: true };
// The API answers this while a freshly started pod is still loading the template catalog.
const CATALOG_WARMING_UP = { code: 'SERVICE_UNAVAILABLE', error: 'Motion template catalog is not ready yet. Retry shortly.' };

type Call = { method: string; path: string; body: Record<string, unknown> };

let host: HTMLDivElement;
let root: Root;
let assign: ReturnType<typeof vi.spyOn>;

beforeAll(() => preloadAllWorkspacePages());

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAccountSummaryCacheForTest();
  setCachedCloudDisklessMode(true);
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  assign = vi.spyOn(location, 'assign').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  assign.mockRestore();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  setCachedCloudDisklessMode(null);
  history.replaceState(null, '', '/');
});

async function settle(until: () => boolean = () => false, timeoutMs = 400) {
  const deadline = Date.now() + timeoutMs;
  do {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  } while (!until() && Date.now() < deadline);
}

async function mountApp() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<I18nProvider initialLocale="en"><MotionApp /></I18nProvider>));
  await settle();
}

function stubGuestApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/template-catalog')) return Response.json({ items: [TEMPLATE], total: 1, next: null, catalogVersion: 'test' });
    return Response.json({ code: 'UNAUTHORIZED', errorCode: 'auth_required', sessionExpired: false, error: 'Authentication required' }, { status: 401 });
  }));
}

/** Signed-in API for an existing account that owns only the sample project; creation endpoints fail once with 503. */
function stubSignedInApi() {
  const calls: Call[] = [];
  const catalog = {
    activeId: SAMPLE,
    projects: [{ id: SAMPLE, title: 'OpenMotion Sample Video' }],
    sessions: [{ id: SAMPLE_SESSION, artifacts: [{ id: SAMPLE, kind: 'motion-project', projectId: SAMPLE, title: 'Sample' }], activeArtifactId: SAMPLE }],
  };
  const sessionsById = new Map<string, { id: string; artifacts: Array<{ id: string; kind: string; projectId: string; title: string }> }>();
  const projectsByRequest = new Map<string, string>();
  let warmingUp = true;
  const createProject = (requestId: string, title: string) => {
    const existing = projectsByRequest.get(requestId);
    if (existing) return existing;
    const id = projectsByRequest.size === 0 ? CREATED : crypto.randomUUID();
    projectsByRequest.set(requestId, id);
    catalog.projects.push({ id, title });
    return id;
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsed = new URL(url, location.origin);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ method, path: parsed.pathname, body });
    if (url.includes('/template-catalog')) return Response.json({ items: [TEMPLATE], total: 1, next: null, catalogVersion: 'test' });
    if (parsed.pathname === '/motion-api/account/summary') {
      return Response.json({ state: 'signed-in', user: { id: 'user-1', email: 'qa@example.com' }, activeWorkspace: { id: 'ws-1' }, plan: 'free' });
    }
    const creating = method === 'POST' && (parsed.pathname === '/motion-api/sessions' || parsed.pathname === '/motion-api/projects');
    if (creating && warmingUp) {
      warmingUp = false;
      return Response.json(CATALOG_WARMING_UP, { status: 503 });
    }
    if (method === 'POST' && parsed.pathname === '/motion-api/sessions') {
      const id = String(body.id);
      const session = sessionsById.get(id) ?? { id, artifacts: [] };
      sessionsById.set(id, session);
      return Response.json({ sessionId: id, session }, { status: 201 });
    }
    const artifacts = /^\/motion-api\/sessions\/([^/]+)\/artifacts$/.exec(parsed.pathname);
    if (method === 'POST' && artifacts) {
      const projectId = createProject(String(body.requestId), TEMPLATE.title);
      sessionsById.get(artifacts[1]!)?.artifacts.push({ id: projectId, kind: 'motion-project', projectId, title: TEMPLATE.title });
      return Response.json({ sessionId: artifacts[1], projectId, projectTitle: TEMPLATE.title, revision: 'r2' }, { status: 201 });
    }
    if (method === 'POST' && parsed.pathname === '/motion-api/projects') {
      const projectId = createProject(String(body.requestId), 'Untitled');
      return Response.json({ projectId, projectTitle: 'Untitled', revision: 'r2' }, { status: 201 });
    }
    if (parsed.pathname === '/motion-api/projects') return Response.json(catalog);
    if (parsed.pathname === '/motion-api/project/status') {
      return Response.json({ projectId: parsed.searchParams.get('projectId') ?? SAMPLE, projectTitle: 'Sample', revision: 'r1', exportJob: null });
    }
    const session = /^\/motion-api\/sessions\/([^/]+)$/.exec(parsed.pathname);
    if (session) return Response.json(sessionsById.get(session[1]!) ?? { id: session[1], artifacts: [] });
    if (parsed.pathname.endsWith('/open')) {
      const projectId = parsed.searchParams.get('projectId') ?? CREATED;
      return Response.json({ projectId, revision: 'r2' });
    }
    return Response.json({});
  }));
  return { calls, catalog, createdProjects: () => [...projectsByRequest.values()] };
}

/** Clicks the guest entry, confirms the login prompt and returns the `returnTo` the server would redirect back to. */
async function signInFrom(click: () => HTMLButtonElement | undefined) {
  const entry = click();
  expect(entry).toBeDefined();
  expect(entry!.disabled).toBe(false);
  await act(async () => entry!.click());
  await settle();
  const signIn = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Sign in now'));
  expect(signIn).toBeDefined();
  await act(async () => signIn!.click());
  expect(assign).toHaveBeenCalledTimes(1);
  const loginUrl = new URL(String(assign.mock.calls[0]![0]), location.origin);
  expect(loginUrl.pathname).toBe('/auth/login');
  return loginUrl.searchParams.get('returnTo')!;
}

/** Simulates the full-page OIDC round trip: the document unloads, then reloads at `returnTo` signed in. */
async function returnFromLogin(returnTo: string) {
  act(() => root.unmount());
  host.remove();
  history.replaceState(null, '', returnTo);
  const api = stubSignedInApi();
  await mountApp();
  return api;
}

it('creates exactly one template project after a guest signs in from Open and edit, retrying a transient 503', async () => {
  history.replaceState(null, '', '/explore?template=custom-agents');
  stubGuestApi();
  await mountApp();

  const returnTo = await signInFrom(() =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Open and edit')));
  expect(returnTo).toBe('/explore?template=custom-agents');
  const intent = readAuthPendingDraft();
  expect(intent).toMatchObject({ action: 'use_template', templateId: 'custom-agents', autoResume: true });

  const api = await returnFromLogin(returnTo);
  await settle(() => api.createdProjects().length > 0 && location.pathname.startsWith('/editor/'), 3_000);

  const sessionPosts = api.calls.filter(call => call.method === 'POST' && call.path === '/motion-api/sessions');
  expect(sessionPosts.length).toBe(2);
  expect(sessionPosts.every(call => call.body.id === intent!.idempotencyKey && call.body.templateId === 'custom-agents')).toBe(true);
  const artifactPosts = api.calls.filter(call => call.method === 'POST' && call.path.endsWith('/artifacts'));
  expect(artifactPosts.map(call => call.body.requestId)).toEqual([intent!.idempotencyKey]);
  expect(api.createdProjects()).toEqual([CREATED]);
  expect(api.catalog.projects.map(project => project.id)).toEqual([SAMPLE, CREATED]);
  expect(readAuthPendingDraft()).toBeNull();
  expect(location.pathname).toBe(`/editor/${CREATED}`);
});

it('creates exactly one blank project after a guest signs in from New project, retrying a transient 503', async () => {
  history.replaceState(null, '', '/motion');
  stubGuestApi();
  await mountApp();

  const returnTo = await signInFrom(() =>
    host.querySelector<HTMLButtonElement>('.om-studio-new-project-button') ?? undefined);
  expect(returnTo).toBe('/motion');
  const intent = readAuthPendingDraft();
  expect(intent).toMatchObject({ action: 'create_project', autoResume: true });

  const api = await returnFromLogin(returnTo);
  await settle(() => api.createdProjects().length > 0 && location.pathname.startsWith('/editor/'), 3_000);

  const projectPosts = api.calls.filter(call => call.method === 'POST' && call.path === '/motion-api/projects');
  expect(projectPosts.length).toBe(2);
  expect(projectPosts.every(call => call.body.requestId === intent!.idempotencyKey)).toBe(true);
  expect(api.createdProjects()).toEqual([CREATED]);
  expect(api.catalog.projects.map(project => project.id)).toEqual([SAMPLE, CREATED]);
  expect(readAuthPendingDraft()).toBeNull();
  expect(location.pathname).toBe(`/editor/${CREATED}`);
});
