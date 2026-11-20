import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from 'open-design-ui/button';
import { RemixIcon } from '../../../../packages/design-system/react/RemixIcons';
import {
  designBriefPrompt, findDesignScenario,
  type DesignSkillSummary, type DesignTemplateSummary,
} from '../../../../shared/design-project';
import { IconButton } from 'open-design-ui/icon-button';
import { StudioToastViewport } from '../../components/StudioToastViewport';
import { useToast } from '../../hooks/useToast';
import { useI18n } from '../../i18n/I18n';
import { useIntegrationInfo } from '../../motion/useIntegrationInfo';
import { BrandKitPicker, type SelectedBrandKit } from '../BrandKitPicker';
import { designClient } from '../designClient';
import { DesignProjectList } from '../DesignProjectList';
import { DesignTemplateDetailModal } from '../DesignTemplateDetailModal';
import { ScaledPreviewThumb } from '../ScaledPreviewThumb';
import type { DesignTabId } from './DesignSceneTabs';
import '../design.css';

export function DesignScenePage({
  scene,
  onSelectDesignScene,
  onOpenProject,
  onOpenMcp,
}: {
  scene: DesignTabId;
  onSelectDesignScene: (scene: DesignTabId) => void;
  onOpenProject: (projectId: string) => void;
  onOpenMcp: () => void;
}) {
  const { t, locale } = useI18n();
  const { info: integrationInfo } = useIntegrationInfo();
  const toast = useToast();
  const showToast = toast.showToast;
  const scenario = scene === 'projects' ? null : findDesignScenario(scene) ?? null;

  const [brief, setBrief] = useState('');
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [selectedBrandKit, setSelectedBrandKit] = useState<SelectedBrandKit | null>(null);

  const [skills, setSkills] = useState<DesignSkillSummary[]>([]);
  const [skillQuery, setSkillQuery] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<DesignSkillSummary[]>([]);
  const [skillOpen, setSkillOpen] = useState(false);

  const [selectedTemplates, setSelectedTemplates] = useState<DesignTemplateSummary[]>([]);
  const [templates, setTemplates] = useState<DesignTemplateSummary[]>([]);
  const [templateQuery, setTemplateQuery] = useState('');
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [remixingId, setRemixingId] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<DesignTemplateSummary | null>(null);

  // @ mention autocomplete state
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  useEffect(() => {
    setPlaceholderIndex(0);
    setSelectedTemplates([]);
    setSelectedSkills([]);
    setManualPrompt(null);
    setMention(null);
    if (!scenario || scenario.examples.length <= 1) return;
    const id = window.setInterval(() => setPlaceholderIndex(i => (i + 1) % scenario.examples.length), 6000);
    return () => window.clearInterval(id);
  }, [scenario?.id]);

  useEffect(() => {
    designClient.listSkills().then(res => { if (Array.isArray(res?.skills)) setSkills(res.skills); }).catch(() => setSkills([]));
  }, []);

  useEffect(() => {
    if (!scenario) return;
    let cancelled = false;
    setTemplatesLoading(true);
    designClient.listTemplates({ scenario: scenario.id, q: templateQuery.trim() || undefined, limit: 24 })
      .then(res => { if (!cancelled && Array.isArray(res?.items)) setTemplates(res.items); })
      .catch(() => { if (!cancelled) setTemplates([]); })
      .finally(() => { if (!cancelled) setTemplatesLoading(false); });
    return () => { cancelled = true; };
  }, [scenario?.id, templateQuery]);

  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    const list = skills.filter(s => !q || s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.id.includes(q));
    return [...list].sort((a, b) => Number(b.scenario === scenario?.id) - Number(a.scenario === scenario?.id)).slice(0, 48);
  }, [skills, skillQuery, scenario?.id]);

  type MentionOption =
    | { kind: 'template'; id: string; label: string; sub: string; item: DesignTemplateSummary }
    | { kind: 'skill'; id: string; label: string; sub: string; item: DesignSkillSummary }
    | { kind: 'prompt'; id: string; label: string; sub: string; text: string };

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    const out: MentionOption[] = [];
    for (const tpl of templates) {
      if (!q || tpl.title.toLowerCase().includes(q) || tpl.id.toLowerCase().includes(q) || tpl.category.toLowerCase().includes(q)) {
        out.push({ kind: 'template', id: `tpl:${tpl.id}`, label: tpl.title, sub: `@template:${tpl.id}`, item: tpl });
        if (out.length >= 6) break;
      }
    }
    let skillCount = 0;
    for (const sk of skills) {
      if (!q || sk.title.toLowerCase().includes(q) || sk.id.toLowerCase().includes(q)) {
        out.push({ kind: 'skill', id: `sk:${sk.id}`, label: sk.title, sub: `@skill:${sk.id}`, item: sk });
        if (++skillCount >= 6) break;
      }
    }
    for (const [i, ex] of (scenario?.examples ?? []).entries()) {
      if (!q || ex.toLowerCase().includes(q)) {
        out.push({ kind: 'prompt', id: `pr:${i}`, label: ex, sub: t('Prompt'), text: ex });
      }
    }
    return out;
  }, [mention, templates, skills, scenario?.examples, t]);

  const syncMention = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    if (match) {
      const start = cursor - match[2].length - 1;
      setMention({ start, end: cursor, query: match[2] });
      setMentionIndex(0);
    } else {
      setMention(null);
    }
  };

  const applyMention = (opt: MentionOption) => {
    if (!mention) return;
    let insert = '';
    if (opt.kind === 'template') {
      insert = `@template:${opt.item.id} `;
      setSelectedTemplates(prev => prev.some(x => x.id === opt.item.id) ? prev : [...prev, opt.item]);
    } else if (opt.kind === 'skill') {
      insert = `@skill:${opt.item.id} `;
      setSelectedSkills(prev => prev.some(x => x.id === opt.item.id) ? prev : [...prev, opt.item]);
    } else {
      insert = `${opt.text} `;
    }
    const next = brief.slice(0, mention.start) + insert + brief.slice(mention.end);
    setBrief(next);
    setMention(null);
    const pos = mention.start + insert.length;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  };

  const triggerAtMention = () => {
    const el = textareaRef.current;
    const pos = el?.selectionStart ?? brief.length;
    const prefix = pos > 0 && !/\s$/.test(brief.slice(0, pos)) ? ' @' : '@';
    const next = brief.slice(0, pos) + prefix + brief.slice(pos);
    const nextPos = pos + prefix.length;
    setBrief(next);
    setMention({ start: nextPos - 1, end: nextPos, query: '' });
    setMentionIndex(0);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(nextPos, nextPos);
    });
  };

  const toggleSkill = (sk: DesignSkillSummary) => {
    setSelectedSkills(prev => {
      const exists = prev.some(x => x.id === sk.id);
      if (exists) return prev.filter(x => x.id !== sk.id);
      const token = `@skill:${sk.id}`;
      setBrief(b => b.includes(token) ? b : (b.trim() ? `${b.trim()} ${token}` : token));
      return [...prev, sk];
    });
  };

  const appendExample = (example: string) => {
    setBrief(prev => {
      const trimmed = prev.trim();
      if (!trimmed) return example;
      if (trimmed.includes(example)) return prev;
      return `${trimmed}\n${example}`;
    });
    textareaRef.current?.focus();
  };

  const copyInstruction = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setManualPrompt(null);
      showToast(t('Copied. Paste into your Agent.'), 'info', 'feedback');
    } catch {
      setManualPrompt(text);
      showToast(t('Could not copy. Select and copy the text manually.'), 'error', 'feedback');
    }
  }, [showToast, t]);

  const handleCopyBrief = () => {
    if (!scenario) return;
    const text = brief.trim() || scenario.examples[placeholderIndex] || scenario.hint;
    const prompt = designBriefPrompt({
      scenario: scenario.id,
      brief: text,
      designSystemId: selectedBrandKit?.catalogId ?? selectedBrandKit?.id ?? null,
      skillIds: selectedSkills.map(s => s.id),
      templateIds: selectedTemplates.map(tpl => tpl.id),
      language: locale !== 'en' ? locale : null,
      integration: integrationInfo,
    });
    void copyInstruction(prompt);
  };

  const handleCreateBlank = async () => {
    if (!scenario) return;
    setCreating(true);
    try {
      const { project } = await designClient.createProject({
        scenario: scenario.id,
        templateId: selectedTemplates[0]?.id ?? null,
        designSystemId: selectedBrandKit?.catalogId ?? selectedBrandKit?.id ?? null,
      });
      onOpenProject(project.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not create project'), 'error', 'feedback');
    } finally {
      setCreating(false);
    }
  };

  const handleRemixTemplate = async (template: DesignTemplateSummary) => {
    setRemixingId(template.id);
    try {
      const { project } = await designClient.createProject({
        scenario: template.scenario,
        templateId: template.id,
        designSystemId: selectedBrandKit?.catalogId ?? selectedBrandKit?.id ?? null,
      });
      onOpenProject(project.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not remix template'), 'error', 'feedback');
    } finally {
      setRemixingId(null);
    }
  };

  const handleUseTemplateWithAgent = (template: DesignTemplateSummary) => {
    const nextTemplates = selectedTemplates.some(x => x.id === template.id) ? selectedTemplates : [...selectedTemplates, template];
    setSelectedTemplates(nextTemplates);
    const token = `@template:${template.id}`;
    const seed = template.examplePrompt || `Adapt the "${template.title}" template for my project.`;
    const nextBrief = brief.trim()
      ? (brief.includes(token) ? brief.trim() : `${brief.trim()} ${token}`)
      : `${token} ${seed}`;
    setBrief(nextBrief);
    const prompt = designBriefPrompt({
      scenario: template.scenario,
      brief: nextBrief,
      designSystemId: selectedBrandKit?.catalogId ?? selectedBrandKit?.id ?? null,
      skillIds: selectedSkills.map(s => s.id),
      templateIds: nextTemplates.map(tpl => tpl.id),
      language: locale !== 'en' ? locale : null,
      integration: integrationInfo,
    });
    void copyInstruction(prompt);
  };

  return (
    <div className="om-design-workspace-shell">

      {scene === 'projects' || !scenario ? (
        <div className="om-design-scroll-body">
          <div className="om-design-page">
            <div className="om-design-section-head">
              <div>
                <h2 className="om-design-hero-title" style={{ fontSize: 28 }}>{t('Design projects')}</h2>
                <p className="om-design-hero-sub" style={{ marginTop: 4 }}>{t('Preview responsive HTML designs, annotate elements, inspect versions and hand off edits to your MCP Agent.')}</p>
              </div>
              <Button type="button" size="sm" variant="secondary" icon={<RemixIcon name="plug-line" size={14} />} onClick={onOpenMcp}>
                {t('Connect an Agent')}
              </Button>
            </div>
            <DesignProjectList onOpen={onOpenProject} />
          </div>
        </div>
      ) : (
        <>
          {/* Middle scrollable gallery & templates area (aligned with Image Studio & Manus) */}
          <div className="om-design-scroll-body">
            <div className="om-design-page om-design-page-with-dock">
              <div className="om-design-section-head">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <h2 className="om-design-section-title" style={{ fontSize: 22 }}>{t(scenario.label)}</h2>
                    <span className="om-design-muted">{t(scenario.hint)}</span>
                  </div>
                </div>
                <div className="om-design-header-group">
                  <input
                    type="search"
                    className="om-design-input"
                    placeholder={t('Filter templates…')}
                    aria-label={t('Filter templates…')}
                    value={templateQuery}
                    onChange={e => setTemplateQuery(e.target.value)}
                  />
                  <Button type="button" size="md" variant="secondary" loading={creating} icon={<RemixIcon name="add-line" size={15} />} onClick={() => void handleCreateBlank()}>
                    {t('Create blank project')}
                  </Button>
                </div>
              </div>

              {/* Quick starter prompt chips */}
              {scenario.examples.length > 0 && (
                <div className="om-design-example-chips" style={{ justifyContent: 'flex-start', maxWidth: 'none' }}>
                  {scenario.examples.map(example => (
                    <Button
                      key={example}
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="om-design-example-chip"
                      title={example}
                      icon={<RemixIcon name="sparkling-line" size={13} />}
                      onClick={() => appendExample(example)}
                    >
                      <span className="om-design-example-chip-label">{example}</span>
                    </Button>
                  ))}
                </div>
              )}

              {/* Template gallery */}
              <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="om-design-section-head">
                  <h3 className="om-design-section-title">{t('{scenario} templates', { scenario: t(scenario.label) })}</h3>
                </div>

                {templatesLoading ? (
                  <div className="om-design-muted">{t('Loading templates…')}</div>
                ) : templates.length === 0 ? (
                  <div className="om-design-muted">{t('No matching templates.')}</div>
                ) : (
                  <div className="om-design-grid">
                    {templates.map(tpl => (
                      <article key={tpl.id} className="om-design-card om-design-gallery-card" onClick={() => setPreviewTemplate(tpl)}>
                        <ScaledPreviewThumb
                          src={tpl.previewUrl}
                          title={tpl.title}
                          badge={tpl.category !== tpl.scenario ? tpl.category : undefined}
                          topRight={
                            <div className="om-design-card-hover-actions" onClick={e => e.stopPropagation()}>
                              <Button type="button" size="sm" variant="primary" loading={remixingId === tpl.id} onClick={() => void handleRemixTemplate(tpl)}>
                                {t('Remix')}
                              </Button>
                              <IconButton
                                aria-label={t('Use with Agent')}
                                icon={<RemixIcon name="plug-line" size={14} />}
                                onClick={() => handleUseTemplateWithAgent(tpl)}
                              />
                            </div>
                          }
                        />
                        <div className="om-design-card-body om-design-gallery-body">
                          <strong className="om-design-card-title">{tpl.title}</strong>
                          <p className="om-design-card-desc">{tpl.description}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              {/* Recent projects for this scenario */}
              <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="om-design-section-head">
                  <h3 className="om-design-section-title">{t('Recent projects')}</h3>
                  <Button type="button" size="sm" variant="ghost" onClick={() => onSelectDesignScene('projects')}>{t('View all')}</Button>
                </div>
                <DesignProjectList scenario={scenario.id} compact onOpen={onOpenProject} />
              </section>
            </div>
          </div>

          {/* Bottom floating composer dock (aligned with Image Studio & Manus) */}
          <div className="om-design-bottom-dock-wrap">
            <div className="om-design-composer om-design-bottom-composer" style={{ position: 'relative', overflow: 'visible' }}>
              {mention && mentionOptions.length > 0 && (
                <div className="om-design-popover om-design-mention-menu om-design-mention-up" role="listbox" aria-label={t('Mention template or skill')}>
                  {mentionOptions.map((opt, idx) => (
                    <Button
                      key={opt.id}
                      type="button"
                      size="sm"
                      variant={idx === mentionIndex ? 'secondary' : 'ghost'}
                      className="om-design-mention-item"
                      icon={<RemixIcon name={opt.kind === 'template' ? 'layout-line' : opt.kind === 'skill' ? 'book-open-line' : 'sparkling-line'} size={14} />}
                      onMouseEnter={() => setMentionIndex(idx)}
                      onClick={() => applyMention(opt)}
                    >
                      <span className="om-design-mention-label">{opt.label}</span>
                      <span className="om-design-muted" style={{ fontSize: 11 }}>{opt.sub}</span>
                    </Button>
                  ))}
                </div>
              )}

              {(selectedTemplates.length > 0 || selectedSkills.length > 0) && (
                <div className="om-design-attached-chips" style={{ paddingTop: 10 }}>
                  {selectedTemplates.map(tpl => (
                    <span key={tpl.id} className="om-design-badge">
                      <RemixIcon name="layout-line" size={12} />
                      <span>@template:{tpl.id}</span>
                      <IconButton aria-label={t('Clear template')} icon={<RemixIcon name="close-line" size={12} />} onClick={() => setSelectedTemplates(prev => prev.filter(x => x.id !== tpl.id))} />
                    </span>
                  ))}
                  {selectedSkills.map(sk => (
                    <span key={sk.id} className="om-design-badge">
                      <RemixIcon name="book-open-line" size={12} />
                      <span>@skill:{sk.id}</span>
                      <IconButton aria-label={t('Clear design skill')} icon={<RemixIcon name="close-line" size={12} />} onClick={() => setSelectedSkills(prev => prev.filter(x => x.id !== sk.id))} />
                    </span>
                  ))}
                </div>
              )}

              <textarea
                ref={textareaRef}
                className="om-design-composer-input om-design-bottom-input"
                aria-label={t('Design brief')}
                placeholder={`${scenario.examples[placeholderIndex] ?? t(scenario.hint)}  (${t('Type @ to mention templates or skills')})`}
                value={brief}
                onChange={e => {
                  setBrief(e.target.value);
                  syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
                }}
                onKeyDown={e => {
                  if (!mention || mentionOptions.length === 0) return;
                  if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => (i + 1) % mentionOptions.length); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => (i - 1 + mentionOptions.length) % mentionOptions.length); }
                  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionOptions[mentionIndex] ?? mentionOptions[0]); }
                  else if (e.key === 'Escape') { e.preventDefault(); setMention(null); }
                }}
              />

              <div className="om-design-composer-dock">
                <div className="om-design-header-group">
                  <Button type="button" size="sm" variant="ghost" onClick={triggerAtMention} title={t('Type @ to mention templates or skills')}>
                    @
                  </Button>

                  <span className="om-design-badge">
                    <RemixIcon name={scenario.icon} size={12} />
                    {t(scenario.label)}
                  </span>

                  {/* Brand Kit picker backed by Motion Brand Kits */}
                  <BrandKitPicker selected={selectedBrandKit} onSelect={setSelectedBrandKit} />

                  {/* Multi-select Design Skill picker */}
                  <Popover.Root modal={false} open={skillOpen} onOpenChange={setSkillOpen}>
                    <Popover.Trigger render={
                      <Button type="button" size="sm" variant={selectedSkills.length > 0 ? 'secondary' : 'ghost'} icon={<RemixIcon name="book-open-line" size={14} />}>
                        {selectedSkills.length > 0 ? `${t('Design skill')} (${selectedSkills.length})` : t('Design skill')}
                      </Button>
                    } />
                    <Popover.Portal>
                      <Popover.Positioner side="top" align="start" sideOffset={6} className="z-150">
                        <Popover.Popup className="om-design-popover" style={{ width: 340, maxHeight: 340 }}>
                          <input
                            type="search"
                            className="om-design-input"
                            placeholder={t('Search design skills…')}
                            value={skillQuery}
                            onChange={e => setSkillQuery(e.target.value)}
                          />
                          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {selectedSkills.length > 0 && (
                              <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedSkills([])}>
                                {t('Clear design skill')}
                              </Button>
                            )}
                            {filteredSkills.map(sk => {
                              const active = selectedSkills.some(x => x.id === sk.id);
                              return (
                                <Button
                                  key={sk.id}
                                  type="button"
                                  size="sm"
                                  variant={active ? 'secondary' : 'ghost'}
                                  style={{ justifyContent: 'space-between' }}
                                  onClick={() => toggleSkill(sk)}
                                >
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{active ? '✓ ' : ''}{sk.title}</span>
                                  {sk.scenario && <span className="om-design-badge">{sk.scenario}</span>}
                                </Button>
                              );
                            })}
                          </div>
                        </Popover.Popup>
                      </Popover.Positioner>
                    </Popover.Portal>
                  </Popover.Root>
                </div>

                <div className="om-design-header-group">
                  <Button type="button" size="sm" variant="primary" icon={<RemixIcon name="file-copy-line" size={14} />} onClick={handleCopyBrief}>
                    {t('Copy to Agent')}
                  </Button>
                </div>
              </div>
            </div>

            {manualPrompt && (
              <div style={{ width: '100%', maxWidth: 820, marginTop: 8 }}>
                <textarea className="om-design-textarea" readOnly value={manualPrompt} onFocus={e => e.currentTarget.select()} />
              </div>
            )}
          </div>
        </>
      )}

      {/* Motion-aligned full template detail view */}
      {previewTemplate && (
        <DesignTemplateDetailModal
          templates={templates}
          index={Math.max(0, templates.findIndex(tItem => tItem.id === previewTemplate.id))}
          remixing={remixingId === previewTemplate.id}
          onNavigate={nextIdx => { const next = templates[nextIdx]; if (next) setPreviewTemplate(next); }}
          onClose={() => setPreviewTemplate(null)}
          onRemix={tpl => { void handleRemixTemplate(tpl); setPreviewTemplate(null); }}
          onUseWithAgent={tpl => { handleUseTemplateWithAgent(tpl); setPreviewTemplate(null); }}
        />
      )}

      <StudioToastViewport {...toast} />
    </div>
  );
}
