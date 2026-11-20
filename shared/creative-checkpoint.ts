/** Creative preview checkpoints recorded on a work round before full production. */
export const previewTypes = ['creative_directions', 'storyboard', 'motion_sample'] as const;
export const checkpointKinds = ['preview_shown', 'decision', 'skipped', 'production_started'] as const;
export const checkpointDecisions = ['selected', 'confirmed', 'revision_requested', 'switched'] as const;
export const revisionReasons = ['visual_adjustment', 'motion_or_audio', 'narrative_change', 'direction_mismatch', 'goal_changed', 'preview_requested', 'other'] as const;
export const revisionScopes = ['frames', 'scene', 'direction', 'whole_film'] as const;
export const skipReasons = ['user_delegated', 'simple_template_adaptation'] as const;
/** Reasons that may reopen preview after production started; local edits continue production without a checkpoint. */
export const redesignReasons = ['motion_or_audio', 'narrative_change', 'direction_mismatch', 'goal_changed', 'preview_requested'] as const;

export type PreviewType = typeof previewTypes[number];
export type CreativeStatus = 'previewing' | 'waiting_user' | 'confirmed' | 'producing';
export type PreviewEvidence = { assetId?: string; versionId?: string; path?: string; jobId?: string };
export type PreviewRecord = {
  version: number; type: PreviewType; motionRisk: 'low' | 'high'; directionId?: string;
  candidates: { id: string; evidence: PreviewEvidence[] }[];
  basedOn: { versionId: string; revision: string }; shownAt: number; note?: string;
};
export type CheckpointRecord = {
  sequence: number; at: number; kind: typeof checkpointKinds[number]; during: 'preview' | 'production'; requestId?: string;
  decision?: typeof checkpointDecisions[number]; previewVersion?: number; directionId?: string;
  reason?: typeof revisionReasons[number]; scope?: typeof revisionScopes[number];
  skipReason?: typeof skipReasons[number]; note?: string;
};
export type CreativeCheckpoint = {
  status: CreativeStatus; sequence: number;
  currentPreviewVersion?: number; selectedDirectionId?: string; adoptedPreviewVersion?: number;
  skipReason?: typeof skipReasons[number]; productionStartedAt?: number;
  revisionCount: number; reworkCount: number;
  previews: PreviewRecord[]; records: CheckpointRecord[];
};
export type CheckpointInput = {
  kind: typeof checkpointKinds[number]; previewType?: PreviewType; motionRisk?: 'low' | 'high';
  candidates?: { id: string; evidence: PreviewEvidence[] }[]; directionId?: string; previewVersion?: number;
  decision?: typeof checkpointDecisions[number]; reason?: typeof revisionReasons[number];
  scope?: typeof revisionScopes[number]; skipReason?: typeof skipReasons[number]; note?: string;
};
/** Structured, content-free telemetry derived from one accepted checkpoint. */
export type CheckpointSignal =
  | { event: 'preview_generated'; properties: { preview_type: PreviewType; preview_version: number; candidate_count: number; direction_clarity: 'clear' | 'unclear'; motion_risk: 'low' | 'high' } }
  | { event: 'preview_selected_or_confirmed'; properties: { preview_type: PreviewType; preview_version: number; decision: 'selected' | 'confirmed'; next_step: 'production' | 'motion_sample'; selected_index?: number; revision_count: number } }
  | { event: 'preview_revision_requested'; properties: { preview_type?: PreviewType; preview_version?: number; revision_reason: typeof revisionReasons[number]; revision_scope: typeof revisionScopes[number]; during: 'preview' | 'production'; selected_index?: number } }
  | { event: 'production_started'; properties: { start_basis: 'confirmed_preview' | typeof skipReasons[number]; preview_type?: PreviewType; preview_version?: number; preview_count: number; revision_count: number } };

const fail = (code: string, message: string): never => { throw new Error(`${code}: ${message}`); };
const invalid = (message: string): never => fail('INVALID_ARGUMENT', message);

/** What the Agent should do next for a recorded checkpoint. */
export function creativeNextAction(creative: CreativeCheckpoint) {
  if (creative.status === 'waiting_user') return 'wait_for_user' as const;
  if (creative.status === 'confirmed') return 'start_production' as const;
  if (creative.status === 'producing') return 'continue_production' as const;
  const current = creative.previews.find(item => item.version === creative.currentPreviewVersion);
  return current?.type === 'creative_directions' && creative.selectedDirectionId && creative.records.at(-1)?.decision === 'selected'
    ? 'show_motion_sample' as const : 'show_revised_preview' as const;
}

/** Full production and its export require a confirmed or skipped checkpoint once a round records one. */
export function requireProduction(creative: CreativeCheckpoint | undefined) {
  if (creative && creative.status !== 'producing')
    fail('CREATIVE_CONFIRMATION_REQUIRED', `creative checkpoint is ${creative.status}; record production_started only after the user confirms or validly skips the preview. Render preview samples without workId`);
}

/**
 * Apply one checkpoint. Returns the next state and the derived telemetry; never mutates its input.
 * A decision must name the preview version the user actually responded to.
 */
export function applyCheckpoint(previous: CreativeCheckpoint | undefined, input: CheckpointInput, basedOn: PreviewRecord['basedOn'], at = Date.now(), requestId?: string) {
  const creative: CreativeCheckpoint = previous ? structuredClone(previous)
    : { status: 'previewing', sequence: 0, revisionCount: 0, reworkCount: 0, previews: [], records: [] };
  const status = previous?.status;
  const current = creative.previews.find(item => item.version === creative.currentPreviewVersion);
  const index = (preview: PreviewRecord | undefined, id: string | undefined) => {
    const found = preview?.type === 'creative_directions' && id ? preview.candidates.findIndex(item => item.id === id) : -1;
    return found >= 0 ? found + 1 : undefined;
  };
  const allowed = { preview_shown: ['previewType', 'motionRisk', 'candidates', 'note'], decision: ['decision', 'previewVersion', 'directionId', 'reason', 'scope', 'note'],
    skipped: ['skipReason', 'note'], production_started: ['note'] }[input.kind];
  for (const key of Object.keys(input)) if (key !== 'kind' && !allowed.includes(key)) invalid(`checkpoint.${key} is not used by ${input.kind}`);
  const record: CheckpointRecord = { sequence: creative.sequence + 1, at, kind: input.kind, during: status === 'producing' || status === 'confirmed' && previous?.productionStartedAt ? 'production' : 'preview',
    ...(requestId ? { requestId } : {}),
    ...(input.note ? { note: input.note } : {}) };
  let signal: CheckpointSignal | undefined;

  if (input.kind === 'preview_shown') {
    if (status === 'confirmed' || status === 'producing') fail('CREATIVE_STATE_CONFLICT', 'record the user\'s redesign or preview request before showing another preview');
    const type = input.previewType ?? invalid('checkpoint.previewType is required');
    const candidates = input.candidates ?? invalid('checkpoint.candidates is required');
    if (status === 'previewing' && current?.type === 'creative_directions' && current.motionRisk === 'high' && creative.selectedDirectionId && type !== 'motion_sample')
      invalid('high-motion direction selection requires a playable motion_sample before production');
    if (type === 'creative_directions' ? candidates.length < 2 || candidates.length > 3 : candidates.length !== 1)
      invalid(type === 'creative_directions' ? 'creative directions show 2-3 distinct candidates; one reasonable direction uses storyboard or motion_sample' : `${type} shows exactly one candidate`);
    if (new Set(candidates.map(item => item.id)).size !== candidates.length) invalid('candidate IDs must be unique');
    for (const candidate of candidates) for (const evidence of candidate.evidence) if (!Object.keys(evidence).length) invalid('each evidence item needs an asset, path or job reference');
    if (type === 'creative_directions' && !input.motionRisk) invalid('creative_directions requires motionRisk');
    if (type !== 'creative_directions' && input.motionRisk && input.motionRisk !== (type === 'motion_sample' ? 'high' : 'low'))
      invalid('storyboard previews low motion risk; high motion risk needs a playable motion_sample');
    const preview: PreviewRecord = { version: creative.previews.length + 1, type, motionRisk: type === 'creative_directions' ? input.motionRisk! : type === 'motion_sample' ? 'high' : 'low',
      candidates: structuredClone(candidates), basedOn: { ...basedOn }, shownAt: at,
      ...(type !== 'creative_directions' && creative.selectedDirectionId ? { directionId: creative.selectedDirectionId } : {}), ...(input.note ? { note: input.note } : {}) };
    if (type === 'creative_directions') delete creative.selectedDirectionId;
    creative.previews.push(preview);
    Object.assign(creative, { status: 'waiting_user', currentPreviewVersion: preview.version });
    record.previewVersion = preview.version;
    signal = { event: 'preview_generated', properties: { preview_type: type, preview_version: preview.version, candidate_count: candidates.length,
      direction_clarity: type === 'creative_directions' ? 'unclear' : 'clear', motion_risk: preview.motionRisk } };
  } else if (input.kind === 'decision') {
    const decision = input.decision ?? invalid('checkpoint.decision is required');
    record.decision = decision;
    if (decision === 'revision_requested' && (status === 'confirmed' || status === 'producing')) {
      const reason = input.reason ?? invalid('checkpoint.reason is required');
      if (!(redesignReasons as readonly string[]).includes(reason))
        fail('CREATIVE_LOCAL_EDIT', 'local edits after confirmation continue production without reopening preview; reopen only for redesign or an explicit preview request');
      if (input.directionId || input.previewVersion !== undefined) invalid('a production redesign does not target a preview version');
      const scope = input.scope ?? invalid('checkpoint.scope is required');
      Object.assign(record, { reason, scope });
      if (creative.productionStartedAt) creative.reworkCount++;
      creative.revisionCount++;
      creative.status = 'previewing';
      signal = { event: 'preview_revision_requested', properties: { ...(current ? { preview_type: current.type, preview_version: current.version } : {}),
        revision_reason: reason, revision_scope: scope, during: creative.productionStartedAt ? 'production' : 'preview' } };
    } else {
      if (status !== 'waiting_user' && status !== 'previewing') fail('CREATIVE_STATE_CONFLICT', `no preview is awaiting a decision (status ${status ?? 'none'})`);
      const version = input.previewVersion ?? invalid('checkpoint.previewVersion is required');
      record.previewVersion = version;
      if (decision === 'switched') {
        const target = creative.previews.find(item => item.version === version) ?? fail('PREVIEW_VERSION_NOT_FOUND', `preview version ${version} does not exist`);
        if (version === creative.currentPreviewVersion) invalid('switched requires an earlier saved preview version');
        if (input.reason || input.scope || input.directionId) invalid('switched only names the saved version');
        Object.assign(creative, { status: 'waiting_user', currentPreviewVersion: target.version });
        if (target.directionId) creative.selectedDirectionId = target.directionId; else delete creative.selectedDirectionId;
      } else {
        if (version !== creative.currentPreviewVersion)
          fail('PREVIEW_VERSION_CONFLICT', `the user responded to version ${version} but version ${creative.currentPreviewVersion} is current; show the current version and wait for the user`);
        if (decision === 'revision_requested') {
          const reason = input.reason ?? invalid('checkpoint.reason is required');
          const scope = input.scope ?? invalid('checkpoint.scope is required');
          if (input.directionId && !index(current, input.directionId)) invalid('directionId must name a candidate of the current preview');
          Object.assign(record, { reason, scope, ...(input.directionId ? { directionId: input.directionId } : {}) });
          if (input.directionId) creative.selectedDirectionId = input.directionId;
          creative.revisionCount++;
          creative.status = 'previewing';
          signal = { event: 'preview_revision_requested', properties: { preview_type: current!.type, preview_version: version,
            revision_reason: reason, revision_scope: scope, during: 'preview', ...(index(current, input.directionId) ? { selected_index: index(current, input.directionId) } : {}) } };
        } else {
          if (status !== 'waiting_user') fail('CREATIVE_STATE_CONFLICT', 'show the revised preview before recording a selection or confirmation');
          if (input.reason || input.scope) invalid('reason and scope describe revisions only');
          if (decision === 'selected') {
            if (current!.type !== 'creative_directions') invalid('selected applies to creative directions; confirm a storyboard or motion sample');
            const selected = index(current, input.directionId) ?? invalid('directionId must name a candidate of the current preview');
            record.directionId = input.directionId;
            creative.selectedDirectionId = input.directionId;
            const next = current!.motionRisk === 'high' ? 'motion_sample' : 'production';
            if (next === 'production') Object.assign(creative, { status: 'confirmed', adoptedPreviewVersion: version });
            else creative.status = 'previewing';
            signal = { event: 'preview_selected_or_confirmed', properties: { preview_type: current!.type, preview_version: version, decision, next_step: next, selected_index: selected, revision_count: creative.revisionCount } };
          } else {
            if (current!.type === 'creative_directions') invalid('choose one creative direction with selected');
            if (input.directionId) invalid('confirmed applies to the current storyboard or motion sample');
            Object.assign(creative, { status: 'confirmed', adoptedPreviewVersion: version });
            signal = { event: 'preview_selected_or_confirmed', properties: { preview_type: current!.type, preview_version: version, decision: 'confirmed', next_step: 'production', revision_count: creative.revisionCount } };
          }
        }
      }
    }
  } else if (input.kind === 'skipped') {
    const reason = input.skipReason ?? invalid('checkpoint.skipReason is required');
    if (reason === 'simple_template_adaptation' ? previous : status === 'confirmed' || status === 'producing')
      fail('CREATIVE_STATE_CONFLICT', reason === 'simple_template_adaptation' ? 'simple template adaptation skips before any preview' : 'production is already confirmed');
    Object.assign(creative, { status: 'confirmed', skipReason: reason });
    delete creative.adoptedPreviewVersion;
    record.skipReason = reason;
  } else {
    if (status === 'producing') return { creative: previous!, record: undefined, signal: undefined, changed: false };
    if (status !== 'confirmed') fail('CREATIVE_CONFIRMATION_REQUIRED', `wait for the user to confirm the current preview (status ${status ?? 'none'})`);
    const adopted = creative.previews.find(item => item.version === creative.adoptedPreviewVersion);
    creative.productionStartedAt ??= at;
    creative.status = 'producing';
    signal = { event: 'production_started', properties: { start_basis: creative.skipReason ?? 'confirmed_preview',
      ...(adopted ? { preview_type: adopted.type, preview_version: adopted.version } : {}), preview_count: creative.previews.length, revision_count: creative.revisionCount } };
  }
  if (input.kind !== 'skipped' && creative.skipReason && creative.status !== 'producing' && creative.status !== 'confirmed') delete creative.skipReason;
  creative.sequence = record.sequence;
  creative.records.push(record);
  return { creative, record, signal, changed: true };
}
