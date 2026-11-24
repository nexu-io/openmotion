import assert from 'node:assert/strict';
import { CloudError } from '../contracts/errors.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isSha256Hex, isUuid, projectPath } from '../../shared/project-validation.ts';
import { boundedMediaBody, cmsUrl } from '../../shared/repository-media.ts';
import { maxLfsAssetBytes } from '../../shared/repository-template-catalog.ts';
import { BUILTIN_TEMPLATES, mimeTypeForPath, validateTemplateId } from './catalog-service.ts';
import type { PreparedCatalogFile, PreparedCatalogTemplate } from './catalog-template-source.ts';

export type { PreparedCatalogFile, PreparedCatalogTemplate };
export type PrismEnvironment = 'dev' | 'prod';

const resourceId = '1500c9af-186b-457f-b74d-a58113f657d8';
const maxPublicationBytes = 64 * 1024 * 1024;
const localeName = z.string().max(63).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/);
const cmsFile = z.string().transform(cmsUrl);
const optionalFile = cmsFile.nullish();
const labels = z.array(z.string()).optional();
const sourceLink = z.string().refine(value => {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password;
});

// Author links can point outside Prism. Source files, guides and artwork are immutable Prism files.
const original = z.object({
  templateName: z.string().trim().min(1), summary: z.string().optional(),
  author: z.string().optional(), attributionNickname: z.string().optional(), category: z.string().optional(),
  promotionalUseCases: z.string().optional(), visualPresentation: z.string().optional(),
  motionTags: z.string().optional(), styleDescription: z.string().optional(), reviewFocus: z.string().optional(),
  durationSeconds: z.string().optional(), sourceUrl: z.union([sourceLink, z.literal('')]).optional(),
});
const file = z.object({
  path: z.string().transform(path => projectPath(path, true)),
  sha256: z.string().refine(isSha256Hex),
  url: cmsFile,
  bytes: z.number().int().nonnegative().max(maxLfsAssetBytes),
});
const entry = z.object({
  templateId: z.string().transform(validateTemplateId), original,
  sortOrder: z.int32(), featuredOrder: z.int32().nonnegative().nullish(),
  files: z.array(file).default([]), indexUrl: optionalFile, projectFileUrl: optionalFile,
  coverUrl: optionalFile, previewUrl: optionalFile, motionDocumentUrl: optionalFile, motionGuideUrl: optionalFile,
  authorAvatarUrl: optionalFile, brand: z.string().optional(), colors: labels, industries: labels, creationModels: labels,
  width: z.int32().positive().nullish(), height: z.int32().positive().nullish(), conversionNotes: z.string().optional(),
});
const identity = z.object({
  resourceId: z.literal(resourceId), channel: z.literal('default'),
  environment: z.enum(['dev','prod']), publicationId: z.string().refine(isUuid),
  versionId: z.string().regex(/^ver_[0-9a-f]{32}$/), version: z.string().min(1),
  generation: z.number().int().positive(), defaultLocale: localeName,
});
const manifestSchema = identity.extend({
  manifestVersion: z.literal('v4'), mainUrl: z.string(), contentPublicationId: z.string().refine(isUuid),
  contents: z.array(z.object({
    locale: localeName, contentUrl: z.string(), byteLength: z.number().int().positive().max(maxPublicationBytes),
    sha256: z.string().refine(isSha256Hex),
  })).min(1).max(64),
});
const publication = identity.extend({
  mainVersion: z.literal('v2').optional(),
  content: z.record(localeName, z.object({
    templates: z.array(entry), brands: z.array(z.object({ name: z.string().min(1), logoUrl: cmsFile })).default([]),
  })),
});

function projectFiles(template: z.infer<typeof entry>): PreparedCatalogFile[] {
  const paths = new Set<string>();
  const files = template.files.map(file => {
    assert(!paths.has(file.path), `Duplicate project path in ${template.templateId}: ${file.path}`);
    paths.add(file.path);
    assert.equal(file.url, 'https://r.open-design.ai/files/' + file.sha256, 'Project file URL must match SHA-256');
    return {
      path: file.path, sha256: file.sha256, sizeBytes: file.bytes, mimeType: mimeTypeForPath(file.path),
      metadata: null, isProjectFile: true, isAvailable: false, remoteUrl: file.url, bytes: null,
    };
  });
  if (!files.length && !template.indexUrl) return [];
  assert(files.some(file => file.path === 'index.html' && file.remoteUrl === template.indexUrl),
    `Missing matching index.html in ${template.templateId}`);
  return files;
}

type LocaleEntry = Pick<z.infer<typeof entry>, 'original' | 'motionDocumentUrl' | 'motionGuideUrl' | 'conversionNotes'>;

/** The default locale owns the project files. A missing translation uses the catalog service's locale fallback. */
export function parsePrismMotionPublication(value: unknown, environment: PrismEnvironment): PreparedCatalogTemplate[] {
  const data = publication.parse(value);
  assert.equal(data.environment, environment, 'Unexpected Prism environment');
  const builtinIds = new Set(BUILTIN_TEMPLATES.map(template => template.id));
  const primary = data.content[data.defaultLocale];
  assert(primary?.templates.length, 'Missing default locale templates');
  const localesById = new Map<string, Record<string, LocaleEntry>>();
  for (const template of primary.templates) localesById.set(template.templateId, {});
  for (const [locale, content] of Object.entries(data.content)) {
    for (const template of content.templates) {
      const locales = localesById.get(template.templateId);
      assert(locales, `Template ${template.templateId} missing from default locale`);
      assert(!Object.hasOwn(locales, locale), `Duplicate template ${template.templateId} in ${locale}`);
      const { original, motionDocumentUrl, motionGuideUrl, conversionNotes } = template;
      locales[locale] = { original, motionDocumentUrl, motionGuideUrl, conversionNotes };
    }
  }
  const brands = new Map(primary.brands.map(brand => [brand.name, brand.logoUrl]));
  const catalogVersion = `prism:${environment}:${data.publicationId}`;
  return primary.templates.map(template => {
    const { templateId: id, files: _files, ...card } = template;
    assert(!builtinIds.has(id.toLowerCase()), `Prism template ID reserved for a builtin: ${id}`);
    const files = projectFiles(template);
    const logo = card.brand && brands.get(card.brand);
    return {
      id, kind: 'prism', catalogVersion, sortOrder: card.sortOrder, featuredOrder: card.featuredOrder ?? null,
      hasHtmlProject: files.length > 0, files, instructionsMd: null, motionMd: null,
      metadata: {
        publicationId: data.publicationId, publicationSize: primary.templates.length, version: data.version, generation: data.generation, defaultLocale: data.defaultLocale,
        entry: { templateId: id, ...card }, locales: localesById.get(id),
        brands: logo && card.brand ? { [card.brand]: logo } : {},
      },
    };
  });
}

async function readPublication(
  environment: PrismEnvironment,
  origin: string,
  fetchImpl: typeof fetch,
  cached?: readonly PreparedCatalogTemplate[],
): Promise<readonly PreparedCatalogTemplate[]> {
  const channelPath = `/resources/${resourceId}/channels/default`;
  const controller = new AbortController();
  const options = { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]) } as const;
  try {
    const response = await fetchImpl(origin + channelPath + '/manifest.json', options);
    const bytes = await boundedMediaBody(response, 128 * 1024);
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    assert.equal(manifest.environment, environment, 'Unexpected Prism environment');
    // Legacy version labels can differ from their public URL address. Follow only this resource's canonical path.
    const versionPrefix = channelPath + '/versions/';
    const address = decodeURIComponent(manifest.mainUrl.split('/')[6] ?? '');
    assert(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,511}$/.test(address), 'Invalid Prism version address');
    const versionPath = versionPrefix + encodeURIComponent(address);
    assert.equal(manifest.mainUrl, versionPath + '/main.json', 'Invalid Prism version path');
    const locales = new Set<string>();
    let totalBytes = 0;
    for (const entry of manifest.contents) {
      assert(!locales.has(entry.locale.toLowerCase()), 'Duplicate manifest locale');
      locales.add(entry.locale.toLowerCase());
      assert.equal(entry.contentUrl, `${versionPath}/${entry.locale}.json`, 'Invalid Prism locale path');
      totalBytes += entry.byteLength;
    }
    assert(manifest.contents.some(entry => entry.locale === manifest.defaultLocale), 'Default locale missing from manifest');
    assert(totalBytes <= maxPublicationBytes, 'Prism publication exceeds maximum bytes');

    if (cached?.[0]?.catalogVersion === `prism:${environment}:${manifest.publicationId}`) return cached;
    const content: Record<string, unknown> = {};
    const pending = manifest.contents.values();
    async function readLocales() {
      for (const entry of pending) {
        const response = await fetchImpl(origin + entry.contentUrl, options);
        const body = await boundedMediaBody(response, entry.byteLength);
        assert.equal(body.length, entry.byteLength, 'Prism locale length mismatch');
        assert.equal(createHash('sha256').update(body).digest('hex'), entry.sha256, 'Prism locale SHA-256 mismatch');
        content[entry.locale] = JSON.parse(body.toString('utf8'));
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, manifest.contents.length) }, readLocales));
    return parsePrismMotionPublication({ ...manifest, content }, environment);
  } finally {
    controller.abort();
  }
}

interface PrismMotionCatalogOptions {
  publicOrigin?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  onRefreshError?: (error: unknown) => void;
  /** Invoked asynchronously when a newly validated publication replaces the previous snapshot. */
  onPublicationChanged?: (
    templates: readonly PreparedCatalogTemplate[],
    catalogVersion: string,
  ) => unknown;
}

const emptyCatalog: readonly PreparedCatalogTemplate[] = [];

/** Per API instance and environment. Access triggers checks; no timer runs between requests. */
export class PrismMotionCatalog {
  private readonly environment: PrismEnvironment;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly onRefreshError?: (error: unknown) => void;
  private readonly onPublicationChanged?: (
    templates: readonly PreparedCatalogTemplate[],
    catalogVersion: string,
  ) => unknown;
  private cached?: readonly PreparedCatalogTemplate[];
  private pending?: Promise<void>;
  private checkAfter = 0;

  constructor(environment: PrismEnvironment, options: PrismMotionCatalogOptions = {}) {
    assert(environment === 'dev' || environment === 'prod', 'Unknown Prism environment');
    const configuredOrigin = options.publicOrigin ?? (environment === 'prod' ? 'https://r.open-design.ai' : undefined);
    assert(configuredOrigin, 'Set PRISM_PUBLIC_ORIGIN for the dev catalog');
    const url = new URL(configuredOrigin);
    assert(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
      'PRISM_PUBLIC_ORIGIN must be an HTTPS origin');
    this.environment = environment;
    this.origin = url.origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.retryMs = options.retryMs ?? 30_000;
    this.onRefreshError = options.onRefreshError;
    this.onPublicationChanged = options.onPublicationChanged;
  }

  async getTemplates({ requirePublication = false } = {}): Promise<readonly PreparedCatalogTemplate[]> {
    if (!this.pending && this.now() >= this.checkAfter) {
      this.pending = this.refresh();
    }
    if (requirePublication && !this.cached) {
      throw new CloudError('SERVICE_UNAVAILABLE', 'Motion template catalog is not ready yet. Retry shortly.', { status: 503 });
    }
    return this.cached ?? emptyCatalog;
  }

  private async refresh(): Promise<void> {
    try {
      const prev = this.cached;
      const next = await readPublication(this.environment, this.origin, this.fetchImpl, prev);
      this.cached = next;
      this.checkAfter = this.now() + this.ttlMs;
      if (next !== prev && next.length > 0 && this.onPublicationChanged) {
        const catalogVersion = next[0]?.catalogVersion ?? `prism:${this.environment}`;
        void Promise.resolve(this.onPublicationChanged(next, catalogVersion)).catch((error) => {
          this.onRefreshError?.(error);
        });
      }
    } catch (error) {
      this.checkAfter = this.now() + this.retryMs;
      this.onRefreshError?.(error);
    } finally {
      this.pending = undefined;
    }
  }
}
