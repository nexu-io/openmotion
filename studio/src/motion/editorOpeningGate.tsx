import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "open-design-ui/button";
import { useI18n } from "../i18n/I18n";

export const EDITOR_ASSET_ESCAPE_HATCH_MS = 4_000;
export const EDITOR_ASSET_AUTO_RELEASE_MS = 12_000;
const EXIT_FADE_MS = 200;

export interface EditorOpeningDelegation {
  owner: symbol;
  visible: boolean;
  onSkip: () => void;
  escapeDelayMs?: number;
  autoReleaseMs?: number;
}

interface EditorOpeningGateController {
  setDelegation: (next: EditorOpeningDelegation) => void;
  clearDelegation: (owner: symbol) => void;
  enterSuspense: () => () => void;
}

const EditorOpeningGateContext = createContext<EditorOpeningGateController | null>(null);

export function useEditorOpeningGate(): EditorOpeningGateController | null {
  return useContext(EditorOpeningGateContext);
}

/**
 * Render-nothing Suspense fallback used inside `MotionApp` so the single host
 * opening cover remains continuously mounted while the lazy editor chunk loads.
 */
export function SuspenseOpeningGateMarker() {
  const gate = useEditorOpeningGate();
  useLayoutEffect(() => {
    if (!gate) return;
    return gate.enterSuspense();
  }, [gate]);
  return null;
}

export interface UnifiedEditorOpeningCoverProps {
  visible: boolean;
  onSkip?: () => void;
  escapeDelayMs?: number;
  autoReleaseMs?: number;
  /** Fade out over 200ms after real editor readiness releases; unmount immediately on error or non-editor routes. */
  fadeOnExit?: boolean;
}

/**
 * Single seamless solid full-cover opening screen shared across shell project
 * resolution, lazy editor chunk loading, and the project file tree.
 */
export function UnifiedEditorOpeningCover({
  visible,
  onSkip,
  escapeDelayMs = EDITOR_ASSET_ESCAPE_HATCH_MS,
  autoReleaseMs = EDITOR_ASSET_AUTO_RELEASE_MS,
  fadeOnExit = true,
}: UnifiedEditorOpeningCoverProps) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(visible);
  const [escapeReady, setEscapeReady] = useState(false);
  const visibleSinceRef = useRef<number>(visible ? Date.now() : 0);
  const onSkipRef = useRef(onSkip);
  onSkipRef.current = onSkip;

  if (visible && !mounted) {
    setMounted(true);
  } else if (!visible && !fadeOnExit && mounted) {
    setMounted(false);
  }

  useEffect(() => {
    if (!visible) {
      visibleSinceRef.current = 0;
      setEscapeReady(false);
      if (!fadeOnExit) {
        setMounted(false);
        return;
      }
      const unmountTimer = setTimeout(() => setMounted(false), EXIT_FADE_MS);
      return () => clearTimeout(unmountTimer);
    }

    setMounted(true);
    if (visibleSinceRef.current === 0) {
      visibleSinceRef.current = Date.now();
    }
    const elapsed = Math.max(0, Date.now() - visibleSinceRef.current);
    const remainingEscape = Math.max(0, escapeDelayMs - elapsed);
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;
    if (remainingEscape === 0) {
      setEscapeReady(true);
    } else {
      setEscapeReady(false);
      escapeTimer = setTimeout(() => setEscapeReady(true), remainingEscape);
    }

    let autoReleaseTimer: ReturnType<typeof setTimeout> | undefined;
    if (autoReleaseMs > 0 && onSkip) {
      const remainingRelease = Math.max(0, autoReleaseMs - elapsed);
      autoReleaseTimer = setTimeout(() => onSkipRef.current?.(), remainingRelease);
    }

    return () => {
      if (escapeTimer) clearTimeout(escapeTimer);
      if (autoReleaseTimer) clearTimeout(autoReleaseTimer);
    };
  }, [autoReleaseMs, escapeDelayMs, fadeOnExit, onSkip, visible]);

  if (!mounted || (!visible && !fadeOnExit)) return null;

  return (
    <div
      className="motion-editor-cover motion-loading"
      data-visible={visible ? "true" : "false"}
      data-testid="editor-asset-loading-overlay"
      role="status"
      aria-live="polite"
      aria-busy={visible || undefined}
      onDragStart={(event) => event.preventDefault()}
    >
      <div className="motion-editor-cover-inner">
        <span className="motion-editor-cover-mark motion-loading-mark" aria-hidden="true" />
        <p className="motion-editor-cover-label motion-loading-label">
          {t("Opening project…")}
        </p>
        {visible && escapeReady && onSkip && (
          <div className="motion-editor-cover-escape">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              data-testid="editor-asset-loading-skip"
              onClick={onSkip}
            >
              {t("Enter editor now")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Owns one unbroken opening cover inside `.motion-project-surface` across
 * shell route resolution -> Suspense lazy chunk -> StudioApp readiness.
 */
export function EditorOpeningGateHost({
  shellLoading,
  suppressed,
  targetProjectId,
  children,
}: {
  shellLoading: boolean;
  suppressed: boolean;
  targetProjectId: string | null;
  children: ReactNode;
}) {
  const [suspenseCount, setSuspenseCount] = useState(0);
  const [delegation, setDelegationState] = useState<EditorOpeningDelegation | null>(null);
  const [hadEditorDelegation, setHadEditorDelegation] = useState(false);

  // Hold the cover across the single synchronous commit when `targetProjectId` resolves
  // so child `useLayoutEffect` (Suspense marker or EditorAssetLoadingOverlay) hands over
  // before the cover can unmount; cleared in passive `useEffect` if nothing claims it.
  const [handoverProjectId, setHandoverProjectId] = useState<string | null>(null);
  const [prevProjectId, setPrevProjectId] = useState<string | null>(targetProjectId);
  if (targetProjectId !== prevProjectId) {
    setPrevProjectId(targetProjectId);
    setHandoverProjectId(targetProjectId);
    if (targetProjectId === null) {
      setHadEditorDelegation(false);
    }
  }
  useEffect(() => {
    if (handoverProjectId !== null) setHandoverProjectId(null);
  }, [handoverProjectId]);

  const setDelegation = useCallback((next: EditorOpeningDelegation) => {
    setHadEditorDelegation(true);
    setDelegationState((prev) => {
      if (
        prev &&
        prev.owner === next.owner &&
        prev.visible === next.visible &&
        prev.onSkip === next.onSkip &&
        prev.escapeDelayMs === next.escapeDelayMs &&
        prev.autoReleaseMs === next.autoReleaseMs
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const clearDelegation = useCallback((owner: symbol) => {
    setDelegationState((prev) => (prev?.owner === owner ? null : prev));
  }, []);

  const enterSuspense = useCallback(() => {
    setSuspenseCount((count) => count + 1);
    return () => {
      setSuspenseCount((count) => Math.max(0, count - 1));
    };
  }, []);

  const controller = useMemo<EditorOpeningGateController>(
    () => ({ setDelegation, clearDelegation, enterSuspense }),
    [clearDelegation, enterSuspense, setDelegation],
  );

  const visible =
    !suppressed &&
    (shellLoading ||
      handoverProjectId !== null ||
      suspenseCount > 0 ||
      Boolean(delegation?.visible));
  const fadeOnExit = !suppressed && hadEditorDelegation;

  return (
    <EditorOpeningGateContext.Provider value={controller}>
      {children}
      <UnifiedEditorOpeningCover
        visible={visible}
        onSkip={delegation?.onSkip}
        escapeDelayMs={delegation?.escapeDelayMs}
        autoReleaseMs={delegation?.autoReleaseMs}
        fadeOnExit={fadeOnExit}
      />
    </EditorOpeningGateContext.Provider>
  );
}
