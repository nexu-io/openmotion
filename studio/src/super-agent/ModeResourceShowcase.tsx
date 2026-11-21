import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useEffect, useMemo, useRef, useState } from 'react';
import { blackFridayTemplates } from '../../../shared/black-friday-collection';
import type { GalleryTemplate } from '../../../shared/catalog';
import type { SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { Skeleton } from '../components/ui/Skeleton';
import { ScaledPreviewThumb } from '../design/ScaledPreviewThumb';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { groupBrandSeries, rankDiscoverySeries } from '../motion/brandStoryData';
import { cinemaTemplates } from '../motion/cinemaTemplates';
import { gptImageStory, seedanceStory } from '../motion/exploreModelStories';
import { sceneExamples } from '../motion/sceneShowcase';
import { motionSkills, skillCategories, type MotionSkill, type SkillCategory } from '../motion/skillCatalog';
import { templateCollectionFacets, templatesInCollection, type TemplateCollection } from '../motion/templateCollections';
import { aiTechnologyIndustry, purposeOrder } from '../motion/templateDiscoveryTaxonomy';
import { useCoveredTemplates } from '../motion/useCoveredTemplates';
import { resourceIcon, resourceKey, type ResourceCategoryTab } from './ResourcePickerDialog';
import { fetchWorkspaceResources } from './superAgentClient';

export type SuperAgentCreationModeId = 'game' | 'website' | 'motion' | 'deck' | 'image' | 'media';

export type SuperAgentModeSpec = {
  id: SuperAgentCreationModeId;
  tone: 'agent' | 'image' | 'video' | 'audio';
  icon: string;
  label: string;
  title: string;
  subtitle: string;
  placeholder: string;
  defaultPrompt: string;
  pickerCategory: ResourceCategoryTab;
  quickIdeas: readonly { title: string; prompt: string }[];
};

export const SUPER_AGENT_MODES: readonly SuperAgentModeSpec[] = [
  {
    id: 'website',
    tone: 'agent',
    icon: 'layout-line',
    label: 'Website & App',
    title: 'Your idea, live on the web',
    subtitle: 'Pick a Design Studio template or Brand Kit below to attach as context, then describe what you want to build.',
    placeholder: 'Describe the website, dashboard, or mobile app you want to build…',
    defaultPrompt: 'Design a modern interactive website prototype with a bold hero, interactive feature tabs, pricing toggle, and responsive mobile layout, then open it in the Artifact Viewer.',
    pickerCategory: 'design-template',
    quickIdeas: [
      { title: 'AI product landing page', prompt: 'Build a responsive AI product landing page with interactive feature switcher, pricing toggle, and customer proof.' },
      { title: 'Interactive SaaS dashboard', prompt: 'Create a live analytics dashboard with KPI cards, interactive filters, and trend charts.' },
      { title: 'Mobile app prototype', prompt: 'Design a mobile app prototype in a 390x844 phone viewport with bottom tab navigation and smooth transitions.' },
    ],
  },
  {
    id: 'motion',
    tone: 'video',
    icon: 'movie-line',
    label: 'Motion Video',
    title: 'Direct an editable Motion film',
    subtitle: 'Select Motion Studio templates, Skills, or Brand Kits to feed into Super Agent and generate editable HyperFrames timelines.',
    placeholder: 'Describe the motion video you want to create…',
    defaultPrompt: 'Create an editable 15-second Motion Studio product launch video using HyperFrames HTML and GSAP timelines with bold kinetic typography and smooth transitions, then open it in the Artifact Viewer.',
    pickerCategory: 'motion-template',
    quickIdeas: [
      { title: '15s product launch reel', prompt: 'Create a 15-second product launch video with bold kinetic typography, feature callouts, and a crisp logo outro.' },
      { title: 'Website to launch video', prompt: 'Turn a product story into a fast-paced 20-second launch film with UI screen choreography.' },
      { title: 'Brand commercial intro', prompt: 'Design a sleek 12-second brand opener styled with the attached Brand Kit palette and typography.' },
    ],
  },
  {
    id: 'deck',
    tone: 'audio',
    icon: 'slideshow-line',
    label: 'Slides & Docs',
    title: 'Make a deck. Tell it clearly.',
    subtitle: 'Choose a Design Studio presentation or document template to attach, and export to PDF or PPTX anytime.',
    placeholder: 'Describe your presentation or document topic…',
    defaultPrompt: 'Create a clean 8-slide investor pitch deck in Design Studio with speaker notes, KPI visualizations, and keyboard slide navigation, then present it in the Artifact Viewer.',
    pickerCategory: 'design-template',
    quickIdeas: [
      { title: 'Investor pitch deck', prompt: 'Create an 8-slide investor pitch deck covering problem, solution, traction KPIs, and roadmap with speaker notes.' },
      { title: 'Quarterly business review', prompt: 'Build a quarterly performance deck with metric comparisons, key milestones, and next-quarter priorities.' },
      { title: 'Competitor landscape report', prompt: 'Draft a structured competitor analysis report with positioning matrix and executive summary.' },
    ],
  },
  {
    id: 'game',
    tone: 'agent',
    icon: 'sparkling-line',
    label: 'HTML Game',
    title: 'Build a playable HTML game',
    subtitle: 'Attach interactive Prototype/WebGL references or Brand Kits, then play directly inside the Artifact Viewer.',
    placeholder: 'Describe the playable HTML5 Canvas or WebGL game you want to build…',
    defaultPrompt: 'Build a playable retro neon arcade space-shooter game in HTML5 Canvas with keyboard and mouse controls, score & wave HUD, particle explosions, and a restart button. Preview it in the Artifact Viewer.',
    pickerCategory: 'design-template',
    quickIdeas: [
      { title: 'Neon arcade space shooter', prompt: 'Build a retro neon space-shooter game in HTML5 Canvas with mouse/keyboard controls, waves, score HUD, and explosions.' },
      { title: 'Physics puzzle game', prompt: 'Create an interactive 2D physics puzzle game with 5 handcrafted levels, move counter, and instant restart.' },
      { title: 'Interactive WebGL playground', prompt: 'Build an interactive WebGL particle & shader playground reacting to mouse movement with live parameter controls.' },
    ],
  },
  {
    id: 'image',
    tone: 'image',
    icon: 'image-line',
    label: 'Image Artwork',
    title: 'Generate or remix visual assets',
    subtitle: 'Start from curated Image Studio cases, or attach your own workspace assets and Brand Kits as visual references.',
    placeholder: 'Describe the image artwork or reference edit you want to generate…',
    defaultPrompt: 'Check my configured image models and generate a cinematic product hero illustration in the workspace asset library, inspect the result, and display it in the Artifact Viewer.',
    pickerCategory: 'asset',
    quickIdeas: [
      { title: 'Cinematic product hero', prompt: 'Generate a studio-lit product hero illustration matching the attached Brand Kit colors and mood.' },
      { title: 'Character concept sheet', prompt: 'Create a consistent character concept illustration in 16:9 widescreen framing.' },
      { title: 'Editorial poster artwork', prompt: 'Design a bold editorial campaign visual with dramatic lighting and clean composition.' },
    ],
  },
  {
    id: 'media',
    tone: 'video',
    icon: 'clapperboard-line',
    label: 'Cinema & Audio',
    title: 'Direct cinema shots & sound',
    subtitle: 'Choose a Cinema Studio shot template or Sound Studio audio preset to seed your prompt, or attach workspace media.',
    placeholder: 'Describe the video clip, soundtrack, SFX, or voiceover you want to create…',
    defaultPrompt: 'Inspect my configured video and audio models, then help me generate a short cinematic clip or background soundtrack in workspace assets and show it in the Artifact Viewer.',
    pickerCategory: 'asset',
    quickIdeas: [
      { title: 'Cinematic B-roll shot', prompt: 'Generate a 5-second cinematic camera-movement shot based on the attached still reference.' },
      { title: 'Product launch soundtrack', prompt: 'Compose an upbeat 30-second electronic product launch soundtrack with a clean build-up.' },
      { title: 'Narration & sound effects', prompt: 'Generate a warm voiceover intro and crisp UI transition sound effects in workspace assets.' },
    ],
  },
];

export function findSuperAgentMode(id: SuperAgentCreationModeId | null): SuperAgentModeSpec | null {
  return id ? SUPER_AGENT_MODES.find(item => item.id === id) ?? null : null;
}

const PAGE_BATCH_SIZE = 24;

type CuratedShowcaseCard = {
  id: string;
  title: string;
  subtitle: string;
  poster: string;
  posterPosition?: string;
  prompt: string;
};

function buildImageCardsByCategory(category: string): CuratedShowcaseCard[] {
  const gpt: CuratedShowcaseCard[] = gptImageStory.cases.map((item, idx) => ({
    id: `gpt-${idx}`,
    title: item.example.title,
    subtitle: 'GPT Image 2.6 · Image',
    poster: item.example.poster,
    posterPosition: item.example.posterPosition,
    prompt: item.example.prompt,
  }));
  const t2i: CuratedShowcaseCard[] = sceneExamples['text-to-image'].map((ex, idx) => ({
    id: `t2i-${idx}`,
    title: ex.title,
    subtitle: 'Text to image',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));
  const edit: CuratedShowcaseCard[] = sceneExamples['image-edit'].map((ex, idx) => ({
    id: `edit-${idx}`,
    title: ex.title,
    subtitle: 'Image edit',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));
  const bg: CuratedShowcaseCard[] = sceneExamples['remove-background'].map((ex, idx) => ({
    id: `bg-${idx}`,
    title: ex.title,
    subtitle: 'Remove background',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));
  const relight: CuratedShowcaseCard[] = sceneExamples.relight.map((ex, idx) => ({
    id: `relight-${idx}`,
    title: ex.title,
    subtitle: 'Relight',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));
  const char: CuratedShowcaseCard[] = sceneExamples.character.map((ex, idx) => ({
    id: `char-${idx}`,
    title: ex.title,
    subtitle: 'Character consistency',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));

  const cinemaStills: CuratedShowcaseCard[] = [
    ...cinemaTemplates.map(tpl => ({
      id: `still-cinema-${tpl.id}`,
      title: tpl.en.title,
      subtitle: 'Cinema still · Visual reference',
      poster: tpl.poster,
      prompt: tpl.en.prompt,
    })),
    ...seedanceStory.cases.map((item, idx) => ({
      id: `still-seedance-${idx}`,
      title: item.example.title,
      subtitle: 'Key visual · Art direction',
      poster: item.example.poster,
      posterPosition: item.example.posterPosition,
      prompt: item.example.prompt,
    })),
  ];

  if (category === 'gpt-image') return gpt;
  if (category === 'text-to-image') return t2i;
  if (category === 'image-edit') return edit;
  if (category === 'remove-background') return bg;
  if (category === 'relight') return relight;
  if (category === 'character') return char;

  const seenTitles = new Set<string>();
  const seenPosters = new Set<string>();
  const primary: CuratedShowcaseCard[] = [];
  const secondary: CuratedShowcaseCard[] = [];
  for (const item of [...gpt, ...t2i, ...edit, ...bg, ...relight, ...char, ...cinemaStills]) {
    if (seenTitles.has(item.title)) continue;
    seenTitles.add(item.title);
    if (item.poster && !seenPosters.has(item.poster)) {
      seenPosters.add(item.poster);
      primary.push(item);
    } else {
      secondary.push(item);
    }
  }
  return [...primary, ...secondary];
}

function buildCinemaCardsByCategory(category: string, isZh: boolean): CuratedShowcaseCard[] {
  const cinema: CuratedShowcaseCard[] = cinemaTemplates.map(tpl => {
    const copy = isZh ? tpl.zh : tpl.en;
    return {
      id: `cinema-${tpl.id}`,
      title: copy.title,
      subtitle: `${tpl.model.name} · ${tpl.aspect} · ${tpl.duration}s`,
      poster: tpl.poster,
      prompt: copy.prompt,
    };
  });
  const seedance: CuratedShowcaseCard[] = seedanceStory.cases.map((item, idx) => ({
    id: `seedance-${idx}`,
    title: item.example.title,
    subtitle: 'Seedance 2.5 · Video',
    poster: item.example.poster,
    posterPosition: item.example.posterPosition,
    prompt: item.example.prompt,
  }));
  const videoScenes: CuratedShowcaseCard[] = (['video-camera-control', 'video-multi-shot'] as const).flatMap(sceneKey =>
    sceneExamples[sceneKey].map((ex, idx) => ({
      id: `${sceneKey}-${idx}`,
      title: ex.title,
      subtitle: sceneKey.replace('video-', '').replaceAll('-', ' '),
      poster: ex.poster,
      posterPosition: ex.posterPosition,
      prompt: ex.prompt,
    })),
  );
  const audio: CuratedShowcaseCard[] = [
    ...sceneExamples.music.map((ex, idx) => ({
      id: `audio-${idx}`,
      title: ex.title,
      subtitle: [ex.kind || 'Audio', ex.model, ex.seconds ? `${ex.seconds}s` : ''].filter(Boolean).join(' · '),
      poster: ex.poster,
      prompt: ex.prompt,
    })),
    ...sceneExamples.speech.map((ex, idx) => ({
      id: `speech-${idx}`,
      title: ex.title,
      subtitle: 'Text to speech',
      poster: ex.poster,
      prompt: ex.prompt,
    })),
  ];

  const dedupe = (list: CuratedShowcaseCard[]) => {
    const seenTitles = new Set<string>();
    const seenPosters = new Set<string>();
    const primary: CuratedShowcaseCard[] = [];
    const secondary: CuratedShowcaseCard[] = [];
    for (const item of list) {
      if (seenTitles.has(item.title)) continue;
      seenTitles.add(item.title);
      if (item.poster && !seenPosters.has(item.poster)) {
        seenPosters.add(item.poster);
        primary.push(item);
      } else {
        secondary.push(item);
      }
    }
    return [...primary, ...secondary];
  };

  if (category === 'all-media') return dedupe([...cinema, ...seedance, ...videoScenes, ...audio]);
  if (category === 'ai-video') return dedupe([...cinema, ...seedance, ...videoScenes]);
  if (category === 'cinema') return cinema;
  if (category === 'seedance') return seedance;
  if (category === 'video-scenes') return videoScenes;
  if (category === 'audio') return audio;
  return dedupe([...cinema, ...seedance, ...videoScenes]);
}

function motionTemplateToAttachment(tpl: GalleryTemplate): SuperAgentResourceAttachment {
  return {
    id: tpl.id,
    kind: 'motion-template',
    title: tpl.title,
    subtitle: tpl.brand || tpl.subtitle || tpl.collection || 'Motion',
    previewUrl: tpl.posterUrl,
    tags: tpl.tags,
  };
}

function motionSkillToAttachment(skill: MotionSkill): SuperAgentResourceAttachment {
  return {
    id: skill.id,
    kind: 'skill',
    title: skill.title,
    subtitle: `${skill.category} · ${skill.useWhen}`,
    previewUrl: skill.cover?.poster || skill.cover?.gif,
    tags: [skill.category],
  };
}

type FilterOption = { id: string; label: string; count?: number };

function ResourceShowcaseThumb({ item, active = true }: { item: SuperAgentResourceAttachment; active?: boolean }) {
  const [imgFailed, setImgFailed] = useState(false);

  if (item.kind === 'design-template' && item.previewUrl) {
    return (
      <div className="om-sa-showcase-thumb om-sa-showcase-iframe-wrap" aria-hidden="true">
        <ScaledPreviewThumb src={item.previewUrl} title={item.title} active={active} />
      </div>
    );
  }

  const showImg =
    !imgFailed
    && Boolean(item.previewUrl)
    && (
      item.kind === 'motion-template'
      || item.kind === 'brand-kit'
      || item.kind === 'skill'
      || (item.kind === 'asset' && item.modality === 'image')
    );

  if (showImg) {
    return (
      <div className="om-sa-showcase-thumb" aria-hidden="true">
        <img src={item.previewUrl} alt="" loading="lazy" onError={() => setImgFailed(true)} />
      </div>
    );
  }

  if (item.swatches?.length) {
    return (
      <div className="om-sa-showcase-thumb om-sa-showcase-swatches" aria-hidden="true">
        {item.swatches.slice(0, 5).map((hex, i) => (
          <span key={`${hex}-${i}`} style={{ background: hex }} />
        ))}
      </div>
    );
  }

  return (
    <div className="om-sa-showcase-thumb om-sa-showcase-icon-fallback" aria-hidden="true">
      <RemixIcon name={resourceIcon(item)} size={24} />
    </div>
  );
}

export function ModeResourceShowcase({
  active = true,
  mode,
  attachments,
  onToggleAttachment,
  onPickPrompt,
  onOpenAllResources,
  onClose,
}: {
  active?: boolean;
  mode: SuperAgentModeSpec;
  attachments: SuperAgentResourceAttachment[];
  onToggleAttachment: (item: SuperAgentResourceAttachment) => void;
  onPickPrompt: (prompt: string) => void;
  onOpenAllResources: (category: ResourceCategoryTab) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const isZh = locale === 'zh-CN';

  // Motion & Cinema modes share Explore's full covered Motion template catalog.
  const coveredMotion = useCoveredTemplates(locale, mode.id === 'motion' || mode.id === 'media', { showFirstPage: true });
  const motionCatalog = useMemo(
    () => coveredMotion.catalog ?? coveredMotion.firstPage?.items ?? [],
    [coveredMotion.catalog, coveredMotion.firstPage],
  );
  const motionPurposes = useMemo(
    () => (coveredMotion.catalog ? templateCollectionFacets(coveredMotion.catalog).purposes : purposeOrder),
    [coveredMotion.catalog],
  );

  // Full workspace catalogs cached per kind for Design templates, Brand Kits, Design Skills, Assets.
  const [designTemplates, setDesignTemplates] = useState<SuperAgentResourceAttachment[] | null>(null);
  const [brandKits, setBrandKits] = useState<SuperAgentResourceAttachment[] | null>(null);
  const [designSkills, setDesignSkills] = useState<SuperAgentResourceAttachment[] | null>(null);
  const [assets, setAssets] = useState<SuperAgentResourceAttachment[] | null>(null);
  const [loadingKind, setLoadingKind] = useState<string | null>(null);

  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [activeSkillCategory, setActiveSkillCategory] = useState<SkillCategory | 'all'>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_BATCH_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Build real categories & live counts per mode.
  const filters = useMemo<FilterOption[]>(() => {
    switch (mode.id) {
      case 'website': {
        const all = (designTemplates ?? []).filter(i => i.scenario !== 'deck' && i.scenario !== 'document' && i.scenario !== 'webgl');
        const proto = (designTemplates ?? []).filter(i => i.scenario === 'prototype');
        const mobile = (designTemplates ?? []).filter(i => i.scenario === 'mobile-app');
        const live = (designTemplates ?? []).filter(i => i.scenario === 'live-artifact');
        const clone = (designTemplates ?? []).filter(i => i.scenario === 'web-clone');
        return [
          { id: 'all', label: 'All templates', count: designTemplates ? all.length : undefined },
          { id: 'prototype', label: 'Prototype', count: designTemplates ? proto.length : undefined },
          { id: 'mobile-app', label: 'Mobile App', count: designTemplates ? mobile.length : undefined },
          { id: 'live-artifact', label: 'Live artifact', count: designTemplates ? live.length : undefined },
          ...(clone.length ? [{ id: 'web-clone', label: 'Website clone', count: clone.length }] : []),
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
          { id: 'design-skill', label: 'Design Skills', count: designSkills?.length },
        ];
      }
      case 'deck': {
        const decks = (designTemplates ?? []).filter(i => i.scenario === 'deck');
        const docs = (designTemplates ?? []).filter(i => i.scenario === 'document');
        return [
          { id: 'all', label: 'All templates', count: designTemplates ? decks.length + docs.length : undefined },
          { id: 'deck', label: 'Slide deck', count: designTemplates ? decks.length : undefined },
          { id: 'document', label: 'Document', count: designTemplates ? docs.length : undefined },
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
          { id: 'design-skill', label: 'Design Skills', count: designSkills?.length },
        ];
      }
      case 'game': {
        const webgl = (designTemplates ?? []).filter(i => i.scenario === 'webgl');
        const live = (designTemplates ?? []).filter(i => i.scenario === 'live-artifact');
        const proto = (designTemplates ?? []).filter(i => i.scenario === 'prototype');
        return [
          { id: 'all', label: 'All templates', count: designTemplates ? webgl.length + live.length + proto.length : undefined },
          ...(webgl.length ? [{ id: 'webgl', label: 'WebGL', count: webgl.length }] : []),
          ...(live.length ? [{ id: 'live-artifact', label: 'Interactive', count: live.length }] : []),
          ...(proto.length ? [{ id: 'prototype', label: 'Prototype', count: proto.length }] : []),
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
          { id: 'design-skill', label: 'Design Skills', count: designSkills?.length },
        ];
      }
      case 'motion': {
        const hasFull = Boolean(coveredMotion.catalog);
        return [
          { id: 'all', label: 'All', count: hasFull ? motionCatalog.length : undefined },
          { id: 'ai-video', label: 'AI Video & Seedance', count: buildCinemaCardsByCategory('ai-video', isZh).length },
          { id: 'top-100-brands', label: 'TOP 100 brands' },
          ...motionPurposes.map(purpose => ({
            id: `purpose:${purpose}`,
            label: purpose,
            count: hasFull ? templatesInCollection(motionCatalog, `purpose:${purpose}` as TemplateCollection).length : undefined,
          })),
          { id: 'ai-technology', label: aiTechnologyIndustry, count: hasFull ? templatesInCollection(motionCatalog, 'ai-technology').length : undefined },
          { id: 'black-friday', label: 'Black Friday collection' },
          { id: 'skills', label: 'Skills', count: motionSkills.length },
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
        ];
      }
      case 'image': {
        return [
          { id: 'all-image', label: 'All image scenes', count: buildImageCardsByCategory('all-image').length },
          { id: 'gpt-image', label: 'GPT Image 2.6', count: gptImageStory.cases.length },
          { id: 'text-to-image', label: 'Text to image', count: sceneExamples['text-to-image'].length },
          { id: 'image-edit', label: 'Image edit', count: sceneExamples['image-edit'].length },
          { id: 'remove-background', label: 'Remove background', count: sceneExamples['remove-background'].length },
          { id: 'relight', label: 'Relight', count: sceneExamples.relight.length },
          { id: 'character', label: 'Character', count: sceneExamples.character.length },
          { id: 'design-template', label: 'Design templates', count: designTemplates?.length },
          { id: 'asset', label: 'Workspace Assets', count: assets ? assets.filter(a => a.modality === 'image').length : undefined },
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
        ];
      }
      case 'media': {
        const hasFull = Boolean(coveredMotion.catalog);
        return [
          { id: 'all-media', label: 'All', count: buildCinemaCardsByCategory('all-media', isZh).length },
          { id: 'ai-video', label: 'AI Video & Seedance', count: buildCinemaCardsByCategory('ai-video', isZh).length },
          { id: 'motion-video', label: 'Motion graphics', count: hasFull ? motionCatalog.length : undefined },
          { id: 'cinema', label: 'Cinema Studio', count: cinemaTemplates.length },
          { id: 'video-scenes', label: 'Camera & multi-shot', count: buildCinemaCardsByCategory('video-scenes', isZh).length },
          { id: 'audio', label: 'Music & Sound', count: sceneExamples.music.length + sceneExamples.speech.length },
          { id: 'asset', label: 'Workspace Assets', count: assets?.length },
        ];
      }
    }
  }, [mode.id, designTemplates, brandKits, designSkills, assets, coveredMotion.catalog, motionCatalog, motionPurposes, isZh]);

  // Reset active tab when switching mode.
  useEffect(() => {
    setActiveFilter(filters[0]?.id ?? 'all');
    setActiveSkillCategory('all');
    setVisibleCount(PAGE_BATCH_SIZE);
  }, [mode.id]);

  // Reset visible scroll window when filter changes.
  useEffect(() => {
    setVisibleCount(PAGE_BATCH_SIZE);
  }, [activeFilter, activeSkillCategory]);

  // Eagerly fetch needed catalogs cleanly with full limits (no truncation).
  useEffect(() => {
    let cancelled = false;
    const ensure = async (kind: 'design-template' | 'brand-kit' | 'design-skill' | 'asset') => {
      if (kind === 'design-template' && designTemplates !== null) return;
      if (kind === 'brand-kit' && brandKits !== null) return;
      if (kind === 'design-skill' && designSkills !== null) return;
      if (kind === 'asset' && assets !== null) return;
      setLoadingKind(kind);
      try {
        const res = await fetchWorkspaceResources({ kind, limit: 600 });
        if (cancelled) return;
        if (kind === 'design-template') setDesignTemplates(res.items);
        if (kind === 'brand-kit') setBrandKits(res.items);
        if (kind === 'design-skill') setDesignSkills(res.items);
        if (kind === 'asset') setAssets(res.items);
      } catch {
        if (cancelled) return;
        if (kind === 'design-template') setDesignTemplates([]);
        if (kind === 'brand-kit') setBrandKits([]);
        if (kind === 'design-skill') setDesignSkills([]);
        if (kind === 'asset') setAssets([]);
      } finally {
        if (!cancelled) setLoadingKind(prev => (prev === kind ? null : prev));
      }
    };

    if (mode.id === 'website' || mode.id === 'deck' || mode.id === 'game') {
      void ensure('design-template');
      if (activeFilter === 'brand-kit') void ensure('brand-kit');
      if (activeFilter === 'design-skill') void ensure('design-skill');
    } else if (mode.id === 'motion') {
      if (activeFilter === 'brand-kit') void ensure('brand-kit');
    } else if (mode.id === 'image') {
      if (activeFilter === 'design-template') void ensure('design-template');
      if (activeFilter === 'asset') void ensure('asset');
      if (activeFilter === 'brand-kit') void ensure('brand-kit');
    } else if (mode.id === 'media') {
      if (activeFilter === 'asset') void ensure('asset');
    }

    return () => {
      cancelled = true;
    };
  }, [mode.id, activeFilter, designTemplates, brandKits, designSkills, assets]);

  // Resolve active curated cards (Image / Cinema / Sound / AI Video).
  const curatedCards = useMemo<CuratedShowcaseCard[] | null>(() => {
    if (mode.id === 'image' && activeFilter !== 'asset' && activeFilter !== 'brand-kit' && activeFilter !== 'design-template') {
      return buildImageCardsByCategory(activeFilter);
    }
    if (mode.id === 'media' && activeFilter !== 'asset' && activeFilter !== 'motion-video') {
      return buildCinemaCardsByCategory(activeFilter, isZh);
    }
    if (mode.id === 'motion' && activeFilter === 'ai-video') {
      return buildCinemaCardsByCategory('ai-video', isZh);
    }
    return null;
  }, [mode.id, activeFilter, isZh]);

  // Resolve full resource items for all other tabs (NO 12-item cap!).
  const resourceItems = useMemo<SuperAgentResourceAttachment[]>(() => {
    if (curatedCards) return [];
    if (activeFilter === 'brand-kit') return brandKits ?? [];
    if (activeFilter === 'design-template') return designTemplates ?? [];
    if (activeFilter === 'design-skill') {
      const all = designSkills ?? [];
      if (mode.id === 'deck') {
        const scoped = all.filter(s => s.scenario === 'deck' || s.scenario === 'document');
        return scoped.length ? scoped : all;
      }
      if (mode.id === 'game') {
        const scoped = all.filter(s => s.scenario === 'webgl' || s.scenario === 'live-artifact' || s.scenario === 'prototype');
        return scoped.length ? scoped : all;
      }
      return all;
    }
    if (activeFilter === 'asset') {
      const all = assets ?? [];
      if (mode.id === 'image') return all.filter(a => a.modality === 'image');
      return all;
    }
    if (mode.id === 'media' && activeFilter === 'motion-video') {
      return motionCatalog.map(motionTemplateToAttachment);
    }
    if (mode.id === 'motion') {
      if (activeFilter === 'skills') {
        const list = activeSkillCategory === 'all'
          ? motionSkills
          : motionSkills.filter(s => s.category === activeSkillCategory);
        return list.map(motionSkillToAttachment);
      }
      if (activeFilter === 'top-100-brands') {
        return rankDiscoverySeries(groupBrandSeries(motionCatalog)).map(b => motionTemplateToAttachment(b.items[0]));
      }
      if (activeFilter === 'black-friday') {
        return blackFridayTemplates(motionCatalog, locale).flatMap(stage => stage.items).map(motionTemplateToAttachment);
      }
      if (activeFilter !== 'all') {
        return templatesInCollection(motionCatalog, activeFilter as TemplateCollection).map(motionTemplateToAttachment);
      }
      return motionCatalog.map(motionTemplateToAttachment);
    }
    // Design templates (website / deck / game)
    const all = designTemplates ?? [];
    if (activeFilter !== 'all') return all.filter(i => i.scenario === activeFilter);
    if (mode.id === 'deck') return all.filter(i => i.scenario === 'deck' || i.scenario === 'document');
    if (mode.id === 'game') return all.filter(i => i.scenario === 'webgl' || i.scenario === 'live-artifact' || i.scenario === 'prototype');
    return all.filter(i => i.scenario !== 'deck' && i.scenario !== 'document' && i.scenario !== 'webgl');
  }, [curatedCards, activeFilter, activeSkillCategory, mode.id, brandKits, designSkills, assets, motionCatalog, locale, designTemplates]);

  const totalCount = curatedCards ? curatedCards.length : resourceItems.length;
  const hasMore = visibleCount < totalCount;

  // Automatic continuous scrolling via IntersectionObserver.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisibleCount(prev => Math.min(totalCount, prev + PAGE_BATCH_SIZE));
        }
      },
      { rootMargin: '280px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, totalCount]);

  const isLoading =
    !curatedCards
    && (
      (mode.id === 'motion' && activeFilter !== 'skills' && activeFilter !== 'brand-kit' && activeFilter !== 'black-friday' && motionCatalog.length === 0 && !coveredMotion.failed)
      || (activeFilter === 'brand-kit' && brandKits === null)
      || (activeFilter === 'design-skill' && designSkills === null)
      || (activeFilter === 'asset' && assets === null)
      || ((mode.id === 'website' || mode.id === 'deck' || mode.id === 'game') && activeFilter !== 'brand-kit' && activeFilter !== 'design-skill' && designTemplates === null)
      || (loadingKind !== null && totalCount === 0)
    );

  const selectedKeys = useMemo(() => new Set(attachments.map(resourceKey)), [attachments]);
  const visibleCurated = curatedCards ? curatedCards.slice(0, visibleCount) : null;
  const visibleResources = !curatedCards ? resourceItems.slice(0, visibleCount) : [];

  return (
    <div className="om-sa-mode-showcase">
      <div className="om-sa-mode-hero">
        <div className="om-sa-mode-hero-close">
          <IconButton
            variant="ghost"
            className="motion-icon-button"
            aria-label={t('Close')}
            onClick={onClose}
            icon={<RemixIcon name="close-line" size={16} />}
          />
        </div>
        <span className="om-creation-icon om-sa-mode-hero-icon" data-tone={mode.tone} aria-hidden="true">
          <RemixIcon name={mode.icon} size={22} />
        </span>
        <div className="om-sa-mode-hero-copy">
          <h2>{t(mode.title)}</h2>
          <p className="om-muted">{t(mode.subtitle)}</p>
        </div>
        <div className="om-sa-mode-ideas">
          {mode.quickIdeas.map(idea => (
            <Button
              key={idea.title}
              variant="plain"
              type="button"
              className="om-sa-idea-chip"
              onClick={() => onPickPrompt(t(idea.prompt))}
            >
              <span className="om-sa-tone-icon" data-tone={mode.tone} aria-hidden="true">
                <RemixIcon name="sparkling-line" size={12} />
              </span>
              <span>{t(idea.title)}</span>
            </Button>
          ))}
        </div>
      </div>

      <section className="om-sa-showcase-panel">
        <div className="om-sa-showcase-bar">
          <div className="om-sa-showcase-tabs" role="tablist" aria-label={t('Template filters')}>
            {filters.map(f => (
              <Button
                key={f.id}
                variant="plain"
                type="button"
                role="tab"
                aria-selected={activeFilter === f.id}
                data-active={activeFilter === f.id || undefined}
                className="om-sa-showcase-tab"
                onClick={() => setActiveFilter(f.id)}
              >
                <span>{t(f.label)}</span>
                {typeof f.count === 'number' && <span className="om-sa-tab-count">{f.count}</span>}
              </Button>
            ))}
          </div>
          <Button
            variant="plain"
            type="button"
            className="om-sa-showcase-more"
            onClick={() => onOpenAllResources(
              activeFilter === 'brand-kit' ? 'brand-kit'
                : activeFilter === 'asset' ? 'asset'
                : activeFilter === 'skills' || activeFilter === 'design-skill' ? 'skills'
                : mode.pickerCategory,
            )}
          >
            <span>{t('View all')}</span>
            <RemixIcon name="arrow-right-up-line" size={13} />
          </Button>
        </div>

        {mode.id === 'motion' && activeFilter === 'skills' && (
          <div className="om-sa-showcase-subtabs" role="tablist" aria-label={t('Skill categories')}>
            <Button
              variant="plain"
              type="button"
              role="tab"
              aria-selected={activeSkillCategory === 'all'}
              data-active={activeSkillCategory === 'all' || undefined}
              className="om-sa-showcase-subtab"
              onClick={() => setActiveSkillCategory('all')}
            >
              <span>{t('All')}</span>
              <span className="om-sa-tab-count">{motionSkills.length}</span>
            </Button>
            {skillCategories.map(cat => {
              const count = motionSkills.filter(s => s.category === cat).length;
              return (
                <Button
                  key={cat}
                  variant="plain"
                  type="button"
                  role="tab"
                  aria-selected={activeSkillCategory === cat}
                  data-active={activeSkillCategory === cat || undefined}
                  className="om-sa-showcase-subtab"
                  onClick={() => setActiveSkillCategory(cat)}
                >
                  <span>{t(cat)}</span>
                  <span className="om-sa-tab-count">{count}</span>
                </Button>
              );
            })}
          </div>
        )}

        <div className="om-sa-showcase-grid" aria-busy={isLoading}>
          {visibleCurated ? (
            visibleCurated.map(card => (
              <Button
                key={card.id}
                variant="plain"
                type="button"
                className="om-sa-showcase-card"
                onClick={() => onPickPrompt(card.prompt)}
              >
                <div className="om-sa-showcase-thumb" aria-hidden="true">
                  <img
                    src={card.poster}
                    alt=""
                    loading="lazy"
                    style={card.posterPosition ? { objectPosition: card.posterPosition } : undefined}
                  />
                </div>
                <span className="om-sa-showcase-check" aria-hidden="true">
                  <RemixIcon name="arrow-right-up-line" size={13} />
                </span>
                <div className="om-sa-showcase-meta">
                  <strong>{t(card.title)}</strong>
                  <small>{card.subtitle}</small>
                </div>
              </Button>
            ))
          ) : isLoading ? (
            Array.from({ length: 10 }, (_, idx) => (
              <div key={idx} className="om-sa-showcase-skeleton">
                <Skeleton style={{ width: '100%', height: 130 }} />
              </div>
            ))
          ) : !visibleResources.length ? (
            <div className="om-sa-showcase-empty">
              <p className="om-muted">{t('No matching resources found')}</p>
              <Button
                variant="ghost"
                className="om-button h-auto"
                onClick={() => onOpenAllResources(mode.pickerCategory)}
              >
                {t('Browse workspace resources')}
              </Button>
            </div>
          ) : (
            visibleResources.map(item => {
              const isSelected = selectedKeys.has(resourceKey(item));
              return (
                <Button
                  key={resourceKey(item)}
                  variant="plain"
                  type="button"
                  className="om-sa-showcase-card"
                  aria-pressed={isSelected}
                  data-selected={isSelected || undefined}
                  onClick={() => onToggleAttachment(item)}
                >
                  <ResourceShowcaseThumb item={item} active={active} />
                  <span className="om-sa-showcase-check" aria-hidden="true">
                    <RemixIcon name={isSelected ? 'check-line' : 'add-line'} size={13} />
                  </span>
                  <div className="om-sa-showcase-meta">
                    <strong>{item.title}</strong>
                    {item.subtitle && <small>{item.subtitle}</small>}
                  </div>
                </Button>
              );
            })
          )}
        </div>

        {hasMore && (
          <div ref={sentinelRef} className="om-sa-showcase-load-more">
            <Button
              variant="plain"
              type="button"
              className="om-sa-load-more-btn"
              onClick={() => setVisibleCount(prev => Math.min(totalCount, prev + PAGE_BATCH_SIZE))}
            >
              <span>{t('Load more')}</span>
              <span className="om-sa-tab-count">{totalCount - visibleCount}</span>
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
