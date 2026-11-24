import { isLocale, languages, type Locale } from './manifest';

export const LOCALE_STORAGE_KEY = 'motion.studio.locale';

export function browserLocale(): Locale | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const value of preferred) {
    if (!value) continue;
    const normalized = value.replaceAll('_', '-').toLowerCase();
    const exact = languages.find(language => language.locale.toLowerCase() === normalized);
    if (exact) return exact.locale;
    const primary = normalized.split('-')[0];
    const match = languages.find(language => language.locale.toLowerCase().split('-')[0] === primary);
    if (match) return match.locale;
  }
  return undefined;
}

export function readLocale(): Locale {
  try { const saved = localStorage.getItem(LOCALE_STORAGE_KEY); if (isLocale(saved)) return saved; } catch { /* Private browsing can deny storage. */ }
  return browserLocale() ?? 'zh-CN';
}
