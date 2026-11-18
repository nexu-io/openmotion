import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { aspectRatios, durations, motionSkills, skillCategories, skillPrompt, skillShortcut, type MotionSkill, type SkillCategory, type SkillMotif, type SkillParameters } from './skillCatalog';
import { GitHubMark } from '../../../packages/design-system/react/GitHubMark';
import { MotionIcon } from './icons';
import { motionApi } from './useWorkspace';
import { setupGuideUrl, type IntegrationInfo } from '../../../shared/integration';
import { Popover } from '../components/ui/Popover';
import * as tracking from './pageTracking';
import './skills.css';

/** The contribution guide section with the paste-ready Agent brief for a new library Skill. */
export const skillSubmissionUrl = 'https://github.com/nexu-io/openmotion/blob/main/CONTRIBUTING.md#submit-a-skill-with-your-agent';

/** Cards lead with the task, like the template library; the upstream project name stays verbatim as the source. */
const displayNameOf = (t: (text: string) => string) => (skill: MotionSkill) => t(skill.title);

const defaults: SkillParameters = { subject: '', duration: 10, aspect: '16:9', style: '' };

/** Open-source motion techniques the user can hand to an Agent through OpenMotion MCP. */
export function SkillsPage({ skillId, onSkillChange, hasProject = false }: { skillId: string | null; onSkillChange: (id: string | null) => void; hasProject?: boolean }) {
  const { t, locale } = useI18n(), toast = useToast(), displayName = displayNameOf(t);
  const [query, setQuery] = useState(''), [category, setCategory] = useState<SkillCategory | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [parameters, setParameters] = useState<SkillParameters>(defaults), [manualCopy, setManualCopy] = useState<{ text: string; surface: 'instruction' | 'command' } | null>(null);
  // Same install guide as template instructions; the repository guide is the fallback until the service answers.
  const [installUrl, setInstallUrl] = useState(() => setupGuideUrl(null));
  useEffect(() => {
    let cancelled = false;
    motionApi<IntegrationInfo>('/integration').then(info => { if (!cancelled) setInstallUrl(setupGuideUrl(info)); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const instruction = useRef<HTMLPreElement>(null), command = useRef<HTMLPreElement>(null), search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); search.current?.focus(); } };
    window.addEventListener('keydown', focus); return () => window.removeEventListener('keydown', focus);
  }, []);
  // Select the failed text in its own visible surface so one ⌘C copies the requested content.
  useEffect(() => {
    if (!manualCopy || (manualCopy.surface === 'command' && !commandOpen)) return;
    const element = manualCopy.surface === 'command' ? command.current : instruction.current;
    if (element?.isConnected) { element.focus(); window.getSelection()?.selectAllChildren(element); }
  }, [manualCopy, commandOpen]);
  const selected = motionSkills.find(skill => skill.id === skillId) ?? null;
  const matching = (group: SkillCategory | null, text: string) => {
    const needle = text.trim().toLocaleLowerCase();
    return motionSkills.filter(skill => (!group || skill.category === group)
      && (!needle || [skill.name, skill.title, displayName(skill), t(skill.useWhen), skill.tagline, t(skill.tagline), t(skill.output), skill.repository ?? 'OpenMotion'].some(value => value.toLocaleLowerCase().includes(needle))));
  };
  const visible = useMemo(() => matching(category, query), [query, category, t]);
  // One page view per visit; one detail view per opened Skill; one search result per settled query (500 ms after typing stops).
  useEffect(() => { tracking.reportSkillsPageView(hasProject); }, []);
  const detailView = useRef<string | undefined>(undefined), searchId = useRef<string | undefined>(undefined);
  useEffect(() => {
    detailView.current = selected ? tracking.newTrackingId() : undefined;
    if (selected && detailView.current) tracking.reportSkillDetailShown(selected, detailView.current);
  }, [selected?.id]);
  // Any change to the query, category or interface language (which changes what matches) ends the previous search; a card opened before the new one settles carries no search id.
  const resultCount = visible.length;
  useEffect(() => {
    searchId.current = undefined;
    if (!query.trim()) return;
    const timer = setTimeout(() => { searchId.current = tracking.newTrackingId(); tracking.reportSkillSearch(searchId.current, query, resultCount, category); }, 500);
    return () => clearTimeout(timer);
  }, [query, category, locale]);
  const pickCategory = (value: SkillCategory | null) => {
    setCategory(value);
    tracking.reportSkillCategory(value, matching(value, query).length);
  };
  // The instruction follows the interface language, including the example brief and borrowed technique.
  const prompt = selected ? skillPrompt({ ...selected, output: t(selected.output), example: t(selected.example), technique: t(selected.technique) }, parameters, locale, installUrl) : '';
  const shortcut = selected ? skillShortcut({ ...selected, title: displayName(selected), example: t(selected.example) }, parameters, locale, installUrl) : '';
  const latest = useRef({ instruction: prompt, command: shortcut }); latest.current = { instruction: prompt, command: shortcut };
  const open = (skill: MotionSkill, position: number) => { tracking.reportSkillCardOpened(skill, position, searchId.current); onSkillChange(skill.id); };
  // A failed copy keeps its exact text for manual copying only until the brief changes; then show the live text again.
  useEffect(() => { setManualCopy(null); }, [prompt, shortcut]);
  // The brief belongs to one skill; any route change (card, history, link) starts a fresh brief.
  useEffect(() => { setParameters(defaults); setManualCopy(null); setCommandOpen(false); }, [skillId]);
  async function copy(surface: 'instruction' | 'command' = 'instruction') {
    if (!selected) return;
    const text = surface === 'command' ? shortcut : prompt, attempt = tracking.newTrackingId(), brief = parameters, view = detailView.current;
    if (surface === 'command') tracking.reportSkillCommandCopyClicked(selected, view, attempt);
    else tracking.reportSkillDetailClick(selected, 'copy_instruction', view, attempt);
    try {
      await navigator.clipboard.writeText(text); setManualCopy(null); toast.showToast(t('Copied. Paste into your Agent.'), 'info');
      tracking.reportSkillCopyResult(selected, surface, 'clipboard_written', attempt, brief, view);
    }
    catch {
      // A late failure for a brief that has since changed must not restore stale text.
      if (latest.current[surface] !== text) return;
      tracking.reportSkillCopyResult(selected, surface, 'manual_fallback_shown', attempt, brief, view);
      setManualCopy({ text, surface }); toast.showToast(t(surface === 'command' ? 'Copy failed. Select and copy the command below.' : 'Copy failed. Select and copy the instruction below.'), 'error', 'feedback');
    }
  }
  return <div className="om-gallery-surface om-skills-page om-skills-library" data-detail={Boolean(selected)}>
    <StudioToastViewport {...toast} />
    <div className="om-skills-main">
      <div className="om-gallery-sticky-header">
        <div className="om-gallery-toolbar om-skills-toolbar">
          <div className="om-gallery-categories" role="group" aria-label={t('Skill category')}>
            <button aria-pressed={!category} onClick={() => pickCategory(null)}>{t('All')}</button>
            {skillCategories.map(value => <button key={value} aria-pressed={category === value} onClick={() => pickCategory(value)}>{t(value)}</button>)}
          </div>
          <label className="om-field om-search-field"><MotionIcon name="search" size={18} /><input ref={search} type="search" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search skills...')} aria-label={t('Search skills')} /><kbd aria-hidden="true">⌘ K</kbd></label>
        </div>
      </div>
      <main className="om-gallery-results">
        <section className="om-gallery-intro om-skills-intro"><span className="om-gallery-eyebrow">{t('Pick a skill. Let your Agent make it.')}</span><h1>{t('Teach your Agent new moves.')}</h1><p>{t('Pick a skill, fill in the brief and copy the instruction. Your Agent builds an editable project in OpenMotion.')}</p>
          <div className="om-gallery-intro-actions"><a className="om-gallery-submit" href={skillSubmissionUrl} target="_blank" rel="noopener noreferrer" onClick={() => tracking.reportSkillSubmitClicked()}>{t('Submit a skill')}<MotionIcon name="arrow-up-right" size={15} /></a></div>
        </section>
        <div className="om-gallery-masonry om-skills-grid">
          {visible.map((skill, index) => <SkillCard key={skill.id} skill={skill} name={displayName(skill)} useWhen={t(skill.useWhen)} category={t(skill.category)} selected={skill.id === skillId} onSelect={() => open(skill, index + 1)} />)}
        </div>
        {!visible.length && <div className="om-empty"><MotionIcon name="search" size={28} /><p>{t('No matching skills.')}</p><button className="om-button" onClick={() => { setQuery(''); setCategory(null); tracking.reportSkillFiltersCleared(); }}>{t('Clear filters')}</button></div>}
      </main>
    </div>
    {selected && <aside className="om-skill-detail om-surface-divider" aria-label={displayName(selected)}>
      <header className="om-skill-detail-header"><h2 className="om-subtitle">{displayName(selected)}</h2><button className="motion-icon-button" aria-label={t('Close skill')} onClick={() => { tracking.reportSkillDetailClick(selected, 'close_detail', detailView.current); onSkillChange(null); }}><RemixIcon name="close-line" size={18} /></button></header>
      <SkillMedia key={selected.id} skill={selected} large />
      <p className="om-skill-output"><span>{t('When to use')}</span>{t(selected.useWhen)}</p>
      <p className="om-skill-output"><span>{t('You get')}</span>{t(selected.output)}</p>
      {selected.repository ? <a className="om-skill-source" href={selected.repository} target="_blank" rel="noopener noreferrer" onClick={() => tracking.reportSkillDetailClick(selected, 'view_source', detailView.current)}><GitHubMark width={14} height={14} /><span>{selected.repository.replace('https://', '')}</span><span className="om-badge">{selected.license}</span><RemixIcon name="external-link-line" size={14} /></a>
        : <p className="om-skill-source"><RemixIcon name="flashlight-line" size={16} /><span>{t('OpenMotion skill')}</span></p>}
      {selected.cover?.source && <p className="om-skill-credit"><span>{t('Cover source')}</span>{/^https?:\/\//.test(selected.cover.source)
        ? <a href={selected.cover.source} target="_blank" rel="noopener noreferrer">{selected.cover.source.replace(/^https?:\/\//, '')}</a>
        : selected.cover.source}</p>}
      <section className="om-skill-form" aria-label={t('Brief')}>
        <label><span>{t('What to make')}</span><span className="om-field"><textarea rows={2} maxLength={500} value={parameters.subject} placeholder={t(selected.example)} onChange={event => setParameters({ ...parameters, subject: event.target.value })} /></span></label>
        <fieldset><legend>{t('Duration')}</legend><div className="om-skill-options">{durations.map(value => <button key={value} className="om-nav-item" aria-pressed={parameters.duration === value} onClick={() => setParameters({ ...parameters, duration: value })}>{t('{count}s', { count: value })}</button>)}</div></fieldset>
        <fieldset><legend>{t('Aspect ratio')}</legend><div className="om-skill-options">{aspectRatios.map(value => <button key={value} className="om-nav-item" aria-pressed={parameters.aspect === value} onClick={() => setParameters({ ...parameters, aspect: value })}>{value}</button>)}</div></fieldset>
        <label><span>{t('Style (optional)')}</span><span className="om-field"><input maxLength={200} value={parameters.style} placeholder={t('e.g. dark background, neon green accents')} onChange={event => setParameters({ ...parameters, style: event.target.value })} /></span></label>
      </section>
      <section className="om-skill-prompt" aria-label={t('Agent instruction')}>
        <span className="om-subtitle">{t('Agent instruction')}</span>
        <pre ref={instruction} data-manual={manualCopy?.surface === 'instruction'} tabIndex={0}>{manualCopy?.surface === 'instruction' ? manualCopy.text : prompt}</pre>
      </section>
      <footer className="om-skill-footer">
        <div className="om-skill-actions">
          <button className="om-button" data-primary onClick={() => void copy()}><RemixIcon name="file-copy-line" size={16} />{t('Copy for Agent')}</button>
          <Popover open={commandOpen} onOpenChange={open => { setCommandOpen(open); setManualCopy(null); if (open) tracking.reportSkillDetailClick(selected, 'open_command', detailView.current); }} side="top" align="end" aria-label={t('Use in another AI Agent')} className="om-skill-shortcut"
            trigger={<button className="om-button"><RemixIcon name="plug-line" size={16} />{t('Connect Agent')}</button>}>
            <strong>{t('Use in another AI Agent')}</strong>
            <p className="om-muted">{t('Copy this command into a chat with Codex, Claude or another AI Agent to run this skill.')}</p>
            <pre ref={command} data-manual={manualCopy?.surface === 'command'} tabIndex={0}>{manualCopy?.surface === 'command' ? manualCopy.text : shortcut}</pre>
            <button className="om-button" data-primary onClick={() => void copy('command')}><RemixIcon name="file-copy-line" size={16} />{t('Copy command')}</button>
          </Popover>
        </div>
      </footer>
    </aside>}
  </div>;
}

/** Gallery card shared with the template library: poster first, upstream demo video while hovered or focused. */
function SkillCard({ skill, name, useWhen, category, selected, onSelect }: { skill: MotionSkill; name: string; useWhen: string; category: string; selected: boolean; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false), [visible, setVisible] = useState(false), [near, setNear] = useState(false);
  const card = useRef<HTMLElement>(null);
  // Autoplay while at least half the card is on screen (paused off screen, so only the visible few load).
  // Reduced-motion users keep hover-to-play.
  useEffect(() => {
    const element = card.current;
    if (!element || typeof IntersectionObserver === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.5 });
    // Start buffering a screen ahead so playback is smooth when the card arrives.
    const ahead = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setNear(true); }, { rootMargin: '100% 0px' });
    observer.observe(element); ahead.observe(element);
    return () => { observer.disconnect(); ahead.disconnect(); };
  }, []);
  const active = hovered || visible;
  const setActive = setHovered;
  // Keep the cover clean; the task name and what it makes sit under it, so a glance says what the skill does.
  return <article ref={card} className="om-gallery-card om-skill-gallery-card" data-skill-id={skill.id} data-selected={selected}
    onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}>
    <button className="motion-gallery-card-cover om-gallery-cover" style={{ aspectRatio: skill.cover?.aspect ?? coverAspect[skill.motif.length % coverAspect.length] }} onClick={onSelect} aria-pressed={selected} aria-label={name}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}>
      <SkillMedia skill={skill} playing={active} near={near || hovered} />
      <span className="om-gallery-card-top"><span>{category}</span></span>
    </button>
    <button className="om-skill-card-meta" onClick={onSelect} tabIndex={-1} aria-hidden="true"><strong>{name}</strong><span>{useWhen}</span></button>
  </article>;
}
const coverAspect = [1.78, 1.35, 1, 1.78];

/** Upstream demo media when available; otherwise the package-token illustration. */
export function SkillMedia({ skill, playing = false, near = false, large = false }: { skill: MotionSkill; playing?: boolean; near?: boolean; large?: boolean }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const cover = failed ? undefined : skill.cover;
  const play = large || playing;
  if (!cover) return <SkillCover motif={skill.motif} name={skill.name} large={large} />;
  // A side-by-side before/after demo becomes a split cover (like an upscale preview):
  // each half fills one side, a divider runs down the middle and the skill name sits on it.
  if (cover.compare) return <span className="om-skill-media om-skill-split" data-large={large}>
    {(['before', 'after'] as const).map(side => <span key={side} className="om-skill-split-half" data-side={side}>
      <CoverMedia cover={cover} play={play} near={near} large={large} onFail={() => setFailed(true)} />
    </span>)}
    <span className="om-skill-split-divider" aria-hidden="true" />
    <span className="om-skill-split-label" aria-hidden="true"><RemixIcon name="sparkling-line" size={14} />{t('Remove the AI look')}</span>
    <span className="om-skill-split-caption" data-side="before" aria-hidden="true">{t('Before')}</span>
    <span className="om-skill-split-caption" data-side="after" aria-hidden="true">{t('After')}</span>
  </span>;
  return <span className="om-skill-media" data-large={large}><CoverMedia cover={cover} play={play} near={near} large={large} onFail={() => setFailed(true)} /></span>;
}

/** Poster first; the demo video (or GIF) plays only while the card is active.
 * The video element owns its poster, so playback starts in place with no image-to-video swap,
 * and it starts buffering as soon as the card nears the viewport. */
function CoverMedia({ cover, play, near, large, onFail }: { cover: NonNullable<MotionSkill['cover']>; play: boolean; near: boolean; large: boolean; onFail: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  // A video the browser cannot load or decode falls back to its poster before the motif illustration.
  const [videoFailed, setVideoFailed] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element || !cover.video) return;
    if (play) void element.play().catch(() => {}); else element.pause();
  }, [play, cover.video]);
  if (cover.video && !videoFailed) return <video ref={video} src={cover.video} poster={cover.poster} muted playsInline loop
    preload={large || near || play ? 'auto' : cover.poster ? 'none' : 'metadata'} aria-hidden="true" onError={() => cover.poster ? setVideoFailed(true) : onFail()} />;
  const still = cover.poster ?? cover.gif;
  return <>{cover.gif && <img src={play ? cover.gif : still} alt="" loading="lazy" decoding="async" onError={onFail} />}
    {!cover.gif && cover.poster && <img src={cover.poster} alt="" loading="lazy" decoding="async" onError={onFail} />}</>;
}

/** Package-token illustration: one motif per technique, animated only when motion is allowed. */
export function SkillCover({ motif, name, large = false }: { motif: SkillMotif; name: string; large?: boolean }) {
  return <span className="om-skill-cover om-media-surface" data-motif={motif} data-large={large} role="img" aria-label={name}>
    <svg viewBox="0 0 160 90" aria-hidden="true">{motifShapes[motif]}</svg>
  </span>;
}

const dots = (count: number, y: number) => Array.from({ length: count }, (_, index) => <circle key={`${y}-${index}`} className="om-skill-dot" style={{ animationDelay: `${index * 0.12}s` }} cx={24 + index * 16} cy={y} r="4" />);
const motifShapes: Record<SkillMotif, ReactElement> = {
  agent: <><rect className="om-skill-line" x="28" y="22" width="104" height="46" rx="8" /><path className="om-skill-stroke" d="M44 38h40M44 50h64" /><circle className="om-skill-pulse" cx="118" cy="36" r="6" /></>,
  scene: <><rect className="om-skill-line" x="18" y="20" width="36" height="50" rx="6" /><rect className="om-skill-fill om-skill-slide" x="62" y="20" width="36" height="50" rx="6" /><rect className="om-skill-line" x="106" y="20" width="36" height="50" rx="6" /></>,
  layout: <><rect className="om-skill-fill om-skill-morph" x="20" y="18" width="56" height="54" rx="8" /><rect className="om-skill-line" x="86" y="18" width="54" height="24" rx="6" /><rect className="om-skill-line" x="86" y="48" width="54" height="24" rx="6" /></>,
  curve: <><path className="om-skill-line" d="M16 74H146M16 74V14" /><path className="om-skill-stroke om-skill-draw" d="M16 74C60 74 70 18 146 18" /><circle className="om-skill-pulse" cx="146" cy="18" r="5" /></>,
  stagger: <>{dots(8, 30)}{dots(8, 46)}{dots(8, 62)}</>,
  math: <><path className="om-skill-line" d="M12 45H148M80 10V80" /><path className="om-skill-stroke om-skill-draw" d="M12 45C24 20 36 20 48 45S72 70 84 45 108 20 120 45 144 70 148 60" /><circle className="om-skill-line" cx="80" cy="45" r="18" /></>,
  vector: <><polygon className="om-skill-fill om-skill-spin" points="50,20 70,58 30,58" /><circle className="om-skill-line om-skill-pulse" cx="96" cy="44" r="18" /><rect className="om-skill-fill om-skill-slide" x="118" y="30" width="26" height="26" rx="4" /></>,
  playback: <><path className="om-skill-line" d="M20 64H140" /><circle className="om-skill-fill om-skill-scrub" cx="20" cy="64" r="6" /><path className="om-skill-fill" d="M70 22l24 14-24 14z" /></>,
  depth: <><path className="om-skill-line" d="M80 14l40 20v32L80 86 40 66V34z" /><path className="om-skill-line" d="M40 34l40 20 40-20M80 54v32" /><path className="om-skill-fill om-skill-float" d="M80 14l40 20-40 20-40-20z" /></>,
  frames: <><rect className="om-skill-line" x="18" y="24" width="30" height="42" rx="4" /><rect className="om-skill-line" x="54" y="24" width="30" height="42" rx="4" /><rect className="om-skill-line" x="90" y="24" width="30" height="42" rx="4" /><rect className="om-skill-fill om-skill-frame" x="18" y="24" width="30" height="42" rx="4" /><path className="om-skill-stroke" d="M128 45h16" /></>,
  canvas: <><rect className="om-skill-line" x="14" y="14" width="132" height="62" rx="6" /><rect className="om-skill-fill om-skill-drag" x="28" y="28" width="34" height="22" rx="4" /><rect className="om-skill-line" x="98" y="44" width="34" height="22" rx="4" /><path className="om-skill-stroke" d="M62 39C80 39 80 55 98 55" /></>,
  icon: <><circle className="om-skill-line" cx="80" cy="45" r="26" /><path className="om-skill-stroke om-skill-draw" d="M66 46l10 10 20-22" /></>,
  sequence: <><path className="om-skill-line" d="M16 72H144" /><rect className="om-skill-fill om-skill-dot" style={{ animationDelay: '0s' }} x="20" y="22" width="34" height="10" rx="5" /><rect className="om-skill-fill om-skill-dot" style={{ animationDelay: '.3s' }} x="58" y="38" width="44" height="10" rx="5" /><rect className="om-skill-fill om-skill-dot" style={{ animationDelay: '.6s' }} x="106" y="54" width="34" height="10" rx="5" /></>,
  character: <><circle className="om-skill-fill" cx="80" cy="24" r="9" /><path className="om-skill-stroke" d="M80 34v24M80 58l-12 18M80 58l12 18M80 42l-16 8" /><path className="om-skill-stroke om-skill-wave" d="M80 42l16-12" /></>,
  globe: <><circle className="om-skill-line" cx="80" cy="45" r="30" /><ellipse className="om-skill-line om-skill-turn" cx="80" cy="45" rx="12" ry="30" /><path className="om-skill-line" d="M50 45h60" /><path className="om-skill-stroke om-skill-draw" d="M60 30C80 6 110 20 104 50" /></>,
  levelup: <><rect className="om-skill-line" x="24" y="56" width="112" height="12" rx="6" /><rect className="om-skill-fill om-skill-grow" x="24" y="56" width="112" height="12" rx="6" /><path className="om-skill-fill om-skill-pulse" d="M80 14l6 12 13 2-9 9 2 13-12-6-12 6 2-13-9-9 13-2z" /></>,
  orbit: <><ellipse className="om-skill-line" cx="80" cy="45" rx="54" ry="18" /><circle className="om-skill-fill" cx="80" cy="45" r="14" /><circle className="om-skill-fill om-skill-orbit" cx="134" cy="45" r="5" /></>,
  promo: <><rect className="om-skill-line" x="22" y="18" width="116" height="54" rx="6" /><rect className="om-skill-fill om-skill-dot" style={{ animationDelay: '0s' }} x="32" y="28" width="28" height="34" rx="3" /><rect className="om-skill-fill om-skill-dot" style={{ animationDelay: '.25s' }} x="66" y="28" width="28" height="34" rx="3" /><rect className="om-skill-fill om-skill-dot" style={{ animationDelay: '.5s' }} x="100" y="28" width="28" height="34" rx="3" /><path className="om-skill-stroke" d="M22 82h116" /><circle className="om-skill-fill om-skill-scrub" cx="22" cy="82" r="3" /></>,
  photo: <><ellipse className="om-skill-line" cx="80" cy="72" rx="34" ry="7" /><rect className="om-skill-fill om-skill-float" x="64" y="24" width="32" height="42" rx="8" /><path className="om-skill-stroke" d="M22 20l14 10M138 20l-14 10" /></>,
  listing: <><rect className="om-skill-fill" x="18" y="16" width="56" height="58" rx="5" /><rect className="om-skill-line om-skill-dot" style={{ animationDelay: '0s' }} x="82" y="16" width="26" height="26" rx="4" /><rect className="om-skill-line om-skill-dot" style={{ animationDelay: '.2s' }} x="114" y="16" width="26" height="26" rx="4" /><rect className="om-skill-line om-skill-dot" style={{ animationDelay: '.4s' }} x="82" y="48" width="58" height="26" rx="4" /></>,
  narration: <><rect className="om-skill-line" x="20" y="16" width="120" height="44" rx="6" /><path className="om-skill-stroke om-skill-draw" d="M36 46l18-14 16 10 20-16 18 12" />{[0, 1, 2, 3, 4, 5, 6, 7, 8].map(index => <rect key={index} className="om-skill-fill om-skill-dot" style={{ animationDelay: `${index * 0.1}s` }} x={44 + index * 8} y={70 - (index % 3) * 3} width="4" height={8 + (index % 3) * 6} rx="2" />)}</>,
  brand: <><circle className="om-skill-fill om-skill-spin" cx="48" cy="45" r="18" /><rect className="om-skill-fill" x="84" y="26" width="16" height="38" rx="3" /><rect className="om-skill-line" x="104" y="26" width="16" height="38" rx="3" /><rect className="om-skill-line" x="124" y="26" width="16" height="38" rx="3" /></>,
  thumbnail: <><rect className="om-skill-line" x="18" y="14" width="124" height="62" rx="6" /><circle className="om-skill-fill" cx="112" cy="46" r="20" /><path className="om-skill-stroke om-skill-pulse" d="M30 34h44M30 50h30" /></>,
  polish: <><rect className="om-skill-line" x="16" y="18" width="60" height="54" rx="6" /><rect className="om-skill-fill" x="84" y="18" width="60" height="54" rx="6" /><path className="om-skill-stroke om-skill-draw" d="M66 45h28" /></>,
  particles: <>{Array.from({ length: 14 }, (_, index) => <circle key={index} className="om-skill-dot om-skill-burst" style={{ animationDelay: `${(index % 7) * 0.15}s`, transformOrigin: '80px 45px', ['--angle' as string]: `${index * 26}deg` }} cx="80" cy="45" r={index % 3 + 2} />)}</>,
};
