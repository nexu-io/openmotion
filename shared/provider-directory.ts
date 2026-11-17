/** Settings contracts contain public metadata only. Credentials remain service-owned. */
export const modelKinds = ['text', 'image', 'video', 'audio', 'embedding', 'reranker'] as const;
export type ModelKind = typeof modelKinds[number];
export type ProviderProtocol = 'openai' | 'anthropic' | 'google' | 'media' | 'account' | 'agent';
export type ProviderCategory = 'account' | 'multimodal' | 'language' | 'media' | 'local' | 'custom';
export type ProviderDefinition = {
  id: string; label: string; protocol: ProviderProtocol; baseUrl: string;
  kinds: ModelKind[]; category: ProviderCategory; website?: string; docs?: string;
  setupRequired?: boolean;
  baseUrlEditable?: boolean;
};
export type ProviderConnection = ProviderDefinition & {
  configured: boolean; enabled: boolean; available: boolean; custom: boolean;
  credentialSource: 'stored' | 'environment' | 'local-agent' | 'account' | 'none';
  reason: string;
};
/** Keep registry internals and saved revisions outside the public connection payload. */
export function publicProviderConnection(provider: ProviderConnection): ProviderConnection {
  const { id, label, protocol, baseUrl, kinds, category, website, docs, setupRequired, baseUrlEditable,
    configured, enabled, available, custom, credentialSource, reason } = provider;
  return { id, label, protocol, baseUrl, kinds, category, website, docs, setupRequired, baseUrlEditable,
    configured, enabled, available, custom, credentialSource, reason };
}
export const modelCapabilities = ['reasoning', 'tools'] as const;
export const inputModalities = ['vision', 'audio', 'video'] as const;
export type ModelMetadata = {
  group?: string; capabilities?: typeof modelCapabilities[number][]; inputs?: typeof inputModalities[number][];
  contextWindow?: number | null; maxInputTokens?: number | null; maxOutputTokens?: number | null;
  defaults?: Record<string, unknown>;
};
export type DirectoryModel = ModelMetadata & {
  id: string; provider: string; modelId: string; label: string; kind: ModelKind;
  enabled: boolean; source: 'builtin' | 'live' | 'custom'; mode?: string;
  /** Accepts one input image to edit; set only from the provider's own capability data. */
  supportsImageReference?: boolean;
};
export type ProviderDirectory = {
  providers: ProviderConnection[]; models: DirectoryModel[];
  defaults: Partial<Record<ModelKind, string>>;
};
/** Why the latest sign-in attempt ended without an account session. */
export type AccountErrorCode = 'connector_unavailable' | 'setup_failed' | 'authorization_expired' | 'credentials_rejected';
/** Non-secret progress of one connector sign-in: stages are `stage:result[:errorKind]`. */
export type AccountAttempt = {
  id: string; stages: string[]; persisted: boolean; receipt?: 'accepted' | 'rejected'; exitCode?: number | null;
  /** Confirms credentials an interrupted attempt had already saved; the connector shows no activation link for it. */
  resumed?: boolean;
};
export type AccountSummary = {
  state: 'signed-out' | 'authorizing' | 'signed-in' | 'reauth-required' | 'unavailable';
  user?: { name?: string; email?: string }; authorizationUrl?: string; userCode?: string;
  /** While authorizing: whether the connector opened the activation page in the default browser, once it has tried. */
  browserOpened?: boolean;
  /** While authorizing: the browser approved the sign-in and the account is being set up locally. */
  syncing?: boolean;
  plan?: string; balance?: string | null; billingUnavailable?: boolean;
  /** Service rejection behind `billingUnavailable`, when the connector reported one. */
  billingError?: { status: number; code?: string };
  error?: string; errorCode?: AccountErrorCode; attempt?: AccountAttempt;
  consoleUrl: string;
};
