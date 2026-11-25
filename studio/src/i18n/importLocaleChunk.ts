import type { Message, NonEnglishLocale } from './manifest';

export async function importLocaleChunk(locale: NonEnglishLocale): Promise<Readonly<Record<string, Message>>> {
  switch (locale) {
    case 'zh-CN': return (await import('virtual:openmotion-i18n/locale/zh-CN')).default;
    case 'ja': return (await import('virtual:openmotion-i18n/locale/ja')).default;
    case 'ko': return (await import('virtual:openmotion-i18n/locale/ko')).default;
    case 'de': return (await import('virtual:openmotion-i18n/locale/de')).default;
    case 'fr': return (await import('virtual:openmotion-i18n/locale/fr')).default;
    case 'ru': return (await import('virtual:openmotion-i18n/locale/ru')).default;
    case 'es': return (await import('virtual:openmotion-i18n/locale/es')).default;
    case 'pt-BR': return (await import('virtual:openmotion-i18n/locale/pt-BR')).default;
    case 'it': return (await import('virtual:openmotion-i18n/locale/it')).default;
    case 'tr': return (await import('virtual:openmotion-i18n/locale/tr')).default;
  }
}
