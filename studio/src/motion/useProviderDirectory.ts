import { useCallback, useEffect, useState } from 'react';
import type { DirectoryModel, ModelKind, ProviderConnection, ProviderDirectory } from '../../../shared/provider-directory';
import type { GatewayStatus, Model } from '../../../shared/gateway';
import { gatewayRequest, type CloudApiError } from './gatewayClient';

export type CloudProviderDirectory = ProviderDirectory & {
  gatewayMode?: 'opendesign' | 'mock';
  consoleUrl?: string;
  billing?: {
    plan?: string;
    mediaEntitlement?: 'included' | 'not-included' | 'unknown';
    hasBalance?: boolean;
  };
};

interface CloudCatalogResponse {
  provider?: string;
  mode?: 'opendesign' | 'mock';
  defaults?: Partial<Record<ModelKind, string>>;
  models?: Model[];
  // Legacy ProviderDirectory fields (for mocked tests)
  providers?: ProviderConnection[];
}

function toDirectoryModel(model: Model | DirectoryModel): DirectoryModel {
  if ('kind' in model) return model;
  return {
    id: model.id,
    provider: model.provider || 'opendesign',
    modelId: model.modelId,
    label: model.label,
    kind: model.modality,
    enabled: true,
    source: model.source ?? 'live',
    mode: model.mode,
    defaults: model.defaults,
    supportsImageReference: model.supportsImageReference,
    nativeOptions: model.nativeOptions,
  };
}

function normalizeDirectory(
  catalog: CloudCatalogResponse,
  status?: GatewayStatus | null,
): CloudProviderDirectory {
  if (Array.isArray(catalog.providers) && Array.isArray(catalog.models) && catalog.defaults) {
    return {
      providers: catalog.providers,
      models: catalog.models.map(toDirectoryModel),
      defaults: catalog.defaults,
      gatewayMode: catalog.mode,
      consoleUrl: status?.consoleUrl,
    };
  }
  const models = Array.isArray(catalog.models) ? catalog.models.map(toDirectoryModel) : [];
  const gatewayProvider = status?.providers?.find(item => item.id === 'opendesign') ?? status?.providers?.[0];
  const provider: ProviderConnection = {
    id: 'opendesign',
    label: gatewayProvider?.label ?? 'OpenDesign',
    protocol: 'media',
    baseUrl: '',
    kinds: ['image', 'video', 'audio'],
    category: 'multimodal',
    website: 'https://open-design.ai/cloud',
    configured: gatewayProvider?.configured ?? true,
    enabled: gatewayProvider?.enabled ?? true,
    available: gatewayProvider?.available ?? models.length > 0,
    custom: false,
    credentialSource: 'environment',
    reason: gatewayProvider?.reason ?? (catalog.mode === 'mock'
      ? 'Local mock model gateway (deterministic fixtures)'
      : models.length > 0
        ? 'Unified OpenDesign platform gateway'
        : 'No media models are currently available for this OpenDesign workspace. Upgrade your plan or sync models.'),
  };
  return {
    providers: [provider],
    models,
    defaults: catalog.defaults ?? {},
    gatewayMode: catalog.mode ?? 'opendesign',
    consoleUrl: status?.consoleUrl,
    billing: gatewayProvider
      ? {
          plan: gatewayProvider.plan,
          mediaEntitlement: gatewayProvider.mediaEntitlement,
          hasBalance: gatewayProvider.hasBalance,
        }
      : undefined,
  };
}

export const notifyProvidersChanged = () => window.dispatchEvent(new Event('motion:gateway-changed'));

export function useProviderDirectory() {
  const [data, setData] = useState<CloudProviderDirectory | null>(null);
  const [error, setError] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    setError(false);
    setAuthRequired(false);
    void (async () => {
      try {
        const [catalog, status] = await Promise.all([
          gatewayRequest<CloudCatalogResponse>('models/catalog').catch(async (err: CloudApiError) => {
            if (err.status === 404) return gatewayRequest<CloudCatalogResponse>('models');
            throw err;
          }),
          gatewayRequest<GatewayStatus>('models/status').catch(() => null),
        ]);
        const normalized = normalizeDirectory(catalog, status);
        if (active) setData(normalized);
      } catch (err: unknown) {
        const apiErr = err as CloudApiError | null;
        if (active) {
          if (apiErr?.status === 401) {
            setAuthRequired(true);
            setError(false);
          } else {
            setError(true);
          }
        }
      }
    })();
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    window.addEventListener('motion:gateway-changed', refresh);
    window.addEventListener('motion:account-changed', refresh);
    return () => {
      window.removeEventListener('motion:gateway-changed', refresh);
      window.removeEventListener('motion:account-changed', refresh);
    };
  }, [refresh]);
  return { data, error, authRequired, refresh };
}
