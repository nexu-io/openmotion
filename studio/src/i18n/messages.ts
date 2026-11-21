import componentInspectorUi from './component-inspector-ui.json';
import reviewUi from './review-ui.json';
import timelineHoverUi from './timeline-hover-ui.json';
import canvasUi from './canvas-ui.json';
import fullscreenUi from './fullscreen-ui.json';
import assetNameUi from '../../../shared/asset-name-ui.json';
import zhCN from './zh-CN.json';
import mvpZhCN from './mvp-zh-CN.json';
import mvpUi from './mvp-ui.json';
import errorUi from './error-ui.json';
import templateUi from './template-ui.json';
import templateSearchUi from './template-search-ui.json';
import settingsUi from './settings-ui.json';
import mcpUi from './mcp-ui.json';
import studioNavigationUi from './studio-navigation-ui.json';
import assetsUi from './assets-ui.json';
import brandKitUi from './brand-kit-ui.json';
import skillsUi from './skills-ui.json';
import skillLibraryUi from './skill-library';
import projectUi from './project-ui.json';
import exportRecoveryUi from './export-recovery-ui.json';
import importRecoveryUi from './import-recovery-ui.json';
import platformExportUi from './platform-export-ui.json';
import transcriptUi from './transcript-ui.json';
import modelHubUi from './model-hub-ui.json';
import designUi from './design-ui.json';
import designEditorUi from './design-editor-ui.json';
import soundStudioUi from './sound-studio-ui.json';
import audioNavMenuUi from './audio-nav-menu-ui.json';
import gameStudioUi from './game-studio-ui.json';
import campaignUi from './campaign-ui.json';
import superAgentUi from './super-agent-ui.json';
import scenarioUi from './scenario-ui.json';
import ja from './ja.json';
import ko from './ko.json';
import de from './de.json';
import fr from './fr.json';
import ru from './ru.json';
import es from './es.json';
import ptBR from './pt-BR.json';
import it from './it.json';
import tr from './tr.json';

export const languages = [
  { locale: 'en', label: 'English' }, { locale: 'zh-CN', label: '简体中文' },
  { locale: 'ja', label: '日本語' }, { locale: 'ko', label: '한국어' },
  { locale: 'de', label: 'Deutsch' }, { locale: 'fr', label: 'Français' },
  { locale: 'ru', label: 'Русский' }, { locale: 'es', label: 'Español' },
  { locale: 'pt-BR', label: 'Português (BR)' }, { locale: 'it', label: 'Italiano' },
  { locale: 'tr', label: 'Türkçe' },
] as const;
export type Locale = typeof languages[number]['locale'];
export type MessageValues = Record<string, string | number>;
export type Translate = (message: string, values?: MessageValues) => string;
type Message = string | Partial<Record<Intl.LDMLPluralRule, string>>;
export const dictionaries: Record<Exclude<Locale, 'en'>, Record<string, Message>> = {
  'zh-CN': zhCN, ja, ko, de, fr, ru, es, 'pt-BR': ptBR, it, tr,
};
export const isLocale = (value: unknown): value is Locale => languages.some(language => language.locale === value);
// Phase-one UI additions and terminology corrections are localized in every
// supported language. Retained, unexposed advanced-editor strings still fall back.
export const mvpMessages: Partial<Record<Locale, Record<string, Message>>> = { 'zh-CN': mvpZhCN, ...mvpUi };
const uiMessages: Partial<Record<Locale, Record<string, Message>>>[] = [
  componentInspectorUi, studioNavigationUi, reviewUi, assetNameUi, mvpMessages, errorUi, templateUi, templateSearchUi, settingsUi, mcpUi, assetsUi, skillsUi, skillLibraryUi, brandKitUi, projectUi, transcriptUi, exportRecoveryUi, importRecoveryUi, platformExportUi, canvasUi, fullscreenUi, timelineHoverUi, modelHubUi, designUi, designEditorUi, soundStudioUi, audioNavMenuUi, gameStudioUi, campaignUi, scenarioUi, superAgentUi,
];
type LocalizedLocale = Exclude<Locale, 'en'>;
const effectiveCache = new Map<LocalizedLocale, Record<string, Message>>();
const reverseCache = new Map<LocalizedLocale, Map<string, string>>();
const pluralRuleCache = new Map<Locale, Intl.PluralRules>();

function getEffectiveDictionary(locale: LocalizedLocale): Record<string, Message> {
  let cached = effectiveCache.get(locale);
  if (cached) return cached;
  const localized = { ...dictionaries[locale] };
  for (const extension of uiMessages) Object.assign(localized, extension[locale]);
  effectiveCache.set(locale, localized);
  return localized;
}

function getReverseIndex(locale: LocalizedLocale): Map<string, string> {
  let cached = reverseCache.get(locale);
  if (cached) return cached;
  const messages = getEffectiveDictionary(locale);
  cached = new Map();
  for (const [source, value] of Object.entries(messages)) {
    if (typeof value === 'string') {
      cached.set(value, source);
    } else {
      for (const text of Object.values(value)) {
        if (text !== undefined) cached.set(text, source);
      }
    }
  }
  reverseCache.set(locale, cached);
  return cached;
}

function getPluralRules(locale: Locale): Intl.PluralRules {
  let cached = pluralRuleCache.get(locale);
  if (cached) return cached;
  cached = new Intl.PluralRules(locale);
  pluralRuleCache.set(locale, cached);
  return cached;
}

const singular: Record<string, string> = {
  '{count} renders': '{count} render', '{count} layers': '{count} layer',
  '{count} works': '{count} work',
  '{count} effects': '{count} effect', '{count} elements': '{count} element',
  '{count} errors': '{count} error', '{count} warnings': '{count} warning',
  ' and its {count} slides': ' and its {count} slide', '{count} lint findings': '{count} lint finding',
  '{description} ({count} effects)': '{description} ({count} effect)', '{count} files': '{count} file',
  '{count} tools': '{count} tool', '{count} elements selected': '{count} element selected',
  '{count} active effects': '{count} active effect', '{count} tracks': '{count} track',
};

export const isKnownMessage = (message: string): boolean => Object.hasOwn(getEffectiveDictionary('zh-CN'), message);

/** Accept legacy Chinese labels and already-localized built-in labels. */
export function sourceMessage(message: string, locale: Locale = 'zh-CN'): string {
  if (isKnownMessage(message)) return message;
  if (locale !== 'en') {
    const hit = getReverseIndex(locale).get(message);
    if (hit !== undefined) return hit;
  }
  const zhHit = getReverseIndex('zh-CN').get(message);
  if (zhHit !== undefined) return zhHit;
  for (const entry of languages) {
    if (entry.locale === 'en' || entry.locale === locale || entry.locale === 'zh-CN') continue;
    const otherHit = getReverseIndex(entry.locale).get(message);
    if (otherHit !== undefined) return otherHit;
  }
  return message;
}

export function translate(locale: Locale, message: string, values: MessageValues = {}): string {
  // Prism returns a legacy Chinese warning followed by an untouched diagnostic.
  const warningPrefix = '模板更新失败，使用已缓存目录：';
  if (message.startsWith(warningPrefix)) return translate(locale, 'Template update failed; using cached catalogue: {message}', { message: message.slice(warningPrefix.length) });
  message = sourceMessage(message, locale);
  const value = locale === 'en' ? undefined : getEffectiveDictionary(locale)[message];
  const category = typeof values.count === 'number' ? getPluralRules(locale).select(values.count) : 'other';
  let text = typeof value === 'string' ? value : value?.[category] ?? value?.other ?? message;
  if (locale === 'en' && category === 'one') text = singular[message] ?? text;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]));
}
