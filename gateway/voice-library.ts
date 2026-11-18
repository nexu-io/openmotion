import { registeredProvider } from '../shared/provider-registry.ts';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceStore } from '../workspace.ts';
import { voiceKinds, isVoiceProvider, type VoiceAsset, type VoiceReference, type VoiceProvider } from '../shared/voice-library.ts';
import { AssetLibrary, assetName, atomicAssetJson, libraryId } from './asset-library.ts';
import { ProviderConnections } from './connections.ts';
import { apiJson, publicProviderFetch, type Fetcher } from './network.ts';

type SavedVoice = Omit<VoiceAsset, 'connection'> & { scope?: string; scopeRevision?: number; receipt?: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function providerId(value: unknown): asserts value is VoiceProvider {
  if (!isVoiceProvider(value)) throw new Error('Choose a supported voice provider');
}
function voiceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error('Enter a voice ID (up to 256 characters)');
}
export class VoiceLibrary {
  readonly store: WorkspaceStore;
  readonly connections: ProviderConnections;
  readonly fetcher: Fetcher;
  constructor(store: WorkspaceStore, fetcher: Fetcher = publicProviderFetch) {
    this.fetcher = fetcher; this.store = store.workspaceStore ?? store; this.connections = new ProviderConnections(this.store, fetcher);
  }
  private file(id: string) {
    if (!libraryId(id)) throw new Error('VOICE_NOT_FOUND');
    return path.join(this.store.directory, 'asset-library', 'voices', id + '.json');
  }
  private async saved(id: string): Promise<SavedVoice> {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('VOICE_NOT_FOUND'); throw error; }
  }
  private async context(provider: VoiceProvider) {
    const key = await this.connections.credential(provider), config = await this.connections.gatewayConfig();
    return { key, scope: key ? hash(provider + ':' + key) : undefined, enabled: config.providers[provider]?.enabled !== false };
  }
  private async public(record: SavedVoice): Promise<VoiceAsset> {
    const { scope, scopeRevision, receipt, ...voice } = record, current = await this.context(voice.provider);
    return { ...voice, connection: !current.key || !current.enabled ? 'required' : scope !== current.scope ? 'changed' : 'ready' };
  }
  async get(id: string) { return this.public(await this.saved(id)); }
  async list(trash = false) {
    const folder = path.join(this.store.directory, 'asset-library', 'voices');
    const files = await readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const records = await Promise.all(files.filter(file => libraryId(file.replace(/\.json$/, ''))).map(file => this.saved(file.slice(0, -5))));
    return Promise.all(records.filter(voice => Boolean(voice.trashedAt) === trash).sort((a, b) => b.updatedAt - a.updatedAt).map(voice => this.public(voice)));
  }
  private async preview(value: any) {
    if (value === undefined) return;
    if (!value || Object.keys(value).some(key => !['assetId', 'versionId'].includes(key))) throw new Error('Choose a saved audio preview');
    const { asset } = await new AssetLibrary(this.store).resolve(value);
    if (asset.modality !== 'audio') throw new Error('Choose an audio asset for the preview');
  }
  async add(input: { requestId: string; name: string; provider: VoiceProvider; externalId: string; kind?: VoiceAsset['kind']; description?: string }) {
    providerId(input.provider); voiceId(input.externalId); const name = assetName(input.name);
    if (typeof input.requestId !== 'string' || !/^[\w-]{1,100}$/.test(input.requestId)) throw new Error('A stable requestId is required');
    if (input.kind !== undefined && !voiceKinds.includes(input.kind)) throw new Error('Invalid voice kind');
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) throw new Error('Description exceeds 2000 characters');
    const digest = hash(input.requestId), id = `${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`, receipt = hash(JSON.stringify(input));
    return this.store.lock(async () => {
      const prior = await this.saved(id).catch(error => { if (error.message !== 'VOICE_NOT_FOUND') throw error; });
      if (prior) { if (prior.receipt !== receipt) throw new Error('REQUEST_ID_CONFLICT'); return this.public(prior); }
      const duplicate = (await this.list()).find(voice => voice.provider === input.provider && voice.externalId === input.externalId.trim());
      if (duplicate) return duplicate;
      const context = await this.context(input.provider), now = Date.now();
      const record: SavedVoice = { id, name, provider: input.provider, externalId: input.externalId.trim(), kind: input.kind ?? 'unknown', description: input.description ?? '',
        createdAt: now, updatedAt: now, revision: 1, access: 'unchecked', scope: context.scope, receipt };
      await atomicAssetJson(this.file(id), record); return this.public(record);
    });
  }
  async update(id: string, revision: number, changes: { name?: string; description?: string; trashed?: boolean; preview?: VoiceAsset['preview'] }) {
    if (!changes || Object.keys(changes).some(key => !['name','description','trashed','preview'].includes(key))) throw new Error('Invalid voice changes');
    if (changes.name !== undefined) assetName(changes.name);
    if (changes.description !== undefined && (typeof changes.description !== 'string' || changes.description.length > 2000)) throw new Error('Description exceeds 2000 characters');
    if (changes.trashed !== undefined && typeof changes.trashed !== 'boolean') throw new Error('Invalid trash state');
    await this.preview(changes.preview);
    return this.store.lock(async () => {
      const record = await this.saved(id);
      if (record.revision !== revision) throw new Error('VOICE_CHANGED: Refresh this voice before saving');
      const { trashed, ...fields } = changes; Object.assign(record, fields);
      if (trashed !== undefined) { if (trashed) record.trashedAt = Date.now(); else delete record.trashedAt; }
      record.revision++; record.updatedAt = Date.now(); await atomicAssetJson(this.file(id), record); return this.public(record);
    });
  }
  async discover(provider: VoiceProvider, page = 1) {
    providerId(provider);
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('Invalid voice page');
    const { key, enabled } = await this.context(provider);
    if (!key || !enabled) throw new Error('Connect this voice provider in Model providers');
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    if (provider === 'fishaudio') {
      const result = await apiJson(this.fetcher, `https://api.fish.audio/model?self=true&page_size=100&page_number=${page}`, { headers, signal: AbortSignal.timeout(20000) });
      if (!Array.isArray(result.items)) throw new Error('Voice catalogue unavailable');
      return { voices: result.items.map((row: any) => ({ externalId: String(row._id), name: String(row.title), kind: row.source === 'voice_design' ? 'designed' : 'unknown' })), nextPage: result.items.length === 100 && result.has_more !== false ? page + 1 : null };
    }
    const result = await apiJson(this.fetcher, `${registeredProvider(provider)!.baseUrl}/v1/get_voice`, { method: 'POST', headers, body: JSON.stringify({ voice_type: 'all' }), signal: AbortSignal.timeout(20000) });
    if (result.base_resp?.status_code !== 0) throw new Error('MiniMax voice catalogue unavailable');
    return { voices: (['system_voice','voice_cloning','voice_generation'] as const).flatMap(group => (result[group] ?? []).map((row: any) => ({ externalId: String(row.voice_id), name: String(row.voice_name || row.voice_id), kind: group === 'system_voice' ? 'system' : group === 'voice_cloning' ? 'cloned' : 'designed' }))), nextPage: null };
  }
  async check(id: string, revision: number) {
    const record = await this.saved(id), context = await this.context(record.provider);
    if (record.revision !== revision || record.trashedAt) throw new Error('VOICE_CHANGED');
    const found = await this.discover(record.provider);
    return this.store.lock(async () => {
      const current = await this.saved(id);
      if (current.revision !== revision || context.scope !== (await this.context(record.provider)).scope) throw new Error('VOICE_CHANGED: Connection changed during the check');
      current.access = found.voices.some((voice: any) => voice.externalId === record.externalId) ? 'listed' : 'not_listed';
      if (current.scope !== context.scope) current.scopeRevision = current.revision + 1;
      current.checkedAt = Date.now(); current.scope = context.scope; current.revision++; current.updatedAt = Date.now();
      await atomicAssetJson(this.file(id), current); return this.public(current);
    });
  }
  async resolve(reference: VoiceReference, provider: string) {
    if (!reference || !Number.isInteger(reference.revision) || reference.revision < 1 || Object.keys(reference).some(key => !['voiceId','revision'].includes(key))) throw new Error('Invalid voice reference');
    const record = await this.saved(reference.voiceId), voice = await this.public(record);
    // Source identity is immutable; metadata revisions do not invalidate a speech selection.
    if (voice.trashedAt || reference.revision < (record.scopeRevision ?? 1) || voice.revision < reference.revision) throw new Error('VOICE_CHANGED: Select the current voice');
    if (provider !== voice.provider) throw new Error('Voice and speech model must use the same provider');
    if (voice.connection !== 'ready') throw new Error('Check this voice after connecting or changing its provider');
    return { voiceId: voice.id, revision: voice.revision, name: voice.name, provider: voice.provider, externalId: voice.externalId };
  }
}
