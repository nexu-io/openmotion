import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from 'open-design-ui/button';
import { DisclosureRow } from '../../../packages/design-system/react/DisclosureRow';
import { RemixIcon } from '../../../packages/design-system/react/RemixIcons';
import {
  designRoutes, designScenarios, findDesignScenario,
  type DesignEditorApp, type DesignProject, type DesignScenarioId,
} from '../../../shared/design-project';
import { IconButton } from 'open-design-ui/icon-button';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { FieldInput } from '../components/ui/FormField';
import { Menu, MenuRadioGroup, MenuRadioItem } from '../components/ui/Menu';
import { Tooltip } from '../components/ui/Tooltip';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { MotionIcon } from '../motion/icons';
import { designClient } from './designClient';
import { ScaledPreviewThumb } from './ScaledPreviewThumb';
import './design.css';

export function DesignProjectList({
  scenario,
  layout = 'gallery',
  onViewAll,
  onOpen,
  onCreate,
  onProjectsChanged,
  refreshKey,
}: {
  scenario?: DesignScenarioId;
  layout?: 'gallery' | 'compact' | 'sidebar';
  onViewAll?: () => void;
  onOpen: (projectId: string) => void;
  onCreate?: (projectId: string) => void;
  onProjectsChanged?: () => void;
  refreshKey?: number;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const showToast = toast.showToast;
  const [projects, setProjects] = useState<DesignProject[]>([]);
  const [editors, setEditors] = useState<DesignEditorApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filterScenario, setFilterScenario] = useState<string>(scenario ?? 'all');
  const [trashed, setTrashed] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; original: string; draft: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastLoad = useRef(0);
  const compact = layout === 'compact';
  const sidebar = layout === 'sidebar';

  const load = useCallback(async () => {
    const request = ++lastLoad.current;
    setLoading(true);
    try {
      const res = await designClient.listProjects({ scenario, trashed });
      if (request === lastLoad.current && Array.isArray(res?.projects)) setProjects(res.projects);
    } catch (err) {
      if (request === lastLoad.current) showToast(err instanceof Error ? err.message : t('Could not load design projects'), 'error', 'feedback');
    } finally {
      if (request === lastLoad.current) setLoading(false);
    }
  }, [scenario, trashed, showToast, t]);

  useEffect(() => {
    void load();
    return () => { ++lastLoad.current; };
  }, [load, refreshKey]);
  useEffect(() => {
    designClient.detectEditors().then(res => { if (Array.isArray(res?.editors)) setEditors(res.editors.filter(e => e.available)); }).catch(() => {});
  }, []);

  const refreshAfterChange = () => {
    if (onProjectsChanged) onProjectsChanged();
    else void load();
  };

  const toggleTrash = () => {
    ++lastLoad.current;
    setLoading(true);
    setProjects([]);
    setRenaming(null);
    setTrashed(current => !current);
  };

  const handleCreate = async (scen: DesignScenarioId) => {
    setNewMenuOpen(false);
    try {
      const { project } = await designClient.createProject({ scenario: scen });
      if (onCreate) onCreate(project.id); else onOpen(project.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not create project'), 'error', 'feedback');
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const res = await designClient.importZipFile(file);
      showToast(t('Imported {count} design project(s)', { count: res.projects.length }), 'info', 'feedback');
      refreshAfterChange();
      if (res.projects[0]) onOpen(res.projects[0].id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not import ZIP'), 'error', 'feedback');
    } finally {
      setImporting(false);
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const next = renaming.draft.trim();
    const target = renaming;
    setRenaming(null);
    if (!next || next === target.original) return;
    try {
      await designClient.renameProject(target.id, next, target.original);
      showToast(t('Project renamed'), 'info', 'feedback');
      refreshAfterChange();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not rename project'), 'error', 'feedback');
    }
  };

  const handleDuplicate = async (project: DesignProject) => {
    try {
      await designClient.duplicateProject(project.id);
      showToast(t('Project duplicated'), 'info', 'feedback');
      refreshAfterChange();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not duplicate project'), 'error', 'feedback');
    }
  };

  const handleTrash = async (project: DesignProject) => {
    try {
      await designClient.trashProject(project.id);
      showToast(t('Moved to Trash'), 'info', 'feedback');
      refreshAfterChange();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not trash project'), 'error', 'feedback');
    }
  };

  const handleRestore = async (project: DesignProject) => {
    try {
      await designClient.restoreProject(project.id);
      showToast(t('Project restored'), 'info', 'feedback');
      refreshAfterChange();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not restore project'), 'error', 'feedback');
    }
  };

  const handleDelete = async (project: DesignProject) => {
    try {
      await designClient.deleteProject(project.id);
      showToast(t('Project permanently deleted'), 'info', 'feedback');
      refreshAfterChange();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not delete project'), 'error', 'feedback');
    }
  };

  const handleExport = async (project: DesignProject, format: 'zip' | 'open-design') => {
    try {
      const filename = await designClient.downloadExport(project.id, { format });
      showToast(t('Exported {filename}', { filename }), 'info', 'feedback');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Export failed'), 'error', 'feedback');
    }
  };

  const handleOpenIn = async (project: DesignProject, editor: DesignEditorApp) => {
    try {
      await designClient.openIn(project.id, editor.id);
      showToast(t('Opened in {app}', { app: editor.label }), 'info', 'feedback');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not open editor'), 'error', 'feedback');
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter(p => {
      if (!scenario && filterScenario !== 'all' && p.scenario !== filterScenario) return false;
      if (q && !p.title.toLowerCase().includes(q) && !p.scenario.includes(q)) return false;
      return true;
    }).slice(0, compact ? 6 : 200);
  }, [projects, query, filterScenario, scenario, compact]);

  if (compact && filtered.length === 0) return <StudioToastViewport {...toast} />;

  const emptyMessage = query.trim() || (!scenario && filterScenario !== 'all')
    ? 'No matching projects'
    : trashed ? 'Trash is empty.' : 'No design projects yet.';

  const renameForm = renaming && (
    <form className="om-design-project-rename" onSubmit={event => {
      event.preventDefault();
      void commitRename();
    }}>
      <input className="om-design-input" ref={renameInputRef} autoFocus aria-label={t('Rename project')}
        value={renaming.draft} onChange={event => setRenaming({ ...renaming, draft: event.target.value })}
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          event.currentTarget.closest('[data-design-project-row]')?.querySelector<HTMLButtonElement>('[data-project-actions]')?.focus();
          setRenaming(null);
        }} />
      <Button type="submit" size="sm" variant="primary">{t('Save')}</Button>
    </form>
  );

  const projectMenu = (project: DesignProject) => (
    <Popover.Root modal={false}>
      <Popover.Trigger render={<IconButton type="button" variant={sidebar ? 'plain' : 'ghost'} data-project-actions=""
        className={sidebar ? 'motion-icon-button om-nav-row-action' : undefined}
        aria-label={sidebar ? t('Actions for {title}', { title: project.title }) : t('Project actions')}
        icon={<RemixIcon name={sidebar ? 'more-2-line' : 'more-line'} size={16} />} />} />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-150">
          <Popover.Popup className="om-design-popover om-design-project-menu" aria-label={t('Project actions')}
            finalFocus={() => renaming?.id === project.id ? renameInputRef.current : true}>
            {trashed ? <>
              <Popover.Close render={<Button type="button" size="sm" variant="ghost" onClick={() => void handleRestore(project)} />}>
                {t('Restore')}
              </Popover.Close>
              <Popover.Close render={<Button type="button" size="sm" variant="danger" icon={<RemixIcon name="delete-bin-line" size={14} />} onClick={() => void handleDelete(project)} />}>
                {t('Delete permanently')}
              </Popover.Close>
            </> : <>
              <Popover.Close render={<Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="edit-line" size={14} />}
                onClick={() => setRenaming({ id: project.id, original: project.title, draft: project.title })} />}>
                {t('Rename')}
              </Popover.Close>
              <Popover.Close render={<Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="file-copy-line" size={14} />} onClick={() => void handleDuplicate(project)} />}>
                {t('Duplicate')}
              </Popover.Close>
              <Popover.Close render={<Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="download-2-line" size={14} />} onClick={() => void handleExport(project, 'open-design')} />}>
                {t('Export for Open Design')}
              </Popover.Close>
              <Popover.Close render={<Button type="button" size="sm" variant="ghost" icon={<RemixIcon name="download-2-line" size={14} />} onClick={() => void handleExport(project, 'zip')} />}>
                {t('Export ZIP')}
              </Popover.Close>
              {editors.slice(0, 3).map(editor => (
                <Popover.Close key={editor.id} render={<Button type="button" size="sm" variant="ghost" icon={<RemixIcon name={editor.icon} size={14} />} onClick={() => void handleOpenIn(project, editor)} />}>
                  {t('Open in')} {editor.label}
                </Popover.Close>
              ))}
              <Popover.Close render={<Button type="button" size="sm" variant="danger" icon={<RemixIcon name="delete-bin-line" size={14} />} onClick={() => void handleTrash(project)} />}>
                {t('Move to Trash')}
              </Popover.Close>
            </>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );

  const projectActions = !compact && <>
    <input ref={fileInputRef} type="file" accept=".zip" hidden onChange={handleImportFile} />
    {sidebar ? <Tooltip label={t('Import ZIP')}>
      <IconButton type="button" variant="ghost" className="motion-icon-button" disabled={importing} aria-label={t('Import ZIP')}
        icon={<RemixIcon name="upload-2-line" size={16} />} onClick={() => fileInputRef.current?.click()} />
    </Tooltip> : <Button type="button" size="sm" variant="secondary" loading={importing} icon={<RemixIcon name="upload-2-line" size={14} />} onClick={() => fileInputRef.current?.click()}>
      {t('Import ZIP')}
    </Button>}
    <Popover.Root modal={false} open={newMenuOpen} onOpenChange={setNewMenuOpen}>
      {sidebar ? <Tooltip label={t('New project')} wrap>
        <Popover.Trigger render={<IconButton type="button" variant="ghost" className="motion-icon-button" aria-label={t('New project')} icon={<MotionIcon name="plus-thin" size={20} />} />} />
      </Tooltip> : <Popover.Trigger render={
        <Button type="button" size="sm" variant="primary" icon={<RemixIcon name="add-line" size={14} />}>
          {t('New project')}
        </Button>
      } />}
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-150">
          <Popover.Popup className="om-design-popover">
            {designScenarios.map(s => (
              <Button key={s.id} type="button" size="sm" variant="ghost" icon={<RemixIcon name={s.icon} size={14} />} style={{ justifyContent: 'flex-start' }} onClick={() => void handleCreate(s.id)}>
                {t(s.label)}
              </Button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </>;

  const filterIcon = <>
    <MotionIcon name="sliders" size={16} />
    {filterScenario !== 'all' && <span className="om-status-dot" aria-hidden="true" />}
  </>;
  const categoryFilter = !scenario && (
    <Menu modal={false} align="end" aria-label={t('Project category')} tooltip={sidebar ? t('Filters') : undefined}
      trigger={sidebar
        ? <IconButton type="button" variant="secondary" className="om-gallery-filter-trigger motion-icon-button"
            aria-label={t('Filters')} icon={filterIcon} />
        : <Button type="button" size="sm" variant="secondary" className="om-gallery-filter-trigger"
            icon={filterIcon}>{t('Filters')}</Button>}>
      <div className="om-menu-caption">{t('Project category')}</div>
      <MenuRadioGroup value={filterScenario} onValueChange={setFilterScenario}>
        <MenuRadioItem value="all" closeOnClick>{t('All categories')}</MenuRadioItem>
        {designScenarios.map(entry => (
          <MenuRadioItem key={entry.id} value={entry.id} closeOnClick>{t(entry.label)}</MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );

  if (sidebar) return <>
    <div className="motion-session-heading">
      <span>{t(trashed ? 'Trash' : 'Projects')}</span>
      <div className="motion-session-heading-actions">{projectActions}</div>
    </div>
    <div className="om-design-project-search om-design-sidebar-search">
      <label data-form-field="regular" className="motion-session-search">
        <MotionIcon name="search" />
        <FieldInput appearance="embedded" type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder={t('Search projects…')} aria-label={t('Search design projects…')} />
      </label>
      {categoryFilter}
    </div>
    <nav className="motion-session-list" aria-label={t('Project list')} aria-busy={loading}>
      {loading ? <p className="motion-session-empty">{t('Loading design projects…')}</p>
        : filtered.length === 0 ? <p className="motion-session-empty">{t(emptyMessage)}</p>
        : filtered.map(project => <DisclosureRow key={project.id} active={false} className="om-project-sidebar-row"
          data-design-project-row={project.id} action={projectMenu(project)}>
          {renaming?.id === project.id ? renameForm
            : trashed ? <div className="motion-session om-disclosure-row-label" title={project.title}>
              <span><strong>{project.title}</strong></span>
            </div>
            : <Tooltip label={project.title} wrap><Button type="button" variant="plain" className="motion-session om-disclosure-row-label"
              aria-label={project.title} onClick={() => onOpen(project.id)}>
              <span><strong>{project.title}</strong></span>
            </Button></Tooltip>}
        </DisclosureRow>)}
    </nav>
    <div className="motion-sidebar-footer om-design-sidebar-footer">
      <Button type="button" variant="plain" className="om-nav-item" aria-pressed={trashed}
        icon={<RemixIcon name="delete-bin-line" size={18} />} onClick={toggleTrash}>{t('Trash')}</Button>
    </div>
    <StudioToastViewport {...toast} />
  </>;

  const Container = compact ? 'section' : 'div';
  return (
    <Container style={{ display: 'flex', flexDirection: 'column', gap: compact ? 14 : 16 }}>
      {compact ? (
        <div className="om-design-section-head">
          <h2 className="om-design-section-title">{t('Recent projects')}</h2>
          {onViewAll && <Button type="button" size="sm" variant="ghost" onClick={onViewAll}>{t('View all')}</Button>}
        </div>
      ) : (
        <div className="om-design-section-head">
          <div className="om-design-project-search">
            <input
              type="search"
              className="om-design-input"
              placeholder={t('Search design projects…')}
              aria-label={t('Search design projects…')}
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {categoryFilter}
          </div>

          <div className="om-design-header-group">
            <Button type="button" size="sm" variant={trashed ? 'secondary' : 'ghost'} icon={<RemixIcon name="delete-bin-line" size={14} />} onClick={toggleTrash}>
              {trashed ? t('Viewing Trash') : t('Trash')}
            </Button>
            {projectActions}
          </div>
        </div>
      )}

      {loading && !compact ? (
        <div className="om-design-muted">{t('Loading design projects…')}</div>
      ) : filtered.length === 0 ? (
        <div className="om-design-item-card" style={{ padding: 28, alignItems: 'center', textAlign: 'center' }}>
          <p className="om-design-muted" style={{ margin: 0 }}>
            {t(emptyMessage === 'No design projects yet.'
              ? 'No design projects yet. Create one, import an Open Design ZIP, or send a brief to your MCP Agent.'
              : emptyMessage)}
          </p>
        </div>
      ) : (
        <div className="om-design-grid">
          {filtered.map(project => {
            const scen = findDesignScenario(project.scenario);
            const isEditingTitle = renaming?.id === project.id;
            return (
              <article key={project.id} className="om-design-card" data-design-project-row={project.id}>
                <ScaledPreviewThumb
                  src={designRoutes.raw(project.id, project.entry)}
                  title={project.title}
                  badge={scen ? t(scen.label) : project.scenario}
                />
                <div className="om-design-card-body">
                  {isEditingTitle ? renameForm : (
                    <strong className="om-design-card-title">{project.title}</strong>
                  )}
                  <span className="om-design-muted">{project.versionLabel ?? 'v1'} · {new Date(project.updatedAt).toLocaleDateString()}</span>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 'auto' }}>
                    {trashed ? (
                      <>
                        <Button type="button" size="sm" variant="secondary" onClick={() => void handleRestore(project)}>{t('Restore')}</Button>
                        <Button type="button" size="sm" variant="danger" onClick={() => void handleDelete(project)}>{t('Delete')}</Button>
                      </>
                    ) : (
                      <>
                        <Button type="button" size="sm" variant="primary" onClick={() => onOpen(project.id)}>{t('Open')}</Button>
                        {projectMenu(project)}
                      </>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <StudioToastViewport {...toast} />
    </Container>
  );
}
