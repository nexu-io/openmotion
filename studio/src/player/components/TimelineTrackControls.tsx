import { Tooltip } from "../../components/ui/Tooltip";
import { useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useTimelineEditContextOptional } from '../../contexts/TimelineEditContext';
import { useStudioShellContextOptional } from '../../contexts/StudioContext';
import { useTimelineReadOnlyPress } from './timelineReadOnly';
import { VisibilityButton } from './TimelineTrackPlainHeader';
import { TimelineTrackAudioControls } from './TimelineTrackAudioControls';
import type { TimelineEditCallbacks } from './timelineCallbacks';
import type { TimelineElement } from '../store/timelineElement';

export function TimelineTrackControls({ elements, track, number, label, hidden, audioOnly, toggleHidden, children }: {
  elements: readonly TimelineElement[]; track: number; number: number | null; label: string;
  hidden: boolean; audioOnly: boolean; toggleHidden: TimelineEditCallbacks['onToggleTrackHidden'];
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const edits = useTimelineEditContextOptional();
  const shell = useStudioShellContextOptional();
  const readOnly = useTimelineReadOnlyPress();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const locked = elements.some(el => el.timelineLocked);
  const disabled = busy || !!readOnly || !!shell?.writeBlockedReason || !!shell?.renderQueue?.isRendering;
  const run = async (action: () => Promise<unknown> | unknown) => {
    if (disabled || running.current) return;
    running.current = true; setBusy(true);
    try { await action(); }
    catch (error) { shell?.showToast(error instanceof Error ? error.message : 'Changes could not be saved.', 'error'); }
    finally { running.current = false; setBusy(false); }
  };
  const kind = audioOnly ? 'music-2-line' :
    elements.length && elements.every(element => element.text || /^(h[1-6]|p|span|strong)$/.test(element.tag)) ? 'text' :
    elements.length && elements.every(element => element.tag === 'img') ? 'image-line' : 'film-line';
  const name = t('Track {number}' , { number: number ?? '' });
  const lockLabel = t(locked ? 'Unlock track' : 'Lock track');
  return <div className="motion-track-controls" aria-label={name}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <Tooltip label={`${name} · ${label}`} wrap><span className="motion-track-kind" aria-label={name}>
      <RemixIcon name={kind} size={16} />
    </span></Tooltip>
    <Tooltip label={lockLabel} wrap><button type="button" aria-label={`${lockLabel} · ${name}`}
      aria-pressed={locked} disabled={disabled || !edits.onSetElementsAttributeQuiet}
      onClick={() => void run(() => edits.onSetElementsAttributeQuiet?.(elements.map(element => ({ element, value: locked ? null : '' })), 'data-timeline-locked', locked ? 'Unlock track' : 'Lock track'))}>
      <RemixIcon name={locked ? 'lock-line' : 'lock-unlock-line'} size={16} />
    </button></Tooltip>
    {!audioOnly && <VisibilityButton hidden={hidden} trackNumber={track} trackDisplayNumber={number} asMute={false} onToggle={toggleHidden} disabled={disabled || !toggleHidden} />}
    <TimelineTrackAudioControls elements={elements} trackLabel={name} isAudioOnly={audioOnly} hidden={hidden}
      onUnhide={() => { void toggleHidden?.(track, false, number); }} />
    {children}
    <Tooltip label={t('Delete track')} wrap><button type="button" aria-label={`${t('Delete track')} · ${name}`}
      disabled={disabled || locked || !edits.onDeleteTrack} onClick={() => void run(() => edits.onDeleteTrack?.(track))}>
      <RemixIcon name="delete-bin-line" size={16} />
    </button></Tooltip>
  </div>;
}
