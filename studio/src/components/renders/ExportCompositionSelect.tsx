import { useFileManagerContextOptional } from '../../contexts/FileManagerContext';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { Select } from '../ui/Select';

function formatCompositionLabel(path: string): string {
  const stem = path.replace(/^compositions\//, '').replace(/\.html$/i, '');
  const segment = stem.split('/').pop() || stem;
  return segment.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, ch => ch.toUpperCase());
}

/** Only show a scene picker when the project actually has other compositions. */
export function ExportCompositionSelect({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const files = useFileManagerContextOptional(), { t } = useI18n();
  const compositions = [...new Set([value, ...(files?.compositions || [])])];
  if (compositions.length < 2) return null;
  const labels = compositions.map(path => path === 'index.html' ? t('Full video') : formatCompositionLabel(path));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) duplicates.add(label);
    seen.add(label);
  }
  const options = compositions.map((path, index) => ({
    value: path,
    label: path !== 'index.html' && duplicates.has(labels[index]) ? path : labels[index],
    icon: <RemixIcon name="film-line" size={14} />,
  }));
  return <div className="flex flex-col gap-1 px-3 pb-3">
    <span className="text-step-11 text-text-3">{t('Export scene')}</span>
    <Select label={t('Export scene')} value={value} disabled={disabled} options={options} onCommit={onChange} />
  </div>;
}
