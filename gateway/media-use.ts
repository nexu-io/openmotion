import { ToolInputError } from '../shared/tool-input-error.ts';
import type { OmTracking } from '../shared/tracking.ts';
import type { WorkspaceStore } from '../workspace.ts';
import type { GenerateInput } from '../shared/gateway.ts';
import { isMediaProvider, registeredProvider } from '../shared/provider-registry.ts';
import { gatewayFor } from './service.ts';
import { getWorkflow } from '../shared/workflow.ts';

export async function mediaUse(store: WorkspaceStore, args: any, tracking?: OmTracking) {
  const gateway = gatewayFor(store, tracking);
  const connections = await gateway.connections.list();
  // Codex is a local image Agent: Settings offers it for images, so discovery accepts it; new images go through openmotion_assets_use.
  const supported = (id: string) => isMediaProvider(id) || id === 'codex' || registeredProvider(id)?.integration === 'account' || connections.some(p => p.id === id && p.protocol === 'openai' && !p.setupRequired);
  const referenceSection = (id: string) => registeredProvider(id)?.reference ?? 'compatible';
  if (args.provider !== undefined && !supported(args.provider)) throw new ToolInputError('unsupported media provider', 'provider', 'invalid_enum');
  if (args.action === 'inspect') {
    const status = await gateway.status(false, { refreshAccount: true });
    return { providers: status.providers.filter(p => supported(p.id) && (isMediaProvider(p.id) || p.configured || p.id === 'account')),
      defaults: status.routes,
      settings: 'Open Settings > Model providers, or Account for OpenDesign sign-in. Saving a key enables a provider; sync or add its models and select defaults by capability.',
      settingsHandoff: { tool: 'openmotion_open_preview', arguments: { target: 'providers' } },
      references: status.providers.filter(p => supported(p.id)).map(p => ({ provider: p.id, uri: `openmotion://workflow/media/${referenceSection(p.id)}` })),
      credentials: 'Read by the local service; keys are never returned to the Agent.' };
  }
  if (args.action === 'reference') {
    if (!args.provider) throw new ToolInputError('provider is required', 'provider', 'missing');
    return getWorkflow(referenceSection(args.provider), 'media');
  }
  if (args.action === 'models') {
    const providers = (await gateway.status()).providers.filter(p => supported(p.id) && (!args.provider || p.id === args.provider) && p.enabled);
    const pages = await Promise.all(providers.map(provider => gateway.listModels({ provider: provider.id, modality: args.modality, refresh: args.refresh, query: args.query, offset: args.offset, limit: args.limit })));
    return { providers: providers.map(p => p.id), catalogs: pages, setupRequired: !providers.length };
  }
  if (!args.projectId || !store.projectCatalog().projects.some(p => p.id === args.projectId)) throw new Error('PROJECT_NOT_FOUND');
  if (args.action === 'generate') {
    if (args.provider === 'codex') throw new ToolInputError('Generate Codex images with openmotion_assets_use (model codex:image-generation); project-direct generation does not accept Codex', 'provider', 'invalid_enum');
    const missing = ['provider', 'model', 'requestId', 'modality'].find(field => !args[field]);
    if (missing || typeof args.prompt !== 'string') {
      throw new ToolInputError('provider, model, projectId, requestId, modality and prompt are required', missing ?? 'prompt', 'missing');
    }
    const job = await gateway.submit({ projectId: args.projectId, model: `${args.provider}:${args.model}`, modality: args.modality,
      prompt: args.prompt, parameters: args.parameters, mode: args.mode, referenceAsset: args.referenceAsset, idempotencyKey: args.requestId } as GenerateInput);
    return { projectId: job.projectId, job, next: { action: 'status', projectId: job.projectId, jobId: job.id } };
  }
  if (args.action === 'status' || args.action === 'cancel' || args.action === 'retry_save' || args.action === 'resume') {
    const job = await gateway.getJob(args.jobId);
    if (job.projectId !== args.projectId || job.model.provider === 'codex') throw new Error('GENERATION_NOT_FOUND: job does not belong to this project');
    if (args.action !== 'status' && !args.requestId) throw new ToolInputError('requestId is required', 'requestId', 'missing');
    if (args.action === 'resume') return { projectId: job.projectId, job: await gateway.resume(job.id, args.requestId) };
    return { projectId: job.projectId, job: args.action === 'retry_save' ? await gateway.retrySave(job.id) : args.action === 'cancel' ? await gateway.cancel(job.id) : job };
  }
  throw new ToolInputError('unsupported media action', 'action', 'invalid_enum');
}
