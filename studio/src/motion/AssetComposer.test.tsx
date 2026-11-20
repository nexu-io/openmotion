import { findMediaStudio, findTechniqueStudio } from '../../../shared/studio-catalog';
// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssetComposer, type AssetDraft } from './AssetComposer';
import type { Model } from '../../../shared/gateway';
const { generate, loadGateway, gatewayRequest, chrome } = vi.hoisted(() => ({
  generate: vi.fn(), loadGateway: vi.fn(), gatewayRequest: vi.fn(),
  chrome: { openModelSettings: vi.fn(), openProviderSettings: vi.fn(), openAccountSettings: vi.fn(), openSubscriptionSettings: vi.fn() },
}));
vi.mock('./assetClient', () => ({ assetRequest: generate }));
vi.mock('./gatewayClient', () => ({ loadGateway, gatewayRequest }));
vi.mock('./AssetConversation', () => ({ AssetConversation: () => null }));
vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock('./WorkspaceFrame', () => ({ useWorkspaceChrome: () => chrome }));
const model: Model = { id: 'codex:image', provider: 'codex', modelId: 'image', label: 'Codex Image', modality: 'image', source: 'builtin', mode: 'text-to-image' };
let root: Root, container: HTMLDivElement;
const created = vi.fn();
const props: ComponentProps<typeof AssetComposer> = {
  active: true, draft: { modality: 'image', model: model.id, prompt: 'Continue the original', parameters: { size: '1536x1024', custom: { value: 7 } }, references: [] },
  setDraft: vi.fn(), agentReferences: [], setAgentReferences: vi.fn(), jobs: [], mode: 'direct', onMode: vi.fn(), taskIds: {},
  history: { tasks: [], loading: false, onRetry: vi.fn(), onSelect: vi.fn() }, selectingTask: false,
  onNew: vi.fn(), onChatChanged: vi.fn(), onChatStarted: vi.fn(), onCancel: vi.fn(), onView: vi.fn(), onReference: vi.fn(), onCreated: created, onError: vi.fn(), onClose: vi.fn(),
};
beforeEach(() => { vi.clearAllMocks(); loadGateway.mockResolvedValue({ models: [model], status: { providers: [{ id: 'codex', available: true }], routes: {} } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('temporarily hides the Agent tab and keeps direct generation available when viewing a conversation', async () => {
  await act(async () => root.render(<AssetComposer {...props} mode="agent" />));
  expect(container.querySelector('button[aria-label="Agent conversation"]')).toBeNull();
  const direct = container.querySelector<HTMLButtonElement>('button[aria-label="Direct generation"]')!;
  expect(direct.textContent).toBe('Generate');
  expect(direct.getAttribute('aria-pressed')).toBe('false');
  await act(async () => direct.click());
  expect(props.onMode).toHaveBeenCalledExactlyOnceWith('direct');
});
it('restores native and custom parameters without submitting until explicitly requested', async () => {
  generate.mockResolvedValue({ job: { id: 'new-job' } });
  await act(async () => root.render(<AssetComposer {...props} />));
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Continue the original');
  expect(generate).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'generate', model: model.id, prompt: 'Continue the original', parameters: props.draft.parameters }));
  expect(created).toHaveBeenCalledWith({ id: 'new-job' });
});
it('does not silently replace the historical model with an available default', async () => {
  await act(async () => root.render(<AssetComposer {...props} draft={{ ...props.draft, model: 'missing:model' }} />));
  expect(container.textContent).toContain('This task’s model is unavailable');
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')?.disabled).toBe(true);
  expect(generate).not.toHaveBeenCalled();
});
it.each([
  ['prompt', { prompt: 'A new idea typed while waiting' }],
  ['model', { model: 'other:image' }],
  ['references', { references: [{ name: 'New reference', reference: { assetId: 'asset', versionId: 'version' } }] }],
  ['parameters', { parameters: { size: '1024x1024' } }],
] as const)('preserves pending %s edits while recording the submitted job', async (_field, changes) => {
  let resolve!: (value: unknown) => void;
  generate.mockImplementation(() => new Promise(done => { resolve = done; }));
  let latest!: AssetDraft, update!: ComponentProps<typeof AssetComposer>['setDraft'];
  function Harness() {
    const [draft, setDraft] = useState(props.draft); latest = draft; update = setDraft;
    return <AssetComposer {...props} draft={draft} setDraft={setDraft} />;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  const edited = { ...props.draft, ...structuredClone(changes) } as AssetDraft;
  await act(async () => update(edited));
  await act(async () => resolve({ job: { id: 'submitted-job' } }));
  expect(latest).toBe(edited);
  expect(created).toHaveBeenCalledExactlyOnceWith({ id: 'submitted-job' });
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: props.draft.prompt, model: model.id, parameters: props.draft.parameters, references: [] }));
});
it('sends one reference to an account image model that reports editing support', async () => {
  const account: Model = { id: 'account:image', provider: 'account', modelId: 'image', label: 'Account Image', modality: 'image', source: 'live', mode: 'text-to-image', supportsImageReference: true };
  const basic: Model = { ...account, id: 'account:basic', modelId: 'basic', label: 'Account Basic', supportsImageReference: undefined };
  loadGateway.mockResolvedValue({ models: [account, basic], status: { providers: [{ id: 'account', available: true }], routes: {} } });
  generate.mockResolvedValue({ job: { id: 'edit-job' } });
  const references = [{ name: 'Cup', reference: { assetId: 'asset', versionId: 'version' } }];
  const draft = { ...props.draft, model: basic.id, parameters: {}, references };
  await act(async () => root.render(<AssetComposer {...props} draft={draft} />));
  expect(container.textContent).toContain('This model cannot use asset references');
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')?.disabled).toBe(true);
  await act(async () => root.render(<AssetComposer {...props} draft={{ ...draft, model: account.id }} />));
  expect(container.textContent).toContain('This model edits up to {count} image references.');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'generate', model: account.id, mode: 'text-to-image', references: [references[0].reference] }));
});

it.each(['image', 'video'] as const)('uses the model reference contract for Cloud %s', async modality => {
  const cloud: Model = { id: 'opendesign:references', provider: 'opendesign', modelId: 'references', label: 'Cloud', modality,
    source: 'live', mode: `text-to-${modality}`, supportsImageReference: modality === 'image', maxInputImages: modality === 'image' ? 20 : 1 };
  loadGateway.mockResolvedValue({ models: [cloud], status: { providers: [{ id: 'opendesign', available: true }], routes: {} } });
  generate.mockResolvedValue({ job: { id: 'cloud-reference-job' } });
  const references = Array.from({ length: cloud.maxInputImages! }, (_, index) => ({ name: `Reference ${index}`, reference: { assetId: `asset-${index}`, versionId: 'version' } }));
  await act(async () => root.render(<AssetComposer {...props} draft={{ ...props.draft, modality, model: cloud.id, parameters: {}, references }} />));
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')?.disabled).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('.om-creation-reference')?.disabled).toBe(true);
  expect(container.textContent).toContain(modality === 'video' ? 'This video model uses one image as its first frame.' : 'This model edits up to {count} image references.');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: cloud.id, references: references.map(item => item.reference) }));
  await act(async () => root.render(<AssetComposer {...props} draft={{ ...props.draft, modality, model: cloud.id, references: [...references, references[0]] }} />));
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')?.disabled).toBe(true);
});

const cloudImage: Model = { ...model, id: 'opendesign:sunburst', provider: 'opendesign', source: 'live', supportsImageReference: undefined };
const cloudState = (models: Model[]) => ({ models, status: { providers: [{ id: 'opendesign', available: true }], routes: {} } });
it('syncs unknown Cloud capability without remounting or losing the draft and references', async () => {
  loadGateway.mockResolvedValue(cloudState([cloudImage])); gatewayRequest.mockResolvedValue({});
  const draft = { ...props.draft, model: cloudImage.id, references: [{ name: 'Cup', reference: { assetId: 'a', versionId: 'v' } }] };
  await act(async () => root.render(<AssetComposer {...props} draft={draft} />));
  expect(container.textContent).toContain('Image editing capability is unknown');
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.disabled).toBe(true);
  loadGateway.mockResolvedValue(cloudState([{ ...cloudImage, supportsImageReference: true, maxInputImages: 3 }]));
  await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Sync models')!.click());
  expect(gatewayRequest).toHaveBeenCalledExactlyOnceWith('settings/providers/opendesign/sync', 'POST', {});
  expect(container.querySelector<HTMLButtonElement>('.om-creation-reference')!.disabled).toBe(false);
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(draft.prompt);
  expect(container.textContent).toContain('Cup'); expect(props.setDraft).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
});
it('discards an earlier model response after settings change and keeps a removed model selected for validation', async () => {
  let release!: (value: unknown) => void;
  loadGateway.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(cloudState([]));
  await act(async () => root.render(<AssetComposer {...props} draft={{ ...props.draft, model: cloudImage.id }} />));
  await act(async () => window.dispatchEvent(new Event('motion:gateway-changed')));
  await act(async () => release(cloudState([{ ...cloudImage, supportsImageReference: true }])));
  expect(container.textContent).toContain('This task’s model is unavailable');
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.disabled).toBe(true);
  expect(props.setDraft).not.toHaveBeenCalled();
  gatewayRequest.mockResolvedValue({}); loadGateway.mockResolvedValue(cloudState([{ ...cloudImage, supportsImageReference: true }]));
  await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Sync models')!.click());
  expect(gatewayRequest).toHaveBeenCalledExactlyOnceWith('settings/providers/opendesign/sync', 'POST', {});
  expect(container.textContent).not.toContain('This task’s model is unavailable');
});
it('distinguishes explicit unsupported capability from unknown and reports failed sync', async () => {
  const draft = { ...props.draft, model: cloudImage.id, references: [{ name: 'Cup', reference: { assetId: 'a', versionId: 'v' } }] };
  loadGateway.mockResolvedValue(cloudState([{ ...cloudImage, supportsImageReference: false }]));
  await act(async () => root.render(<AssetComposer {...props} draft={draft} />));
  expect(container.textContent).toContain('This model cannot use asset references');
  expect(container.textContent).not.toContain('Sync models');
  loadGateway.mockResolvedValue(cloudState([cloudImage]));
  await act(async () => window.dispatchEvent(new Event('motion:gateway-changed')));
  gatewayRequest.mockRejectedValue(new Error('Catalogue unavailable'));
  await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Sync models')!.click());
  expect(props.onError).toHaveBeenCalledWith('Catalogue unavailable'); expect(generate).not.toHaveBeenCalled();
});

const firstFrame = [{ name: 'Portrait', reference: { assetId: 'portrait', versionId: 'first-version' } }];
const cloudVideo = (modelId = 'wan-2.7'): Model => ({
  id: `opendesign:${modelId}`, provider: 'opendesign', modelId, label: 'Cloud video', modality: 'video', source: 'live',
  mode: 'text-to-video', maxInputImages: 1, defaults: { ratio: '16:9', duration: 5 },
  generationOptions: { delivery: 'provider', fields: [{ key: 'ratio', label: 'Aspect ratio', kind: 'choice', presentation: 'ratio',
    choices: ['16:9', '9:16', 'adaptive'].map(value => ({ value, label: value })) }] },
});

it.each(['wan-2.7', 'doubao-seedance-2-5-260628'])('shows first-frame geometry and excludes inherited ratio when submitting %s', async modelId => {
  const selected = cloudVideo(modelId);
  loadGateway.mockResolvedValue(cloudState([selected])); generate.mockResolvedValue({ job: { id: 'i2v-job' } });
  await act(async () => root.render(<AssetComposer {...props} draft={{ modality: 'video', model: selected.id, prompt: 'Walk forward', references: firstFrame }} />));
  expect(container.textContent).toContain('Aspect ratio follows the first frame.');
  expect(container.querySelector('.om-generation-summary')!.textContent).toContain('Follows first frame');
  expect(container.querySelector('.om-generation-summary')!.textContent).not.toContain('16:9');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-generation-summary')!.click());
  expect(document.querySelector('.om-generation-ratios')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ parameters: {}, references: firstFrame.map(item => item.reference) }));
});

it('holds the text-to-video quick choice while a first frame is attached and restores it after removal', async () => {
  const selected = cloudVideo();
  loadGateway.mockResolvedValue(cloudState([selected])); generate.mockResolvedValue({ job: { id: 'i2v-job' } });
  let update!: ComponentProps<typeof AssetComposer>['setDraft'];
  function Harness() {
    const [draft, setDraft] = useState<AssetDraft>({ modality: 'video', model: selected.id, prompt: 'Walk forward', references: [] });
    update = setDraft;
    return <AssetComposer {...props} draft={draft} setDraft={setDraft} />;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>('.om-generation-summary')!.click());
  const ratio = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.om-generation-ratios button')).find(button => button.textContent === '9:16');
  await act(async () => ratio()!.click());
  expect(ratio()!.getAttribute('aria-pressed')).toBe('true');
  await act(async () => update(current => ({ ...current, references: firstFrame })));
  expect(ratio()).toBeUndefined();
  expect(container.textContent).toContain('Remove it to restore your text-to-video ratio.');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate.mock.calls[0][0].parameters).toEqual({});
  await act(async () => container.querySelector<HTMLButtonElement>('.om-asset-references .om-badge')!.click());
  expect(container.textContent).not.toContain('Aspect ratio follows the first frame.');
  expect(container.querySelector('.om-generation-summary')!.textContent).toContain('9:16');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-generation-summary')!.click());
  expect(ratio()!.getAttribute('aria-pressed')).toBe('true');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate.mock.calls[1][0]).toEqual(expect.objectContaining({ parameters: { ratio: '9:16' }, references: [] }));
});

it('rejects explicit fixed-ratio JSON without discarding it or submitting a paid request', async () => {
  const selected = cloudVideo(); loadGateway.mockResolvedValue(cloudState([selected]));
  await act(async () => root.render(<AssetComposer {...props} draft={{ modality: 'video', model: selected.id, prompt: 'Walk forward', parameters: { ratio: '16:9', seed: 7 }, references: firstFrame }} />));
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).not.toHaveBeenCalled();
  expect(props.onError).toHaveBeenCalledExactlyOnceWith('First-frame video follows the input image ratio. Remove parameters.ratio or set it to "adaptive".');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-generation-summary')!.click());
  expect(JSON.parse(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Model parameters"]')!.value)).toEqual({ ratio: '16:9', seed: 7 });
  expect(props.setDraft).not.toHaveBeenCalled();
});

it('recognizes a provider-native first frame in advanced JSON and leaves unrelated models unchanged', async () => {
  const selected = cloudVideo();
  const other = { ...selected, id: 'opendesign:other-video', modelId: 'other-video' };
  loadGateway.mockResolvedValue(cloudState([selected, other])); generate.mockResolvedValue({ job: { id: 'other-job' } });
  const parameters = { images: [{ role: 'first_frame', url: 'https://example.test/portrait.png' }], ratio: '16:9' };
  const draft: AssetDraft = { modality: 'video', model: selected.id, prompt: 'Walk forward', parameters, references: [] };
  await act(async () => root.render(<AssetComposer {...props} draft={draft} />));
  expect(container.textContent).toContain('Aspect ratio follows the first frame.');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).not.toHaveBeenCalled();
  await act(async () => root.render(<AssetComposer {...props} draft={{ ...draft, model: other.id }} />));
  expect(container.textContent).not.toContain('Aspect ratio follows the first frame.');
});

it('keeps unsupported account reference drafts blocked without promising first-frame behavior', async () => {
  const selected = { ...cloudVideo(), id: 'account:wan-2.7', provider: 'account', maxInputImages: 0 };
  loadGateway.mockResolvedValue({ models: [selected], status: { providers: [{ id: 'account', available: true }], routes: {} } });
  await act(async () => root.render(<AssetComposer {...props} draft={{ modality: 'video', model: selected.id, prompt: 'Walk forward', references: firstFrame }} />));
  expect(container.textContent).toContain('This model cannot use asset references');
  expect(container.textContent).not.toContain('Aspect ratio follows the first frame.');
  expect(container.querySelector('.om-generation-summary')!.textContent).not.toContain('Follows first frame');
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.disabled).toBe(true);
  expect(generate).not.toHaveBeenCalled();
});

it('requires a pinned image and a capable model for the image-editing scene', async () => {
  const { studioDestination } = await import('./creativeStudios');
  const editing = { ...model, id: 'codex:edit', label: 'Edit model', supportsImageReference: true };
  loadGateway.mockResolvedValue({ models: [model, editing], status: { providers: [{ id: 'codex', available: true }], routes: { image: model.id } } });
  const studio = { catalog: { catalog: await loadGateway(), failed: false, retry: vi.fn() }, destination: studioDestination(findMediaStudio('design')!, 'image-edit', editing.id), remember: vi.fn(), chooseModel: vi.fn() };
  const draft = { modality: 'image' as const, prompt: 'Change the light', references: [] };
  await act(async () => root.render(<AssetComposer {...props} studio={studio} draft={draft} />));
  const submit = () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!;
  expect(submit().disabled).toBe(true);
  const reference = { assetId: 'asset', versionId: 'pinned' };
  await act(async () => root.render(<AssetComposer {...props} studio={studio} draft={{ ...draft, references: [{ reference, name: 'First' }] }} />));
  expect(submit().disabled).toBe(false);
  generate.mockResolvedValue({ job: { id: 'job' } });
  await act(async () => submit().click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: editing.id, references: [reference] }));
});

it('never substitutes a music model for a routed speech model', async () => {
  const { studioDestination } = await import('./creativeStudios');
  const music = { ...model, id: 'p:music', modality: 'audio', mode: 'text-to-audio' };
  loadGateway.mockResolvedValue({ models: [music], status: { providers: [{ id: 'codex', available: true }], routes: { audio: music.id } } });
  const studio = { catalog: { catalog: await loadGateway(), failed: false, retry: vi.fn() }, destination: studioDestination(findMediaStudio('sound')!, 'speech', 'p:voice'), remember: vi.fn(), chooseModel: vi.fn() };
  await act(async () => root.render(<AssetComposer {...props} studio={studio} draft={{ modality: 'audio', prompt: 'Hello', references: [] }} />));
  expect(container.textContent).toContain('p:voice');
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')?.disabled).toBe(true);
  expect(generate).not.toHaveBeenCalled();
});

it('keeps the prompt and pinned reference while switching providers with identically named models', async () => {
  const { studioDestination } = await import('./creativeStudios');
  const editing = { ...model, label: 'Studio Image', supportsImageReference: true };
  const alternate = { ...editing, id: 'other:image', provider: 'other' };
  const offline = { ...editing, id: 'offline:image', provider: 'offline' };
  const reference = { assetId: 'product', versionId: 'v1' };
  const catalog = { models: [editing, alternate, offline], status: {
    providers: [{ id: 'codex', label: 'Codex', available: true }, { id: 'other', label: 'Alternate', available: true }, { id: 'offline', label: 'Offline', available: false }],
    routes: { image: model.id }
  } };
  loadGateway.mockResolvedValue(catalog);
  const loaded = await loadGateway();
  function Harness() {
    const [id, chooseModel] = useState(editing.id);
    const [draft, setDraft] = useState<AssetDraft>({ ...props.draft, references: [{ reference, name: 'Photo' }] });
    return <AssetComposer {...props} draft={draft} setDraft={setDraft} studio={{
      catalog: { catalog: loaded, failed: false, retry: vi.fn() }, chooseModel, remember: vi.fn(),
      destination: studioDestination(findMediaStudio('design')!, 'image-edit', id)
    }} />;
  }
  const switchTo = async (label: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Provider"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes(label))!.click());
  };
  await act(async () => root.render(<Harness />));
  await switchTo('Offline');
  const submit = () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!;
  expect(submit().disabled).toBe(true);
  await switchTo('Alternate');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Asset prompt"]')!.value).toBe(props.draft.prompt);
  expect(generate).not.toHaveBeenCalled();
  generate.mockResolvedValue({ job: { id: 'new' } });
  await act(async () => submit().click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'generate', model: alternate.id, mode: alternate.mode,
    prompt: props.draft.prompt, references: [reference], parameters: {} }));
});

it.each([
  { scene: 'text-to-video', duration: 10, expected: { duration: 10, ratio: '9:16' } },
  { scene: 'image-to-video', duration: 30, expected: {} },
] as const)('submits the requested shot once using compatible preferences for $scene', async ({ scene, duration, expected }) => {
  const { studioDestination } = await import('./creativeStudios');
  const selected = cloudVideo();
  selected.generationOptions!.fields.push({ key: 'duration', kind: 'choice', label: 'Duration (seconds)', choices: [{ value: 10, label: '10' }] });
  loadGateway.mockResolvedValue(cloudState([selected]));
  const studio = { catalog: { catalog: await loadGateway(), failed: false, retry: vi.fn() }, chooseModel: vi.fn(), remember: vi.fn(),
    destination: studioDestination(findTechniqueStudio('shorts')!, scene, selected.id) };
  const references = scene === 'image-to-video' ? firstFrame : [];
  const draft: AssetDraft = { modality: 'video', prompt: 'A vertical shot of a ceramic vase', references, shotPreferences: { aspect: '9:16', duration } };
  await act(async () => root.render(<AssetComposer {...props} draft={draft} studio={studio} />));
  expect(generate).not.toHaveBeenCalled();
  generate.mockResolvedValue({ job: { id: 'test-shot' } });
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'generate', model: selected.id,
    prompt: draft.prompt, references: references.map(item => item.reference), parameters: expected }));
});

it('resumes an old account task while preserving a newer prompt draft', async () => {
  const account: Model = { ...model, id: 'account:image', provider: 'account', modelId: 'image' };
  loadGateway.mockResolvedValue({ models: [account], status: { providers: [{ id: 'account', available: true }], routes: {} } });
  const job = { id: 'old-job', model: account, prompt: 'old prompt', parameters: {}, modality: 'image' as const, state: 'failed' as const, phase: 'failed', remoteId: 'original-remote', assets: [], requestHash: 'snapshot', createdAt: 1, updatedAt: 2 };
  const resume = vi.fn(async () => {}), setDraft = vi.fn();
  const draft = { ...props.draft, model: account.id, prompt: 'new prompt for next generation', parameters: {} };
  await act(async () => root.render(<AssetComposer {...props} draft={draft} setDraft={setDraft} jobs={[job]} taskIds={{ direct: job.id }} onResume={resume} />));
  const button = [...container.querySelectorAll('button')].find(node => node.textContent === 'Continue download')!;
  await act(async () => button.click());
  expect(resume).toHaveBeenCalledExactlyOnceWith(job);
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(draft.prompt);
  expect(setDraft).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
});

it('shows a non-blocking subscription prompt for Free/Go OpenDesign accounts while keeping submit enabled', async () => {
  const account: Model = { ...model, id: 'account:image', provider: 'account', modelId: 'image', label: 'Account Image' };
  loadGateway.mockResolvedValue({
    models: [account],
    status: { providers: [{ id: 'account', label: 'OpenDesign', available: true, mediaEntitlement: 'not-included', plan: 'free', hasBalance: false }], routes: { image: account.id } },
  });
  await act(async () => root.render(<AssetComposer {...props} draft={{ ...props.draft, model: account.id, parameters: {} }} />));
  expect(container.textContent).toContain('Signed in; multimodal generation requires OpenDesign Plus or above');
  const submit = container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!;
  expect(submit.disabled).toBe(false);
  const manage = [...container.querySelectorAll('button')].find(node => node.textContent === 'Manage subscription')!;
  await act(async () => manage.click());
  expect(chrome.openSubscriptionSettings).toHaveBeenCalledTimes(1);
});

it('links directly to provider or account setup when a Studio selects an unconfigured provider', async () => {
  const { studioDestination } = await import('./creativeStudios');
  const falModel: Model = { ...model, id: 'fal:flux', provider: 'fal', modelId: 'flux', label: 'Flux' };
  const accountModel: Model = { ...model, id: 'account:img', provider: 'account', modelId: 'img', label: 'Account Image' };
  const catalog = {
    models: [falModel, accountModel],
    status: {
      providers: [
        { id: 'fal', label: 'fal.ai', available: false },
        { id: 'account', label: 'OpenDesign', available: false },
      ],
      routes: {},
    },
  };
  await act(async () => root.render(<AssetComposer {...props} draft={{ ...props.draft, model: undefined }} studio={{
    catalog: { catalog, failed: false, retry: vi.fn() }, chooseModel: vi.fn(), remember: vi.fn(),
    destination: studioDestination(findMediaStudio('design')!, 'text-to-image', falModel.id),
  }} />));
  expect(container.textContent).toContain('{provider} needs setup before generating.');
  const configure = [...container.querySelectorAll('button')].find(node => node.textContent === 'Configure {provider}')!;
  await act(async () => configure.click());
  expect(chrome.openProviderSettings).toHaveBeenCalledExactlyOnceWith('fal');

  await act(async () => root.render(<AssetComposer {...props} draft={{ ...props.draft, model: undefined }} studio={{
    catalog: { catalog, failed: false, retry: vi.fn() }, chooseModel: vi.fn(), remember: vi.fn(),
    destination: studioDestination(findMediaStudio('design')!, 'text-to-image', accountModel.id),
  }} />));
  const signIn = [...container.querySelectorAll('button')].find(node => node.textContent === 'Sign in with OpenDesign')!;
  await act(async () => signIn.click());
  expect(chrome.openAccountSettings).toHaveBeenCalledTimes(1);
});

it('defaults Shorts Studio to 9:16 on OpenDesign video models publishing ratios and filters paired image resolutions', async () => {
  const { studioDestination } = await import('./creativeStudios');
  const { generationOptions } = await import('../../../shared/generation-options');
  const videoBase: Model = {
    id: 'opendesign:wan-2.7', provider: 'opendesign', modelId: 'wan-2.7', label: 'Wan 2.7', modality: 'video', mode: 'text-to-video', source: 'live',
    nativeOptions: { ratios: { values: ['16:9', '9:16'], default: '16:9' }, durations: { values: [5, 10], default: 5 } },
  };
  const video: Model = { ...videoBase, generationOptions: generationOptions(videoBase) };
  loadGateway.mockResolvedValue(cloudState([video]));
  const studio = {
    catalog: { catalog: await loadGateway(), failed: false, retry: vi.fn() }, chooseModel: vi.fn(), remember: vi.fn(),
    destination: studioDestination(findTechniqueStudio('shorts')!, 'text-to-video', video.id),
  };
  await act(async () => root.render(<AssetComposer {...props} draft={{ modality: 'video', prompt: 'Vertical skyline', references: [] }} studio={studio} />));
  generate.mockResolvedValue({ job: { id: 'shorts-job' } });
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: video.id, parameters: { ratio: '9:16' } }));

  const imageBase: Model = {
    id: 'opendesign:nano-banana-2', provider: 'opendesign', modelId: 'nano-banana-2', label: 'Nano Banana 2', modality: 'image', mode: 'text-to-image', source: 'live',
    nativeOptions: {
      profiles: {
        generations: {
          profiles: [
            { aspect_ratio: '1:1', resolution: '1K' },
            { aspect_ratio: '1:1', resolution: '2K' },
            { aspect_ratio: '16:9', resolution: '2K' },
          ],
          default: { aspect_ratio: '1:1', resolution: '1K' },
        },
      },
    },
  };
  const image: Model = { ...imageBase, generationOptions: generationOptions(imageBase) };
  loadGateway.mockResolvedValue(cloudState([image]));
  await act(async () => root.render(<AssetComposer {...props} draft={{ modality: 'image', model: image.id, prompt: 'Poster', references: [] }} />));
  await act(async () => container.querySelector<HTMLButtonElement>('.om-generation-summary')!.click());
  const ratio16x9 = [...document.querySelectorAll<HTMLButtonElement>('.om-generation-ratios button')].find(b => b.textContent === '16:9')!;
  await act(async () => ratio16x9.click());
  const resolutionSelect = document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Resolution"]')!;
  await act(async () => resolutionSelect.click());
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(el => el.textContent);
  expect(options).toContain('2K');
  expect(options).not.toContain('1K');
});
