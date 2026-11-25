import { contextBridge, ipcRenderer } from 'electron';
import type {
  HostCapabilityDescriptor,
  HostInvokeResult,
  HostRuntimeInfo,
  UniversalHostBridge,
} from '../../shared/desktop-contract.ts';
import { HOST_IPC_CHANNELS } from './ipc-guard.ts';

type HostEventEnvelope = {
  capability?: unknown;
  event?: unknown;
  payload?: unknown;
};

function isTopLevelFrame(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.top === window && window.self === window;
  } catch {
    return false;
  }
}

function isAllowedBridgeLocation(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  const pathname = (window.location.pathname || '/').toLowerCase();
  if (pathname === '/auth' || pathname.startsWith('/auth/')) return false;
  const protocol = window.location.protocol;
  if (protocol === 'https:') return true;
  if (protocol === 'http:') {
    const hostname = window.location.hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost';
  }
  return false;
}

function getAllowedLocalPageBasename(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  if (window.location.protocol !== 'file:') return null;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(window.location.pathname || '');
  } catch {
    return null;
  }
  const normalized = decodedPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '..')) return null;
  return segments[segments.length - 1] ?? null;
}

function isAllowedLocalPageLocation(): boolean {
  const basename = getAllowedLocalPageBasename();
  return basename === 'retry.html' || basename === 'splash.html';
}

function isAllowedEnvSwitcherLocation(): boolean {
  return getAllowedLocalPageBasename() === 'env-switcher.html';
}

if (isTopLevelFrame() && isAllowedBridgeLocation()) {
  const bridge: UniversalHostBridge = {
    info: () => ipcRenderer.invoke(HOST_IPC_CHANNELS.INFO) as Promise<HostRuntimeInfo>,
    capabilities: () =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.CAPABILITIES) as Promise<HostCapabilityDescriptor[]>,
    invoke: <T = unknown>(
      capability: string,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<HostInvokeResult<T>> =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.INVOKE, {
        capability,
        method,
        params,
      }) as Promise<HostInvokeResult<T>>,
    subscribe: (capability, event, callback) => {
      if (
        typeof capability !== 'string' ||
        !capability ||
        typeof event !== 'string' ||
        !event ||
        typeof callback !== 'function'
      ) {
        return () => {};
      }
      const handler = (_ipcEvent: unknown, message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const envelope = message as HostEventEnvelope;
        if (envelope.capability === capability && envelope.event === event) {
          callback(envelope.payload);
        }
      };
      ipcRenderer.on(HOST_IPC_CHANNELS.EVENT, handler);
      return () => {
        ipcRenderer.removeListener(HOST_IPC_CHANNELS.EVENT, handler);
      };
    },
  };

  contextBridge.exposeInMainWorld('__OPENMOTION_HOST__', bridge);

  if (typeof document !== 'undefined') {
    window.addEventListener('fullscreenchange', () => {
      ipcRenderer.send(HOST_IPC_CHANNELS.DOM_FULLSCREEN, Boolean(document.fullscreenElement));
    });

    const clearResizingFlag = () => {
      document.documentElement?.removeAttribute('data-om-resizing');
    };
    ipcRenderer.on(HOST_IPC_CHANNELS.EVENT, (_ipcEvent, message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const envelope = message as HostEventEnvelope;
      if (envelope.capability !== 'window' || envelope.event !== 'resizing') return;
      const active = Boolean(
        envelope.payload &&
          typeof envelope.payload === 'object' &&
          (envelope.payload as { active?: unknown }).active,
      );
      if (active) {
        document.documentElement?.setAttribute('data-om-resizing', 'true');
      } else {
        clearResizingFlag();
      }
    });
    window.addEventListener('pointerdown', clearResizingFlag, { passive: true, capture: true });
  }
} else if (isTopLevelFrame() && isAllowedLocalPageLocation()) {
  const localPageBridge = Object.freeze({
    retryStartup: () => ipcRenderer.invoke(HOST_IPC_CHANNELS.SPLASH_RETRY) as Promise<HostInvokeResult>,
    exportDiagnostics: () =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.SPLASH_EXPORT_DIAGNOSTICS) as Promise<HostInvokeResult>,
    windowControl: (action: 'minimize' | 'toggleMaximize' | 'close') =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.SPLASH_WINDOW_CONTROL, action) as Promise<HostInvokeResult>,
    resetEnvironment: () =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.SPLASH_RESET_ENV) as Promise<HostInvokeResult>,
    openEnvironmentSwitcher: () =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.SPLASH_OPEN_ENV_SWITCHER) as Promise<HostInvokeResult>,
  });
  contextBridge.exposeInMainWorld('__OPENMOTION_LOCAL_PAGE__', localPageBridge);
} else if (isTopLevelFrame() && isAllowedEnvSwitcherLocation()) {
  const envSwitcherBridge = Object.freeze({
    getState: () =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.ENV_SWITCHER_GET_STATE) as Promise<HostInvokeResult>,
    select: (url: string) =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.ENV_SWITCHER_SELECT, { url }) as Promise<HostInvokeResult>,
    reset: () =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.ENV_SWITCHER_RESET) as Promise<HostInvokeResult>,
    close: () =>
      ipcRenderer.invoke(HOST_IPC_CHANNELS.ENV_SWITCHER_CLOSE) as Promise<HostInvokeResult>,
  });
  contextBridge.exposeInMainWorld('__OPENMOTION_ENV_SWITCHER__', envSwitcherBridge);
}
