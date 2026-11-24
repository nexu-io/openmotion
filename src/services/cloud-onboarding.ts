import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ONBOARDING_HTML_BUDGET_BYTES,
  SUPPORTED_ONBOARDING_LANGUAGES,
  loadInlineOnboardingStaticAssets,
  normalizeOnboardingLanguage,
  renderInlineOnboardingDocument,
  type InlineOnboardingRecommendation,
  type InlineOnboardingStaticAssets,
  type InlineProjectPreview,
  type OnboardingLanguage,
} from '../../shared/inline-onboarding-renderer.ts';
import { CloudError } from '../contracts/errors.ts';

export const DEFAULT_CLOUD_ORIGIN = 'https://motion.open-design.ai';
export const MAX_DOCUMENT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_CACHE_VERSIONS = 2;

export {
  ONBOARDING_HTML_BUDGET_BYTES,
  SUPPORTED_ONBOARDING_LANGUAGES,
  normalizeOnboardingLanguage,
  type OnboardingLanguage,
};

interface LoadedTemplatePresentation {
  readonly uri: string;
  readonly resourceVersion: string;
  readonly content: { text: string };
  readonly templates: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly durationSeconds: number;
    readonly kind?: 'builtin' | 'reference';
    readonly videoUrl?: string;
    readonly posterUrl?: string;
  }>;
}

interface OnboardingTemplatesModule {
  onboardingTemplateIds: readonly string[];
  selectOnboardingTemplateIds: (random?: () => number) => string[];
}

interface TemplateRecommendationsModule {
  loadTemplatePresentation: (options?: {
    directory?: string;
    applicationRoot?: string;
  }) => LoadedTemplatePresentation;
  loadInlineProjectPreviews: (
    templateIds: string[],
    options?: { directory?: string; applicationRoot?: string },
  ) => InlineProjectPreview[];
  showTemplateRecommendations: (
    presentation: LoadedTemplatePresentation,
    args: { templateIds: string[]; onboarding?: boolean; language?: string },
  ) => InlineOnboardingRecommendation;
}

interface OnboardingI18nModule {
  inlineDescriptionPrefixes: Record<OnboardingLanguage, string>;
  welcomeMarkdown: (language: OnboardingLanguage, cardsPosition?: 'before' | 'after') => string;
  noSidebarWelcomeMarkdown: (
    language: OnboardingLanguage,
    libraryUrl: string,
    options?: { includeCardIntro?: boolean },
  ) => string;
  installationFallbackWelcome: (language: OnboardingLanguage) => string;
}

export interface CloudOnboardingTemplateItem {
  readonly position: number;
  readonly templateId: string;
  readonly title: string;
  readonly summary: string;
  readonly durationSeconds: number;
  readonly previewUrl: string;
  readonly posterUrl: string | null;
  readonly videoUrl: string | null;
}

export interface CloudOnboardingDshTemplateItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly previewUrl?: string;
  readonly posterUrl?: string;
  readonly duration: number;
}

export interface CloudOnboardingPreparePayload {
  readonly schemaVersion: 1;
  readonly language: OnboardingLanguage;
  readonly origin: string;
  readonly mcpUrl: string;
  readonly libraryUrl: string;
  readonly templateIds: readonly string[];
  readonly resourceVersion: string;
  readonly welcomeMarkdown: string;
  readonly fallbackWelcomeMarkdown: string;
  readonly noSidebarWelcomeMarkdown: string;
  readonly noSidebarTextWelcomeMarkdown: string;
  readonly inlineHtmlUrl: string;
  readonly inlineHtmlSha256: string;
  readonly inlineHtmlBytes: number;
  readonly cardPresentation: {
    readonly tool: 'openmotion_show_template_recommendations';
    readonly arguments: {
      readonly templateIds: readonly string[];
      readonly language: OnboardingLanguage;
      readonly onboarding: true;
    };
    readonly cardsOnlyArguments: {
      readonly templateIds: readonly string[];
      readonly language: OnboardingLanguage;
      readonly onboarding: false;
    };
  };
  readonly dshCardPresentation: {
    readonly tool: 'propose_action';
    readonly skill: 'openmotion-template-recommendations';
    readonly arguments: {
      readonly action: 'openmotion_template_recommendation';
      readonly title: 'OpenMotion';
      readonly brief: string;
      readonly details: {
        readonly onboarding: true;
        readonly language: OnboardingLanguage;
        readonly templates: readonly CloudOnboardingDshTemplateItem[];
      };
    };
  };
  readonly templates: readonly CloudOnboardingTemplateItem[];
}

export interface RenderedOnboardingDocument {
  readonly html: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly resourceVersion: string;
  readonly language: OnboardingLanguage;
  readonly templateIds: readonly string[];
  readonly templates: readonly CloudOnboardingTemplateItem[];
}

export interface ByteBoundedDocumentCache<T extends { readonly bytes: number }> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  readonly size: number;
  readonly totalBytes: number;
  readonly maxBytes: number;
}

/**
 * Byte-bounded LRU cache so unauthenticated permutations of `/api/onboarding/cards.html`
 * cannot accumulate unbounded heap across languages and template orderings.
 */
export function createByteBoundedDocumentCache<T extends { readonly bytes: number }>(
  maxBytes = MAX_DOCUMENT_CACHE_BYTES,
): ByteBoundedDocumentCache<T> {
  const entries = new Map<string, T>();
  let totalBytes = 0;

  return {
    get(key: string): T | undefined {
      const value = entries.get(key);
      if (!value) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key: string, value: T): void {
      if (value.bytes > maxBytes) return;
      const existing = entries.get(key);
      if (existing) {
        totalBytes -= existing.bytes;
        entries.delete(key);
      }
      while (totalBytes + value.bytes > maxBytes && entries.size > 0) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = entries.get(oldestKey);
        entries.delete(oldestKey);
        if (oldest) totalBytes -= oldest.bytes;
      }
      entries.set(key, value);
      totalBytes += value.bytes;
    },
    clear(): void {
      entries.clear();
      totalBytes = 0;
    },
    get size(): number {
      return entries.size;
    },
    get totalBytes(): number {
      return totalBytes;
    },
    get maxBytes(): number {
      return maxBytes;
    },
  };
}

interface CachedResourceMedia {
  readonly previewsById: ReadonlyMap<string, InlineProjectPreview>;
  readonly staticAssets: InlineOnboardingStaticAssets;
}

const documentCache = createByteBoundedDocumentCache<RenderedOnboardingDocument>(
  MAX_DOCUMENT_CACHE_BYTES,
);
const resourceMediaCache = new Map<string, Promise<CachedResourceMedia>>();

export function clearCloudOnboardingCaches(): void {
  documentCache.clear();
  resourceMediaCache.clear();
}

export function getCloudOnboardingCacheStats(): {
  readonly documentCount: number;
  readonly documentBytes: number;
  readonly documentMaxBytes: number;
  readonly resourceVersionCount: number;
} {
  return {
    documentCount: documentCache.size,
    documentBytes: documentCache.totalBytes,
    documentMaxBytes: documentCache.maxBytes,
    resourceVersionCount: resourceMediaCache.size,
  };
}

let cachedTemplatesModule: Promise<OnboardingTemplatesModule> | null = null;
let cachedRecommendationsModule: Promise<TemplateRecommendationsModule> | null = null;
let cachedI18nModule: Promise<OnboardingI18nModule> | null = null;

function loadOnboardingTemplatesModule(): Promise<OnboardingTemplatesModule> {
  if (!cachedTemplatesModule) {
    const modPath = '../../shared/onboarding-templates' + '.ts';
    cachedTemplatesModule = import(modPath) as Promise<OnboardingTemplatesModule>;
  }
  return cachedTemplatesModule;
}

function loadRecommendationsModule(): Promise<TemplateRecommendationsModule> {
  if (!cachedRecommendationsModule) {
    const modPath = '../../shared/mcp-template-recommendations' + '.ts';
    cachedRecommendationsModule = import(modPath) as Promise<TemplateRecommendationsModule>;
  }
  return cachedRecommendationsModule;
}

function loadI18nModule(): Promise<OnboardingI18nModule> {
  if (!cachedI18nModule) {
    const modPath = '../../mcp-ui/template-recommendations/i18n' + '.ts';
    cachedI18nModule = import(modPath) as Promise<OnboardingI18nModule>;
  }
  return cachedI18nModule;
}

function loadCachedResourceMedia(options: {
  runtimeRoot: string;
  directory: string;
  resourceVersion: string;
  onboardingTemplateIds: readonly string[];
  recMod: TemplateRecommendationsModule;
}): Promise<CachedResourceMedia> {
  const key = `${options.runtimeRoot}|${options.resourceVersion}`;
  const existing = resourceMediaCache.get(key);
  if (existing) {
    resourceMediaCache.delete(key);
    resourceMediaCache.set(key, existing);
    return existing;
  }

  const pending = (async (): Promise<CachedResourceMedia> => {
    // Load and base64-encode each curated preview once per resource version (~1.2 MiB total)
    // instead of duplicating media across every language and permutation.
    const [previews, staticAssets] = await Promise.all([
      Promise.resolve(
        options.recMod.loadInlineProjectPreviews([...options.onboardingTemplateIds], {
          applicationRoot: options.runtimeRoot,
          directory: options.directory,
        }),
      ),
      loadInlineOnboardingStaticAssets(options.directory),
    ]);
    return {
      previewsById: new Map(previews.map((item) => [item.id, item])),
      staticAssets,
    };
  })();

  while (resourceMediaCache.size >= MAX_RESOURCE_CACHE_VERSIONS) {
    const oldestKey = resourceMediaCache.keys().next().value;
    if (oldestKey === undefined) break;
    resourceMediaCache.delete(oldestKey);
  }
  resourceMediaCache.set(key, pending);
  pending.catch(() => {
    if (resourceMediaCache.get(key) === pending) {
      resourceMediaCache.delete(key);
    }
  });
  return pending;
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  // Set RFC 4122 version 4 / variant 10 bits so downstream UUID validators accept it.
  const part3 = '4' + hex.slice(13, 16);
  const variantNibble = (8 + (Number.parseInt(hex.slice(16, 17), 16) % 4)).toString(16);
  const part4 = variantNibble + hex.slice(17, 20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${part3}-${part4}-${hex.slice(20, 32)}`;
}

export function normalizePublicOrigin(rawOrigin: string): string {
  return rawOrigin.trim().replace(/\/+$/, '');
}

/**
 * Renders `docs/install.md` bound to the active deployment's `APP_PUBLIC_ORIGIN`
 * so staging/test and local Docker deployments serve self-consistent cloud setup
 * instructions without committing non-public hostnames into the repository.
 */
export async function renderCloudInstallGuide(options: {
  runtimeRoot: string;
  publicOrigin: string;
}): Promise<string> {
  const origin = normalizePublicOrigin(options.publicOrigin || DEFAULT_CLOUD_ORIGIN);
  const guidePath = path.join(options.runtimeRoot, 'docs/install.md');
  let raw: string;
  try {
    raw = await readFile(guidePath, 'utf8');
  } catch {
    throw new CloudError('SERVICE_UNAVAILABLE', 'Installation guide is unavailable in this deployment', {
      status: 503,
      applied: false,
    });
  }
  return raw.replaceAll(DEFAULT_CLOUD_ORIGIN, origin);
}

export async function resolveOnboardingTemplateSelection(rawTemplates?: string | null): Promise<{
  templateIds: string[];
  explicit: boolean;
}> {
  const { onboardingTemplateIds, selectOnboardingTemplateIds } = await loadOnboardingTemplatesModule();
  if (rawTemplates === undefined || rawTemplates === null || !rawTemplates.trim()) {
    return { templateIds: selectOnboardingTemplateIds(), explicit: false };
  }
  const parts = rawTemplates
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 3 || new Set(parts).size !== 3) {
    throw new CloudError(
      'INVALID_ARGUMENT',
      'templates must be three distinct comma-separated curated onboarding template IDs',
      { status: 400, applied: false },
    );
  }
  for (const id of parts) {
    if (!onboardingTemplateIds.includes(id)) {
      throw new CloudError('INVALID_ARGUMENT', `Unknown onboarding template ID: ${id}`, {
        status: 400,
        applied: false,
      });
    }
  }
  return { templateIds: parts, explicit: true };
}

export async function defaultDeterministicTemplateIds(): Promise<string[]> {
  const { onboardingTemplateIds } = await loadOnboardingTemplatesModule();
  return onboardingTemplateIds.slice(0, 3);
}

/**
 * Deterministically renders the self-contained `< 1 MiB` onboarding HTML cards
 * fragment in memory so any stateless `api` replica serves byte-identical HTML
 * and SHA-256 digests for a given `(resourceVersion, language, templateIds)` tuple.
 */
export async function renderCloudOnboardingDocument(options: {
  runtimeRoot: string;
  publicOrigin: string;
  language: OnboardingLanguage;
  templateIds: readonly string[];
}): Promise<RenderedOnboardingDocument> {
  const origin = normalizePublicOrigin(options.publicOrigin || DEFAULT_CLOUD_ORIGIN);
  const directory = path.join(options.runtimeRoot, 'mcp-ui/template-recommendations');
  const [templatesMod, recMod, i18nMod] = await Promise.all([
    loadOnboardingTemplatesModule(),
    loadRecommendationsModule(),
    loadI18nModule(),
  ]);

  let presentation: LoadedTemplatePresentation;
  try {
    presentation = recMod.loadTemplatePresentation({
      applicationRoot: options.runtimeRoot,
      directory,
    });
  } catch (error) {
    throw new CloudError(
      'SERVICE_UNAVAILABLE',
      `Onboarding template presentation assets are unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { status: 503, applied: false },
    );
  }

  const cacheKey = `${options.runtimeRoot}|${origin}|${presentation.resourceVersion}|${options.language}|${options.templateIds.join(',')}`;
  const cached = documentCache.get(cacheKey);
  if (cached) return cached;

  const templateIds = [...options.templateIds];
  const rawRecommendation = recMod.showTemplateRecommendations(presentation, {
    templateIds,
    language: options.language,
    onboarding: true,
  });

  // Replace random UUIDs with deterministic tuple-derived UUIDs so multi-replica pods
  // return identical HTML bytes and SHA-256 hashes across `/prepare` and `/cards.html`.
  const seedBase = `${presentation.resourceVersion}|${options.language}|${templateIds.join(',')}`;
  const recommendation: InlineOnboardingRecommendation = {
    ...rawRecommendation,
    recommendationId: deterministicUuid(`${seedBase}|rec`),
    cards: rawRecommendation.cards.map((card, index) => ({
      ...card,
      actionRequestId: deterministicUuid(`${seedBase}|card|${index}|${card.templateId}`),
    })),
  };

  let resourceMedia: CachedResourceMedia;
  try {
    resourceMedia = await loadCachedResourceMedia({
      runtimeRoot: options.runtimeRoot,
      directory,
      resourceVersion: presentation.resourceVersion,
      onboardingTemplateIds: templatesMod.onboardingTemplateIds,
      recMod,
    });
  } catch (error) {
    throw new CloudError(
      'SERVICE_UNAVAILABLE',
      `Onboarding preview assets are unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { status: 503, applied: false },
    );
  }

  const rootDomId = `openmotion-onboarding-${createHash('sha256').update(seedBase).digest('hex').slice(0, 16)}`;
  let rendered;
  try {
    rendered = await renderInlineOnboardingDocument({
      directory,
      language: options.language,
      templateIds,
      previewSource: 'project',
      presentation,
      recommendation,
      inlineDescriptionPrefixes: i18nMod.inlineDescriptionPrefixes,
      rootDomId,
      loadProjectPreviews: (referenceIds) => {
        const resolved: InlineProjectPreview[] = [];
        for (const id of referenceIds) {
          const hit = resourceMedia.previewsById.get(id);
          if (hit) {
            resolved.push(hit);
          } else {
            const loaded = recMod.loadInlineProjectPreviews([id], {
              applicationRoot: options.runtimeRoot,
              directory,
            });
            resolved.push(...loaded);
          }
        }
        return resolved;
      },
      loadStaticAssets: async () => resourceMedia.staticAssets,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('host budget') ? 500 : 503;
    throw new CloudError('SERVICE_UNAVAILABLE', message, { status, applied: false });
  }

  if (rendered.status !== 'prepared') {
    throw new CloudError(
      'SERVICE_UNAVAILABLE',
      'Inline onboarding document requires native MCP App presentation',
      { status: 503, applied: false },
    );
  }

  const templates: CloudOnboardingTemplateItem[] = rendered.templates.map((item) => ({
    position: item.position,
    templateId: item.templateId,
    title: item.title,
    summary: item.summary,
    durationSeconds: item.durationSeconds,
    previewUrl: `${origin}/?templates=1&template=${encodeURIComponent(item.templateId)}`,
    posterUrl: item.posterUrl,
    videoUrl: item.videoUrl,
  }));

  const result: RenderedOnboardingDocument = {
    html: rendered.html,
    sha256: rendered.sha256,
    bytes: rendered.bytes,
    resourceVersion: rendered.resourceVersion,
    language: rendered.language,
    templateIds,
    templates,
  };

  documentCache.set(cacheKey, result);
  return result;
}

export function buildDshCardPresentation(
  templates: readonly CloudOnboardingTemplateItem[],
  language: OnboardingLanguage,
): CloudOnboardingPreparePayload['dshCardPresentation'] {
  // DSH action cards validate against `detailsSchema` (`id`, `title`, `description`,
  // video `previewUrl`, `posterUrl`, `duration`) rather than the text-fallback HTML URL.
  const dshTemplates: CloudOnboardingDshTemplateItem[] = templates.map((item) => ({
    id: item.templateId,
    title: item.title,
    description: item.summary.slice(0, 1000),
    ...(item.videoUrl ? { previewUrl: item.videoUrl } : {}),
    ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
    duration: item.durationSeconds,
  }));
  return {
    tool: 'propose_action',
    skill: 'openmotion-template-recommendations',
    arguments: {
      action: 'openmotion_template_recommendation',
      title: 'OpenMotion',
      brief: 'Choose a template to begin',
      details: {
        onboarding: true,
        language,
        templates: dshTemplates,
      },
    },
  };
}

export async function prepareCloudOnboarding(options: {
  runtimeRoot: string;
  publicOrigin: string;
  language?: string | null;
  templates?: string | null;
}): Promise<CloudOnboardingPreparePayload> {
  const origin = normalizePublicOrigin(options.publicOrigin || DEFAULT_CLOUD_ORIGIN);
  const language = normalizeOnboardingLanguage(options.language);
  const { templateIds } = await resolveOnboardingTemplateSelection(options.templates);
  const [doc, i18nMod] = await Promise.all([
    renderCloudOnboardingDocument({
      runtimeRoot: options.runtimeRoot,
      publicOrigin: origin,
      language,
      templateIds,
    }),
    loadI18nModule(),
  ]);

  const libraryUrl = `${origin}/?templates=1`;
  const inlineHtmlUrl = `${origin}/api/onboarding/cards.html?lang=${encodeURIComponent(language)}&templates=${encodeURIComponent(templateIds.join(','))}`;

  return {
    schemaVersion: 1,
    language,
    origin,
    mcpUrl: `${origin}/mcp`,
    libraryUrl,
    templateIds: doc.templateIds,
    resourceVersion: doc.resourceVersion,
    welcomeMarkdown: i18nMod.welcomeMarkdown(language),
    fallbackWelcomeMarkdown: i18nMod.installationFallbackWelcome(language),
    noSidebarWelcomeMarkdown: i18nMod.noSidebarWelcomeMarkdown(language, libraryUrl, {
      includeCardIntro: true,
    }),
    noSidebarTextWelcomeMarkdown: i18nMod.noSidebarWelcomeMarkdown(language, libraryUrl, {
      includeCardIntro: false,
    }),
    inlineHtmlUrl,
    inlineHtmlSha256: doc.sha256,
    inlineHtmlBytes: doc.bytes,
    cardPresentation: {
      tool: 'openmotion_show_template_recommendations',
      arguments: {
        templateIds: doc.templateIds,
        language,
        onboarding: true,
      },
      cardsOnlyArguments: {
        templateIds: doc.templateIds,
        language,
        onboarding: false,
      },
    },
    dshCardPresentation: buildDshCardPresentation(doc.templates, language),
    templates: doc.templates,
  };
}
