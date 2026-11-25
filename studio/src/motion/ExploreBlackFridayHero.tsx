import { Button } from 'open-design-ui/button';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { useI18n } from '../i18n/I18n';
import cover01 from './corridor-covers/cover-01.webp?no-inline';
import cover02 from './corridor-covers/cover-02.webp?no-inline';
import cover03 from './corridor-covers/cover-03.webp?no-inline';
import cover04 from './corridor-covers/cover-04.avif?no-inline';
import cover05 from './corridor-covers/cover-05.webp?no-inline';
import cover06 from './corridor-covers/cover-06.avif?no-inline';
import cover07 from './corridor-covers/cover-07.webp?no-inline';
import cover08 from './corridor-covers/cover-08.avif?no-inline';
import cover09 from './corridor-covers/cover-09.webp?no-inline';
import cover10 from './corridor-covers/cover-10.avif?no-inline';
import cover11 from './corridor-covers/cover-11.avif?no-inline';
import cover12 from './corridor-covers/cover-12.avif?no-inline';
import cover13 from './corridor-covers/cover-13.webp?no-inline';
import cover14 from './corridor-covers/cover-14.avif?no-inline';
import cover15 from './corridor-covers/cover-15.avif?no-inline';
import cover16 from './corridor-covers/cover-16.webp?no-inline';
import cover17 from './corridor-covers/cover-17.avif?no-inline';
import cover18 from './corridor-covers/cover-18.avif?no-inline';
import cover19 from './corridor-covers/cover-19.webp?no-inline';
import cover20 from './corridor-covers/cover-20.avif?no-inline';
import cover21 from './corridor-covers/cover-21.webp?no-inline';
import cover22 from './corridor-covers/cover-22.avif?no-inline';
import cover23 from './corridor-covers/cover-23.avif?no-inline';
import cover24 from './corridor-covers/cover-24.avif?no-inline';
import cover25 from './corridor-covers/cover-25.avif?no-inline';
import cover26 from './corridor-covers/cover-26.avif?no-inline';
import cover27 from './corridor-covers/cover-27.avif?no-inline';
import cover28 from './corridor-covers/cover-28.avif?no-inline';
import cover29 from './corridor-covers/cover-29.avif?no-inline';
import cover30 from './corridor-covers/cover-30.avif?no-inline';
import cover31 from './corridor-covers/cover-31.webp?no-inline';
import cover32 from './corridor-covers/cover-32.webp?no-inline';
import cover34 from './corridor-covers/cover-34.webp?no-inline';
import cover35 from './corridor-covers/cover-35.avif?no-inline';
import cover36 from './corridor-covers/cover-36.webp?no-inline';
import styles from './ExploreBlackFridayHero.module.css';
import { MODEL_LOGO_ASSETS, type ModelLogoAsset } from './exploreModelLogos';
import {
  BLACK_FRIDAY_CAMPAIGN,
  blackFridayHeroActive,
  campaignPricingUrl,
  newCampaignEntryId,
  readBlackFridayCountdown,
} from './campaignAttribution';
import { trackMotion } from './tracking';

const RING_COUNT = 8;
const SIDE_ROWS = 3;
const BASE_CRUISE_SPEED = 56; // px/sec forward glide along +Z
const AUTO_COLLAPSE_DELAY_MS = 3200; // hold full-screen opening briefly, then glide to reveal Explore cards

// 36 unique cinematic video covers lining the 3D corridor walls (4 rings x 9 tiles = 36 -> zero visible duplicates)
const CORRIDOR_ARTWORKS = [
  cover01,
  cover02,
  cover03,
  cover04,
  cover05,
  cover06,
  cover07,
  cover08,
  cover09,
  cover10,
  cover11,
  cover12,
  cover13,
  cover14,
  cover15,
  cover16,
  cover17,
  cover18,
  cover19,
  cover20,
  cover21,
  cover22,
  cover23,
  cover24,
  cover25,
  cover26,
  cover27,
  cover28,
  cover29,
  cover30,
  cover31,
  cover32,
  null,
  cover34,
  cover35,
  cover36,
] as const;

type TileSpec = {
  id: string;
  src: string | null;
  logo?: ModelLogoAsset;
  rot?: number;
};

// Pick exactly `artCount` staggered slot indices out of `slotCount` so every wall has balanced rhythm
function pickArtSlots(slotCount: number, artCount: number, seed: number): Set<number> {
  const chosen = new Set<number>();
  const target = Math.min(slotCount, artCount);
  const start = Math.abs(seed) % slotCount;
  // Golden-ratio-like step coprime to 3, 4, 5, 6, 7 when scanning cyclically
  let cursor = start;
  let guard = 0;
  while (chosen.size < target && guard < slotCount * 4) {
    chosen.add(cursor % slotCount);
    cursor += slotCount === 4 ? 1 : 2;
    if (chosen.size < target && chosen.has(cursor % slotCount)) {
      cursor += 1;
    }
    guard += 1;
  }
  return chosen;
}

function buildCorridorRings(topCols: number) {
  // Deterministic non-repeating deal: 9 artwork tiles per ring * 4 consecutive rings = 36 unique covers.
  // Rings 4..7 mirror-offset wall order so even 4 rings apart a cover never lands on the same wall.
  return Array.from({ length: RING_COUNT }, (_, ringIdx) => {
    const cycleRing = ringIdx % 4;
    const baseDeckOffset = cycleRing * 9;
    const secondHalf = ringIdx >= 4;

    // 2 art on left, 2 art on right, 5 art split (2+3 or 3+2) across top & bottom = 9 total per ring
    const topArtCount = ringIdx % 2 === 0 ? 3 : 2;
    const bottomArtCount = 5 - topArtCount;

    const leftSlots = pickArtSlots(SIDE_ROWS, 2, ringIdx * 2 + 1);
    const rightSlots = pickArtSlots(SIDE_ROWS, 2, ringIdx * 2 + 2);
    const topSlots = pickArtSlots(topCols, topArtCount, ringIdx * 3 + 1);
    const bottomSlots = pickArtSlots(topCols, bottomArtCount, ringIdx * 3 + 3);

    // Assign the 9 unique covers for this ring; flip dealing order in rings 4..7 so same cover moves to opposite wall
    const ringDeck = Array.from({ length: 9 }, (_, k) => CORRIDOR_ARTWORKS[(baseDeckOffset + k) % CORRIDOR_ARTWORKS.length]);
    if (secondHalf) ringDeck.reverse();

    let cursor = 0;
    let logoCursor = ringIdx * 5;
    const fillWall = (wallIdx: number, count: number, artSlots: Set<number>): TileSpec[] =>
      Array.from({ length: count }, (_, slot) => {
        const src = artSlots.has(slot) ? ringDeck[cursor++] : null;
        if (src) {
          return { id: `${ringIdx}-${wallIdx}-${slot}`, src };
        }
        const logoIndex = logoCursor++;
        return {
          id: `${ringIdx}-${wallIdx}-${slot}`,
          src: null,
          logo: MODEL_LOGO_ASSETS[logoIndex % MODEL_LOGO_ASSETS.length],
          rot: ((logoIndex % 5) - 2) * 4,
        };
      });

    return {
      index: ringIdx,
      left: fillWall(0, SIDE_ROWS, leftSlots),
      right: fillWall(1, SIDE_ROWS, rightSlots),
      top: fillWall(2, topCols, topSlots),
      bottom: fillWall(3, topCols, bottomSlots),
    };
  });
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function easeOutQuart(t: number): number {
  const inv = 1 - clamp01(t);
  return 1 - inv * inv * inv * inv;
}

function easeOutExpo(t: number): number {
  const c = clamp01(t);
  return c >= 1 ? 1 : 1 - Math.pow(2, -10 * c);
}

export function ExploreBlackFridayHero({ active = true, onExpire }: { active?: boolean; onExpire?: () => void } = {}) {
  const { locale, t } = useI18n();
  const script = locale.startsWith('zh') ? 'zh' : (locale === 'ja' || locale === 'ko') ? 'cjk' : 'latin';
  const [time, setTime] = useState(() => readBlackFridayCountdown());
  const [entryId, setEntryId] = useState(newCampaignEntryId);
  const [displayDigits, setDisplayDigits] = useState<[string, string, string] | null>(null);
  const [startedCollapsed] = useState(() => (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));
  const [collapsed, setCollapsed] = useState(startedCollapsed);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const [ctaEngaged, setCtaEngaged] = useState(false);
  const [scrolledPastIntro, setScrolledPastIntro] = useState(false);
  const collapseRemainingRef = useRef(AUTO_COLLAPSE_DELAY_MS);

  const heroRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const ringRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [stageSize, setStageSize] = useState({ width: 1280, height: 660 });
  const [collapsedHeight, setCollapsedHeight] = useState<number | null>(null);
  const introStartRef = useRef<number>(typeof performance !== 'undefined' ? performance.now() : 0);

  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero || !active) return;
    let inView = true;
    const update = () => setVisible(inView && !document.hidden);
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      inView = entries[entries.length - 1].isIntersecting;
      update();
    });
    observer?.observe(hero);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, [active]);
  const playing = active && visible;

  // Interactive physics state kept in refs to avoid React re-renders at 60fps
  const interactionRef = useRef({
    targetPointerX: 0,
    targetPointerY: 0,
    pointerX: 0,
    pointerY: 0,
    boostVelocity: 0,
    hoveringTile: false,
    scrollZ: 0,
  });

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      if (!blackFridayHeroActive()) { onExpire?.(); return; }
      setTime(readBlackFridayCountdown());
    };
    const timer = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(timer);
  }, [onExpire, playing]);

  // Measure the exact compact Spotlight row below so the collapsed Black Friday hero stays large (~64-68% viewport)
  // while keeping the entire row of Spotlight cards 100% visible above the fold with zero bottom clipping.
  useEffect(() => {
    const heroEl = heroRef.current;
    if (!heroEl) return;
    const scroller = heroEl.closest('.om-explore') as HTMLElement | null;
    if (!scroller) return;

    const measure = () => {
      const discovery = scroller.querySelector('.om-discovery-page') as HTMLElement | null;
      const features = discovery?.querySelector('.om-explore-features') as HTMLElement | null;
      const viewportH = scroller.clientHeight;
      if (!discovery || !features || viewportH <= 0) return;

      const discoveryTop = discovery.getBoundingClientRect().top;
      const featuresBottom = features.getBoundingClientRect().bottom;
      const neededBelow = Math.max(0, featuresBottom - discoveryTop) + 16;
      const maxHero = Math.round(viewportH * 0.72);
      const minHero = viewportH < 720 ? 340 : 400;
      const next = Math.max(minHero, Math.min(maxHero, Math.round(viewportH - neededBelow)));
      setCollapsedHeight(prev => (prev === next ? prev : next));
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    const features = scroller.querySelector('.om-explore-features');
    if (features) ro.observe(features);
    return () => ro.disconnect();
  }, []);

  const triggerCollapse = () => {
    setCollapsed(true);
  };

  // Present full-viewport opening for a few seconds on every load/refresh,
  // pausing while the user hovers/focuses the CTA so the button never moves away under their cursor.
  useEffect(() => {
    if (collapsed || ctaEngaged) return;
    const waitMs = Math.max(700, collapseRemainingRef.current);
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      const scroller = heroRef.current?.closest('.om-explore');
      if (scroller && scroller.scrollTop > 20) return;
      setCollapsed(true);
    }, waitMs);
    return () => {
      window.clearTimeout(timer);
      collapseRemainingRef.current = Math.max(0, waitMs - (performance.now() - startedAt));
    };
  }, [collapsed, ctaEngaged]);

  // If the user manually drags the scrollbar before auto-collapse fires, keep below-the-fold cards at full opacity.
  useEffect(() => {
    if (collapsed) return;
    const scroller = heroRef.current?.closest('.om-explore') as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => {
      if (scroller.scrollTop > 12) {
        setScrolledPastIntro(true);
      }
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [collapsed]);

  // Precision staggered countdown digit roll-in synced with the signature opening sequence
  useEffect(() => {
    if (!playing) return;
    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      setDisplayDigits(null);
      return;
    }

    const startMs = 660;
    const durationMs = 760;
    const startAt = performance.now();
    let rafId = 0;
    let lastEmit = 0;

    const stepRoll = (now: number) => {
      const elapsed = now - startAt;
      if (elapsed < startMs) {
        if (lastEmit === 0) {
          setDisplayDigits(['00', '00', '00']);
          lastEmit = now;
        }
        rafId = window.requestAnimationFrame(stepRoll);
        return;
      }

      const rel = elapsed - startMs;
      if (rel >= durationMs) {
        setDisplayDigits(null);
        return;
      }

      if (now - lastEmit >= 32) {
        lastEmit = now;
        const live = readBlackFridayCountdown();
        const targets = [Number(live.hours), Number(live.minutes), Number(live.seconds)];
        const ranges = [23, 59, 59];
        const next: [string, string, string] = ['00', '00', '00'];

        for (let idx = 0; idx < 3; idx++) {
          // Stagger lock-in left-to-right: HRS -> MIN -> SEC
          const unitEnd = durationMs * (0.64 + idx * 0.18);
          const p = clamp01(rel / unitEnd);
          if (p >= 1) {
            next[idx] = String(targets[idx]).padStart(2, '0');
          } else {
            const eased = easeOutQuart(p);
            const spinOffset = Math.round((1 - eased) * (ranges[idx] + 18 + idx * 7));
            const val = (targets[idx] + spinOffset) % (ranges[idx] + 1);
            next[idx] = String(val).padStart(2, '0');
          }
        }
        setDisplayDigits(next);
      }

      rafId = window.requestAnimationFrame(stepRoll);
    };

    rafId = window.requestAnimationFrame(stepRoll);
    return () => window.cancelAnimationFrame(rafId);
  }, [playing]);

  // Keep 3D corridor walls flush with viewport corners across resizes.
  // Observe the centered full-height stage rather than the collapsible section
  // so the 3D tunnel never reflows or swaps rings during the height glide.
  useEffect(() => {
    const el = stageRef.current ?? heroRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageSize({
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const { width, height } = stageSize;
    const tileZ = Math.max(150, Math.round(height / SIDE_ROWS));
    const topCols = Math.max(4, Math.min(7, Math.round(width / tileZ)));
    const perspective = Math.round(Math.max(520, Math.min(width, height) * 0.94));
    const totalDepth = RING_COUNT * tileZ;
    return { width, height, tileZ, topCols, perspective, totalDepth };
  }, [stageSize]);

  const rings = useMemo(() => buildCorridorRings(geometry.topCols), [geometry.topCols]);

  // 60fps infinite ring-recycling + signature opening camera choreography + mouse parallax + wheel inertia
  useEffect(() => {
    if (!playing) return;
    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const { tileZ, totalDepth, perspective: basePerspective } = geometry;
    const zMax = tileZ + 6;
    const zMin = zMax - totalDepth;

    const applyStatic = () => {
      if (stageRef.current) {
        stageRef.current.style.perspective = `${basePerspective}px`;
      }
      if (cameraRef.current) {
        cameraRef.current.style.transform = 'translate3d(0, 0, 0)';
      }
      for (let i = 0; i < RING_COUNT; i++) {
        const el = ringRefs.current[i];
        if (!el) continue;
        let raw = (tileZ * 0.45 + i * tileZ) % totalDepth;
        if (raw < 0) raw += totalDepth;
        const z = zMin + raw;
        const depthRatio = clamp01((zMax - z) / (totalDepth * 0.9));
        const opacity = clamp01(Math.pow(1 - depthRatio, 1.65));
        el.style.transform = `translate3d(0, 0, ${z.toFixed(2)}px)`;
        el.style.setProperty('--ring-opacity', opacity.toFixed(3));
      }
    };

    if (prefersReduced) {
      applyStatic();
      return;
    }

    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      const introT = Math.max(0, (now - introStartRef.current) / 1000);

      const state = interactionRef.current;
      const damp = 1 - Math.exp(-6.5 * dt);
      state.pointerX += (state.targetPointerX - state.pointerX) * damp;
      state.pointerY += (state.targetPointerY - state.pointerY) * damp;

      state.boostVelocity *= Math.exp(-4.5 * dt);
      if (Math.abs(state.boostVelocity) < 0.2) state.boostVelocity = 0;

      // Signature opening: warp brake + wide-angle lens pullback + subtle steadicam roll settle
      const speedMultiplier = 1 + 7.5 * Math.exp(-3.6 * introT);
      const perspectiveScale = 0.64 + 0.36 * easeOutQuart(introT / 1.25);
      const introCamZ = -65 * (1 - easeOutExpo(introT / 1.1));
      const introRollDeg = -2.4 * (1 - easeOutQuart(introT / 1.15));

      const baseSpeed = collapsedRef.current ? BASE_CRUISE_SPEED * 0.58 : BASE_CRUISE_SPEED;
      const cruiseBase = state.hoveringTile ? baseSpeed * 0.28 : baseSpeed;
      const activeSpeed = cruiseBase * speedMultiplier + state.boostVelocity;
      state.scrollZ = (state.scrollZ + activeSpeed * dt) % totalDepth;

      if (stageRef.current) {
        stageRef.current.style.perspective = `${Math.round(basePerspective * perspectiveScale)}px`;
      }

      const cam = cameraRef.current;
      if (cam) {
        const parallaxGain = smoothstep(0.4, 1.2, introT);
        const rotY = -state.pointerX * 4.2 * parallaxGain;
        const rotX = state.pointerY * 2.8 * parallaxGain;
        const shiftX = -state.pointerX * 18 * parallaxGain;
        const shiftY = -state.pointerY * 12 * parallaxGain;
        cam.style.transform = `translate3d(${shiftX.toFixed(2)}px, ${shiftY.toFixed(2)}px, ${introCamZ.toFixed(2)}px) rotateX(${rotX.toFixed(3)}deg) rotateY(${rotY.toFixed(3)}deg) rotateZ(${introRollDeg.toFixed(3)}deg)`;
      }

      const wave = (introT - 0.06) / 0.78;
      for (let i = 0; i < RING_COUNT; i++) {
        const el = ringRefs.current[i];
        if (!el) continue;
        let raw = (state.scrollZ + i * tileZ) % totalDepth;
        if (raw < 0) raw += totalDepth;
        const z = zMin + raw;
        const depthRatio = clamp01((zMax - z) / (totalDepth * 0.9));
        const ringOrder = 1 - depthRatio;
        const ringLit = smoothstep(ringOrder - 0.35, ringOrder + 0.12, wave);
        const opacity = clamp01(Math.pow(1 - depthRatio, 1.65)) * (0.18 + 0.82 * ringLit);

        el.style.transform = `translate3d(0, 0, ${z.toFixed(2)}px)`;
        // Apply opacity on child .wall elements via CSS var so .ring keeps transform-style: preserve-3d
        el.style.setProperty('--ring-opacity', opacity.toFixed(3));
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [geometry, playing]);

  // Passive wheel listener for kinetic corridor speed nudge; downward scroll while expanded immediately triggers collapse.
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const impulse = Math.max(-220, Math.min(220, event.deltaY * 1.45));
      interactionRef.current.boostVelocity = Math.max(
        -260,
        Math.min(340, interactionRef.current.boostVelocity + impulse),
      );
      if (!collapsed && event.deltaY > 12) {
        const scroller = el.closest('.om-explore');
        if (!scroller || scroller.scrollTop <= 20) {
          setCollapsed(true);
        }
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, [collapsed]);

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    interactionRef.current.targetPointerX = Math.max(-1, Math.min(1, nx));
    interactionRef.current.targetPointerY = Math.max(-1, Math.min(1, ny));
  };

  const handlePointerLeave = () => {
    interactionRef.current.targetPointerX = 0;
    interactionRef.current.targetPointerY = 0;
    interactionRef.current.hoveringTile = false;
  };

  const pricingHref = campaignPricingUrl(locale, 'openmotion_bf_banner', entryId);
  const claimOffer = (event: MouseEvent<HTMLAnchorElement>) => {
    void trackMotion('ui_click', {
      page_name: 'explore',
      area: 'campaign_banner',
      element: 'claim_offer',
      campaign_id: BLACK_FRIDAY_CAMPAIGN,
      entry_id: entryId,
      interaction_method: event.detail === 0 ? 'keyboard' : 'pointer',
    });
    event.currentTarget.href = campaignPricingUrl(locale, 'openmotion_bf_banner', entryId);
    window.setTimeout(() => setEntryId(newCampaignEntryId()), 0);
  };

  const copy = {
    sectionLabel: t('Black Friday flagship image 7 days unlimited hero'),
    campaign: 'Black Friday',
    countdownAria: t('Black Friday round ends in {hours} hours {minutes} minutes {seconds} seconds', {
      hours: time.hours,
      minutes: time.minutes,
      seconds: time.seconds,
    }),
    serifLead: 'Create',
    serifItalic: 'Unlimited',
    cnHeadline: t('Flagship Image · 7 Days Unlimited'),
    modalities: [t('Annual Pro & Max'), t('API Supported')] as const,
    offerNote: t('Up to 50% off annual'),
    primaryCta: t('Claim 50% Off'),
    scrollHintAria: t('Collapse hero to explore'),
  };

  const segments = [
    { key: 'hours', value: displayDigits ? displayDigits[0] : time.hours, label: 'HRS' },
    { key: 'minutes', value: displayDigits ? displayDigits[1] : time.minutes, label: 'MIN' },
    { key: 'seconds', value: displayDigits ? displayDigits[2] : time.seconds, label: 'SEC' },
  ] as const;

  const renderTile = (tile: TileSpec) => {
    if (!tile.src) {
      if (tile.logo) {
        return (
          <div
            key={tile.id}
            className={styles.tileLogo}
            onPointerEnter={() => {
              interactionRef.current.hoveringTile = true;
            }}
            onPointerLeave={() => {
              interactionRef.current.hoveringTile = false;
            }}
          >
            <div
              className={styles.tileLogoInner}
              style={{ '--tile-rot': `${tile.rot ?? 0}deg` } as CSSProperties}
            >
              <div className={styles.tileLogoBadge}>
                <img className={styles.tileLogoImg} src={tile.logo.src} alt={tile.logo.label} draggable={false} />
              </div>
              <span className={styles.tileLogoName}>{tile.logo.label}</span>
            </div>
          </div>
        );
      }
      return <div key={tile.id} className={styles.tileVoid} />;
    }
    return (
      <div
        key={tile.id}
        className={styles.tileArt}
        onPointerEnter={() => {
          interactionRef.current.hoveringTile = true;
        }}
        onPointerLeave={() => {
          interactionRef.current.hoveringTile = false;
        }}
      >
        <img src={tile.src} alt="" draggable={false} />
      </div>
    );
  };

  const collapsedEditorialScale = collapsedHeight !== null
    ? Math.min(0.96, Math.max(0.78, (collapsedHeight - 36) / 480))
    : 0.94;

  const heroClassName = collapsed ? `${styles.hero} ${styles.heroCollapsed}` : styles.hero;

  return (
    <section
      ref={heroRef}
      className={heroClassName}
      data-bf-hero="true"
      data-script={script}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-instant={startedCollapsed ? 'true' : undefined}
      data-curtain={collapsed || scrolledPastIntro ? 'open' : 'closed'}
      aria-label={copy.sectionLabel}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={
        {
          '--corridor-perspective': `${geometry.perspective}px`,
          '--corridor-tile-z': `${geometry.tileZ}px`,
          '--corridor-cols': `${geometry.topCols}`,
          '--corridor-rows': `${SIDE_ROWS}`,
          ...(collapsedHeight !== null ? { '--hero-collapsed-height': `${collapsedHeight}px` } : {}),
          '--hero-collapsed-scale': collapsedEditorialScale.toFixed(3),
        } as CSSProperties
      }
    >
      <div ref={stageRef} className={styles.corridorStage} aria-hidden="true">
        <div ref={cameraRef} className={styles.corridorCamera}>
          {rings.map((ring, idx) => (
            <div
              key={ring.index}
              ref={el => {
                ringRefs.current[idx] = el;
              }}
              className={styles.ring}
            >
              <div className={`${styles.wall} ${styles.wallLeft}`}>
                {ring.left.map(renderTile)}
              </div>
              <div className={`${styles.wall} ${styles.wallRight}`}>
                {ring.right.map(renderTile)}
              </div>
              <div className={`${styles.wall} ${styles.wallTop}`}>
                {ring.top.map(renderTile)}
              </div>
              <div className={`${styles.wall} ${styles.wallBottom}`}>
                {ring.bottom.map(renderTile)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.stageGlow} aria-hidden="true" />
      <div className={styles.voidVignette} aria-hidden="true" />
      <div className={styles.filmGrain} aria-hidden="true" />

      <div className={styles.editorial}>
        <div className={styles.kicker} lang="en">
          <span className={styles.kickerText}>{copy.campaign}</span>
        </div>

        <h2 className={styles.headline}>
          <span className={styles.serifDisplay} lang="en">
            <span className={styles.serifRoman}>{copy.serifLead}</span>
            <em className={styles.serifItalic}>{copy.serifItalic}</em>
          </span>
          <span className={styles.cnHeadline}>{copy.cnHeadline}</span>
        </h2>

        <time
          className={styles.thinClockRow}
          dateTime={time.datetime}
          role="timer"
          aria-live="off"
          aria-label={copy.countdownAria}
        >
          {segments.map((seg, idx) => (
            <div key={seg.key} className={styles.thinClockItem}>
              <div className={styles.thinClockUnit}>
                <span className={styles.thinClockDigits}>{seg.value}</span>
                <span className={styles.thinClockLabel} aria-hidden="true">{seg.label}</span>
              </div>
              {idx < segments.length - 1 && (
                <span className={styles.thinClockColon} aria-hidden="true">
                  <span className={styles.thinColonSq} />
                  <span className={styles.thinColonSq} />
                </span>
              )}
            </div>
          ))}
        </time>

        <p className={styles.metaLine}>
          <span className={styles.metaGroup}>
            {copy.modalities.map((item, idx) => (
              <span key={item} className={styles.metaItem}>
                {idx > 0 && <span className={styles.metaBar} aria-hidden="true" />}
                <span>{item}</span>
              </span>
            ))}
          </span>
          <span>{copy.offerNote}</span>
        </p>

        <div className={styles.actions}>
          <a
            className={styles.ctaBeam}
            href={pricingHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={claimOffer}
            onAuxClick={event => {
              if (event.button === 1) claimOffer(event);
            }}
            onPointerEnter={() => setCtaEngaged(true)}
            onPointerLeave={() => setCtaEngaged(false)}
            onFocus={() => setCtaEngaged(true)}
            onBlur={() => setCtaEngaged(false)}
          >
            <span className={styles.ctaBeamInner}>
              <span>{copy.primaryCta}</span>
            </span>
          </a>
        </div>
      </div>

      <Button
        type="button"
        variant="plain"
        data-bf-hero-scroll="true"
        className={styles.scrollHint}
        aria-label={copy.scrollHintAria}
        tabIndex={collapsed ? -1 : 0}
        aria-hidden={collapsed}
        onClick={triggerCollapse}
      >
        <span className={styles.scrollHairline} />
      </Button>
    </section>
  );
}
