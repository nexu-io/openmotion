import { useRef, type InputHTMLAttributes, type RefObject } from 'react';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>,
  'aria-label' | 'className' | 'defaultValue' | 'onChange' | 'type' | 'value'> {
  'aria-label': string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  shortcut?: string;
}

/** Application-density search. The consumer owns filtering, shortcuts and when to commit IME input. */
export function SearchField({ value, onChange, className, inputRef, shortcut, maxLength = 200, disabled, ...input }: SearchFieldProps) {
  const { t } = useI18n();
  const localRef = useRef<HTMLInputElement>(null);
  const field = inputRef ?? localRef;
  const clear = t('Clear search');
  return <div className={['om-field om-search-field', className].filter(Boolean).join(' ')}>
    <RemixIcon name="search-line" size={16} aria-hidden="true" />
    <input {...input} ref={field} type="search" value={value} maxLength={maxLength} disabled={disabled}
      onChange={event => onChange(event.currentTarget.value)} />
    {value ? <button type="button" className="om-nav-item om-search-clear" aria-label={clear} title={clear} disabled={disabled}
      onClick={() => { onChange(''); field.current?.focus(); }}><RemixIcon name="close-line" size={14} aria-hidden="true" /></button>
      : shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
  </div>;
}
