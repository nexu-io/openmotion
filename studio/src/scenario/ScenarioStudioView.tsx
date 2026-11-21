import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Button } from 'open-design-ui/button';
import type { ScenarioBriefField, ScenarioDefinition, ScenarioStepDefinition } from '../../../shared/scenarios';
import type { PoolItem, PoolRef, ScenarioBundleReceipt, ScenarioRun, ScenarioStepState } from '../../../shared/scenario-runs';
import { Checkbox } from '../components/ui/Checkbox';
import { FieldInput, FieldTextarea } from '../components/ui/FormField';
import type { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { uploadLibraryAsset } from '../motion/assetClient';
import type { PoolExportOptions } from './AssetPoolPanel';
import { PoolItemPreviewDialog, PoolThumb } from './PoolItemPreview';
import { buildShowcaseSlides } from './ScenarioStage';
import { scenarioStudio, studioDeliverables } from './scenarioStudios';
import type { ScenarioRunApi } from './stepContract';
import { briefPresetsFor } from './steps/briefPresets';
import { productBrief, readProducts, studioUsesProduct, type StudioProduct } from './productLibrary';
import { StudioProductPicker } from './StudioProductPicker';

const AUTOSAVE_DELAY_MS = 800;
/** After the kit is handed to the Agent, check for returned outputs this often, for at most this long. */
const HANDOFF_POLL_MS = 8000;
const HANDOFF_POLL_LIMIT_MS = 15 * 60 * 1000;

type DeliverableState = 'waiting' | 'making' | 'ready' | 'failed' | 'skipped';

export type ScenarioStudioViewProps = {
  scenario: ScenarioDefinition;
  run: ScenarioRun | null;
  api: ScenarioRunApi;
  toast: Pick<ReturnType<typeof useToast>, 'showToast'>;
  poolItems: PoolItem[];
  onAddPoolItems(items: { ref: PoolRef; label?: string; tags?: string[]; stepId?: string | null; source: PoolItem['source'] }[]): Promise<string[]>;
  /** Resolves false when the brief could not be copied, so the hand-off note is not shown. */
  onRemovePoolItem(poolItemId: string): Promise<void>;
  onOpenDesignProject(id: string): void;
  onOpenMotionProject(id: string): Promise<boolean>;
  onCopyAgentPrompt(customPrompt?: string): Promise<boolean>;
  onExportBundle(options?: PoolExportOptions): Promise<ScenarioBundleReceipt | null>;
  exportingBundle: boolean;
  onSwitchToManual(): void;
  onOpenMcp(example?: string): void;
};

function briefText(brief: Record<string, string | string[]> | undefined, id: string) {
  const value = brief?.[id];
  return typeof value === 'string' ? value : '';
}

/** The fields people must fill before the kit can be made: the idea plus any other required field. */
export function studioInputFields(scenario: ScenarioDefinition): ScenarioBriefField[] {
  return scenario.briefFields.filter(field => field.id !== 'idea' && field.required);
}

function latestIteration(state: ScenarioStepState | undefined) {
  if (!state?.iterations.length) return undefined;
  return state.iterations.find(iteration => iteration.id === state.activeIterationId) ?? state.iterations[state.iterations.length - 1];
}

export function deliverableState(state: ScenarioStepState | undefined): DeliverableState {
  if (state?.status === 'skipped') return 'skipped';
  const iteration = latestIteration(state);
  if (iteration?.job && (iteration.job.state === 'queued' || iteration.job.state === 'running')) return 'making';
  if (iteration?.job?.state === 'failed') return 'failed';
  if (state?.status === 'done' || (iteration && iteration.outputs.length > 0)) return 'ready';
  if (state?.status === 'in-progress') return 'making';
  return 'waiting';
}

const stateLabels: Record<DeliverableState, string> = { waiting: 'Not started', making: 'In the making', ready: 'Ready', failed: 'Needs a retry', skipped: 'Not this time' };

/** Status to restore when a deliverable is chosen again: keep a finished output, otherwise start over. */
export const restoredStatus = (state: ScenarioStepState | undefined): ScenarioStepState['status'] =>
  latestIteration(state)?.outputs.length ? 'done' : 'todo';

/** Everything a step has made so far: its pool items, newest first, plus text outputs of the shown version. */
function stepOutputs(step: ScenarioStepDefinition, state: ScenarioStepState | undefined, run: ScenarioRun | null, poolById: Map<string, PoolItem>) {
  const seen = new Set<string>();
  const items: PoolItem[] = [];
  const add = (item: PoolItem | undefined) => { if (item && !seen.has(item.id)) { seen.add(item.id); items.push(item); } };
  for (const iteration of [...(state?.iterations ?? [])].reverse()) {
    for (const output of iteration.outputs) if (output.type === 'pool') add(poolById.get(output.poolItemId));
  }
  for (const item of run?.pool ?? []) if (item.stepId === step.id) add(item);
  const iteration = latestIteration(state);
  const posts = iteration?.outputs.flatMap(output => output.type === 'social' ? output.posts : []) ?? [];
  const scripts = iteration?.outputs.flatMap(output => output.type === 'script' ? [output.text] : []) ?? [];
  return { items, posts, scripts };
}

/** A deliverable tab: the top row switches which output is shown below. */
function DeliverableTab({ step, state, cover, example, selected, onSelect }: {
  step: ScenarioStepDefinition;
  state: ScenarioStepState | undefined;
  cover: { item: PoolItem; run: ScenarioRun | null } | null;
  example: string | undefined;
  selected: boolean;
  onSelect(): void;
}) {
  const { t } = useI18n();
  const status = deliverableState(state);
  return (
    <Button variant="plain" role="tab" aria-selected={selected} className="om-studio-output" data-studio-output={step.id}
      data-output-state={status} onClick={onSelect}>
      <span className="om-studio-output-art" aria-hidden="true">
        {cover ? <PoolThumb item={cover.item} run={cover.run} size="lg" />
          : example ? <img src={example} alt="" loading="lazy" />
          : <RemixIcon name={step.icon} size={24} />}
        {!cover && example && <span className="om-studio-output-example">{t('Example output')}</span>}
      </span>
      <span className="om-studio-output-meta">
        <RemixIcon name={step.icon} size={14} aria-hidden="true" />
        <strong>{t(step.title)}</strong>
        <span className="om-studio-output-state" data-output-state={status}>{t(stateLabels[status])}</span>
      </span>
    </Button>
  );
}

export function ScenarioStudioView({
  scenario, run, api, toast, poolItems, onAddPoolItems, onRemovePoolItem, onOpenDesignProject, onOpenMotionProject, onCopyAgentPrompt, onExportBundle, exportingBundle, onSwitchToManual, onOpenMcp,
}: ScenarioStudioViewProps) {
  const { t, locale } = useI18n();
  const studio = scenarioStudio(scenario.id);
  const inputFields = useMemo(() => studioInputFields(scenario), [scenario]);
  const deliverables = useMemo(() => studioDeliverables(scenario), [scenario]);
  const examples = useMemo(() => new Map(buildShowcaseSlides(scenario).map(slide => [slide.stepId, slide.poster])), [scenario]);
  const presets = useMemo(() => briefPresetsFor(scenario.id, locale), [scenario.id, locale]);
  const poolById = useMemo(() => new Map(poolItems.map(item => [item.id, item])), [poolItems]);
  const references = useMemo(() => poolItems.filter(item => item.stepId === null && !item.tags.includes('product') && (item.source === 'upload' || item.source === 'workspace')), [poolItems]);
  const briefFieldIds = useMemo(() => new Set(scenario.briefFields.map(field => field.id)), [scenario]);
  const usesProduct = studioUsesProduct(briefFieldIds);
  const productFor = (brief: Record<string, string | string[]> | undefined) => {
    const name = briefText(brief, 'productName');
    return name ? readProducts().find(product => product.name === name) ?? null : null;
  };
  const [product, setProduct] = useState<StudioProduct | null>(() => usesProduct ? productFor(run?.brief) : null);

  const fieldIds = useMemo(() => ['idea', ...inputFields.map(field => field.id)], [inputFields]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fieldIds.map(id => [id, briefText(run?.brief, id)])));
  const dirty = useRef(new Set<string>());
  const latest = useRef(values);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [making, setMaking] = useState(false);
  const [handedOffAt, setHandedOffAt] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Switching to another draft (or starting a new one) starts from that draft's brief.
  // The first save of a fresh page creates the run and keeps what was typed.
  const runIdRef = useRef(run?.id ?? null);
  useEffect(() => {
    const previous = runIdRef.current;
    runIdRef.current = run?.id ?? null;
    if (!previous || !run || previous === run.id) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    dirty.current.clear();
    const reset = Object.fromEntries(fieldIds.map(id => [id, briefText(run.brief, id)]));
    latest.current = reset;
    setValues(reset);
    setHandedOffAt(null);
    if (usesProduct) setProduct(productFor(run.brief));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldIds, run]);

  // Take remote brief values for fields the person is not editing.
  useEffect(() => {
    setValues(previous => {
      const next = { ...previous };
      for (const id of fieldIds) if (!dirty.current.has(id) && run?.brief?.[id] !== undefined) next[id] = briefText(run.brief, id);
      latest.current = next;
      return next;
    });
  }, [fieldIds, run?.brief]);

  /** Saves typed fields; resolves false when the brief could not be saved. */
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!dirty.current.size) return true;
    const patch = Object.fromEntries([...dirty.current].map(id => [id, latest.current[id] ?? '']));
    try {
      await api.mutate('studio-brief', 'update_brief', { brief: patch });
      for (const id of Object.keys(patch)) if (latest.current[id] === patch[id]) dirty.current.delete(id);
      return true;
    } catch {
      // useScenarioRun reports conflicts; the typed values stay so nothing is lost.
      return false;
    }
  }, [api]);

  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); if (dirty.current.size) void flushRef.current(); }, []);

  const update = (patch: Record<string, string>) => {
    for (const id of Object.keys(patch)) dirty.current.add(id);
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setValues(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  };

  // While the Agent is making the kit, pick up what it saves back without a manual Sync.
  useEffect(() => {
    if (handedOffAt === null) return;
    const id = setInterval(() => {
      if (Date.now() - handedOffAt > HANDOFF_POLL_LIMIT_MS) { clearInterval(id); return; }
      void api.refresh().catch(() => {});
    }, HANDOFF_POLL_MS);
    return () => clearInterval(id);
  }, [api, handedOffAt]);

  // Deliverables people chose for this run; an unticked one is saved on the run as skipped.
  const chosen = deliverables.filter(step => run?.steps[step.id]?.status !== 'skipped');
  const [toggling, setToggling] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<PoolItem | null>(null);
  const [shownStepId, setShownStepId] = useState<string | null>(null);
  const shownStep = deliverables.find(step => step.id === shownStepId) ?? chosen[0] ?? deliverables[0];
  const toggleDeliverable = async (stepId: string, include: boolean) => {
    if (toggling) return;
    if (!include && chosen.length <= 1) {
      toast.showToast(t('Keep at least one output'), 'error', 'feedback');
      return;
    }
    setToggling(stepId);
    try {
      await api.ensureRun();
      await api.mutate(`studio-output:${stepId}:${include ? 'on' : 'off'}`, 'update_step', {
        stepId,
        status: include ? restoredStatus(run?.steps[stepId]) : 'skipped',
      });
    } catch {
      // useScenarioRun reports conflicts and failures; the checkbox stays as saved.
    } finally {
      setToggling(null);
    }
  };

  /** A picked product fills the brief and puts its photos in the run's Assets for every step. */
  // Product switches run one after another against the latest Assets, and the hand-off waits for them.
  const poolRef = useRef(poolItems);
  poolRef.current = poolItems;
  const productSync = useRef<Promise<boolean>>(Promise.resolve(true));
  const selectProduct = (next: StudioProduct) => {
    setProduct(next);
    update(productBrief(next, briefFieldIds));
    productSync.current = productSync.current.then(() => syncProductPhotos(next));
    return productSync.current;
  };
  const syncProductPhotos = async (next: StudioProduct) => {
    // Read the run the hook holds right now, which already includes the previous switch's writes.
    let poolItems = poolRef.current;
    try {
      poolItems = (await api.ensureRun()).pool;
    } catch {
      // Fall back to the rendered Assets; the write below reports its own failure.
    }
    const known = new Set(poolItems.flatMap(item => item.ref.type === 'asset' ? [item.ref.assetId + '/' + item.ref.versionId] : []));
    // Photos of a previously picked product leave this run; other reference images stay.
    const keep = new Set(next.images.map(image => image.assetId + '/' + image.versionId));
    const stale = poolItems.filter(item => item.tags.includes('product') && !(item.ref.type === 'asset' && keep.has(item.ref.assetId + '/' + item.ref.versionId)));
    const items = next.images
      .filter(image => !known.has(image.assetId + '/' + image.versionId))
      .map(image => ({ ref: { type: 'asset' as const, assetId: image.assetId, versionId: image.versionId }, label: `${next.name} · ${image.name}`, tags: ['product'], stepId: null, source: 'upload' as const }));
    if (!items.length && !stale.length) return true;
    try {
      await api.ensureRun();
      for (const item of stale) await onRemovePoolItem(item.id);
      if (items.length) await onAddPoolItems(items);
      return true;
    } catch {
      toast.showToast(t('Could not add the product photos'), 'error', 'feedback');
      return false;
    }
  };

  /** Leave the studio only after the typed brief is saved, so nothing typed is lost. */
  const leaveAfterSave = async (leave: () => void) => {
    if ((await productSync.current) && (await flush())) { leave(); return; }
    toast.showToast(t('Could not save brief revision.'), 'error', 'feedback');
  };

  const missing = [{ id: 'idea', label: 'Core idea' }, ...inputFields].filter(field => !(values[field.id] ?? '').trim());
  const readyCount = chosen.filter(step => deliverableState(run?.steps[step.id]) === 'ready').length;

  const makeKit = async () => {
    if (making) return;
    if (usesProduct && !(values.productName ?? '').trim()) {
      toast.showToast(t('Choose or add a product first'), 'error', 'feedback');
      return;
    }
    if (missing.length) {
      toast.showToast(t('Fill in {field} first', { field: t(missing[0].label) }), 'error', 'feedback');
      return;
    }
    setMaking(true);
    try {
      // Only hand over a brief the run has saved, so the Agent never gets stale fields.
      if (!(await productSync.current)) return;
      if (!(await flush())) {
        toast.showToast(t('Could not save brief revision.'), 'error', 'feedback');
        return;
      }
      if (await onCopyAgentPrompt(latest.current.idea)) setHandedOffAt(Date.now());
    } finally {
      setMaking(false);
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    setUploading(true);
    try {
      await api.ensureRun();
      const items: { ref: PoolRef; label: string; stepId: null; source: 'upload' }[] = [];
      for (const file of files) {
        try {
          const asset = await uploadLibraryAsset(file);
          items.push({ ref: { type: 'asset', assetId: asset.id, versionId: asset.currentVersionId }, label: asset.name || file.name, stepId: null, source: 'upload' });
        } catch {
          toast.showToast(t('Could not upload {name}', { name: file.name }), 'error', 'feedback');
        }
      }
      if (items.length) await onAddPoolItems(items);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="om-studio-view" data-studio-view={scenario.id}>
      <section className="om-studio-input" aria-label={t('Your brief')}>
        <h1>{t(studio.title)}</h1>
        <p className="om-studio-input-hint">{t(studio.inputHint)}</p>
        {usesProduct && <StudioProductPicker selected={product} onSelect={next => void selectProduct(next)} toast={toast} />}
        <FieldTextarea
          className="om-studio-idea"
          rows={4}
          aria-label={t('Core idea')}
          value={values.idea ?? ''}
          maxLength={scenario.briefFields.find(field => field.id === 'idea')?.maxLength}
          placeholder={t(scenario.briefFields.find(field => field.id === 'idea')?.placeholder ?? 'Describe what you want to create and the outcome you want.')}
          onChange={event => update({ idea: event.target.value })}
        />
        {inputFields.some(field => !(usesProduct && field.id === 'productName')) && <div className="om-studio-fields">
          {inputFields.filter(field => !(usesProduct && field.id === 'productName')).map(field => (
            <FieldInput key={field.id} density="compact" aria-label={t(field.label)} value={values[field.id] ?? ''}
              placeholder={t(field.label)} maxLength={field.maxLength} onChange={event => update({ [field.id]: event.target.value })} />
          ))}
        </div>}
        <div className="om-studio-refs">
          {references.map(item => <PoolThumb key={item.id} item={item} run={run} size="sm" />)}
          <input ref={fileInput} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={event => void upload(event)} />
          <Button variant="secondary" size="sm" icon={<RemixIcon name="upload-2-line" size={14} />} disabled={uploading}
            onClick={() => fileInput.current?.click()}>
            {uploading ? t('Uploading…') : t('Add reference images')}
          </Button>
        </div>
        <fieldset className="om-studio-choose">
          <legend>{t('Outputs this time')}</legend>
          {deliverables.map(step => {
            const included = run?.steps[step.id]?.status !== 'skipped';
            return (
              <label key={step.id} className="om-studio-choose-item" data-studio-choose={step.id}>
                <Checkbox aria-label={t(step.title)} checked={included} disabled={toggling !== null}
                  onCheckedChange={checked => void toggleDeliverable(step.id, checked)} />
                <RemixIcon name={step.icon} size={14} aria-hidden="true" />
                <span>{t(step.title)}</span>
              </label>
            );
          })}
        </fieldset>
        {presets.length > 0 && <div className="om-studio-presets">
          <span>{t('Try:')}</span>
          {presets.map(preset => (
            <Button key={preset.id} variant="plain" size="sm" className="om-studio-preset"
              onClick={() => update(Object.fromEntries(Object.entries(preset.values).filter((entry): entry is [string, string] => typeof entry[1] === 'string')))}>
              {preset.label}
            </Button>
          ))}
        </div>}
        <Button variant="primary" className="om-studio-make" icon={<RemixIcon name="sparkling-line" size={16} />} disabled={making || toggling !== null} onClick={() => void makeKit()}>
          {t('Make the full kit')}
        </Button>
        {handedOffAt !== null && <div className="om-studio-handoff" role="status">
          <RemixIcon name="checkbox-circle-line" size={16} aria-hidden="true" />
          <span>{t('Copied. Paste it into your connected Agent and the kit fills in below as it is made.')}</span>
          <Button variant="plain" size="sm" onClick={() => onOpenMcp()}>{t('Connect an Agent')}</Button>
        </div>}
      </section>

      <section className="om-studio-outputs" aria-label={t('Your kit')}>
        <header>
          <h2>{t('Your kit')}</h2>
          <span className="om-studio-progress">{t('{ready} of {total} ready', { ready: readyCount, total: chosen.length })}</span>
          <Button variant="secondary" size="sm" icon={<RemixIcon name="download-2-line" size={14} />} disabled={!run || readyCount === 0 || exportingBundle}
            onClick={() => void onExportBundle({ stepIds: ['brief', ...chosen.map(step => step.id)].filter(id => scenario.steps.some(step => step.id === id)) })}>
            {t('Download the kit')}
          </Button>
        </header>
        <div className="om-studio-output-grid" role="tablist" aria-label={t('Your kit')}>
          {deliverables.map(step => {
            const first = stepOutputs(step, run?.steps[step.id], run, poolById).items[0];
            return (
              <DeliverableTab key={step.id} step={step} state={run?.steps[step.id]} example={examples.get(step.id)}
                cover={first ? { item: first, run } : null} selected={step.id === shownStep?.id} onSelect={() => setShownStepId(step.id)} />
            );
          })}
        </div>
        {shownStep && (() => {
          const state = run?.steps[shownStep.id];
          const status = deliverableState(state);
          const { items, posts, scripts } = stepOutputs(shownStep, state, run, poolById);
          const empty = !items.length && !posts.length && !scripts.length;
          return (
            <div className="om-studio-output-panel" role="tabpanel" data-studio-output-panel={shownStep.id}>
              <header>
                <RemixIcon name={shownStep.icon} size={16} aria-hidden="true" />
                <strong>{t(shownStep.title)}</strong>
                <span className="om-studio-output-state" data-output-state={status}>{t(stateLabels[status])}</span>
                {!empty && <span className="om-studio-output-count">{t('{count} outputs', { count: items.length + posts.length + scripts.length })}</span>}
              </header>
              {empty ? (
                <div className="om-studio-output-empty">
                  {examples.get(shownStep.id) && (
                    <span className="om-studio-output-empty-art">
                      <img src={examples.get(shownStep.id)} alt="" />
                      <span className="om-studio-output-example">{t('Example output')}</span>
                    </span>
                  )}
                  <p>{status === 'skipped' ? t('Not made this time. Tick it under Outputs this time to include it.')
                    : status === 'making' ? t('In the making. It appears here as soon as it is ready.')
                    : t('Nothing made yet. Click Make the full kit and it appears here.')}</p>
                </div>
              ) : (
                <>
                  {items.length > 0 && (
                    <div className="om-studio-output-items">
                      {items.map(item => (
                        <Button key={item.id} variant="plain" className="om-studio-output-item" aria-label={`${t('Preview')} · ${item.label}`}
                          onClick={() => setPreviewItem(item)}>
                          <PoolThumb item={item} run={run} size="lg" />
                          <span>{item.label}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                  {posts.length > 0 && (
                    <div className="om-studio-output-posts">
                      {posts.map(post => (
                        <article key={post.id} className="om-studio-output-post">
                          <strong>{post.platform}</strong>
                          {post.title && <h3>{post.title}</h3>}
                          <p>{post.text}</p>
                          {post.hashtags.length > 0 && <span>{post.hashtags.map(tag => '#' + tag.replace(/^#/, '')).join(' ')}</span>}
                        </article>
                      ))}
                    </div>
                  )}
                  {scripts.map((text, index) => <pre key={index} className="om-studio-output-script">{text}</pre>)}
                </>
              )}
            </div>
          );
        })()}
        <PoolItemPreviewDialog item={previewItem} run={run} canUseInCurrentStep={false} onClose={() => setPreviewItem(null)}
          onOpen={item => {
            setPreviewItem(null);
            if (item.ref.type === 'design') onOpenDesignProject(item.ref.projectId);
            else if (item.ref.type === 'motion') void onOpenMotionProject(item.ref.projectId);
            else if (item.ref.type === 'asset') window.open(`/?page=assets&asset=${encodeURIComponent(item.ref.assetId)}`, '_blank', 'noopener,noreferrer');
          }} />
        <Button variant="plain" size="sm" className="om-studio-workflow-link" icon={<RemixIcon name="route-line" size={14} />} onClick={() => void leaveAfterSave(onSwitchToManual)}>
          {t('Fine-tune each step')}
        </Button>
      </section>
    </div>
  );
}
