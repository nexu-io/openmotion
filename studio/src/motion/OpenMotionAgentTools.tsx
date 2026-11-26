import { useEffect } from 'react';
import { studioApiFetch } from '../utils/studioApiFetch';
import { resolvePendingCloudDisklessMode } from '../utils/cloudRuntime';
import { readStudioUiPreferences } from '../utils/studioUiPreferences';
import { makeStudioDebugLogger } from '../utils/studioDebug';
import { getModelContext, getNativeModelContext } from '../webmcp/types';
import { loadModelContextPolyfill } from '../webmcp/polyfill';
import { registerStudioTools } from '../webmcp/registrar';
import { useCloudWebMode } from './entitlementModalBus';

const log = makeStudioDebugLogger('webmcp');

export function OpenMotionAgentTools({ polyfillOnly = false }: { polyfillOnly?: boolean } = {}) {
  const cloudMode = useCloudWebMode();
  useEffect(() => {
    if (readStudioUiPreferences().agentToolsEnabled === false) return;
    if (polyfillOnly && getNativeModelContext()) return;
    const controller = new AbortController();
    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;

    const registerTools = () => {
      if (controller.signal.aborted) return;
      if (polyfillOnly && getNativeModelContext()) return;
      void (async () => {
        const context = getModelContext() ?? await loadModelContextPolyfill();
        if (!context || controller.signal.aborted) return;
        if (polyfillOnly && getNativeModelContext()) return;
        const [{ buildOpenMotionWebMcpTools }, resolvedCloudMode] = await Promise.all([
          import('../../../shared/webmcp-tools'),
          cloudMode ? Promise.resolve(true) : resolvePendingCloudDisklessMode(),
        ]);
        if (controller.signal.aborted) return;
        const report = await registerStudioTools(
          context,
          buildOpenMotionWebMcpTools(studioApiFetch, {
            cloud: resolvedCloudMode,
            publicOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
          }),
          controller.signal,
        );
        log('openmotion_registered', { ...report });
      })().catch(error => log('openmotion_registration_failed', {
        message: error instanceof Error ? error.message : String(error),
      }));
    };

    const isTestOrAutomation = import.meta.env.MODE === 'test'
      || (typeof navigator !== 'undefined' && navigator.webdriver === true);

    if (getModelContext() || isTestOrAutomation) {
      registerTools();
    } else if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleHandle = window.requestIdleCallback(registerTools, { timeout: 2000 });
    } else {
      timeoutHandle = globalThis.setTimeout(registerTools, 800);
    }

    return () => {
      controller.abort();
      if (idleHandle !== undefined && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== undefined) {
        globalThis.clearTimeout(timeoutHandle);
      }
    };
  }, [polyfillOnly, cloudMode]);
  return null;
}
