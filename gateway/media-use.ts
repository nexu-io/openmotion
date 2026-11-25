import { randomUUID } from 'node:crypto';
import { ToolInputError } from '../shared/tool-input-error.ts';
import type { OmTracking } from '../shared/tracking.ts';
import type { WorkspaceStore } from '../workspace.ts';
import type { GenerateInput, GatewayStatus, Modality, ProviderState } from '../shared/gateway.ts';
import type { ProviderSetupEntry } from '../shared/workspace-url.ts';
import { isMediaProvider, registeredProvider } from '../shared/provider-registry.ts';
import { gatewayFor } from './service.ts';
import { getWorkflow } from '../shared/workflow.ts';
import { OPENMOTION_CLOUD_ENTRY_SOURCE } from '../shared/workspace-collab.ts';
import type { AccountSummary } from '../shared/provider-directory.ts';
import { accountMediaState } from './account-media.ts';
import { openSystemBrowser } from './account.ts';

type Account = ReturnType<typeof gatewayFor>['account'];
type Upgrade = { url: string; entryId: string; plan: 'plus'; opened: boolean };
type UpgradeLinkResult = { entry_from: 'agent_sign_in_upgrade'; outcome: 'success' | 'failure'; entry_id: string; browser_opened: boolean };
export type SignInView = {
  state: 'authorizing' | 'ready' | 'awaiting_payment' | 'failed' | 'signed_out';
  authorizationUrl?: string; userCode?: string; browserOpened?: boolean;
  plan?: string; mediaEntitlement?: 'included' | 'not-included' | 'unknown';
  errorCode?: AccountSummary['errorCode']; error?: string; connectorInstall?: AccountSummary['connectorInstall'];
  upgrade?: Upgrade; instruction: string;
};
/** Test seams keep sign-in and billing polling deterministic without changing account.login. */
export type MediaSignInOptions = {
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  pollMs?: number; signInWaitMs?: number; billingPollMs?: number;
  openBrowser?: (url: string) => Promise<void>;
};
const upgradeWindowMs = 30 * 60_000;
type UpgradeAttempt = { at: number; result: Promise<{ upgrade?: Upgrade; tracking: UpgradeLinkResult }>; billingAt: number };
// Account IDs stay inside the service. Shared accounts across workspaces share this browser-open guard.
const upgradeAttempts = new Map<string | Account, UpgradeAttempt>();

function signInView(summary: AccountSummary, upgrade?: Upgrade): SignInView {
  const { plan, mediaEntitlement } = accountMediaState(summary);
  const base = { ...(plan ? { plan } : {}), ...(mediaEntitlement ? { mediaEntitlement } : {}) };
  if (summary.syncing || summary.state === 'authorizing' || summary.state === 'signed-in' && !plan && summary.billingUnavailable !== true) {
    return { ...base, state: 'authorizing',
      ...(summary.authorizationUrl ? { authorizationUrl: summary.authorizationUrl } : {}),
      ...(summary.userCode ? { userCode: summary.userCode } : {}),
      ...(summary.browserOpened !== undefined ? { browserOpened: summary.browserOpened } : {}),
      instruction: 'Tell the user the browser sign-in page is open only if browserOpened is true, or give authorizationUrl and userCode as a clickable link. While syncing, explain that account models are being synchronized. Call wait_sign_in again; do not ask the user to confirm in chat. Stop after ready/failed or 15 minutes.' };
  }
  if (summary.state === 'signed-out' || summary.state === 'reauth-required' || summary.state === 'unavailable') {
    return summary.errorCode ? { state: 'failed', errorCode: summary.errorCode,
      ...(summary.error ? { error: summary.error } : {}),
      ...(summary.connectorInstall ? { connectorInstall: summary.connectorInstall } : {}),
      instruction: 'Explain the sign-in failure and available connector recovery, then retry sign_in when appropriate.' }
      : { state: 'signed_out', instruction: 'Call sign_in to start browser authorization; do not ask the user to open Settings or confirm in chat.' };
  }
  if (mediaEntitlement === 'not-included') return { ...base, state: 'awaiting_payment', ...(upgrade ? { upgrade } : {}),
    instruction: upgrade
      ? `Tell the user the Plus checkout page ${upgrade.opened ? 'is open in the browser' : 'could not be opened automatically'} (Plus includes image and video generation), show upgrade.url as a fallback link, then call wait_sign_in again for up to 15 minutes; after ready, state the model and cost and get consent before generating.`
      : 'Call wait_sign_in to open the Plus checkout page and wait for payment automatically. Plus includes image and video generation. Do not ask the user to confirm payment in chat.' };
  return { ...base, state: 'ready', instruction: 'Continue the original request with inspect/models. State the model and cost and get consent before generating.' };
}

function signInResult(signIn: SignInView, tracking?: UpgradeLinkResult) {
  const action = signIn.state === 'signed_out' ? 'sign_in' : signIn.state === 'ready' ? 'inspect'
    : signIn.state === 'failed' ? undefined : 'wait_sign_in';
  return { signIn, next: action ? { tool: 'openmotion_media_use', arguments: { action } } : null,
    ...(tracking ? { _upgradeLinkResult: tracking } : {}) };
}

async function openMediaUpgrade(account: Account, openBrowser: (url: string) => Promise<void>, canOpen = () => true) {
  const entryId = randomUUID();
  let upgrade: Upgrade | undefined;
  let opened = false;
  try {
    // Only this shareable URL may cross the Agent boundary. The intent URL is discarded locally.
    const { url } = await account.openCloudUrl('/dashboard?billing=plan', OPENMOTION_CLOUD_ENTRY_SOURCE, false,
      { utmMedium: 'agent', entryId, accountIntent: false });
    upgrade = { url, entryId, plan: 'plus', opened: false };
    if (!canOpen()) return { upgrade, tracking: { entry_from: 'agent_sign_in_upgrade' as const,
      outcome: 'success' as const, entry_id: entryId, browser_opened: false } };
    const result = await account.openCloudUrl('/dashboard?billing=plan', OPENMOTION_CLOUD_ENTRY_SOURCE, async url => {
      if (!canOpen()) throw new Error('Sign-in wait ended before checkout could open');
      await openBrowser(url);
    },
      { utmMedium: 'agent', entryId });
    opened = result.opened;
    upgrade.opened = opened;
  } catch { /* Preserve a safe fallback link if launching fails; never expose account errors or intent URLs. */ }
  return { ...(upgrade ? { upgrade } : {}), tracking: { entry_from: 'agent_sign_in_upgrade' as const,
    outcome: upgrade ? 'success' as const : 'failure' as const, entry_id: entryId, browser_opened: opened } };
}

async function reserveUpgrade(account: Account, now: () => number, openBrowser: (url: string) => Promise<void>, force = false, canOpen = () => true) {
  const session = await account.getControlSession();
  if (!canOpen()) return undefined;
  const key = session?.controlKeyId ?? account;
  for (const [id, item] of upgradeAttempts) if (now() - item.at >= upgradeWindowMs) upgradeAttempts.delete(id);
  let attempt = force ? undefined : upgradeAttempts.get(key);
  const created = !attempt;
  if (!attempt) {
    // Reserve before awaiting the launch, including concurrent calls across workspaces.
    attempt = { at: now(), billingAt: -Infinity, result: openMediaUpgrade(account, openBrowser, canOpen) };
    upgradeAttempts.set(key, attempt);
  }
  return { attempt, created };
}

async function mediaSignIn(account: Account, args: any, options: MediaSignInOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const pollMs = Math.max(1, options.pollMs ?? 1000);
  const billingPollMs = Math.max(1, options.billingPollMs ?? 10_000);
  const openBrowser = options.openBrowser ?? openSystemBrowser;
  // wait_sign_in starts its deadline before even the first account read.
  let summary: AccountSummary = args.action === 'wait_sign_in' ? { state: 'authorizing', consoleUrl: '' } : await account.summary();
  if (args.action === 'sign_in') {
    if (summary.state !== 'signed-in') summary = await account.login({ hookId: 'mcp_oauth', entryId: args.entryId });
    const deadline = now() + Math.min(8000, Math.max(0, options.signInWaitMs ?? 8000));
    while (summary.state === 'authorizing' && !summary.authorizationUrl && now() < deadline) {
      await sleep(Math.min(pollMs, deadline - now()));
      summary = await account.summary();
    }
    return signInResult(signInView(summary));
  }
  if (args.action === 'open_upgrade') {
    if (summary.state === 'signed-in' && !summary.syncing) summary = await account.summary(true);
    const view = signInView(summary);
    if (view.state !== 'awaiting_payment') return { state: view.state, instruction: view.instruction };
    const { attempt } = (await reserveUpgrade(account, now, openBrowser, true))!;
    const result = await attempt.result;
    return { ...(result.upgrade ? { upgrade: result.upgrade } : { state: 'awaiting_payment', instruction: 'Unable to create the Plus checkout link. Retry open_upgrade or open Settings > Model providers > OpenDesign.' }), _upgradeLinkResult: result.tracking };
  }
  if (args.timeoutSeconds !== undefined && (typeof args.timeoutSeconds !== 'number' || !Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0)) {
    throw new ToolInputError('timeoutSeconds must be a positive number (maximum 60)', 'timeoutSeconds', 'out_of_range');
  }
  const deadline = now() + Math.min(60, args.timeoutSeconds ?? 50) * 1000;
  let upgrade: Upgrade | undefined, tracking: UpgradeLinkResult | undefined;
  let billingAt = -Infinity;
  let attempt: UpgradeAttempt | undefined;
  let active = true;
  let latest = signInResult(signInView(summary));
  // Bound slow account I/O too, not only sleeps between reads. Late reads must not start another browser action.
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof latest>(resolve => {
    timer = setTimeout(() => { active = false; resolve(latest); }, Math.max(0, deadline - now()));
  });
  const poll = async () => {
    summary = await account.summary();
    while (active) {
      let view = signInView(summary, upgrade);
      latest = signInResult(view, tracking);
      if (view.state === 'ready' || view.state === 'failed' || view.state === 'signed_out') return signInResult(view, tracking);
      if (now() >= deadline) return signInResult(view, tracking);
      if (summary.state === 'signed-in' && !summary.syncing) {
        if (!attempt && view.state === 'awaiting_payment') {
          const reserved = await reserveUpgrade(account, now, openBrowser, false, () => active && now() < deadline);
          if (!reserved) return latest;
          attempt = reserved.attempt;
          const result = await attempt.result;
          if (reserved.created) tracking = result.tracking;
          upgrade = result.upgrade;
          if (!active) return latest;
          view = signInView(summary, upgrade);
          latest = signInResult(view, tracking);
        }
        const lastRefresh = attempt?.billingAt ?? billingAt;
        if (now() - lastRefresh >= billingPollMs) {
          billingAt = now();
          if (attempt) attempt.billingAt = billingAt;
          summary = await account.summary(true);
          if (!active) return latest;
          view = signInView(summary, upgrade);
          latest = signInResult(view, tracking);
          if (view.state === 'ready' || view.state === 'failed' || view.state === 'signed_out') return latest;
        }
      }
      latest = signInResult(signInView(summary, upgrade), tracking);
      if (now() >= deadline) return latest;
      await sleep(Math.min(pollMs, deadline - now()));
      if (!active) return latest;
      summary = await account.summary();
    }
    return latest;
  };
  try { return await Promise.race([poll(), timeout]); }
  finally { active = false; clearTimeout(timer!); }
}

type MediaProviderLike = Pick<ProviderState, 'id' | 'available'> & Partial<Pick<ProviderState, 'mediaEntitlement'>>;
type SetupProviderLike = Pick<ProviderState, 'id' | 'available' | 'configured' | 'verification'>
  & Partial<Pick<ProviderState, 'mediaEntitlement' | 'plan'>>;

export function isMediaProviderUsable(provider: MediaProviderLike): boolean {
  return Boolean(provider.available && !(provider.id === 'account' && provider.mediaEntitlement === 'not-included'));
}

export function resolveMediaSetupEntry(
  providers: readonly SetupProviderLike[],
  options?: {
    modality?: Modality;
    capabilities?: GatewayStatus['capabilities'];
  },
): ProviderSetupEntry | undefined {
  const hasUsableForScope = options?.capabilities
    ? (options.modality
      ? options.capabilities.some(cap => cap.modality === options.modality && cap.available)
      : options.capabilities.some(cap => cap.available))
    : providers.some(isMediaProviderUsable);
  if (hasUsableForScope) return undefined;
  const account = providers.find(p => p.id === 'account');
  if (account?.mediaEntitlement === 'not-included' && account.plan === 'go') return 'agent_media_upgrade_go';
  if (account?.mediaEntitlement === 'not-included' && account.plan === 'free') return 'agent_media_upgrade_free';
  if (providers.some(p => p.id !== 'account' && p.configured && p.verification === 'rejected')) return 'agent_media_key_rejected';
  if (!account?.configured) return 'agent_media_signed_out';
  return undefined;
}

export function buildMediaSettingsHandoff(entry?: ProviderSetupEntry) {
  if (entry === 'agent_media_signed_out') return {
    tool: 'openmotion_media_use' as const, arguments: { action: 'sign_in' as const },
  };
  return {
    tool: 'openmotion_open_preview' as const,
    arguments: { target: 'providers' as const, ...(entry ? { entry } : {}) },
  };
}

export async function mediaUse(store: WorkspaceStore, args: any, tracking?: OmTracking, options: MediaSignInOptions = {}) {
  const gateway = gatewayFor(store, tracking);
  if (['sign_in', 'wait_sign_in', 'open_upgrade'].includes(args.action)) return mediaSignIn(gateway.account, args, options);
  const connections = await gateway.connections.list();
  // Codex is a local image Agent: Settings offers it for images, so discovery accepts it; new images go through openmotion_assets_use.
  const supported = (id: string) => isMediaProvider(id) || id === 'codex' || registeredProvider(id)?.integration === 'account' || connections.some(p => p.id === id && p.protocol === 'openai' && !p.setupRequired);
  const referenceSection = (id: string) => registeredProvider(id)?.reference ?? 'compatible';
  if (args.provider !== undefined && !supported(args.provider)) throw new ToolInputError('unsupported media provider', 'provider', 'invalid_enum');
  if (args.action === 'inspect') {
    const status = await gateway.status(false, { refreshAccount: true });
    const providers = status.providers.filter(p => supported(p.id) && (isMediaProvider(p.id) || p.configured || p.id === 'account'));
    const modality = typeof args.modality === 'string' && ['image', 'video', 'audio'].includes(args.modality)
      ? args.modality as Modality
      : undefined;
    const entry = resolveMediaSetupEntry(providers, modality ? { modality, capabilities: status.capabilities } : undefined);
    let upgrade: { url: string; entryId: string; plan: 'plus'; instruction: string } | undefined;
    let upgradeLinkResult: { entry_from: 'agent_media_upgrade_free' | 'agent_media_upgrade_go'; outcome: 'success' | 'failure'; entry_id?: string } | undefined;
    if (entry === 'agent_media_upgrade_free' || entry === 'agent_media_upgrade_go') {
      try {
        const entryId = randomUUID();
        const { url } = await gateway.account.openCloudUrl('/dashboard?billing=plan', OPENMOTION_CLOUD_ENTRY_SOURCE, false, { utmMedium: 'agent', entryId, accountIntent: false });
        upgrade = { url, entryId, plan: 'plus', instruction: 'Present url to the user as a clickable "Upgrade to Plus / 升级到 Plus" link, then inspect again after payment and continue the original request.' };
        upgradeLinkResult = { entry_from: entry, outcome: 'success', entry_id: entryId };
      } catch {
        upgradeLinkResult = { entry_from: entry, outcome: 'failure' };
      }
    }
    return { providers,
      defaults: status.routes,
      settings: 'Use sign_in then wait_sign_in for browser authorization and automatic Plus checkout. Settings > Model providers > OpenDesign remains a fallback. Save or replace API keys in Model providers.',
      settingsHandoff: buildMediaSettingsHandoff(entry),
      ...(upgrade ? { upgrade } : {}),
      // Service metadata crosses the local HTTP bridge; only stdio MCP records it.
      ...(upgradeLinkResult ? { _upgradeLinkResult: upgradeLinkResult } : {}),
      references: status.providers.filter(p => supported(p.id)).map(p => ({ provider: p.id, uri: `openmotion://workflow/media/${referenceSection(p.id)}` })),
      credentials: 'Read by the local service; keys are never returned to the Agent.' };
  }
  if (args.action === 'reference') {
    if (!args.provider) throw new ToolInputError('provider is required', 'provider', 'missing');
    return getWorkflow(referenceSection(args.provider), 'media');
  }
  if (args.action === 'models') {
    const providers = (await gateway.status()).providers.filter(p => supported(p.id) && (!args.provider || p.id === args.provider) && p.available);
    const pages = await Promise.all(providers.map(provider => gateway.listModels({ provider: provider.id, modality: args.modality, refresh: args.refresh, query: args.query, offset: args.offset, limit: args.limit })));
    return { providers: providers.map(p => p.id), catalogs: pages, setupRequired: !providers.length };
  }
  if (!args.projectId) throw new ToolInputError('projectId is required', 'projectId', 'missing');
  if (!store.projectCatalog().projects.some(p => p.id === args.projectId)) throw new Error('PROJECT_NOT_FOUND');
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
