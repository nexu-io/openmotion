// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssetComposer, type AssetDraft } from './AssetComposer';
import type { Model } from '../../../shared/gateway';
const { generate, loadGateway, gatewayRequest } = vi.hoisted(() => ({ generate: vi.fn(), loadGateway: vi.fn(), gatewayRequest: vi.fn() }));
vi.mock('./assetClient', () => ({ assetRequest: generate }));
vi.mock('./gatewayClient', () => ({ loadGateway, gatewayRequest }));
vi.mock('./AssetConversation', () => ({ AssetConversation: () => null }));
vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock('./WorkspaceFrame', () => ({ useWorkspaceChrome: () => ({ openModelSettings: vi.fn() }) }));
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

it('keeps the saved voice and provider pinned when reselecting audio, and submits that reference', async () => {
  const speech: Model = { ...model, id: 'fishaudio:s2-pro', provider: 'fishaudio', modelId: 's2-pro', label: 'Fish Audio', modality: 'audio', mode: 'text-to-speech' };
  loadGateway.mockResolvedValue({ models: [speech, { ...speech, id: 'minimax-speech:speech-2.8-hd', provider: 'minimax-speech' }], status: { providers: [{ id: 'fishaudio', available: true }, { id: 'minimax-speech', available: true }], routes: {} } });
  generate.mockResolvedValue({ job: { id: 'speech-job' } });
  const voiceRef = { voiceId: 'my-saved-voice', revision: 3 };
  function Harness() {
    const [draft, setDraft] = useState<AssetDraft>({ modality: 'audio', model: speech.id, prompt: 'My narration', references: [], voiceRef, voiceName: 'Channel narrator' });
    return <AssetComposer {...props} draft={draft} setDraft={setDraft} />;
  }
  await act(async () => root.render(<Harness />));
  const audio = container.querySelector<HTMLButtonElement>('.om-creation-type[data-tone="audio"]')!;
  await act(async () => audio.click());
  expect(container.textContent).toContain('Channel narrator');
  expect(container.querySelector<HTMLButtonElement>('.om-creation-type[data-tone="video"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.disabled).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>('.om-creation-submit-button')!.click());
  expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: speech.id, modality: 'audio', mode: 'text-to-speech', voiceRef }));
});
