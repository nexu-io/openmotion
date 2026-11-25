import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ONBOARDING_HTML_BUDGET_BYTES = 1_000_000;
export const SUPPORTED_ONBOARDING_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'fr', 'es', 'pt'] as const;
export type OnboardingLanguage = (typeof SUPPORTED_ONBOARDING_LANGUAGES)[number];

export interface InlineProjectPreview {
  readonly id: string;
  readonly durationSeconds: number;
  readonly videoBase64: string;
  readonly videoMimeType: 'video/webm';
  readonly posterBase64: string;
  readonly posterMimeType: 'image/jpeg';
}

export interface InlineOnboardingStaticAssets {
  readonly fragmentTemplate: string;
  readonly inlineCss: string;
  readonly inlineJs: string;
}

export interface InlineOnboardingPresentationLike {
  readonly uri: string;
  readonly resourceVersion: string;
  readonly content: { readonly text: string };
}

export interface InlineOnboardingCard {
  position: number;
  templateId: string;
  title: string;
  description: string;
  durationSeconds: number;
  actionRequestId: string;
  templateKind?: 'reference';
  createArgs?: Record<string, unknown>;
}

export interface InlineOnboardingRecommendation {
  schemaVersion: number;
  resourceVersion: string;
  recommendationId: string;
  cards: InlineOnboardingCard[];
  language?: string;
  onboarding?: boolean;
  selectionGuide: string;
}

export interface InlineOnboardingTemplateSummary {
  readonly position: number;
  readonly templateId: string;
  readonly title: string;
  readonly summary: string;
  readonly durationSeconds: number;
  readonly posterUrl: string | null;
  readonly videoUrl: string | null;
}

interface BootstrapTemplateEntry {
  id: string;
  title: string;
  description: string;
  descriptions?: Record<string, string>;
  kind?: string;
  durationSeconds: number;
  videoUrl?: string;
  posterUrl?: string;
  videoBase64?: string;
  videoMimeType?: string;
  posterBase64?: string;
  posterMimeType?: string;
}

interface BootstrapPayload {
  resourceVersion?: string;
  templates: BootstrapTemplateEntry[];
}

export type RenderInlineOnboardingResult =
  | {
      readonly status: 'native_required';
      readonly reason: 'INLINE_EXTERNAL_MEDIA_BLOCKED';
      readonly resourceVersion: string;
      readonly resourceUri: string;
      readonly templateIds: readonly string[];
      readonly language: OnboardingLanguage;
    }
  | {
      readonly status: 'prepared';
      readonly html: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly previewSource: 'project' | 'builtin';
      readonly resourceVersion: string;
      readonly resourceUri: string;
      readonly templateIds: readonly string[];
      readonly language: OnboardingLanguage;
      readonly templates: readonly InlineOnboardingTemplateSummary[];
    };

export interface RenderInlineOnboardingOptions {
  readonly directory: string;
  readonly language?: string | null;
  readonly templateIds: readonly string[];
  readonly previewSource?: 'project' | 'reference';
  readonly presentation: InlineOnboardingPresentationLike;
  readonly recommendation: InlineOnboardingRecommendation;
  readonly inlineDescriptionPrefixes: Readonly<Record<OnboardingLanguage, string>>;
  readonly loadProjectPreviews: (
    referenceIds: string[],
  ) => readonly InlineProjectPreview[] | Promise<readonly InlineProjectPreview[]>;
  readonly loadStaticAssets?: (directory: string) => Promise<InlineOnboardingStaticAssets>;
  readonly rootDomId?: string;
  readonly maxBytes?: number;
}

export function normalizeOnboardingLanguage(raw?: string | null): OnboardingLanguage {
  if (typeof raw !== 'string' || !raw.trim()) return 'en';
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_ONBOARDING_LANGUAGES as readonly string[]).includes(base)
    ? (base as OnboardingLanguage)
    : 'en';
}

export async function loadInlineOnboardingStaticAssets(
  directory: string,
): Promise<InlineOnboardingStaticAssets> {
  const [fragmentTemplate, inlineCss, inlineJs] = await Promise.all([
    readFile(path.join(directory, 'inline.fragment.html'), 'utf8'),
    readFile(path.join(directory, 'build/app.css'), 'utf8'),
    readFile(path.join(directory, 'build/inline.js'), 'utf8'),
  ]);
  return { fragmentTemplate, inlineCss, inlineJs };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/**
 * Shared self-contained onboarding HTML fragment renderer used by both the
 * local/CLI onboarding helper (`scripts/inline-onboarding.mjs`) and the
 * stateless cloud onboarding service (`src/services/cloud-onboarding.ts`).
 */
export async function renderInlineOnboardingDocument(
  options: RenderInlineOnboardingOptions,
): Promise<RenderInlineOnboardingResult> {
  const previewSource = options.previewSource ?? 'project';
  if (previewSource !== 'project' && previewSource !== 'reference') {
    throw new Error(`Unknown preview source: ${String(previewSource)}`);
  }

  const language = normalizeOnboardingLanguage(options.language);
  const templateIds = [...options.templateIds];
  const maxBytes = options.maxBytes ?? ONBOARDING_HTML_BUDGET_BYTES;

  const bootstrapMatch = options.presentation.content.text.match(
    /window\.__OPENMOTION_TEMPLATE_CARDS__=(.*?);<\/script>/s,
  );
  if (!bootstrapMatch) {
    throw new Error('Verified production bootstrap is missing');
  }

  const bootstrap = JSON.parse(bootstrapMatch[1]) as BootstrapPayload;
  const recommendation: InlineOnboardingRecommendation = {
    ...options.recommendation,
    cards: options.recommendation.cards.map((card) => ({ ...card })),
  };

  // Capture original reference media URLs and localized summaries before substituting
  // inline project previews into the HTML bootstrap.
  const mediaById = new Map<string, { posterUrl: string | null; videoUrl: string | null; summary: string }>();
  for (const tpl of bootstrap.templates) {
    if (!templateIds.includes(tpl.id)) continue;
    const localizedSummary = tpl.descriptions?.[language] ?? tpl.description;
    mediaById.set(tpl.id, {
      posterUrl: typeof tpl.posterUrl === 'string' ? tpl.posterUrl : null,
      videoUrl: typeof tpl.videoUrl === 'string' ? tpl.videoUrl : null,
      summary: localizedSummary,
    });
  }

  // Only the selected three enter the document budget. Native recommendations
  // retain the original reference films; inline documents embed silent project renders.
  bootstrap.templates = bootstrap.templates.filter((tpl) => templateIds.includes(tpl.id));
  const references = bootstrap.templates.filter((tpl) => tpl.kind === 'reference');
  if (references.length > 0 && previewSource === 'project') {
    const previews = await options.loadProjectPreviews(references.map((item) => item.id));
    const prefix = options.inlineDescriptionPrefixes[language];
    for (const tpl of references) {
      const preview = previews.find((item) => item.id === tpl.id);
      if (!preview) {
        throw new Error(`Missing inline preview for ${tpl.id}`);
      }
      delete tpl.videoUrl;
      delete tpl.posterUrl;
      Object.assign(tpl, preview);
      tpl.description = prefix + tpl.description;
      if (tpl.descriptions) {
        for (const loc of Object.keys(tpl.descriptions) as OnboardingLanguage[]) {
          const locPrefix = options.inlineDescriptionPrefixes[loc] ?? prefix;
          tpl.descriptions[loc] = locPrefix + tpl.descriptions[loc];
        }
      }
      const card = recommendation.cards.find((item) => item.templateId === tpl.id);
      if (card) {
        card.durationSeconds = preview.durationSeconds;
        card.description = tpl.description;
      }
    }
  }

  // Native MCP Apps carry ui.csp.resourceDomains; a standalone HTML visualization
  // fragment cannot inherit it. Never mark remote-reference fragments as displayable.
  if (
    bootstrap.templates.some(
      (tpl) => templateIds.includes(tpl.id) && Boolean(tpl.posterUrl || tpl.videoUrl),
    )
  ) {
    return {
      status: 'native_required',
      reason: 'INLINE_EXTERNAL_MEDIA_BLOCKED',
      resourceVersion: options.presentation.resourceVersion,
      resourceUri: options.presentation.uri,
      templateIds: recommendation.cards.map((card) => card.templateId),
      language,
    };
  }

  const assets = await (options.loadStaticAssets ?? loadInlineOnboardingStaticAssets)(
    options.directory,
  );

  const rootDomId = options.rootDomId ?? `openmotion-onboarding-${randomUUID()}`;
  const replacements: Record<string, string> = {
    '__OPENMOTION_INLINE_ROOT__': rootDomId,
    '/*__OPENMOTION_INLINE_STYLE__*/': assets.inlineCss.replace(/<\/style/gi, '<\\/style'),
    '/*__OPENMOTION_INLINE_APP__*/': assets.inlineJs.replace(/<\/script/gi, '<\\/script'),
    '/*__OPENMOTION_INLINE_BOOTSTRAP__*/': safeJson(bootstrap),
    '/*__OPENMOTION_INLINE_RECOMMENDATION__*/': safeJson({ ...recommendation, onboarding: false }),
  };

  let html = assets.fragmentTemplate;
  for (const [marker, value] of Object.entries(replacements)) {
    if (!html.includes(marker)) {
      throw new Error(`Inline template marker is missing: ${marker}`);
    }
    html = html.replaceAll(marker, () => value);
  }
  if (html.includes('__OPENMOTION_INLINE_')) {
    throw new Error('Inline template contains unresolved markers');
  }

  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes >= maxBytes) {
    throw new Error(`Inline onboarding document (${bytes} bytes) exceeds ${maxBytes}-byte host budget`);
  }

  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  const templates: InlineOnboardingTemplateSummary[] = recommendation.cards.map((card) => {
    const orig = mediaById.get(card.templateId);
    return {
      position: card.position,
      templateId: card.templateId,
      title: card.title,
      summary: orig?.summary ?? card.description,
      durationSeconds: card.durationSeconds,
      posterUrl: orig?.posterUrl ?? null,
      videoUrl: orig?.videoUrl ?? null,
    };
  });

  return {
    status: 'prepared',
    html,
    bytes,
    sha256,
    previewSource: references.length > 0 ? 'project' : 'builtin',
    resourceVersion: options.presentation.resourceVersion,
    resourceUri: options.presentation.uri,
    templateIds: recommendation.cards.map((card) => card.templateId),
    language,
    templates,
  };
}
