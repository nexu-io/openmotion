import type { Translate } from './messages';

const PREFIX = 'Edit layer style: ';
const propertyLabels: Record<string, string> = {
  opacity: 'Opacity', 'font-size': 'Font size', color: 'Color',
  'font-family': 'Font', 'text-align': 'Align', 'background-color': 'Background',
  'line-height': 'Line height', 'letter-spacing': 'Letter spacing',
  'border-radius': 'Radius',
};
const compact = (value: string, limit: number) => {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > limit ? singleLine.slice(0, limit - 1) + '…' : singleLine;
};

export function opacityPercent(value: string): string | undefined {
  const number = Number(value);
  if (value.trim() && Number.isFinite(number)) return `${Math.round(number * 10000) / 100}%`;
  return /^\d+(?:\.\d+)?%$/.test(value) ? value : undefined;
}

/** Keep locale-neutral edit details in the existing history label contract. */
export function styleHistoryLabel(target: string, styles: Record<string, string>): string {
  const multiplier = styles['--hf-layer-opacity'];
  const changes = Object.entries(styles)
    .filter(([property]) => !(multiplier !== undefined && property === 'filter'))
    .map(([property, value]) => {
      const key = property === '--hf-layer-opacity' ? 'opacity' : property;
      const shown = (key === 'opacity' ? opacityPercent(value) : undefined) ?? compact(value, 60);
      return [key, shown];
    });
  return PREFIX + JSON.stringify([compact(target, 48), changes]);
}

function readStyleHistory(label: string): { target: string; changes: [string, string][] } | null {
  if (!label.startsWith(PREFIX)) return null;
  try {
    const data: unknown = JSON.parse(label.slice(PREFIX.length));
    if (!Array.isArray(data) || data.length !== 2 || typeof data[0] !== 'string' || !Array.isArray(data[1]) || !data[1].length) return null;
    const changes: [string, string][] = [];
    for (const change of data[1]) {
      if (!Array.isArray(change) || change.length !== 2 || change.some(value => typeof value !== 'string')) return null;
      changes.push([change[0], change[1]]);
    }
    return { target: data[0], changes };
  } catch { return null; }
}

/** History includes the target for context. Toasts describe the action alone. */
export function formatStyleHistoryLabel(label: string, t: Translate): string | null {
  const entry = readStyleHistory(label);
  if (!entry) return null;
  const changes = entry.changes.map(([property, value]) => `${t(propertyLabels[property] ?? property)}: ${value || t('Auto')}`);
  return `${entry.target} · ${changes.join(' / ')}`;
}

export function formatStyleToast(label: string, action: 'apply' | 'undo' | 'redo', t: Translate): string | null {
  if (!label.startsWith(PREFIX)) return null;
  const entry = readStyleHistory(label);
  if (entry?.changes.length === 1) {
    const [property, value] = entry.changes[0];
    const percent = property === 'opacity' ? opacityPercent(value) : undefined;
    if (percent) {
      const key = {
        apply: 'Set layer opacity to {value}',
        undo: 'Undid the layer opacity change to {value}',
        redo: 'Redid the layer opacity change to {value}',
      }[action];
      return t(key, { value: percent });
    }
  }
  return t({ apply: 'Updated layer style', undo: 'Undid the layer style change', redo: 'Redid the layer style change' }[action]);
}
