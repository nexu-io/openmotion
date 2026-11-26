import { buildOpenDesignPreviewModels } from '../../../shared/opendesign-preview-catalog';
import type { loadGateway } from './gatewayClient';

/** Public model descriptions for the creation form. Account routes and entitlements come from the live gateway after login. */
export const guestMediaCatalog: Awaited<ReturnType<typeof loadGateway>> = {
  mode: 'opendesign',
  status: { providers: [], agents: [], routes: {}, capabilities: [] },
  models: buildOpenDesignPreviewModels(),
};
