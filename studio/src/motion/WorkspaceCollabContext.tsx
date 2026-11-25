import { Button } from 'open-design-ui/button';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  classifyBillingErrorCode,
  CLOUD_DESTINATION_UTM_MEDIUM,
  EMPTY_WORKSPACE_PERMISSIONS,
  isFreeOrGoPlan,
  OPENMOTION_CLOUD_ENTRY_SOURCE,
  type ProjectVisibility,
  type WorkspaceCloudDestination,
  type WorkspaceCollabSnapshot,
  type WorkspaceConcurrencyResult,
  type WorkspaceDirectoryEntry,
  type WorkspaceInviteRowInput,
  type WorkspaceInviteRowResult,
  type WorkspaceMembersResponse,
  type WorkspacePreflightReason,
  type WorkspacePreflightResult,
  type WorkspaceProjectKind,
} from '../../../shared/workspace-collab';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { getDesktopBridge, openExternalUrl } from '../utils/platformHost';
import { gatewayRequest } from './gatewayClient';
import {
  ARTIFACT_DELIVERED_EVENT,
  canShowArtifactUpgrade,
  markArtifactUpgradeShown,
  type ArtifactDeliveredDetail,
  type ArtifactDeliveryKind,
} from './collab/artifactDeliveryBus';
import { CollabDialog } from './collab/CollabDialog';
import './workspaceCollab.css';

export type MoveToTeamTarget = {
  projectId: string;
  title: string;
  kind?: WorkspaceProjectKind;
};

export type SharingProjectTarget = {
  projectId: string;
  title: string;
  kind?: WorkspaceProjectKind;
};

export type RemoveFromTeamTarget = {
  projectId: string;
  title: string;
  workspaceName: string;
};

export type BillingGateModalState =
  | {
      kind: 'balance' | 'owner-topup';
      reason?: WorkspacePreflightReason;
      balanceUsd?: string | null;
      weeklyPercentLeft?: number | null;
      onRecovered?: () => void;
    }
  | {
      kind: 'concurrency';
      inFlight?: number | null;
      limit?: number | null;
      onRetry?: () => void;
    }
  | {
      kind: 'artifact-upgrade';
      featureLabel?: string;
      deliveryKind?: ArtifactDeliveryKind;
      enforced?: boolean;
    }
  | null;

export type WorkspaceCollabContextValue = {
  snapshot: WorkspaceCollabSnapshot | null;
  loading: boolean;
  switching: boolean;
  hasActiveTask: boolean;
  projectsRevision: number;
  bumpProjectsRevision: () => void;
  refresh: (force?: boolean) => Promise<WorkspaceCollabSnapshot | null>;
  requestSwitchWorkspace: (workspaceId: string) => void;
  recoverToPersonal: () => Promise<void>;
  inviteDialogOpen: boolean;
  setInviteDialogOpen: (open: boolean) => void;
  teamMembersDialogOpen: boolean;
  setTeamMembersDialogOpen: (open: boolean) => void;
  fetchWorkspaceMembers: (workspaceId?: string) => Promise<WorkspaceMembersResponse>;
  sendInvites: (
    rows: WorkspaceInviteRowInput[],
    workspaceId?: string,
  ) => Promise<{ workspaceId: string; results: WorkspaceInviteRowResult[] }>;
  openCloudLink: (destination: WorkspaceCloudDestination, workspaceId?: string) => Promise<void>;
  openingCloudDestination: WorkspaceCloudDestination | null;
  moveToTeamTarget: MoveToTeamTarget | null;
  setMoveToTeamTarget: (target: MoveToTeamTarget | null) => void;
  requestMoveToTeam: (project: { id: string; title: string; kind?: WorkspaceProjectKind }) => void;
  moveProjectToTeam: (
    projectId: string,
    targetWorkspaceId: string,
    skipConfirm?: boolean,
    options?: { kind?: WorkspaceProjectKind; title?: string },
  ) => Promise<void>;
  sharingProjectTarget: SharingProjectTarget | null;
  openProjectSharing: (target: SharingProjectTarget) => void;
  closeProjectSharing: () => void;
  removeFromTeamTarget: RemoveFromTeamTarget | null;
  setRemoveFromTeamTarget: (target: RemoveFromTeamTarget | null) => void;
  requestRemoveFromTeam: (project: { id: string; title: string; workspaceName?: string | null }) => void;
  removeProjectFromTeam: (projectId: string, skipConfirm?: boolean) => Promise<void>;
  setProjectVisibility: (projectId: string, visibility: ProjectVisibility) => Promise<void>;
  retryCommentSync: (projectId: string) => Promise<void>;
  dismissBanner: (key: string) => Promise<void>;
  billingGate: BillingGateModalState;
  setBillingGate: (gate: BillingGateModalState) => void;
  topUpPolling: boolean;
  startTopUpPolling: (onRecovered?: () => void) => void;
  stopTopUpPolling: () => void;
  checkTopUpNow: () => Promise<boolean>;
  checkPreflightNow: (options?: {
    model?: string;
    silent?: boolean;
    onRecovered?: () => void;
  }) => Promise<WorkspacePreflightResult | null>;
  handleBillingError: (
    codeOrMessage?: string | null,
    options?: {
      featureLabel?: string;
      onRecovered?: () => void;
      onRetry?: () => void;
    },
  ) => Promise<boolean>;
  triggerArtifactUpgradePrompt: (
    featureLabel?: string,
    deliveryKind?: ArtifactDeliveryKind,
  ) => boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
};

const EMPTY_SNAPSHOT: WorkspaceCollabSnapshot = {
  signedIn: false,
  accountState: 'signed-out',
  workspaces: [],
  activeWorkspaceId: null,
  activeWorkspace: null,
  permissions: EMPTY_WORKSPACE_PERMISSIONS,
  removedFromWorkspace: null,
  quota: null,
  referral: null,
  projectMeta: {},
  commentSync: {},
  preferences: { skipMoveToTeamConfirm: false, dismissedBanners: [] },
};

function normalizeSnapshot(raw: unknown): WorkspaceCollabSnapshot {
  if (!raw || typeof raw !== 'object') return EMPTY_SNAPSHOT;
  const record = raw as Partial<WorkspaceCollabSnapshot>;
  const signedIn = record.signedIn === true;
  return {
    ...EMPTY_SNAPSHOT,
    ...record,
    signedIn,
    accountState: typeof record.accountState === 'string' ? record.accountState : signedIn ? 'signed-in' : 'signed-out',
    workspaces: Array.isArray(record.workspaces) ? record.workspaces : [],
    activeWorkspaceId: typeof record.activeWorkspaceId === 'string' ? record.activeWorkspaceId : null,
    activeWorkspace:
      record.activeWorkspace && typeof record.activeWorkspace === 'object' ? record.activeWorkspace : null,
    permissions:
      record.permissions && typeof record.permissions === 'object'
        ? { ...EMPTY_WORKSPACE_PERMISSIONS, ...record.permissions }
        : EMPTY_WORKSPACE_PERMISSIONS,
    removedFromWorkspace: record.removedFromWorkspace ?? null,
    quota: record.quota ?? null,
    referral: record.referral ?? null,
    projectMeta: record.projectMeta && typeof record.projectMeta === 'object' ? record.projectMeta : {},
    commentSync: record.commentSync && typeof record.commentSync === 'object' ? record.commentSync : {},
    preferences: {
      skipMoveToTeamConfirm: Boolean(record.preferences?.skipMoveToTeamConfirm),
      skipRemoveFromTeamConfirm: Boolean(record.preferences?.skipRemoveFromTeamConfirm),
      dismissedBanners: Array.isArray(record.preferences?.dismissedBanners)
        ? record.preferences!.dismissedBanners
        : [],
    },
  };
}

const COLLAB_CHROME_CACHE_KEY = 'openmotion.workspace-collab-chrome.v1';
const COLLAB_CHROME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CollabChromeCacheEnvelope = {
  at: number;
  snapshot: WorkspaceCollabSnapshot;
};

function readCachedCollabSnapshot(): WorkspaceCollabSnapshot | null {
  if (typeof window === 'undefined' || import.meta.env?.MODE === 'test') return null;
  try {
    const raw = window.localStorage.getItem(COLLAB_CHROME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CollabChromeCacheEnvelope> | null;
    if (
      !parsed ||
      typeof parsed.at !== 'number' ||
      !Number.isFinite(parsed.at) ||
      Date.now() - parsed.at > COLLAB_CHROME_CACHE_TTL_MS ||
      !parsed.snapshot
    ) {
      return null;
    }
    const normalized = normalizeSnapshot(parsed.snapshot);
    return normalized.signedIn ? normalized : null;
  } catch {
    return null;
  }
}

function writeCachedCollabSnapshot(next: WorkspaceCollabSnapshot | null): void {
  if (typeof window === 'undefined' || import.meta.env?.MODE === 'test') return;
  try {
    if (!next || !next.signedIn) {
      window.localStorage.removeItem(COLLAB_CHROME_CACHE_KEY);
      return;
    }
    const payload: CollabChromeCacheEnvelope = {
      at: Date.now(),
      snapshot: {
        ...EMPTY_SNAPSHOT,
        signedIn: true,
        accountState: next.accountState,
        user: next.user,
        workspaces: next.workspaces,
        activeWorkspaceId: next.activeWorkspaceId,
        activeWorkspace: next.activeWorkspace,
        permissions: next.permissions,
        quota: next.quota,
        referral: next.referral,
      },
    };
    window.localStorage.setItem(COLLAB_CHROME_CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* Storage quota / privacy mode must not affect collaboration state. */
  }
}

const WorkspaceCollabContext = createContext<WorkspaceCollabContextValue | null>(null);

export const useOptionalWorkspaceCollab = () => useContext(WorkspaceCollabContext);

export function useWorkspaceCollab(): WorkspaceCollabContextValue {
  const ctx = useContext(WorkspaceCollabContext);
  if (!ctx) throw new Error('WorkspaceCollabProvider is required');
  return ctx;
}

export function WorkspaceCollabProvider({
  children,
  hasActiveTask = false,
  onWorkspaceSwitched,
}: {
  children: ReactNode;
  hasActiveTask?: boolean;
  onWorkspaceSwitched?: (workspace: WorkspaceDirectoryEntry | null) => void;
}) {
  const { t } = useI18n();
  const collabToast = useToast();
  const { showToast } = collabToast;
  const [snapshot, setSnapshot] = useState<WorkspaceCollabSnapshot | null>(() => readCachedCollabSnapshot());
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [teamMembersDialogOpen, setTeamMembersDialogOpen] = useState(false);
  const [moveToTeamTarget, setMoveToTeamTarget] = useState<MoveToTeamTarget | null>(null);
  const [sharingProjectTarget, setSharingProjectTarget] = useState<SharingProjectTarget | null>(null);
  const [removeFromTeamTarget, setRemoveFromTeamTarget] = useState<RemoveFromTeamTarget | null>(null);
  const [projectsRevision, setProjectsRevision] = useState(0);
  const [billingGate, setBillingGate] = useState<BillingGateModalState>(null);
  const [topUpPolling, setTopUpPolling] = useState(false);
  const [openingCloudDestination, setOpeningCloudDestination] = useState<WorkspaceCloudDestination | null>(null);
  const openingCloudRef = useRef<WorkspaceCloudDestination | null>(null);
  const lastDirectCloudOpenAt = useRef(0);
  const requestSeq = useRef(0);
  const pendingCloudReturn = useRef(false);
  const snapshotRef = useRef<WorkspaceCollabSnapshot | null>(null);
  const billingGateRef = useRef<BillingGateModalState>(null);
  const pollingActiveRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);
  const pollStartedAtRef = useRef(0);
  const recoveredCallbackRef = useRef<(() => void) | undefined>(undefined);

  snapshotRef.current = snapshot;
  billingGateRef.current = billingGate;

  useEffect(() => {
    if (snapshot !== null) writeCachedCollabSnapshot(snapshot);
  }, [snapshot]);

  const bumpProjectsRevision = useCallback(() => {
    setProjectsRevision(prev => prev + 1);
  }, []);

  const stopTopUpPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollingActiveRef.current = false;
    recoveredCallbackRef.current = undefined;
    setTopUpPolling(false);
  }, []);

  const refresh = useCallback(async (force = false) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const raw = await gatewayRequest<WorkspaceCollabSnapshot>(
        `workspace/collab${force ? '?refresh=true' : ''}`,
      );
      if (seq !== requestSeq.current) return null;
      const next = normalizeSnapshot(raw);
      setSnapshot(next);
      if (!next.signedIn) {
        stopTopUpPolling();
      }
      if (force) setProjectsRevision(prev => prev + 1);
      return next;
    } catch {
      if (seq === requestSeq.current) {
        setSnapshot(prev => prev ?? EMPTY_SNAPSHOT);
      }
      return null;
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [stopTopUpPolling]);

  const checkTopUpNow = useCallback(async (): Promise<boolean> => {
    if (pollInFlightRef.current) return false;
    if (pollingActiveRef.current && Date.now() - pollStartedAtRef.current >= 10 * 60_000) {
      stopTopUpPolling();
      return false;
    }
    pollInFlightRef.current = true;
    try {
      const result = await gatewayRequest<WorkspacePreflightResult>('workspace/collab/preflight');
      if (result?.funded === true) {
        const cb = recoveredCallbackRef.current;
        stopTopUpPolling();
        setBillingGate(prev =>
          prev && (prev.kind === 'balance' || prev.kind === 'owner-topup') ? null : prev,
        );
        showToast(t('Credits restored. You can continue now.'), 'info');
        void refresh(true).then(next => {
          if (next) window.dispatchEvent(new Event('motion:account-changed'));
        });
        cb?.();
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      pollInFlightRef.current = false;
    }
  }, [refresh, showToast, stopTopUpPolling, t]);

  const startTopUpPolling = useCallback(
    (onRecovered?: () => void) => {
      if (onRecovered) {
        recoveredCallbackRef.current = onRecovered;
      }
      pollStartedAtRef.current = Date.now();
      if (pollingActiveRef.current) return;
      pollingActiveRef.current = true;
      setTopUpPolling(true);
      pollTimerRef.current = window.setInterval(() => {
        if (!pollingActiveRef.current) return;
        void checkTopUpNow();
      }, 5_000);
    },
    [checkTopUpNow],
  );

  const checkPreflightNow = useCallback(
    async (options?: {
      model?: string;
      silent?: boolean;
      onRecovered?: () => void;
    }): Promise<WorkspacePreflightResult | null> => {
      if (!snapshotRef.current?.signedIn) return null;
      try {
        const qs = options?.model?.trim() ? `?model=${encodeURIComponent(options.model.trim())}` : '';
        const result = await gatewayRequest<WorkspacePreflightResult>(`workspace/collab/preflight${qs}`);
        if (result && !result.funded && !options?.silent) {
          setBillingGate({
            kind: 'balance',
            reason: result.reason,
            balanceUsd: result.balanceUsd,
            weeklyPercentLeft: result.weeklyPercentLeft,
            onRecovered: options?.onRecovered,
          });
        }
        return result ?? null;
      } catch {
        return null;
      }
    },
    [],
  );

  const handleBillingError = useCallback(
    async (
      codeOrMessage?: string | null,
      options?: {
        featureLabel?: string;
        onRecovered?: () => void;
        onRetry?: () => void;
      },
    ): Promise<boolean> => {
      const kind = classifyBillingErrorCode(codeOrMessage);
      if (!kind) return false;
      if (kind === 'insufficient_balance') {
        setBillingGate({
          kind: 'balance',
          reason: 'insufficient_balance',
          balanceUsd: snapshotRef.current?.quota?.creditsUsd ?? null,
          weeklyPercentLeft: snapshotRef.current?.quota?.weeklyPercentLeft ?? null,
          onRecovered: options?.onRecovered,
        });
        void refresh(true);
        return true;
      }
      if (kind === 'tier_limit_exceeded') {
        const concurrency = await gatewayRequest<WorkspaceConcurrencyResult>(
          'workspace/collab/concurrency',
        ).catch(() => null);
        setBillingGate({
          kind: 'concurrency',
          inFlight: concurrency?.inFlight ?? null,
          limit: concurrency?.limit ?? null,
          onRetry: options?.onRetry,
        });
        return true;
      }
      setBillingGate({
        kind: 'artifact-upgrade',
        featureLabel: options?.featureLabel,
        enforced: true,
      });
      return true;
    },
    [refresh],
  );

  const triggerArtifactUpgradePrompt = useCallback(
    (featureLabel?: string, deliveryKind?: ArtifactDeliveryKind): boolean => {
      const snap = snapshotRef.current;
      if (!snap?.signedIn || !isFreeOrGoPlan(snap.quota?.planId)) return false;
      if (billingGateRef.current) return false;
      if (!canShowArtifactUpgrade()) return false;
      markArtifactUpgradeShown();
      setBillingGate({
        kind: 'artifact-upgrade',
        featureLabel,
        deliveryKind,
        enforced: false,
      });
      return true;
    },
    [],
  );

  useEffect(() => {
    void refresh(false);
    const onAccountChanged = () => void refresh(true);
    window.addEventListener('motion:account-changed', onAccountChanged);
    return () => {
      requestSeq.current++;
      window.removeEventListener('motion:account-changed', onAccountChanged);
    };
  }, [refresh]);

  useEffect(() => () => stopTopUpPolling(), [stopTopUpPolling]);

  useEffect(() => {
    const onArtifactDelivered = (event: Event) => {
      const detail = (event as CustomEvent<ArtifactDeliveredDetail>).detail;
      triggerArtifactUpgradePrompt(detail?.label, detail?.kind);
    };
    window.addEventListener(ARTIFACT_DELIVERED_EVENT, onArtifactDelivered);
    return () => {
      window.removeEventListener(ARTIFACT_DELIVERED_EVENT, onArtifactDelivered);
    };
  }, [triggerArtifactUpgradePrompt]);

  useEffect(() => {
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'hidden') return;
      if (pollingActiveRef.current) {
        void checkTopUpNow();
      }
      if (!pendingCloudReturn.current || document.visibilityState !== 'visible') return;
      pendingCloudReturn.current = false;
      void refresh(true).then(next => {
        if (next) window.dispatchEvent(new Event('motion:account-changed'));
      });
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, [checkTopUpNow, refresh]);

  const executeSwitch = useCallback(
    async (workspaceId: string) => {
      stopTopUpPolling();
      setSwitching(true);
      try {
        const next = normalizeSnapshot(
          await gatewayRequest<WorkspaceCollabSnapshot>('workspace/collab/switch', 'POST', {
            workspaceId,
          }),
        );
        setSnapshot(next);
        setProjectsRevision(prev => prev + 1);
        onWorkspaceSwitched?.(next.activeWorkspace);
        showToast(
          t('Switched to {name}', { name: next.activeWorkspace?.workspaceName ?? t('Workspace') }),
          'info',
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('Could not switch workspace'), 'error');
      } finally {
        setSwitching(false);
        setPendingSwitchId(null);
      }
    },
    [onWorkspaceSwitched, showToast, stopTopUpPolling, t],
  );

  const requestSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      if (!workspaceId || workspaceId === snapshot?.activeWorkspaceId || switching) return;
      if (hasActiveTask) {
        setPendingSwitchId(workspaceId);
        return;
      }
      void executeSwitch(workspaceId);
    },
    [executeSwitch, hasActiveTask, snapshot?.activeWorkspaceId, switching],
  );

  const recoverToPersonal = useCallback(async () => {
    stopTopUpPolling();
    setSwitching(true);
    try {
      const next = normalizeSnapshot(
        await gatewayRequest<WorkspaceCollabSnapshot>('workspace/collab/recover-personal', 'POST', {}),
      );
      setSnapshot(next);
      setProjectsRevision(prev => prev + 1);
      onWorkspaceSwitched?.(next.activeWorkspace);
      showToast(t('Returned to your personal workspace'), 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not switch workspace'), 'error');
    } finally {
      setSwitching(false);
    }
  }, [onWorkspaceSwitched, showToast, stopTopUpPolling, t]);

  const sendInvites = useCallback(
    async (rows: WorkspaceInviteRowInput[], workspaceId?: string) => {
      return gatewayRequest<{ workspaceId: string; results: WorkspaceInviteRowResult[] }>(
        'workspace/collab/invites',
        'POST',
        { workspaceId: workspaceId ?? snapshot?.activeWorkspaceId ?? undefined, rows },
      );
    },
    [snapshot?.activeWorkspaceId],
  );

  const openCloudLink = useCallback(
    async (destination: WorkspaceCloudDestination, workspaceId?: string) => {
      if (openingCloudRef.current) return;
      pendingCloudReturn.current = true;

      const desktopBridge = getDesktopBridge();
      const canUseBrowserTab = !desktopBridge && typeof window !== 'undefined' && typeof window.open === 'function';

      // Fast 0ms path: referral (/cloud/reset) does not require a server auth intent roundtrip.
      // Note: window.open with `noopener` always returns `null` per the HTML spec even when the
      // tab opens successfully, so never branch on its return value or fall through to open a second tab.
      if (destination === 'referral' && canUseBrowserTab) {
        const directUrl = snapshot?.referral?.referralUrl?.trim();
        if (directUrl && /^https?:\/\//i.test(directUrl)) {
          const now = Date.now();
          if (now - lastDirectCloudOpenAt.current < 400) return;
          try {
            const parsed = new URL(directUrl);
            parsed.searchParams.delete('source');
            if (!parsed.searchParams.has('entry_source')) {
              parsed.searchParams.set('entry_source', 'client_entry');
            }
            parsed.searchParams.set('od_origin', 'openmotion');
            parsed.searchParams.set('od_entry_source', OPENMOTION_CLOUD_ENTRY_SOURCE);
            parsed.searchParams.set('od_entry_id', crypto.randomUUID());
            parsed.searchParams.set('od_entry_at', new Date().toISOString());
            parsed.searchParams.set('utm_source', 'openmotion');
            parsed.searchParams.set('utm_medium', CLOUD_DESTINATION_UTM_MEDIUM.referral);
            lastDirectCloudOpenAt.current = now;
            window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
            return;
          } catch {
            // Fall through to server-resolved URL if directUrl is malformed.
          }
        }
      }

      // Open a themed placeholder tab synchronously inside the click gesture so the browser
      // responds immediately (0ms) and never blocks the redirect as a delayed popup.
      let pendingTab: Window | null = null;
      if (canUseBrowserTab) {
        try {
          pendingTab = window.open('', '_blank');
          if (pendingTab && pendingTab.document) {
            const rootStyle = getComputedStyle(document.documentElement);
            const bg = rootStyle.getPropertyValue('--motion-bg').trim() || rootStyle.backgroundColor || 'Canvas';
            const fg = rootStyle.getPropertyValue('--motion-text').trim() || rootStyle.color || 'CanvasText';
            pendingTab.document.title = t('OpenDesign Cloud');
            pendingTab.document.body.style.cssText =
              `margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,sans-serif;font-size:14px;background:${bg};color:${fg};`;
            pendingTab.document.body.textContent = t('OpenDesign Cloud');
          }
        } catch {
          pendingTab = null;
        }
      }

      openingCloudRef.current = destination;
      setOpeningCloudDestination(destination);
      try {
        const serverShouldLaunch = !pendingTab && !desktopBridge;
        const { url, opened } = await gatewayRequest<{ url: string; opened: boolean }>(
          'workspace/collab/cloud-link',
          'POST',
          {
            destination,
            workspaceId: workspaceId ?? snapshot?.activeWorkspaceId ?? undefined,
            launch: serverShouldLaunch,
          },
        );
        if (pendingTab) {
          if (url) {
            try {
              pendingTab.opener = null;
            } catch {
              // Ignore cross-origin opener assignment errors.
            }
            pendingTab.location.replace(url);
          } else {
            pendingTab.close();
          }
        } else if (!opened && url) {
          await openExternalUrl(url);
        }
      } catch {
        pendingCloudReturn.current = false;
        try {
          pendingTab?.close();
        } catch {
          // Ignore cross-origin or already-closed tab errors.
        }
        showToast(t("Couldn't open your browser. Try again."), 'error');
      } finally {
        openingCloudRef.current = null;
        setOpeningCloudDestination(null);
      }
    },
    [showToast, snapshot?.activeWorkspaceId, snapshot?.referral?.referralUrl, t],
  );

  const fetchWorkspaceMembers = useCallback(
    async (workspaceId?: string): Promise<WorkspaceMembersResponse> => {
      const qs = workspaceId?.trim() ? `?workspaceId=${encodeURIComponent(workspaceId.trim())}` : '';
      return gatewayRequest<WorkspaceMembersResponse>(`workspace/collab/members${qs}`);
    },
    [],
  );

  const moveProjectToTeam = useCallback(
    async (
      projectId: string,
      targetWorkspaceId: string,
      skipConfirm = false,
      options?: { kind?: WorkspaceProjectKind; title?: string },
    ) => {
      const next = normalizeSnapshot(
        await gatewayRequest<WorkspaceCollabSnapshot>(
          `workspace/collab/projects/${encodeURIComponent(projectId)}/move`,
          'POST',
          {
            workspaceId: targetWorkspaceId,
            skipConfirm,
            ...(options?.kind ? { kind: options.kind } : {}),
            ...(options?.title ? { title: options.title } : {}),
          },
        ),
      );
      setSnapshot(next);
      setProjectsRevision(prev => prev + 1);
      const targetName =
        next.workspaces.find(item => item.workspaceId === targetWorkspaceId)?.workspaceName ??
        t('team workspace');
      showToast(t('Moved project to {name}', { name: targetName }), 'info');
    },
    [showToast, t],
  );

  const requestMoveToTeam = useCallback(
    (project: { id: string; title: string; kind?: WorkspaceProjectKind }) => {
      const teams = (snapshot?.workspaces ?? []).filter(
        w => w.workspaceType === 'team' && w.memberStatus === 'active' && w.lifecycleState === 'active',
      );
      if (!teams.length) {
        void openCloudLink('create-workspace');
        return;
      }
      const preferredTeam =
        snapshot?.activeWorkspace?.workspaceType === 'team' ? snapshot.activeWorkspace : teams[0];
      if (snapshot?.preferences.skipMoveToTeamConfirm && preferredTeam) {
        void moveProjectToTeam(project.id, preferredTeam.workspaceId, false, {
          kind: project.kind,
          title: project.title,
        }).catch(err => {
          showToast(err instanceof Error ? err.message : t('Could not move project'), 'error');
        });
        return;
      }
      setMoveToTeamTarget({ projectId: project.id, title: project.title, kind: project.kind });
    },
    [moveProjectToTeam, openCloudLink, showToast, snapshot, t],
  );

  const removeProjectFromTeam = useCallback(
    async (projectId: string, skipConfirm = false) => {
      const next = normalizeSnapshot(
        await gatewayRequest<WorkspaceCollabSnapshot>(
          `workspace/collab/projects/${encodeURIComponent(projectId)}/remove-from-team`,
          'POST',
          { skipConfirm },
        ),
      );
      setSnapshot(next);
      setProjectsRevision(prev => prev + 1);
      showToast(t('Removed from team and returned to Personal'), 'info');
    },
    [showToast, t],
  );

  const requestRemoveFromTeam = useCallback(
    (project: { id: string; title: string; workspaceName?: string | null }) => {
      const meta = snapshot?.projectMeta[project.id];
      const teamName =
        project.workspaceName?.trim() ||
        snapshot?.workspaces.find(w => w.workspaceId === meta?.workspaceId)?.workspaceName ||
        snapshot?.activeWorkspace?.workspaceName ||
        t('team workspace');
      if (snapshot?.preferences.skipRemoveFromTeamConfirm) {
        void removeProjectFromTeam(project.id, false).catch(err => {
          showToast(err instanceof Error ? err.message : t('Could not remove project from team'), 'error');
        });
        return;
      }
      setRemoveFromTeamTarget({
        projectId: project.id,
        title: project.title,
        workspaceName: teamName,
      });
    },
    [removeProjectFromTeam, showToast, snapshot, t],
  );

  const openProjectSharing = useCallback((target: SharingProjectTarget) => {
    setSharingProjectTarget(target);
  }, []);

  const closeProjectSharing = useCallback(() => {
    setSharingProjectTarget(null);
  }, []);

  const setProjectVisibility = useCallback(
    async (projectId: string, visibility: ProjectVisibility) => {
      const next = normalizeSnapshot(
        await gatewayRequest<WorkspaceCollabSnapshot>(
          `workspace/collab/projects/${encodeURIComponent(projectId)}/visibility`,
          'POST',
          { visibility },
        ),
      );
      setSnapshot(next);
      setProjectsRevision(prev => prev + 1);
      showToast(
        t(visibility === 'workspace' ? 'Visible to workspace members' : 'Restricted to only you'),
        'info',
      );
    },
    [showToast, t],
  );

  const retryCommentSync = useCallback(
    async (projectId: string) => {
      try {
        const next = normalizeSnapshot(
          await gatewayRequest<WorkspaceCollabSnapshot>(
            `workspace/collab/comments/${encodeURIComponent(projectId)}/sync`,
            'POST',
            {},
          ),
        );
        setSnapshot(next);
        const result = next.commentSync[projectId];
        if (result?.state === 'failed') {
          showToast(result.lastError || t('Could not sync comments. Please try again.'), 'error');
        } else {
          showToast(t('Comments synced with your workspace'), 'info');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('Could not sync comments. Please try again.'), 'error');
      }
    },
    [showToast, t],
  );

  const dismissBanner = useCallback(async (key: string) => {
    setSnapshot(prev =>
      prev
        ? {
            ...prev,
            preferences: {
              ...prev.preferences,
              dismissedBanners: [...new Set([...prev.preferences.dismissedBanners, key])],
            },
          }
        : prev,
    );
    try {
      const next = normalizeSnapshot(
        await gatewayRequest<WorkspaceCollabSnapshot>('workspace/collab/preferences', 'POST', {
          dismissBanner: key,
        }),
      );
      setSnapshot(next);
    } catch {
      // Keep local dismissal if preference write fails transiently.
    }
  }, []);

  const notify = useCallback(
    (message: string, tone: 'info' | 'error' = 'info') => {
      showToast(message, tone);
    },
    [showToast],
  );

  const value = useMemo<WorkspaceCollabContextValue>(
    () => ({
      snapshot,
      loading,
      switching,
      hasActiveTask,
      projectsRevision,
      bumpProjectsRevision,
      refresh,
      requestSwitchWorkspace,
      recoverToPersonal,
      inviteDialogOpen,
      setInviteDialogOpen,
      teamMembersDialogOpen,
      setTeamMembersDialogOpen,
      fetchWorkspaceMembers,
      sendInvites,
      openCloudLink,
      openingCloudDestination,
      moveToTeamTarget,
      setMoveToTeamTarget,
      requestMoveToTeam,
      moveProjectToTeam,
      sharingProjectTarget,
      openProjectSharing,
      closeProjectSharing,
      removeFromTeamTarget,
      setRemoveFromTeamTarget,
      requestRemoveFromTeam,
      removeProjectFromTeam,
      setProjectVisibility,
      retryCommentSync,
      dismissBanner,
      billingGate,
      setBillingGate,
      topUpPolling,
      startTopUpPolling,
      stopTopUpPolling,
      checkTopUpNow,
      checkPreflightNow,
      handleBillingError,
      triggerArtifactUpgradePrompt,
      notify,
    }),
    [
      snapshot,
      loading,
      switching,
      hasActiveTask,
      projectsRevision,
      bumpProjectsRevision,
      refresh,
      requestSwitchWorkspace,
      recoverToPersonal,
      inviteDialogOpen,
      teamMembersDialogOpen,
      fetchWorkspaceMembers,
      sendInvites,
      openCloudLink,
      openingCloudDestination,
      moveToTeamTarget,
      requestMoveToTeam,
      moveProjectToTeam,
      sharingProjectTarget,
      openProjectSharing,
      closeProjectSharing,
      removeFromTeamTarget,
      requestRemoveFromTeam,
      removeProjectFromTeam,
      setProjectVisibility,
      retryCommentSync,
      dismissBanner,
      billingGate,
      topUpPolling,
      startTopUpPolling,
      stopTopUpPolling,
      checkTopUpNow,
      checkPreflightNow,
      handleBillingError,
      triggerArtifactUpgradePrompt,
      notify,
    ],
  );

  const targetWorkspace = snapshot?.workspaces.find(item => item.workspaceId === pendingSwitchId);

  return (
    <WorkspaceCollabContext.Provider value={value}>
      <StudioToastViewport {...collabToast} />
      {children}
      <CollabDialog
        open={Boolean(pendingSwitchId)}
        title={t('Switch workspace?')}
        onClose={() => setPendingSwitchId(null)}
      >
        <p className="om-muted">
          {t(
            'A task is currently running. Switching to {name} applies future usage and projects to that workspace while running tasks stay billed to the original workspace.',
            { name: targetWorkspace?.workspaceName ?? t('selected workspace') },
          )}
        </p>
        <div className="om-collab-dialog-footer">
          <Button variant="plain" type="button" className="om-collab-tonal-btn" onClick={() => setPendingSwitchId(null)}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={switching}
            onClick={() => pendingSwitchId && void executeSwitch(pendingSwitchId)}
          >
            {t('Switch workspace')}
          </Button>
        </div>
      </CollabDialog>
    </WorkspaceCollabContext.Provider>
  );
}
