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
  findPriorityAnnouncementMessage,
  localizeWhatsNewContent,
  type MessageCenterMessage,
  type ProductionTouchpointDecision,
  type ProductionTouchpointResponse,
  type TouchpointEventType,
  type TouchpointPlacementKey,
  type WhatsNewResponse,
} from '../../../../shared/growth-surfaces';
import { normalizeFeedbackText } from '../../../../shared/social-share';
import { useI18n } from '../../i18n/I18n';
import { openExternalUrl } from '../../utils/platformHost';
import { gatewayRequest } from '../gatewayClient';
import * as motionTracking from '../tracking';

function safeTrackingExport<K extends keyof typeof motionTracking>(
  name: K,
): (typeof motionTracking)[K] | undefined {
  try {
    const value = motionTracking[name];
    return typeof value === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';
import { ARTIFACT_DELIVERED_EVENT, type ArtifactDeliveredDetail } from './artifactDeliveryBus';
import {
  EXPERIENCE_SURVEY_DELAY_MS,
  EXPERIENCE_SURVEY_MIN_DELIVERIES,
  EXPERIENCE_SURVEY_THANK_YOU_CLOSE_MS,
  incrementSurveyDeliveries,
  isSurveyRetired,
  mapArtifactKindToSurveyTrigger,
  retireSurvey,
  type ExperienceSurveyImprovement,
  type ExperienceSurveyTrigger,
} from './experienceSurveyState';
import {
  clearAnonymousReadIds,
  fetchMessageCenterFeed,
  markAllMessageCenterRead,
  markMessageCenterRead,
  readAnonymousReadIds,
  readArchivedMessageIds,
  writeAnonymousReadIds,
  writeArchivedMessageIds,
} from './messageCenterClient';

const MESSAGE_POLL_INTERVAL_MS = 60_000;
const TOUCHPOINT_LIVE_POLL_MS = 5 * 60 * 1000;
const TOUCHPOINT_OFFLINE_REPLAY_POLL_MS = 2 * 60 * 1000;
const TOUCHPOINT_SEEN_KEY = 'openmotion.touchpoint.seen.v1';
const WHATS_NEW_SEEN_KEY = 'openmotion.whats-new.last-seen-id.v1';
const STORAGE_UNAVAILABLE_SENTINEL = '__storage_unavailable__';

export type WhatsNewCardModel = {
  id: string;
  version: string;
  title: string;
  notes: string[];
  imageUrl: string | null;
  linkUrl: string | null;
  ctaLabel: string | null;
};

export type SupportErrorContext = {
  summary?: string;
  detail?: string;
  source?: string;
};

export type GrowthSurfacesContextValue = {
  // Message center
  messages: MessageCenterMessage[];
  archivedIds: Set<string>;
  unreadCount: number;
  messagesLoading: boolean;
  messagesError: boolean;
  messageCenterOpen: boolean;
  setMessageCenterOpen: (open: boolean) => void;
  refreshMessages: () => Promise<void>;
  markMessageRead: (messageId: string) => Promise<void>;
  markAllMessagesRead: () => Promise<void>;
  toggleArchiveMessage: (messageId: string) => void;
  // Priority announcement (slot 3)
  priorityMessage: MessageCenterMessage | null;
  priorityAnnouncementOpen: boolean;
  // Production touchpoints (slot 4)
  badgeDecision: ProductionTouchpointDecision | null;
  modalDecision: ProductionTouchpointDecision | null;
  touchpointOfflineReplay: boolean;
  campaignModalOpen: boolean;
  openCampaignModal: () => void;
  closeCampaignModal: (reason?: 'dismiss' | 'action') => void;
  reportTouchpointEvent: (
    decision: ProductionTouchpointDecision,
    eventType: TouchpointEventType,
    actionId?: string,
  ) => void;
  navigateInternalAction: (internalPath: string) => void;
  useCampaignModelAction: (modelId: string, modelLabel: string | null) => void;
  // Release highlights (slot 5)
  whatsNewCard: WhatsNewCardModel | null;
  whatsNewOpen: boolean;
  dismissWhatsNew: () => void;
  openWhatsNewLink: () => void;
  // Support dialog (Phase C)
  supportDialogOpen: boolean;
  supportContext: SupportErrorContext | null;
  openSupportDialog: (context?: SupportErrorContext) => void;
  closeSupportDialog: () => void;
  // Post-delivery NPS experience survey (Phase C)
  surveyOpen: boolean;
  surveySubmitted: boolean;
  surveyTrigger: ExperienceSurveyTrigger;
  submitSurvey: (score: number, improvement?: ExperienceSurveyImprovement, note?: string) => void;
  dismissSurvey: () => void;
};

const GrowthSurfacesContext = createContext<GrowthSurfacesContextValue | null>(null);

function readSeenCampaignIds(): Set<string> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(TOUCHPOINT_SEEN_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
  } catch {
    return null;
  }
}

function markCampaignActivitySeen(activityId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = readSeenCampaignIds() ?? new Set<string>();
    existing.add(activityId);
    const bounded = [...existing].slice(-40);
    window.localStorage.setItem(TOUCHPOINT_SEEN_KEY, JSON.stringify(bounded));
  } catch {
    // Advisory frequency cap only.
  }
}

function readLastSeenWhatsNewId(): string | null {
  if (typeof window === 'undefined') return STORAGE_UNAVAILABLE_SENTINEL;
  try {
    return window.localStorage.getItem(WHATS_NEW_SEEN_KEY);
  } catch {
    return STORAGE_UNAVAILABLE_SENTINEL;
  }
}

function writeLastSeenWhatsNewId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, id);
  } catch {
    // Non-fatal in private browsing.
  }
}

function isDecisionActive(decision: ProductionTouchpointDecision | null): boolean {
  if (!decision) return false;
  const endsMs = Date.parse(decision.endsAt);
  if (!Number.isFinite(endsMs) || endsMs <= Date.now()) return false;
  if (decision.authorizationExpiresAt) {
    const authMs = Date.parse(decision.authorizationExpiresAt);
    if (Number.isFinite(authMs) && authMs <= Date.now()) return false;
  }
  return true;
}

export function GrowthSurfacesProvider({
  children,
  isHomeSurface = false,
  higherModalOpen = false,
  surveyDelayMs = EXPERIENCE_SURVEY_DELAY_MS,
  onNavigateInternal,
  onUseCampaignModel,
}: {
  children: ReactNode;
  isHomeSurface?: boolean;
  higherModalOpen?: boolean;
  surveyDelayMs?: number;
  onNavigateInternal?: (internalPath: string) => void;
  onUseCampaignModel?: (modelId: string, modelLabel: string | null) => void;
}) {
  const { locale } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const signedIn = Boolean(collab?.snapshot?.signedIn);

  // --- Message Center State ---
  const [messages, setMessages] = useState<MessageCenterMessage[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => readArchivedMessageIds());
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(false);
  const [messageCenterOpen, setMessageCenterOpen] = useState(false);

  const messagesRef = useRef<MessageCenterMessage[]>([]);
  messagesRef.current = messages;
  const archivedIdsRef = useRef<Set<string>>(archivedIds);
  archivedIdsRef.current = archivedIds;
  const pendingReadIdsRef = useRef<Set<string>>(new Set());
  const messageSyncSeqRef = useRef(0);

  // --- Production Touchpoints State ---
  const [badgeDecision, setBadgeDecision] = useState<ProductionTouchpointDecision | null>(null);
  const [modalDecision, setModalDecision] = useState<ProductionTouchpointDecision | null>(null);
  const [touchpointOfflineReplay, setTouchpointOfflineReplay] = useState(false);
  const [manualCampaignOpen, setManualCampaignOpen] = useState(false);
  const [autoCampaignOpen, setAutoCampaignOpen] = useState(false);
  const touchpointSyncSeqRef = useRef(0);
  const impressionSentRef = useRef<Set<string>>(new Set());
  const badgeDecisionRef = useRef<ProductionTouchpointDecision | null>(null);
  badgeDecisionRef.current = badgeDecision;
  const modalDecisionRef = useRef<ProductionTouchpointDecision | null>(null);
  modalDecisionRef.current = modalDecision;

  // --- What's New State ---
  const [whatsNewRaw, setWhatsNewRaw] = useState<WhatsNewResponse | null>(null);
  const whatsNewDecisionRef = useRef(false);

  // --- Support Dialog & Post-Delivery NPS Survey State ---
  const [supportDialogOpen, setSupportDialogOpen] = useState(false);
  const [supportContext, setSupportContext] = useState<SupportErrorContext | null>(null);
  const [surveyArmed, setSurveyArmed] = useState(false);
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [surveySubmitted, setSurveySubmitted] = useState(false);
  const [surveyTrigger, setSurveyTrigger] = useState<ExperienceSurveyTrigger>('post_generation');
  const surveyShownRef = useRef(false);
  const surveyDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surveyCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshMessages = useCallback(async () => {
    const seq = ++messageSyncSeqRef.current;
    if (messagesRef.current.length === 0) {
      setMessagesLoading(true);
    }
    try {
      const feed = await fetchMessageCenterFeed(locale);
      if (seq !== messageSyncSeqRef.current) return;

      const serverReadIds = new Set(feed.messages.filter(m => m.readAt != null).map(m => m.id));
      if (feed.signedIn) {
        pendingReadIdsRef.current = new Set(
          [...pendingReadIdsRef.current].filter(id => !serverReadIds.has(id)),
        );
        clearAnonymousReadIds();
      }
      const anonymousReadIds = feed.signedIn ? new Set<string>() : readAnonymousReadIds();
      const overlayRead = new Set([
        ...serverReadIds,
        ...(feed.signedIn ? pendingReadIdsRef.current : anonymousReadIds),
      ]);

      const merged = feed.messages.map(item => ({
        ...item,
        readAt: item.readAt ?? (overlayRead.has(item.id) ? new Date().toISOString() : null),
      }));

      setMessages(merged);
      setMessagesError(false);

      if (archivedIdsRef.current.size > 0 && merged.length > 0) {
        const liveIds = new Set(merged.map(m => m.id));
        const pruned = new Set([...archivedIdsRef.current].filter(id => liveIds.has(id)));
        if (pruned.size !== archivedIdsRef.current.size) {
          setArchivedIds(pruned);
          writeArchivedMessageIds(pruned);
        }
      }
    } catch {
      if (seq !== messageSyncSeqRef.current) return;
      setMessagesError(true);
    } finally {
      if (seq === messageSyncSeqRef.current) {
        setMessagesLoading(false);
      }
    }
  }, [locale]);

  useEffect(() => {
    pendingReadIdsRef.current.clear();
    void refreshMessages();
    const timer = window.setInterval(() => {
      void refreshMessages();
    }, MESSAGE_POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshMessages();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshMessages, signedIn]);

  useEffect(() => {
    if (messageCenterOpen) {
      void refreshMessages();
    }
  }, [messageCenterOpen, refreshMessages]);

  const markMessageRead = useCallback(
    async (messageId: string) => {
      const target = messagesRef.current.find(m => m.id === messageId);
      if (!target || target.readAt != null) return;
      const stamped = new Date().toISOString();
      pendingReadIdsRef.current.add(messageId);
      setMessages(prev => prev.map(item => (item.id === messageId ? { ...item, readAt: stamped } : item)));

      if (!signedIn) {
        const anon = readAnonymousReadIds();
        anon.add(messageId);
        writeAnonymousReadIds(anon);
        return;
      }

      try {
        await markMessageCenterRead(messageId);
      } catch (error) {
        pendingReadIdsRef.current.delete(messageId);
        setMessages(prev => prev.map(item => (item.id === messageId ? { ...item, readAt: null } : item)));
        throw error;
      }
    },
    [signedIn],
  );

  const markAllMessagesRead = useCallback(async () => {
    const unreadIds = messagesRef.current
      .filter(item => !archivedIdsRef.current.has(item.id) && item.readAt == null)
      .map(item => item.id);
    if (!unreadIds.length) return;
    const stamped = new Date().toISOString();
    for (const id of unreadIds) pendingReadIdsRef.current.add(id);
    const unreadSet = new Set(unreadIds);
    setMessages(prev =>
      prev.map(item => (unreadSet.has(item.id) ? { ...item, readAt: stamped } : item)),
    );

    if (!signedIn) {
      const anon = readAnonymousReadIds();
      for (const id of unreadIds) anon.add(id);
      writeAnonymousReadIds(anon);
      return;
    }

    try {
      await markAllMessageCenterRead();
    } catch {
      for (const id of unreadIds) pendingReadIdsRef.current.delete(id);
      void refreshMessages();
    }
  }, [refreshMessages, signedIn]);

  const toggleArchiveMessage = useCallback((messageId: string) => {
    setArchivedIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      writeArchivedMessageIds(next);
      return next;
    });
  }, []);

  const unreadCount = useMemo(
    () => messages.filter(item => !archivedIds.has(item.id) && item.readAt == null).length,
    [archivedIds, messages],
  );

  const priorityMessage = useMemo(
    () => (signedIn ? findPriorityAnnouncementMessage(messages) : null),
    [messages, signedIn],
  );

  const reportTouchpointEvent = useCallback(
    (decision: ProductionTouchpointDecision, eventType: TouchpointEventType, actionId?: string) => {
      if (!signedIn) return;
      void gatewayRequest<{ ok: boolean }>('touchpoints/events', 'POST', {
        activityId: decision.activityId,
        touchpointDecisionId: decision.touchpointDecisionId,
        ...(decision.deploymentId ? { deploymentId: decision.deploymentId } : {}),
        placementKey: decision.placementKey,
        eventType,
        locale,
        ...(actionId ? { actionId } : {}),
      }).catch(() => {});
    },
    [locale, signedIn],
  );

  const loadPlacement = useCallback(
    async (
      placementKey: TouchpointPlacementKey,
      activeDecisionId?: string,
    ): Promise<ProductionTouchpointResponse | null> => {
      const params = new URLSearchParams({ placementKey, locale });
      if (activeDecisionId) params.set('activeDecisionId', activeDecisionId);
      try {
        return await gatewayRequest<ProductionTouchpointResponse>(`touchpoints/production?${params.toString()}`);
      } catch {
        return null;
      }
    },
    [locale],
  );

  const refreshTouchpoints = useCallback(async () => {
    if (!signedIn) {
      setBadgeDecision(null);
      setModalDecision(null);
      setTouchpointOfflineReplay(false);
      setManualCampaignOpen(false);
      setAutoCampaignOpen(false);
      return;
    }

    const seq = ++touchpointSyncSeqRef.current;
    const [badgeRes, modalRes] = await Promise.all([
      loadPlacement('opend.home.account-badge', badgeDecisionRef.current?.touchpointDecisionId),
      loadPlacement('opend.home.campaign-modal', modalDecisionRef.current?.touchpointDecisionId),
    ]);
    if (seq !== touchpointSyncSeqRef.current) return;

    if (badgeRes) {
      const nextBadge =
        badgeRes.status === 'active' && isDecisionActive(badgeRes.decision) ? badgeRes.decision : null;
      setBadgeDecision(nextBadge);
    }

    let nextReplay = Boolean(badgeRes?.offlineReplay || modalRes?.offlineReplay);
    if (modalRes) {
      const nextModal =
        modalRes.status === 'active' && isDecisionActive(modalRes.decision) ? modalRes.decision : null;
      setModalDecision(nextModal);
      if (!nextModal) {
        setAutoCampaignOpen(false);
        setManualCampaignOpen(false);
      }
    } else if (!badgeRes) {
      nextReplay = false;
    }
    setTouchpointOfflineReplay(nextReplay);
  }, [loadPlacement, signedIn]);

  useEffect(() => {
    void refreshTouchpoints();
    if (!signedIn) return;
    const intervalMs = touchpointOfflineReplay ? TOUCHPOINT_OFFLINE_REPLAY_POLL_MS : TOUCHPOINT_LIVE_POLL_MS;
    const timer = window.setInterval(() => {
      void refreshTouchpoints();
    }, intervalMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshTouchpoints();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshTouchpoints, signedIn, touchpointOfflineReplay]);

  // Expire active decisions accurately at endsAt without requiring a page reload.
  useEffect(() => {
    const candidates = [badgeDecision, modalDecision].filter((item): item is ProductionTouchpointDecision =>
      Boolean(item),
    );
    if (!candidates.length) return;
    const earliestExpiry = Math.min(
      ...candidates
        .map(d => Date.parse(d.endsAt))
        .filter(ms => Number.isFinite(ms)),
    );
    if (!Number.isFinite(earliestExpiry)) return;
    const delayMs = Math.max(0, Math.min(2_147_000_000, earliestExpiry - Date.now() + 250));
    const timer = window.setTimeout(() => {
      if (!isDecisionActive(badgeDecisionRef.current)) setBadgeDecision(null);
      if (!isDecisionActive(modalDecisionRef.current)) {
        setModalDecision(null);
        setAutoCampaignOpen(false);
        setManualCampaignOpen(false);
      }
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [badgeDecision, modalDecision]);

  // Impression telemetry for active badge.
  useEffect(() => {
    if (!signedIn || !badgeDecision) return;
    const key = `${badgeDecision.placementKey}:${badgeDecision.touchpointDecisionId}`;
    if (impressionSentRef.current.has(key)) return;
    impressionSentRef.current.add(key);
    reportTouchpointEvent(badgeDecision, 'impression');
  }, [badgeDecision, reportTouchpointEvent, signedIn]);

  // --- Slot Arbitration ---
  const priorityAnnouncementOpen = Boolean(
    isHomeSurface && !higherModalOpen && !supportDialogOpen && signedIn && priorityMessage,
  );

  // Auto-open campaign modal at most once per activityId on Home when no higher priority dialog occupies the slot.
  useEffect(() => {
    if (!signedIn || !isHomeSurface || higherModalOpen || supportDialogOpen || priorityAnnouncementOpen) return;
    if (!modalDecision || !isDecisionActive(modalDecision)) return;
    const seen = readSeenCampaignIds();
    if (!seen || seen.has(modalDecision.activityId)) return;
    markCampaignActivitySeen(modalDecision.activityId);
    setAutoCampaignOpen(true);
  }, [higherModalOpen, isHomeSurface, modalDecision, priorityAnnouncementOpen, signedIn, supportDialogOpen]);

  const campaignModalOpen = Boolean(
    signedIn &&
      modalDecision &&
      isDecisionActive(modalDecision) &&
      (manualCampaignOpen ||
        (autoCampaignOpen && isHomeSurface && !higherModalOpen && !supportDialogOpen && !priorityAnnouncementOpen)),
  );

  const openCampaignModal = useCallback(() => {
    const active = modalDecisionRef.current ?? badgeDecisionRef.current;
    if (active) {
      reportTouchpointEvent(active, 'click');
      markCampaignActivitySeen(active.activityId);
      if (!modalDecisionRef.current && badgeDecisionRef.current) {
        setModalDecision(badgeDecisionRef.current);
      }
    }
    setManualCampaignOpen(true);
  }, [reportTouchpointEvent]);

  const closeCampaignModal = useCallback(
    (reason: 'dismiss' | 'action' = 'dismiss') => {
      if (reason === 'dismiss' && modalDecisionRef.current) {
        reportTouchpointEvent(modalDecisionRef.current, 'dismiss');
      }
      setManualCampaignOpen(false);
      setAutoCampaignOpen(false);
    },
    [reportTouchpointEvent],
  );

  const navigateInternalAction = useCallback(
    (internalPath: string) => {
      onNavigateInternal?.(internalPath);
    },
    [onNavigateInternal],
  );

  const useCampaignModelAction = useCallback(
    (modelId: string, modelLabel: string | null) => {
      onUseCampaignModel?.(modelId, modelLabel);
    },
    [onUseCampaignModel],
  );

  // --- What's New Loader ---
  useEffect(() => {
    if (!isHomeSurface || whatsNewDecisionRef.current) return;
    let cancelled = false;
    void gatewayRequest<WhatsNewResponse>('whats-new')
      .then(info => {
        if (cancelled) return;
        whatsNewDecisionRef.current = true;
        if (!info.id || !info.content) {
          setWhatsNewRaw(null);
          return;
        }
        const lastSeen = readLastSeenWhatsNewId();
        if (lastSeen === STORAGE_UNAVAILABLE_SENTINEL || lastSeen === info.id) {
          setWhatsNewRaw(null);
          return;
        }
        setWhatsNewRaw(info);
      })
      .catch(() => {
        if (!cancelled) {
          whatsNewDecisionRef.current = true;
          setWhatsNewRaw(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isHomeSurface]);

  const whatsNewCard = useMemo<WhatsNewCardModel | null>(() => {
    if (!whatsNewRaw?.id || !whatsNewRaw.content) return null;
    const localized = localizeWhatsNewContent(whatsNewRaw.content, locale);
    return {
      id: whatsNewRaw.id,
      version: whatsNewRaw.version,
      title: localized.title,
      notes: localized.notes,
      imageUrl: whatsNewRaw.content.imageUrl ?? null,
      linkUrl: localized.linkUrl,
      ctaLabel: localized.ctaLabel,
    };
  }, [locale, whatsNewRaw]);

  const whatsNewOpen = Boolean(
    isHomeSurface && !higherModalOpen && !supportDialogOpen && !priorityAnnouncementOpen && !campaignModalOpen && whatsNewCard,
  );

  const dismissWhatsNew = useCallback(() => {
    if (whatsNewRaw?.id) {
      writeLastSeenWhatsNewId(whatsNewRaw.id);
    }
    setWhatsNewRaw(null);
  }, [whatsNewRaw]);

  const openWhatsNewLink = useCallback(() => {
    const link = whatsNewCard?.linkUrl;
    if (whatsNewRaw?.id) {
      writeLastSeenWhatsNewId(whatsNewRaw.id);
    }
    setWhatsNewRaw(null);
    if (link) {
      void openExternalUrl(link);
    }
  }, [whatsNewCard, whatsNewRaw]);

  // --- Support Dialog Controls ---
  const openSupportDialog = useCallback((context?: SupportErrorContext) => {
    setSupportContext(context ?? null);
    setSupportDialogOpen(true);
  }, []);

  const closeSupportDialog = useCallback(() => {
    setSupportDialogOpen(false);
  }, []);

  // --- Post-Delivery NPS Experience Survey Lifecycle ---
  const initTrackingSafe = useCallback(() => {
    return safeTrackingExport('initializeTracking')?.() ?? Promise.resolve();
  }, []);

  const isAppTrackingEnabled = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return false;
    return safeTrackingExport('getMotionTrackingStatus')?.().enabled ?? false;
  }, []);

  const emitSurveyTelemetry = useCallback(
    (payload: Parameters<typeof motionTracking.trackMotion<'experience_survey_event'>>[1]) => {
      const track = safeTrackingExport('trackMotion');
      if (!track) return;
      void Promise.resolve(track('experience_survey_event', payload)).then(() => {
        return safeTrackingExport('flushMotionTracking')?.();
      });
    },
    [],
  );

  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return;
    void initTrackingSafe();
  }, [initTrackingSafe]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    const handleDelivered = (event: Event) => {
      if (isSurveyRetired() || surveyShownRef.current) return;
      if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return;
      const custom = event as CustomEvent<ArtifactDeliveredDetail>;
      const trigger = mapArtifactKindToSurveyTrigger(custom.detail?.kind ?? 'media');
      void (async () => {
        await initTrackingSafe();
        if (cancelled || isSurveyRetired() || surveyShownRef.current) return;
        if (!isAppTrackingEnabled()) return;
        const deliveries = incrementSurveyDeliveries();
        if (deliveries < EXPERIENCE_SURVEY_MIN_DELIVERIES) return;
        setSurveyTrigger(trigger);
        if (surveyDelayTimerRef.current) clearTimeout(surveyDelayTimerRef.current);
        const delay = Math.max(0, surveyDelayMs);
        surveyDelayTimerRef.current = setTimeout(() => {
          surveyDelayTimerRef.current = null;
          if (cancelled || isSurveyRetired() || surveyShownRef.current) return;
          if (!isAppTrackingEnabled()) return;
          setSurveyArmed(true);
        }, delay);
      })();
    };
    window.addEventListener(ARTIFACT_DELIVERED_EVENT, handleDelivered);
    return () => {
      cancelled = true;
      window.removeEventListener(ARTIFACT_DELIVERED_EVENT, handleDelivered);
    };
  }, [initTrackingSafe, isAppTrackingEnabled, surveyDelayMs]);

  useEffect(() => {
    return () => {
      if (surveyDelayTimerRef.current) clearTimeout(surveyDelayTimerRef.current);
      if (surveyCloseTimerRef.current) clearTimeout(surveyCloseTimerRef.current);
    };
  }, []);

  const surveyBlocked = Boolean(
    higherModalOpen || supportDialogOpen || priorityAnnouncementOpen || campaignModalOpen || whatsNewOpen,
  );

  useEffect(() => {
    if (!surveyArmed || surveyShownRef.current || surveyBlocked) return;
    if (isSurveyRetired()) {
      setSurveyArmed(false);
      return;
    }
    if (!isAppTrackingEnabled()) {
      setSurveyArmed(false);
      return;
    }
    surveyShownRef.current = true;
    retireSurvey();
    setSurveyOpen(true);
    setSurveyArmed(false);
    emitSurveyTelemetry({ action: 'shown', trigger: surveyTrigger });
  }, [emitSurveyTelemetry, isAppTrackingEnabled, surveyArmed, surveyBlocked, surveyTrigger]);

  const submitSurvey = useCallback(
    (score: number, improvement?: ExperienceSurveyImprovement, note?: string) => {
      retireSurvey();
      setSurveySubmitted(true);
      const boundedScore = Math.max(0, Math.min(10, Math.round(score)));
      const feedbackText = normalizeFeedbackText(note ?? '');
      const payload: {
        action: 'submitted';
        trigger: ExperienceSurveyTrigger;
        score: number;
        improvement?: ExperienceSurveyImprovement;
        feedback_text?: string;
      } = {
        action: 'submitted',
        trigger: surveyTrigger,
        score: boundedScore,
      };
      if (improvement) payload.improvement = improvement;
      if (feedbackText) payload.feedback_text = feedbackText;
      emitSurveyTelemetry(payload);
      if (surveyCloseTimerRef.current) clearTimeout(surveyCloseTimerRef.current);
      surveyCloseTimerRef.current = setTimeout(() => {
        surveyCloseTimerRef.current = null;
        setSurveyOpen(false);
        setSurveySubmitted(false);
      }, EXPERIENCE_SURVEY_THANK_YOU_CLOSE_MS);
    },
    [emitSurveyTelemetry, surveyTrigger],
  );

  const dismissSurvey = useCallback(() => {
    retireSurvey();
    if (surveyCloseTimerRef.current) {
      clearTimeout(surveyCloseTimerRef.current);
      surveyCloseTimerRef.current = null;
    }
    const wasSubmitted = surveySubmitted;
    setSurveyOpen(false);
    setSurveySubmitted(false);
    if (!wasSubmitted) {
      emitSurveyTelemetry({ action: 'dismissed', trigger: surveyTrigger });
    }
  }, [emitSurveyTelemetry, surveySubmitted, surveyTrigger]);

  const effectiveSurveyOpen = Boolean(surveyOpen && !surveyBlocked);

  const value = useMemo<GrowthSurfacesContextValue>(
    () => ({
      messages,
      archivedIds,
      unreadCount,
      messagesLoading,
      messagesError,
      messageCenterOpen,
      setMessageCenterOpen,
      refreshMessages,
      markMessageRead,
      markAllMessagesRead,
      toggleArchiveMessage,
      priorityMessage,
      priorityAnnouncementOpen,
      badgeDecision,
      modalDecision,
      touchpointOfflineReplay,
      campaignModalOpen,
      openCampaignModal,
      closeCampaignModal,
      reportTouchpointEvent,
      navigateInternalAction,
      useCampaignModelAction,
      whatsNewCard,
      whatsNewOpen,
      dismissWhatsNew,
      openWhatsNewLink,
      supportDialogOpen,
      supportContext,
      openSupportDialog,
      closeSupportDialog,
      surveyOpen: effectiveSurveyOpen,
      surveySubmitted,
      surveyTrigger,
      submitSurvey,
      dismissSurvey,
    }),
    [
      archivedIds,
      badgeDecision,
      campaignModalOpen,
      closeCampaignModal,
      closeSupportDialog,
      dismissSurvey,
      dismissWhatsNew,
      effectiveSurveyOpen,
      markAllMessagesRead,
      markMessageRead,
      messageCenterOpen,
      messages,
      messagesError,
      messagesLoading,
      modalDecision,
      navigateInternalAction,
      openCampaignModal,
      openSupportDialog,
      openWhatsNewLink,
      priorityAnnouncementOpen,
      priorityMessage,
      refreshMessages,
      reportTouchpointEvent,
      submitSurvey,
      supportContext,
      supportDialogOpen,
      surveySubmitted,
      surveyTrigger,
      toggleArchiveMessage,
      touchpointOfflineReplay,
      unreadCount,
      useCampaignModelAction,
      whatsNewCard,
      whatsNewOpen,
    ],
  );

  return <GrowthSurfacesContext.Provider value={value}>{children}</GrowthSurfacesContext.Provider>;
}

export function useOptionalGrowthSurfaces(): GrowthSurfacesContextValue | null {
  return useContext(GrowthSurfacesContext);
}

export function useGrowthSurfaces(): GrowthSurfacesContextValue {
  const ctx = useContext(GrowthSurfacesContext);
  if (!ctx) throw new Error('useGrowthSurfaces must be used within GrowthSurfacesProvider');
  return ctx;
}
