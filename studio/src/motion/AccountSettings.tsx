import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import * as tracking from './pageTracking';
import { Tooltip } from '../components/ui/Tooltip';
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { AccountSummary } from '../../../shared/provider-directory';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import { Select } from '../components/ui/Select';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { gatewayRequest, type CloudApiError } from './gatewayClient';
import { notifyProvidersChanged } from './useProviderDirectory';
import { activeAccountOffer, MULTIMODAL_CAPABILITIES } from './accountOffer';
import { SettingsError, SettingsLoading } from './settingsPrimitives';

export interface CloudWorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  externalWorkspaceId?: string | null;
}

export interface CloudAccountSummary extends AccountSummary {
  userId?: string;
  authMode?: 'oidc' | 'dev';
  authMethod?: 'session_cookie' | 'pat' | 'oauth_bearer' | 'oidc_jwt' | 'dev_bypass';
  activeWorkspace?: CloudWorkspaceSummary | null;
  workspaces?: CloudWorkspaceSummary[];
  mediaEntitlement?: 'included' | 'not-included' | 'unknown';
  modelGateway?: {
    provider: string;
    mode: 'opendesign' | 'mock' | 'volcengine';
  };
}

export interface ConnectedApplicationRecord {
  clientId: string;
  clientName: string;
  redirectHost: string;
  redirectUris: string[];
  workspaceId: string;
  scopes: string[];
  firstAuthorizedAt: string;
  lastUsedAt: string | null;
  activeTokenCount: number;
}

export interface PersonalAccessTokenRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface CloudSummaryApiResponse {
  authenticated?: boolean;
  authMode?: 'oidc' | 'dev';
  authMethod?: CloudAccountSummary['authMethod'];
  consoleUrl?: string;
  user?: {
    id?: string;
    email?: string | null;
    displayName?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
    planTier?: string | null;
  } | null;
  activeWorkspace?: CloudWorkspaceSummary | null;
  workspaces?: CloudWorkspaceSummary[];
  billing?: {
    plan?: string;
    mediaEntitlement?: 'included' | 'not-included' | 'unknown';
    hasBalance?: boolean;
    balanceUsd?: number | null;
    unavailable?: boolean;
  };
  modelGateway?: {
    provider: string;
    mode: 'opendesign' | 'mock' | 'volcengine';
  };
  // Legacy AccountSummary fields (accepted for mocked unit tests)
  state?: AccountSummary['state'];
  plan?: string;
  balance?: string | number | null;
  billingUnavailable?: boolean;
  billingError?: { status: number; code?: string };
  error?: string;
  errorCode?: AccountSummary['errorCode'];
}

const DEFAULT_CONSOLE_URL = 'https://open-design.ai';
const DEFAULT_PAT_SCOPES = [
  'projects:read',
  'projects:write',
  'assets:read',
  'assets:write',
  'exports:write',
  'media:generate',
  'mcp:tools',
] as const;

function subscriptionUrl(consoleUrl: string, entrySource = 'openmotion_manage_subscription') {
  const url = new URL((consoleUrl || DEFAULT_CONSOLE_URL).replace(/\/+$/, '') + '/dashboard');
  url.search = new URLSearchParams({
    billing: 'plan',
    od_origin: 'openmotion',
    od_entry_source: entrySource,
    od_entry_id: crypto.randomUUID(),
    od_entry_at: new Date().toISOString(),
  }).toString();
  return url.href;
}

function normalizeBalance(value: string | number | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return typeof value === 'number' ? String(value) : value;
}

function normalizeAccountSummary(raw: CloudSummaryApiResponse): CloudAccountSummary {
  const consoleUrl = raw.consoleUrl || DEFAULT_CONSOLE_URL;
  if (raw.state) {
    return {
      state: raw.state,
      userId: raw.user?.id,
      consoleUrl,
      user: raw.user ? { name: raw.user.name ?? raw.user.displayName ?? undefined, email: raw.user.email ?? undefined } : undefined,
      plan: raw.plan,
      balance: normalizeBalance(raw.balance),
      billingUnavailable: raw.billingUnavailable,
      billingError: raw.billingError,
      error: raw.error,
      errorCode: raw.errorCode,
      authMode: raw.authMode,
      authMethod: raw.authMethod,
      activeWorkspace: raw.activeWorkspace,
      workspaces: raw.workspaces,
      modelGateway: raw.modelGateway,
    };
  }
  const authenticated = Boolean(raw.authenticated && raw.user);
  const plan = raw.billing?.plan ?? raw.user?.planTier ?? undefined;
  return {
    state: authenticated ? 'signed-in' : 'signed-out',
    userId: raw.user?.id,
    consoleUrl,
    user: raw.user
      ? {
          name: raw.user.displayName ?? raw.user.name ?? undefined,
          email: raw.user.email ?? undefined,
        }
      : undefined,
    plan,
    balance: normalizeBalance(raw.billing?.balanceUsd),
    billingUnavailable: raw.billing?.unavailable,
    authMode: raw.authMode ?? 'oidc',
    authMethod: raw.authMethod,
    activeWorkspace: raw.activeWorkspace ?? null,
    workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
    mediaEntitlement: raw.billing?.mediaEntitlement,
    modelGateway: raw.modelGateway,
  };
}

export function buildLoginUrl(returnTo?: string): string {
  const target = returnTo ?? (typeof window !== 'undefined'
    ? `${window.location.pathname}${window.location.search}${window.location.hash}`
    : '/');
  return `/auth/login?returnTo=${encodeURIComponent(target || '/')}`;
}

export function useAccountSummary() {
  const [account, updateAccount] = useState<CloudAccountSummary | null>(null);
  const [error, setError] = useState(false);
  const request = useRef(0);
  const setAccount = useCallback((value: CloudAccountSummary) => {
    request.current++;
    updateAccount(value);
    setError(false);
  }, []);
  const refresh = useCallback(async (billing = false) => {
    const current = ++request.current;
    try {
      const raw = await gatewayRequest<CloudSummaryApiResponse>('account/summary' + (billing ? '?refresh=true' : ''));
      if (current === request.current) {
        updateAccount(normalizeAccountSummary(raw));
        setError(false);
      }
    } catch (err) {
      if (current !== request.current) return;
      const apiErr = err as CloudApiError;
      if (apiErr.status === 401) {
        updateAccount({ state: 'signed-out', consoleUrl: DEFAULT_CONSOLE_URL, authMode: 'oidc' });
        setError(false);
        return;
      }
      setError(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const update = () => void refresh();
    window.addEventListener('motion:account-changed', update);
    return () => {
      request.current++;
      window.removeEventListener('motion:account-changed', update);
    };
  }, [refresh]);
  return { account, error, refresh, setAccount };
}
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleDateString();
}

export function AccountSettings({ subscription = false, openProviders }: { subscription?: boolean; openProviders: () => void }) {
  const { t } = useI18n();
  const state = useAccountSummary();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null);

  // Connected OAuth applications ("已连接的应用") state
  const [connections, setConnections] = useState<ConnectedApplicationRecord[] | null>(null);
  const [revokingClientId, setRevokingClientId] = useState<string | null>(null);

  // Personal Access Token management state
  const [tokens, setTokens] = useState<PersonalAccessTokenRecord[] | null>(null);
  const [tokensError, setTokensError] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenExpiryDays, setTokenExpiryDays] = useState('90');
  const [creatingToken, setCreatingToken] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<{ token: string; name: string } | null>(null);

  const account = state.account;
  const signedIn = account?.state === 'signed-in';
  const isDevMode = account?.authMode === 'dev';

  const loadTokens = useCallback(async () => {
    if (!signedIn || subscription) return;
    try {
      const response = await gatewayRequest<{ tokens: PersonalAccessTokenRecord[] }>('tokens');
      setTokens(Array.isArray(response.tokens) ? response.tokens : []);
      setTokensError(false);
    } catch {
      setTokensError(true);
    }
  }, [signedIn, subscription]);

  const loadConnections = useCallback(async () => {
    if (!signedIn || subscription) return;
    try {
      const response = await gatewayRequest<{ connections?: ConnectedApplicationRecord[] }>('connections');
      setConnections(Array.isArray(response.connections) ? response.connections : []);
    } catch {
      setConnections([]);
    }
  }, [signedIn, subscription]);

  useEffect(() => {
    if (signedIn && !subscription) {
      void loadTokens();
      void loadConnections();
    }
  }, [signedIn, subscription, loadTokens, loadConnections]);

  function subscriptionLink(source: string, element: 'manage_subscription' | 'view_plans') {
    const consoleUrl = state.account!.consoleUrl;
    const open = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.detail === 0 && event.button === 0) event.currentTarget.href = subscriptionUrl(consoleUrl, source);
      tracking.reportSettingsClick('account', element);
    };
    return {
      href: subscriptionUrl(consoleUrl, source),
      target: '_blank',
      rel: 'noreferrer',
      onPointerDown: (event: MouseEvent<HTMLAnchorElement>) => { event.currentTarget.href = subscriptionUrl(consoleUrl, source); },
      onClick: open,
      onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => { if (event.button === 1) open(event); },
    };
  }

  function signInWithOidc() {
    tracking.reportSettingsClick('account', 'sign_in');
    window.location.assign(buildLoginUrl());
  }

  async function signOut() {
    tracking.reportSettingsClick('account', 'sign_out');
    setBusy(true);
    try {
      const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; endSessionUrl?: string };
      if (!response.ok) throw new Error(t('Could not sign out'));
      state.setAccount({ state: 'signed-out', consoleUrl: account?.consoleUrl || DEFAULT_CONSOLE_URL, authMode: account?.authMode ?? 'oidc' });
      setTokens(null);
      setCreatedToken(null);
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
      toast.showToast(t('Signed out'), 'info');
      if (data.endSessionUrl) {
        window.location.assign(data.endSessionUrl);
      }
    } catch (error) {
      toast.showToast(error instanceof Error ? error.message : t('Could not update account'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function refreshBilling() {
    tracking.reportSettingsClick('account', 'refresh_billing');
    setRefreshing(true);
    try { await state.refresh(true); } finally { setRefreshing(false); }
  }
  async function switchWorkspace(workspaceId: string) {
    if (workspaceId === account?.activeWorkspace?.id) return;
    setSwitchingWorkspaceId(workspaceId);
    try {
      await gatewayRequest('account/workspaces/switch', 'POST', { workspaceId });
      await state.refresh(true);
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
      toast.showToast(t('Workspace switched'), 'info');
    } catch (error) {
      toast.showToast(error instanceof Error ? error.message : t('Could not switch workspace'), 'error');
    } finally {
      setSwitchingWorkspaceId(null);
    }
  }

  async function createToken(event: FormEvent) {
    event.preventDefault();
    const trimmed = tokenName.trim();
    if (!trimmed) {
      toast.showToast(t('Enter a name for this token'), 'error');
      return;
    }
    setCreatingToken(true);
    try {
      const expiresInDays = tokenExpiryDays === 'never' ? undefined : Number(tokenExpiryDays);
      // Omit explicit `scopes` so `createPat()` intersects DEFAULT_PAT_SCOPES with the user's live workspace role (incl. viewers).
      const response = await gatewayRequest<{
        id?: string;
        name?: string;
        token: string;
        scopes?: string[];
        record?: PersonalAccessTokenRecord;
      }>('tokens', 'POST', {
        name: trimmed,
        ...(expiresInDays ? { expiresInDays } : {}),
      });
      setCreatedToken({ token: response.token, name: response.name ?? response.record?.name ?? trimmed });
      setTokenName('');
      await loadTokens();
      toast.showToast(t('Personal access token created'), 'info');
    } catch (error) {
      toast.showToast(error instanceof Error ? error.message : t('Could not create token'), 'error');
    } finally {
      setCreatingToken(false);
    }
  }

  async function revokeConnection(clientId: string) {
    setRevokingClientId(clientId);
    try {
      await gatewayRequest(`connections/${encodeURIComponent(clientId)}`, 'DELETE');
      await loadConnections();
      toast.showToast(t('Connection revoked'), 'info');
    } catch (error) {
      toast.showToast(error instanceof Error ? error.message : t('Could not revoke connection'), 'error');
    } finally {
      setRevokingClientId(null);
    }
  }

  async function revokeToken(id: string) {
    setRevokingId(id);
    try {
      await gatewayRequest(`tokens/${encodeURIComponent(id)}`, 'DELETE');
      await loadTokens();
      toast.showToast(t('Token revoked'), 'info');
    } catch (error) {
      toast.showToast(error instanceof Error ? error.message : t('Could not revoke token'), 'error');
    } finally {
      setRevokingId(null);
    }
  }

  async function copyCreatedToken() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken.token);
      toast.showToast(t('Token copied'), 'info');
    } catch {
      toast.showToast(t('Could not copy token'), 'error');
    }
  }

  const signIn = (
    <Button variant="ghost" className="om-button h-auto" data-primary disabled={busy} onClick={signInWithOidc}>
      <RemixIcon name="login-box-line" size={17} />
      {t('Sign in with OpenDesign')}
    </Button>
  );

  const signedOutGuide = !signedIn;
  const plan = signedIn && !account?.billingUnavailable ? account?.plan?.trim().toLowerCase() : undefined;
  const upgradeGuide = plan === 'free' || plan === 'go';
  const offer = activeAccountOffer();
  const capabilities = (
    <ul className="om-account-capabilities" aria-label={t('Multimodal')}>
      {MULTIMODAL_CAPABILITIES.map(item => (
        <li key={item.label}><RemixIcon name={item.icon} size={16} />{t(item.label)}</li>
      ))}
    </ul>
  );
  const offerNote = offer && (
    <p className="om-account-offer">
      <RemixIcon name="sparkling-fill" size={15} />
      <strong>{t(offer.title)}</strong>
      {offer.detail && <span>{t(offer.detail)}</span>}
    </p>
  );
  const name = account?.user?.name?.trim();
  const email = account?.user?.email;
  const named = Boolean(name) && name!.toLowerCase() !== email?.toLowerCase();
  const workspaces = account?.workspaces ?? [];
  const canSwitchWorkspace = account?.authMethod === 'session_cookie';
  const activeTokens = (tokens ?? []).filter(item => !item.revokedAt);

  return (
    <div className="om-settings-page">
      {state.error ? <SettingsError retry={() => void state.refresh(true)} /> : !account ? <SettingsLoading /> : (
        <>
          <div className="om-account-identity">
            <span className="om-avatar"><RemixIcon name="user-3-line" size={36} /></span>
            <h1 className="om-title">{subscription ? t('Subscription & usage') : named ? name : email || t('Your OpenDesign account')}</h1>
            <p className="om-muted">{(subscription || named) && email ? email : t('Your creative workspace, connected.')}</p>
          </div>

          {isDevMode && (
            <section className="om-card om-card-stack" role="status" data-dev-mode="true">
              <div className="om-settings-row">
                <h2 className="om-subtitle">{t('Local Dev Mode')}</h2>
                <span className="om-badge" data-active="true">AUTH_MODE=dev</span>
              </div>
              <p className="om-muted">{t('Authentication is bypassed for local Docker Compose development. A single local owner workspace is active; switch to AUTH_MODE=oidc for multi-user cloud deployments.')}</p>
            </section>
          )}

          {signedOutGuide ? (
            <section className="om-card om-plan-guide">
              <div className="om-plan-guide-head">
                <h2 className="om-title">{t('Sign in to start multimodal generation')}</h2>
                <span className="om-badge" data-active="true">{t('Plus and above')}</span>
              </div>
              <p className="om-muted">{t('Sign in with OpenDesign to access your cloud workspace, personal access tokens, and unified image, video, speech and music generation.')}</p>
              {capabilities}
              {offerNote}
              <div className="om-settings-actions">{signIn}</div>
            </section>
          ) : (
            <section className="om-card om-account-summary">
              <div>
                <h2 className="om-subtitle">{t(isDevMode ? 'Local developer session' : 'Connected to OpenDesign')}</h2>
                <p className="om-muted">
                  {t(isDevMode
                    ? 'Running in local development mode with the default local workspace.'
                    : 'Signed in via OpenDesign OIDC. Your workspace, personal access tokens and model gateway stay in sync.')}
                </p>
                {account.activeWorkspace && (
                  <div className="om-settings-tags">
                    <span className="om-badge" data-active="true">{account.activeWorkspace.name}</span>
                    <span className="om-badge">{account.activeWorkspace.role}</span>
                  </div>
                )}
              </div>
              {!isDevMode && (
                <div className="om-settings-actions">
                  <Button variant="ghost" className="om-button h-auto" onClick={() => void signOut()} disabled={busy}>
                    {t('Sign out')}
                  </Button>
                </div>
              )}
            </section>
          )}

          {!subscription && signedIn && workspaces.length > 0 && (
            <section className="om-settings-section" aria-label={t('Workspaces')}>
              <div className="om-settings-row">
                <h2 className="om-subtitle">{t('Workspaces')}</h2>
                {!canSwitchWorkspace && (
                  <span className="om-muted">{t('Session cookie required to switch workspaces')}</span>
                )}
              </div>
              <div className="om-card om-card-stack">
                {workspaces.map(ws => {
                  const isActive = ws.id === account.activeWorkspace?.id;
                  return (
                    <div className="om-preference-row" key={ws.id}>
                      <div>
                        <strong>{ws.name}</strong>
                        <p className="om-muted">{ws.slug} · {ws.role}</p>
                      </div>
                      <Button
                        variant="ghost"
                        className="om-button h-auto"
                        disabled={isActive || !canSwitchWorkspace || switchingWorkspaceId !== null}
                        onClick={() => void switchWorkspace(ws.id)}
                      >
                        {isActive ? <><RemixIcon name="check-line" size={14} />{t('Active workspace')}</> : t(switchingWorkspaceId === ws.id ? 'Switching…' : 'Switch workspace')}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {!subscription && signedIn && (
            <section id="account-connections" className="om-settings-section" aria-label={t('Connected applications')}>
              <div className="om-settings-row">
                <div>
                  <h2 className="om-subtitle">{t('Connected applications')}</h2>
                  <p className="om-muted">{t('External MCP agents (such as Codex or Claude Code) authorized to connect to your OpenDesign Workbench. Revoking an app immediately invalidates all of its access and refresh tokens.')}</p>
                </div>
                <Tooltip label={t('Refresh connections')} wrap>
                  <IconButton
                    variant="ghost"
                    className="motion-icon-button"
                    aria-label={t('Refresh connections')}
                    onClick={() => void loadConnections()}
                    icon={<RemixIcon name="refresh-line" size={17} />}
                  />
                </Tooltip>
              </div>
              <div className="om-card om-card-stack">
                {!connections || connections.length === 0 ? (
                  <p className="om-muted">{t('No connected applications yet.')}</p>
                ) : (
                  connections.map(conn => (
                    <div className="om-preference-row" key={conn.clientId}>
                      <div>
                        <strong>{conn.clientName}</strong>
                        <p className="om-muted">
                          {conn.redirectHost} · {t('Authorized')}: {formatDate(conn.firstAuthorizedAt)} · {t('Last used')}: {formatDate(conn.lastUsedAt)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="om-button h-auto"
                        disabled={revokingClientId === conn.clientId}
                        onClick={() => void revokeConnection(conn.clientId)}
                      >
                        {t(revokingClientId === conn.clientId ? 'Revoking…' : 'Revoke')}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          {!subscription && signedIn && (
            <section id="account-tokens" className="om-settings-section" aria-label={t('Personal access tokens')}>
              <div className="om-settings-row">
                <div>
                  <h2 className="om-subtitle">{t('Personal access tokens')}</h2>
                  <p className="om-muted">{t('Use a Bearer token to connect external MCP Agents over Streamable HTTP (/mcp) when OAuth 2.1 is unavailable.')}</p>
                </div>
                <Tooltip label={t('Refresh tokens')} wrap>
                  <IconButton
                    variant="ghost"
                    className="motion-icon-button"
                    aria-label={t('Refresh tokens')}
                    onClick={() => void loadTokens()}
                    icon={<RemixIcon name="refresh-line" size={17} />}
                  />
                </Tooltip>
              </div>

              {createdToken && (
                <div className="om-card om-card-stack" role="status" data-pat-created="true">
                  <div className="om-settings-row">
                    <strong>{t('Copy your new token now')} · {createdToken.name}</strong>
                    <div className="om-settings-actions">
                      <Button variant="ghost" className="om-button h-auto" data-primary onClick={() => void copyCreatedToken()}>
                        <RemixIcon name="file-copy-line" size={15} />{t('Copy token')}
                      </Button>
                      <IconButton
                        variant="ghost"
                        className="motion-icon-button"
                        aria-label={t('Dismiss')}
                        onClick={() => setCreatedToken(null)}
                        icon={<RemixIcon name="close-line" size={16} />}
                      />
                    </div>
                  </div>
                  <p className="om-muted">{t('For security, this token is shown once and cannot be retrieved later.')}</p>
                  <code className="om-inset">{createdToken.token}</code>
                </div>
              )}

              <form className="om-card om-card-stack" onSubmit={event => void createToken(event)}>
                <div className="om-settings-row">
                  <label className="om-label" style={{ flex: 1 }}>
                    {t('Token name')}
                    <span className="om-field">
                      <input
                        type="text"
                        value={tokenName}
                        onChange={event => setTokenName(event.target.value)}
                        placeholder={t('e.g. Cursor laptop or CI runner')}
                        aria-label={t('Token name')}
                        maxLength={80}
                      />
                    </span>
                  </label>
                  <div className="om-label">
                    {t('Expiration')}
                    <Select
                      label={t('Expiration')}
                      value={tokenExpiryDays}
                      onCommit={setTokenExpiryDays}
                      options={[
                        { value: '30', label: t('30 days') },
                        { value: '90', label: t('90 days') },
                        { value: '365', label: t('1 year') },
                        { value: 'never', label: t('No expiration') },
                      ]}
                    />
                  </div>
                </div>
                <div className="om-settings-row">
                  <span className="om-muted">{t('Scopes')}: {DEFAULT_PAT_SCOPES.join(', ')}</span>
                  <Button variant="ghost" className="om-button h-auto" data-primary type="submit" disabled={creatingToken || !tokenName.trim()}>
                    <RemixIcon name="lock-line" size={15} />
                    {t(creatingToken ? 'Creating token…' : 'Create token')}
                  </Button>
                </div>
              </form>

              <div className="om-card om-card-stack">
                {tokensError ? (
                  <p className="om-muted">{t('Could not load personal access tokens.')}</p>
                ) : tokens === null ? (
                  <p className="om-muted">{t('Loading tokens…')}</p>
                ) : activeTokens.length === 0 ? (
                  <p className="om-muted">{t('No active personal access tokens yet.')}</p>
                ) : (
                  activeTokens.map(item => (
                    <div className="om-preference-row" key={item.id}>
                      <div>
                        <strong>{item.name}</strong>
                        <p className="om-muted">
                          <code>{item.tokenPrefix}…</code> · {t('Created')} {formatDate(item.createdAt)} · {t('Expires')} {item.expiresAt ? formatDate(item.expiresAt) : t('Never')}
                          {item.lastUsedAt ? ` · ${t('Last used')} ${formatDate(item.lastUsedAt)}` : ''}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="om-button h-auto"
                        disabled={revokingId === item.id}
                        onClick={() => void revokeToken(item.id)}
                      >
                        {t(revokingId === item.id ? 'Revoking…' : 'Revoke')}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          {upgradeGuide && (
            <section className="om-card om-plan-guide" data-guide="upgrade">
              <div className="om-plan-guide-head">
                <h2 className="om-title om-plan-name">{plan === 'free' ? t('Free plan') : 'Go'}</h2>
                <span className="om-badge">{t('Current plan')}</span>
              </div>
              <p className="om-muted">{t('Upgrade to Plus to generate images, video, voiceovers and music. Pro and Max include them too.')}</p>
              {capabilities}
              {offerNote}
              <div className="om-settings-actions">
                <a className="om-button" data-primary {...subscriptionLink('openmotion_manage_subscription', 'view_plans')}>
                  <RemixIcon name="sparkling-line" size={16} />{t('Upgrade to Plus')}<RemixIcon name="external-link-line" size={15} />
                </a>
                <a className="om-button" {...subscriptionLink('openmotion_manage_subscription', 'manage_subscription')}>
                  {t('Manage subscription')}<RemixIcon name="external-link-line" size={15} />
                </a>
              </div>
            </section>
          )}

          <section className="om-settings-section">
            <div className="om-settings-row">
              <h2 className="om-subtitle">{t('Subscription & usage')}</h2>
              {signedIn && (
                <Tooltip label={t('Refresh account')} wrap>
                  <IconButton
                    variant="ghost"
                    className="motion-icon-button"
                    aria-label={t('Refresh account')}
                    disabled={refreshing}
                    aria-busy={refreshing}
                    onClick={() => void refreshBilling()}
                    icon={<RemixIcon name={refreshing ? 'loader-4-line' : 'refresh-line'} size={17} className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />}
                  />
                </Tooltip>
              )}
            </div>
            {!(signedIn && account.billingUnavailable) && (
              <div className="om-account-metrics">
                <div className="om-card">
                  <span className="om-muted">{t('Current plan')}</span>
                  <h3 className="om-title">{signedIn && account.plan ? account.plan === 'free' ? t('Free plan') : account.plan : '—'}</h3>
                  <p className="om-muted">{t(signedIn ? 'Managed by OpenDesign' : 'Sign in to view your plan')}</p>
                </div>
                <div className="om-card">
                  <span className="om-muted">{t('Available balance')}</span>
                  <h3 className="om-title">{signedIn && account.balance != null ? `$${account.balance}` : '—'}</h3>
                  <p className="om-muted">{t(signedIn ? 'Account credits in USD' : 'Sign in to view usage')}</p>
                </div>
              </div>
            )}
            {signedIn && account.billingUnavailable && (
              <div className="om-settings-row">
                <p className="om-muted">
                  {t(account.billingError?.status === 403
                    ? 'The billing service declined this request. Open Manage subscription to check your plan in OpenDesign.'
                    : "Couldn't load your plan and balance. Account models are unaffected and can be used as usual.")}
                </p>
                <Button variant="ghost" className="om-button h-auto" disabled={refreshing} aria-busy={refreshing} onClick={() => void refreshBilling()}>
                  <RemixIcon name={refreshing ? 'loader-4-line' : 'refresh-line'} size={15} className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />
                  {t('Refresh')}
                </Button>
              </div>
            )}
            {signedIn && !upgradeGuide && (
              <a className="om-button" {...subscriptionLink('openmotion_manage_subscription', 'manage_subscription')}>
                {t('Manage subscription')}<RemixIcon name="external-link-line" size={15} />
              </a>
            )}
          </section>

          <section className="om-card om-settings-row">
            <div>
              <h2 className="om-subtitle">{t('Unified model gateway')}</h2>
              <p className="om-muted">{t('All image, video, speech and music generation routes through the OpenDesign platform gateway. No third-party API keys are required.')}</p>
            </div>
            <Button variant="ghost" className="om-button h-auto" onClick={openProviders}>
              {t('Model gateway')}<RemixIcon name="arrow-right-line" size={15} />
            </Button>
          </section>
        </>
      )}
      <StudioToastViewport {...toast} />
    </div>
  );
}
