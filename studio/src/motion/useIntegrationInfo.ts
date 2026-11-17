import { useEffect, useState } from 'react';
import type { IntegrationInfo } from '../../../shared/integration';

export function useIntegrationInfo() {
  const [info, setInfo] = useState<IntegrationInfo | null>(null);
  const [failed, setFailed] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setInfo(null); setFailed(false);
    void (async () => {
      try {
        const response = await fetch('/motion-api/integration', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!response.ok) throw new Error('Unavailable');
        const value = await response.json() as IntegrationInfo;
        if (!['OpenMotion', 'OpenDesign', 'OpenDesign Motion'].includes(value.name) || value.transport?.type !== 'stdio'
          || !value.transport.command || !Array.isArray(value.transport.args) || !value.transport.env?.MOTION_DATA_DIR
          || !Array.isArray(value.tools) || !value.previewUrl) throw new Error('Invalid integration');
        if (!controller.signal.aborted) setInfo(value);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    })();
    return () => controller.abort();
  }, [attempt]);
  return { info, failed, retry: () => retry(value => value + 1) };
}
