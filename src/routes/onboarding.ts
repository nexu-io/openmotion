import { Hono } from 'hono';
import { isCloudError } from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import {
  defaultDeterministicTemplateIds,
  normalizeOnboardingLanguage,
  prepareCloudOnboarding,
  renderCloudInstallGuide,
  renderCloudOnboardingDocument,
  resolveOnboardingTemplateSelection,
} from '../services/cloud-onboarding.ts';

export interface OnboardingRoutesDeps {
  config: Pick<AppConfig, 'APP_PUBLIC_ORIGIN'>;
  runtimeRoot: string;
}

/**
 * Public, stateless cloud onboarding and installation guide routes:
 * - `GET /install.md`: serves `docs/install.md` dynamically bound to `APP_PUBLIC_ORIGIN`.
 * - `GET /api/onboarding/prepare`: freezes 3-of-4 curated onboarding templates, localized
 *   welcome copy, cloud template library URL, and self-contained card URL + SHA-256.
 * - `GET /api/onboarding/cards.html`: serves the `< 1 MiB` self-contained HTML cards
 *   fragment for hosts with an inline visualization surface (e.g. Codex) without needing
 *   a local npm package or source checkout.
 */
export function createOnboardingRoutes(deps: OnboardingRoutesDeps): Hono {
  const app = new Hono();

  app.get('/install.md', async (c) => {
    try {
      const markdown = await renderCloudInstallGuide({
        runtimeRoot: deps.runtimeRoot,
        publicOrigin: deps.config.APP_PUBLIC_ORIGIN,
      });
      return new Response(markdown, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      if (isCloudError(error)) {
        return c.json(error.toJSON(), error.status as 400 | 404 | 500 | 503);
      }
      throw error;
    }
  });

  app.get('/api/onboarding/prepare', async (c) => {
    try {
      const rawTemplates = c.req.query('templates') ?? null;
      const payload = await prepareCloudOnboarding({
        runtimeRoot: deps.runtimeRoot,
        publicOrigin: deps.config.APP_PUBLIC_ORIGIN,
        language: c.req.query('lang') ?? c.req.query('language') ?? null,
        templates: rawTemplates,
      });
      c.header(
        'Cache-Control',
        rawTemplates ? 'public, max-age=300' : 'no-store',
      );
      return c.json(payload, 200);
    } catch (error) {
      if (isCloudError(error)) {
        return c.json(error.toJSON(), error.status as 400 | 404 | 500 | 503);
      }
      throw error;
    }
  });

  app.get('/api/onboarding/cards.html', async (c) => {
    try {
      const language = normalizeOnboardingLanguage(
        c.req.query('lang') ?? c.req.query('language') ?? null,
      );
      const rawTemplates = c.req.query('templates') ?? null;
      const templateIds = rawTemplates
        ? (await resolveOnboardingTemplateSelection(rawTemplates)).templateIds
        : await defaultDeterministicTemplateIds();
      const doc = await renderCloudOnboardingDocument({
        runtimeRoot: deps.runtimeRoot,
        publicOrigin: deps.config.APP_PUBLIC_ORIGIN,
        language,
        templateIds,
      });
      return new Response(doc.html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'ETag': `"${doc.sha256}"`,
          'X-Content-SHA256': doc.sha256,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      if (isCloudError(error)) {
        return c.json(error.toJSON(), error.status as 400 | 404 | 500 | 503);
      }
      throw error;
    }
  });

  return app;
}
