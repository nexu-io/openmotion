// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenMotionAgentTools } from './OpenMotionAgentTools';
import { MotionAppShell } from './MotionAppShell';
import { phase1Tools } from '../../../shared/phase1-tools';
import { registerStudioTools } from '../webmcp/registrar';
import { buildStudioTools, type StudioAgentToolsDeps } from '../webmcp/useStudioAgentTools';
import { markModelContextPolyfilled, type ModelContext, type ModelContextTool } from '../webmcp/types';
import { setCachedCloudDisklessMode, warmCloudDisklessMode } from '../utils/cloudRuntime';

const { loadPolyfill, request } = vi.hoisted(() => ({ loadPolyfill: vi.fn(), request: vi.fn() }));
vi.mock('../webmcp/polyfill', () => ({ loadModelContextPolyfill: loadPolyfill }));
vi.mock('../utils/studioApiFetch', () => ({ studioApiFetch: request }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  Reflect.deleteProperty(document, 'modelContext'); vi.unstubAllGlobals(); localStorage.clear();
  setCachedCloudDisklessMode(null);
  document.head.querySelectorAll('meta[name="openmotion-runtime"]').forEach(node => node.remove());
  Reflect.deleteProperty(window, '__OPENMOTION_OBSERVABILITY__');
});

function context() {
  const registered = new Map<string, ModelContextTool>();
  const registerTool = vi.fn<ModelContext['registerTool']>(async (tool, options) => {
    options?.signal?.throwIfAborted();
    if (registered.has(tool.name)) throw new DOMException('Duplicate', 'InvalidStateError');
    registered.set(tool.name, tool);
    options?.signal?.addEventListener('abort', () => registered.delete(tool.name), { once: true });
  });
  return { registered, registerTool };
}

it('native registration coexists with the five Studio observation/navigation tools and survives rerenders without duplicate registration', async () => {
  const native = context();
  Object.defineProperty(document, 'modelContext', { value: native, configurable: true });
  const studioController = new AbortController();
  const studio = buildStudioTools({ current: {} as StudioAgentToolsDeps });
  expect((await registerStudioTools(native, studio, studioController.signal)).failed).toEqual([]);
  await act(async () => root.render(<StrictMode><OpenMotionAgentTools /></StrictMode>));
  await vi.waitFor(() => expect(native.registered.size).toBe(27));
  expect([...native.registered.keys()].sort()).toEqual([...studio, ...phase1Tools.filter(tool => !tool.name.startsWith('openmotion_game_'))].map(tool => tool.name).sort());
  expect(native.registered.size).toBe(27);
  expect([...native.registered.keys()]).not.toContain('openmotion_studio_set_text');
  expect(loadPolyfill).not.toHaveBeenCalled();
  const count = native.registerTool.mock.calls.length;
  await act(async () => root.render(<StrictMode><OpenMotionAgentTools /></StrictMode>));
  expect(native.registerTool).toHaveBeenCalledTimes(count);
  request.mockResolvedValue(Response.json({ projects: [] }));
  expect(await native.registered.get('openmotion_get_project')!.execute({})).toEqual({ projects: [] });
  expect(request).toHaveBeenCalledWith('/motion-api/phase1/call', expect.objectContaining({ method: 'POST' }));
  await act(async () => root.unmount());
  expect([...native.registered.keys()].sort()).toEqual(studio.map(tool => tool.name).sort());
  studioController.abort();
});

it('uses the existing polyfill and unregisters only its own tools on cleanup', async () => {
  const fallback = context(); loadPolyfill.mockResolvedValue(fallback);
  await act(async () => root.render(<OpenMotionAgentTools />));
  expect(loadPolyfill).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(fallback.registered.size).toBe(22));
  await act(async () => root.unmount());
  expect(fallback.registered.size).toBe(0);
});

it('honors the existing disabled preference and does not initialize a fallback', async () => {
  localStorage.setItem('hf-studio-ui-preferences', JSON.stringify({ agentToolsEnabled: false }));
  await act(async () => root.render(<OpenMotionAgentTools />));
  expect(loadPolyfill).not.toHaveBeenCalled();
});

it('does not register after an asynchronous fallback outlives the page', async () => {
  const fallback = context();
  let resolve!: (value: ModelContext | null) => void;
  loadPolyfill.mockReturnValue(new Promise<ModelContext | null>(done => { resolve = done; }));
  await act(async () => root.render(<OpenMotionAgentTools />));
  await act(async () => root.unmount());
  await act(async () => resolve(fallback));
  expect(fallback.registerTool).not.toHaveBeenCalled();
});

it('keeps the page usable when no WebMCP context is available', async () => {
  loadPolyfill.mockResolvedValue(null);
  await act(async () => root.render(<><OpenMotionAgentTools /><p>Editor ready</p></>));
  expect(container.textContent).toBe('Editor ready');
});

it('skips native document.modelContext when polyfillOnly is set while still falling back to polyfill when absent', async () => {
  const native = context();
  Object.defineProperty(document, 'modelContext', { value: native, configurable: true });
  await act(async () => root.render(<OpenMotionAgentTools polyfillOnly />));
  expect(native.registerTool).not.toHaveBeenCalled();
  expect(loadPolyfill).not.toHaveBeenCalled();

  await act(async () => root.unmount());
  Reflect.deleteProperty(document, 'modelContext');
  root = createRoot(container);
  const fallback = context();
  loadPolyfill.mockResolvedValue(fallback);
  await act(async () => root.render(<OpenMotionAgentTools polyfillOnly />));
  expect(loadPolyfill).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(fallback.registered.size).toBe(22));
});

it('still registers cloud export-only archive tools when polyfillOnly mounts after StudioAgentTools installed the polyfill or remounts on project switch', async () => {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'openmotion-runtime');
  meta.setAttribute('content', 'cloud-diskless');
  document.head.append(meta);

  // Simulate StudioAgentTools loading @mcp-b/global before OpenMotionAgentTools mounts.
  const polyfilled = context();
  markModelContextPolyfilled(polyfilled);
  Object.defineProperty(document, 'modelContext', { value: polyfilled, configurable: true });
  loadPolyfill.mockResolvedValue(polyfilled);

  await act(async () => root.render(<OpenMotionAgentTools polyfillOnly />));
  await vi.waitFor(() => expect(polyfilled.registered.size).toBe(22));

  const archiveTool = polyfilled.registered.get('openmotion_project_archive')!;
  expect(archiveTool).toBeDefined();
  expect(archiveTool.inputSchema).toMatchObject({
    properties: { action: { enum: ['export'] } },
  });
  expect((archiveTool.inputSchema as { properties?: Record<string, unknown> }).properties).not.toHaveProperty('sourcePath');
  expect(archiveTool.description).toContain('/motion-api/project-archives/import');
  expect(archiveTool.description).not.toContain('sourcePath');

  // Switching projects unmounts and remounts MotionEditorHost / OpenMotionAgentTools.
  await act(async () => root.unmount());
  expect(polyfilled.registered.size).toBe(0);
  root = createRoot(container);
  await act(async () => root.render(<OpenMotionAgentTools polyfillOnly />));
  await vi.waitFor(() => expect(polyfilled.registered.size).toBe(22));
  expect(polyfilled.registered.get('openmotion_project_archive')?.inputSchema).toMatchObject({
    properties: { action: { enum: ['export'] } },
  });
});

it('awaits a pending startup cloud runtime probe before registering WebMCP archive schema', async () => {
  let resolveConfig!: (response: Response) => void;
  request.mockImplementation((url: string) => {
    if (url === '/__hyperframes_config') {
      return new Promise<Response>(resolve => { resolveConfig = resolve; });
    }
    return Promise.resolve(Response.json({}));
  });
  warmCloudDisklessMode();

  const native = context();
  Object.defineProperty(document, 'modelContext', { value: native, configurable: true });

  await act(async () => root.render(<MotionAppShell><div>Shell</div></MotionAppShell>));
  // Must not prematurely register desktop action=import/sourcePath before the cloud probe settles.
  await act(async () => { await Promise.resolve(); });
  expect(native.registered.has('openmotion_project_archive')).toBe(false);

  await act(async () => {
    resolveConfig(Response.json({ mode: 'cloud-diskless', diskless: true }));
  });

  await vi.waitFor(() => expect(native.registered.size).toBe(22));
  const registeredSchemas = native.registerTool.mock.calls
    .filter(([tool]) => tool.name === 'openmotion_project_archive')
    .map(([tool]) => tool.inputSchema as { properties?: { action?: { enum?: string[] }; sourcePath?: unknown } });
  expect(registeredSchemas.length).toBeGreaterThanOrEqual(1);
  for (const schema of registeredSchemas) {
    expect(schema.properties?.action?.enum).toEqual(['export']);
    expect(schema.properties?.sourcePath).toBeUndefined();
  }
});
