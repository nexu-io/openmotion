import { lazy, useEffect, type ReactNode } from 'react';
import { StudioErrorBoundary } from '../components/StudioErrorBoundary';
import { I18nProvider } from '../i18n/I18n';
import { readStudioUiPreferences } from '../utils/studioUiPreferences';
import { resolvePendingCloudDisklessMode } from '../utils/cloudRuntime';
import { getNativeModelContext } from '../webmcp/types';
import { installEditorTracking } from './editorTracking';
import { useCloudWebMode } from './entitlementModalBus';
import { StudioHostContext, type StudioHost } from './StudioHost';
import { trackMotion } from './tracking';

installEditorTracking(trackMotion);

let editorHostPreload: Promise<{ default: typeof import('./MotionStudioHost').MotionEditorHost }> | undefined;
const loadMotionEditorHost = () => {
  editorHostPreload ??= import('./MotionStudioHost')
    .then(({ MotionEditorHost }) => ({ default: MotionEditorHost }))
    .catch((error) => {
      editorHostPreload = undefined;
      throw error;
    });
  return editorHostPreload;
};
const LazyMotionEditorHost = lazy(loadMotionEditorHost);

const shellHost: StudioHost = {
  feedback: false,
  EditorHost: LazyMotionEditorHost,
  preloadEditorHost: loadMotionEditorHost,
};

/**
 * Registers OpenMotion WebMCP tools once for the app lifetime when the browser
 * natively exposes `document.modelContext`, avoiding the 340 KB `@mcp-b/global`
 * polyfill download on `/explore` and other shell routes. `MotionEditorHost`
 * passes `polyfillOnly` to `OpenMotionAgentTools` so native browsers never
 * double-register when entering the editor.
 */
function NativeWebMcpRegistrar() {
  const cloudMode = useCloudWebMode();
  useEffect(() => {
    if (readStudioUiPreferences().agentToolsEnabled === false) return;
    const context = getNativeModelContext();
    if (!context) return;
    const controller = new AbortController();
    void Promise.all([
      import('../../../shared/webmcp-tools'),
      import('../webmcp/registrar'),
      import('../utils/studioApiFetch'),
      cloudMode ? Promise.resolve(true) : resolvePendingCloudDisklessMode(),
    ])
      .then(([{ buildOpenMotionWebMcpTools }, { registerStudioTools }, { studioApiFetch }, resolvedCloudMode]) => {
        if (controller.signal.aborted) return;
        return registerStudioTools(
          context,
          buildOpenMotionWebMcpTools(studioApiFetch, {
            cloud: resolvedCloudMode,
            publicOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
          }),
          controller.signal,
        );
      })
      .catch(() => {});
    return () => {
      controller.abort();
    };
  }, [cloudMode]);
  return null;
}

export function MotionAppShell({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <StudioHostContext.Provider value={shellHost}>
        <StudioErrorBoundary>
          <NativeWebMcpRegistrar />
          {children}
        </StudioErrorBoundary>
      </StudioHostContext.Provider>
    </I18nProvider>
  );
}
