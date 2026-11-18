// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceLibrary } from './VoiceLibrary';
import { assetRequest } from './assetClient';
import type { VoiceAsset } from '../../../shared/voice-library';
vi.mock('./WorkspaceFrame', () => ({ useWorkspaceChrome: () => ({ openModelSettings: vi.fn() }) }));
vi.mock('./pageTracking', () => ({ reportAssetsClick: vi.fn() }));
vi.mock('./assetClient', () => ({ assetRequest: vi.fn(), uploadLibraryAsset: vi.fn() }));
vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text, formatDate: () => 'Today' }) }));
const voice: VoiceAsset = { id: '12345678-1234-1234-1234-123456789abc', name: 'My channel voice', provider: 'fishaudio', externalId: 'private-id', kind: 'cloned', description: '', revision: 1, createdAt: 1, updatedAt: 1, access: 'unchecked', connection: 'required' };
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); vi.clearAllMocks(); });
async function render(extra = {}, savedVoice = voice) {
 container = document.createElement('div'); document.body.append(container); root = createRoot(container);
 const onUse = vi.fn(), onError = vi.fn(), onNotice = vi.fn();
 vi.mocked(assetRequest).mockResolvedValue({ voices: [savedVoice] });
 await act(async () => root!.render(<VoiceLibrary active revision={0} adding={false} onCloseAdd={vi.fn()} onUse={onUse} onError={onError} onNotice={onNotice} {...extra} />));
 return { onUse, onError, onNotice };
}
async function click(text: string) {
 const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes(text));
 expect(button, text).toBeTruthy(); await act(async () => button!.click());
}
it('voice detail keeps a missing connection visible, opens narration with its pinned identity, and never generates on selection', async () => {
 const { onUse } = await render();
 await click('My channel voice');
 expect(container.textContent).toContain('Connect provider');
 expect(container.textContent).toContain('No audio sample attached');
 await click('Use for narration');
 expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ modality: 'audio', model: 'fishaudio:s2-pro', voiceRef: { voiceId: voice.id, revision: 1 } }));
 expect(vi.mocked(assetRequest).mock.calls.every(([args]) => (args.voice as any).command === 'list')).toBe(true);
});
it('trashing sends only a revision-guarded local update and refreshes the library', async () => {
 await render(); await click('My channel voice');
 vi.mocked(assetRequest).mockImplementation(async args => (args.voice as any).command === 'update' ? { voice: { ...voice, revision: 2, trashedAt: 2 } } : { voices: [] });
 await click('Move voice to trash');
 expect(assetRequest).toHaveBeenCalledWith({ action: 'voice', voice: { command: 'update', voiceId: voice.id, revision: 1, changes: { trashed: true } } });
 expect(container.textContent).not.toContain('My channel voice');
});
it('the add form saves an existing ID without a catalogue or speech request', async () => {
 await render({ adding: true });
 const name = document.querySelector<HTMLInputElement>('[aria-label="Voice name"]')!, id = document.querySelector<HTMLInputElement>('[aria-label="Voice ID"]')!;
 await act(async () => { for (const [input,value] of [[name,'A narrator'],[id,'my-voice-id']] as const) { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!; setter.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); } });
 vi.mocked(assetRequest).mockResolvedValue({ voice });
 await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(assetRequest).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice', voice: expect.objectContaining({ command: 'add', name: 'A narrator', externalId: 'my-voice-id' }) }));
 expect(vi.mocked(assetRequest).mock.calls.some(([args]) => args.action === 'generate')).toBe(false);
});

it('uses the same asset tile and three-column detail layout without a separate voice introduction', async () => {
  await render();
  expect(container.querySelector('.om-asset-tile .om-asset-open .om-asset-preview')).toBeTruthy();
  expect(container.querySelector('.om-asset-tile-caption')?.textContent).toContain(voice.name);
  expect(container.textContent).not.toContain('Your voice, in every video');
  await click(voice.name);
  expect(container.querySelector('.om-asset-workspace .om-asset-filmstrip')).toBeTruthy();
  expect(container.querySelector('.om-asset-viewer-stage')).toBeTruthy();
  expect(container.querySelector('.om-asset-inspector')).toBeTruthy();
  await click('All assets');
  expect(container.querySelector('.om-asset-workspace')).toBeNull();
});

for (const provider of ['minimax-speech-cn', 'minimax-speech'] as const) it(`narration keeps the ${provider} voice on its regional speech model`, async () => {
 const { onUse } = await render({}, { ...voice, provider });
 await click(voice.name); await click('Use for narration');
 expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ model: `${provider}:speech-2.8-hd`, voiceRef: { voiceId: voice.id, revision: voice.revision } }));
});
