import { useCallback, useEffect, useRef, useState } from 'react';
import { loadGateway, type CloudApiError } from './gatewayClient';
import { guestMediaCatalog } from './guestMediaCatalog';
import { useOptionalWorkspaceChrome } from './WorkspaceChromeContext';

/** Both navigation and generation read the executable gateway catalog. */
export function useMediaCatalog(active: boolean) {
  const chrome = useOptionalWorkspaceChrome();
  const guestMode = Boolean(chrome?.guestMode);
  const authResolving = Boolean(chrome?.authResolving);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof loadGateway>>>();
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  const retry = useCallback(() => {
    sequence.current++;
    setCatalog(undefined);
    setFailed(false);
    setAttempt(value => value + 1);
  }, []);
  useEffect(() => {
    window.addEventListener('motion:gateway-changed', retry);
    window.addEventListener('motion:account-changed', retry);
    return () => {
      window.removeEventListener('motion:gateway-changed', retry);
      window.removeEventListener('motion:account-changed', retry);
    };
  }, [retry]);
  useEffect(() => {
    setFailed(false);
    setCatalog(undefined);
    if (!active || guestMode || authResolving) return;
    const request = ++sequence.current;
    void loadGateway()
      .then(value => { if (sequence.current === request) setCatalog(value); })
      .catch((err: unknown) => {
        if (sequence.current !== request) return;
        if ((err as CloudApiError | null)?.status === 401) {
          setCatalog(guestMediaCatalog);
          setFailed(false);
          return;
        }
        setFailed(true);
      });
    return () => { sequence.current++; };
  }, [active, guestMode, authResolving, attempt]);
  if (active && guestMode) {
    return { catalog: guestMediaCatalog, failed: false, retry };
  }
  return { catalog, failed, retry };
}
