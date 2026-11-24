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
  CLOUD_DESTINATION_UTM_MEDIUM,
  EMPTY_WORKSPACE_PERMISSIONS,
  OPENMOTION_CLOUD_ENTRY_SOURCE,
  type ProjectVisibility,
  type WorkspaceCloudDestination,
  type WorkspaceCollabSnapshot,
  type WorkspaceDirectoryEntry,
  type WorkspaceInviteRowInput,
  type WorkspaceInviteRowResult,
} from '../../../shared/workspace-collab';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { getDesktopBridge, openExternalUrl } from '../utils/platformHost';
import { gatewayRequest } from './gatewayClient';
import { CollabDialog } from './collab/CollabDialog';
import './workspaceCollab.css';

export type MoveToTeamTarget = {
  projectId: string;
  title: string;
};

export type BillingGateModalState = {
  kind: 'balance' | 'owner-topup' | 'artifact-upgrade';
  featureLabel?: string;
} | null;

export type WorkspaceCollabContextValue = {
  snapshot: WorkspaceCollabSnapshot | null;
  loading: boolean;
  switching: boolean;
  hasActiveTask: boolean;
  refresh: (force?: boolean) => Promise<WorkspaceCollabSnapshot | null>;
  requestSwitchWorkspace: (workspaceId: string) => void;
  recoverToPersonal: () => Promise<void>;
  inviteDialogOpen: boolean;
  setInviteDialogOpen: (open: boolean) => void;
  sendInvites: (
    rows: WorkspaceInviteRowInput[],
    workspaceId?: string,
  ) => Promise<{ workspaceId: string; results: WorkspaceInviteRowResult[] }>;
  openCloudLink: (destination: WorkspaceCloudDestination, workspaceId?: string) => Promise<void>;
  openingCloudDestination: WorkspaceCloudDestination | null;
  moveToTeamTarget: MoveToTeamTarget | null;
  setMoveToTeamTarget: (target: MoveToTeamTarget | null) => void;
  requestMoveToTeam: (project: { id: string; title: string }) => void;
  moveProjectToTeam: (
    projectId: string,
    targetWorkspaceId: string,
    skipConfirm?: boolean,
  ) => Promise<void>;
  setProjectVisibility: (projectId: string, visibility: ProjectVisibility) => Promise<void>;
  retryCommentSync: (projectId: string) => Promise<void>;
  dismissBanner: (key: string) => Promise<void>;
  billingGate: BillingGateModalState;
  setBillingGate: (gate: BillingGateModalState) => void;
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
      dismissedBanners: Array.isArray(record.preferences?.dismissedBanners)
        ? record.preferences!.dismissedBanners
        : [],
    },
  };
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
  const [snapshot, setSnapshot] = useState<WorkspaceCollabSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [moveToTeamTarget, setMoveToTeamTarget] = useState<MoveToTeamTarget | null>(null);
  const [billingGate, setBillingGate] = useState<BillingGateModalState>(null);
  const [openingCloudDestination, setOpeningCloudDestination] = useState<WorkspaceCloudDestination | null>(null);
  const openingCloudRef = useRef<WorkspaceCloudDestination | null>(null);
  const requestSeq = useRef(0);
  const pendingCloudReturn = useRef(false);

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
      return next;
    } catch {
      if (seq === requestSeq.current) {
        setSnapshot(prev => prev ?? EMPTY_SNAPSHOT);
      }
      return null;
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
    const onAccountChanged = () => void refresh(true);
    window.addEventListener('motion:account-changed', onAccountChanged);
    return () => {
      requestSeq.current++;
      window.removeEventListener('motion:account-changed', onAccountChanged);
    };
  }, [refresh]);

  useEffect(() => {
    const onFocusOrVisible = () => {
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
  }, [refresh]);

  const executeSwitch = useCallback(
    async (workspaceId: string) => {
      setSwitching(true);
      try {
        const next = normalizeSnapshot(
          await gatewayRequest<WorkspaceCollabSnapshot>('workspace/collab/switch', 'POST', {
            workspaceId,
          }),
        );
        setSnapshot(next);
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
    [onWorkspaceSwitched, showToast, t],
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
    setSwitching(true);
    try {
      const next = normalizeSnapshot(
        await gatewayRequest<WorkspaceCollabSnapshot>('workspace/collab/recover-personal', 'POST', {}),
      );
      setSnapshot(next);
      onWorkspaceSwitched?.(next.activeWorkspace);
      showToast(t('Returned to your personal workspace'), 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not switch workspace'), 'error');
    } finally {
      setSwitching(false);
    }
  }, [onWorkspaceSwitched, showToast, t]);

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
      if (destination === 'referral' && canUseBrowserTab) {
        const directUrl = snapshot?.referral?.referralUrl?.trim();
        if (directUrl && /^https?:\/\//i.test(directUrl)) {
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
            const openedTab = window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
            if (openedTab) return;
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

  const moveProjectToTeam = useCallback(
    async (projectId: string, targetWorkspaceId: string, skipConfirm = false) => {
      const next = normalizeSnapshot(
        await gatewayRequest<WorkspaceCollabSnapshot>(
          `workspace/collab/projects/${encodeURIComponent(projectId)}/move`,
          'POST',
          { workspaceId: targetWorkspaceId, skipConfirm },
        ),
      );
      setSnapshot(next);
      const targetName =
        next.workspaces.find(item => item.workspaceId === targetWorkspaceId)?.workspaceName ??
        t('team workspace');
      showToast(t('Moved project to {name}', { name: targetName }), 'info');
    },
    [showToast, t],
  );

  const requestMoveToTeam = useCallback(
    (project: { id: string; title: string }) => {
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
        void moveProjectToTeam(project.id, preferredTeam.workspaceId, false).catch(err => {
          showToast(err instanceof Error ? err.message : t('Could not move project'), 'error');
        });
        return;
      }
      setMoveToTeamTarget({ projectId: project.id, title: project.title });
    },
    [moveProjectToTeam, openCloudLink, showToast, snapshot, t],
  );

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
      showToast(
        t(visibility === 'workspace' ? 'Visible to workspace members' : 'Restricted to only you'),
        'info',
      );
    },
    [showToast, t],
  );

  const retryCommentSync = useCallback(
    async (projectId: string) => {
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
      refresh,
      requestSwitchWorkspace,
      recoverToPersonal,
      inviteDialogOpen,
      setInviteDialogOpen,
      sendInvites,
      openCloudLink,
      openingCloudDestination,
      moveToTeamTarget,
      setMoveToTeamTarget,
      requestMoveToTeam,
      moveProjectToTeam,
      setProjectVisibility,
      retryCommentSync,
      dismissBanner,
      billingGate,
      setBillingGate,
      notify,
    }),
    [
      snapshot,
      loading,
      switching,
      hasActiveTask,
      refresh,
      requestSwitchWorkspace,
      recoverToPersonal,
      inviteDialogOpen,
      sendInvites,
      openCloudLink,
      openingCloudDestination,
      moveToTeamTarget,
      requestMoveToTeam,
      moveProjectToTeam,
      setProjectVisibility,
      retryCommentSync,
      dismissBanner,
      billingGate,
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
