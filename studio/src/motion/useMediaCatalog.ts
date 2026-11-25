import { useCallback, useEffect, useRef, useState } from 'react';
import { gatewayRequest, invalidateGatewayCache, loadGateway } from './gatewayClient';
import { peekCachedGateway } from './gatewayCache';

let pendingAccountCatalog: ReturnType<typeof loadGateway> | undefined;
function resolveAccountCatalog() {
  // The navigation menu and the generation panel can open against the same cold account.
  pendingAccountCatalog ??= gatewayRequest('settings/account?refresh=true')
    .then(() => {
      invalidateGatewayCache();
      return loadGateway();
    })
    .finally(() => { pendingAccountCatalog = undefined; });
  return pendingAccountCatalog;
}

/** Both navigation and generation read the executable gateway catalog. */
export function useMediaCatalog(active: boolean, resolveAccountPlan = false) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof loadGateway>> | undefined>(() =>
    active ? peekCachedGateway() : undefined,
  );
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  const retry = useCallback(() => {
    sequence.current++;
    invalidateGatewayCache();
    setCatalog(undefined);
    setFailed(false);
    setAttempt(value => value + 1);
  }, []);
  useEffect(() => {
    window.addEventListener('motion:gateway-changed', retry);
    return () => window.removeEventListener('motion:gateway-changed', retry);
  }, [retry]);
  useEffect(() => {
    setFailed(false);
    if (!active) {
      setCatalog(undefined);
      return;
    }
    const cached = attempt === 0 ? peekCachedGateway() : undefined;
    if (cached) {
      setCatalog(cached);
    } else {
      setCatalog(undefined);
    }
    const request = ++sequence.current;
    void loadGateway().then(async value => {
      if (sequence.current !== request) return;
      const needsPlan = resolveAccountPlan && value.status.providers.some(provider =>
        provider.id === 'account' && provider.available && provider.mediaEntitlement === 'unknown');
      // Resolve a restored sign-in before choosing a default provider. If billing is
      // unreachable, the original catalog still offers the available providers.
      const resolved = needsPlan ? await resolveAccountCatalog().catch(() => value) : value;
      if (sequence.current === request) setCatalog(resolved);
    })
      .catch(() => {
        if (sequence.current === request && !cached) setFailed(true);
      });
    return () => { sequence.current++; };
  }, [active, attempt, resolveAccountPlan]);
  return { catalog, failed, retry };
}
