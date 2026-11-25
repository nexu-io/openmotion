import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCloudIntegrationInfo,
  integrationConfig,
  manualConnection,
  setupGuideUrl,
  setupPrompt,
} from '../../shared/integration.ts';
import { onboardingSourceFiles, onboardingTemplateIds } from '../../shared/onboarding-templates.ts';
import { phase1Tools } from '../../shared/phase1-tools.ts';
import { createOnboardingRoutes } from '../../src/routes/onboarding.ts';
import {
  DEFAULT_CLOUD_ORIGIN,
  MAX_DOCUMENT_CACHE_BYTES,
  ONBOARDING_HTML_BUDGET_BYTES,
  SUPPORTED_ONBOARDING_LANGUAGES,
  clearCloudOnboardingCaches,
  createByteBoundedDocumentCache,
  getCloudOnboardingCacheStats,
  renderCloudInstallGuide,
} from '../../src/services/cloud-onboarding.ts';
import { renderInlineOnboardingDocument } from '../../shared/inline-onboarding-renderer.ts';
import { renderOAuthConsentHtml } from '../../src/auth/oauth21.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('Cloud install guide and stateless onboarding endpoints', () => {
  it('renders /install.md dynamically bound to APP_PUBLIC_ORIGIN without npm or source-clone steps', async () => {
    const customOrigin = 'https://staging-motion.example.test';
    const app = createOnboardingRoutes({
      config: { APP_PUBLIC_ORIGIN: customOrigin },
      runtimeRoot: REPO_ROOT,
    });

    const res = await app.request('/install.md');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/);
    const body = await res.text();

    assert.ok(body.includes(`${customOrigin}/mcp`), 'MCP endpoint must bind to APP_PUBLIC_ORIGIN');
    assert.ok(body.includes(`${customOrigin}/api/onboarding/prepare`), 'Onboarding API must bind to APP_PUBLIC_ORIGIN');
    assert.ok(body.includes(`${customOrigin}/?templates=1`), 'Template library URL must bind to APP_PUBLIC_ORIGIN');
    assert.ok(!body.includes(DEFAULT_CLOUD_ORIGIN), 'No default prod origin should remain after override');
    assert.ok(!body.includes('{{'), 'Cloud install.md must not contain unresolved template placeholders');
    assert.ok(body.includes('codex mcp add openmotion --url'));
    assert.ok(body.includes('codex mcp login openmotion'));
    assert.ok(body.includes('claude mcp add --transport http'));
    assert.ok(body.includes('claude mcp login openmotion'));
    assert.ok(body.includes('HARD GATE — Never run Onboarding while login is still pending'));
    assert.ok(body.includes('Never narrate internal onboarding mechanics'));
    assert.ok(body.includes('create_thread'));
    assert.ok(body.includes('navigate_to_codex_page'));
    assert.ok(body.includes('Output purity rule'));
    assert.ok(body.includes(`${customOrigin}/install.md`), 'Handoff prompt must bind to APP_PUBLIC_ORIGIN');
    assert.ok(!body.includes('Workbench'), 'Login guidance must avoid internal Workbench jargon');
    assert.ok(body.includes('/mcp'));
    assert.ok(body.includes('🎉 OpenMotion 连接好啦，右侧就是模板库！'));

    const markers = [...body.matchAll(/<!-- installation-onboarding:start -->([\s\S]*?)<!-- installation-onboarding:end -->/g)];
    assert.equal(markers.length, 1, 'docs/install.md must retain one canonical onboarding contract block');

    // Default production guide retains canonical production origin.
    const prodGuide = await renderCloudInstallGuide({
      runtimeRoot: REPO_ROOT,
      publicOrigin: DEFAULT_CLOUD_ORIGIN,
    });
    assert.ok(prodGuide.includes(`${DEFAULT_CLOUD_ORIGIN}/mcp`));
  });

  it('serves /api/onboarding/prepare and /api/onboarding/cards.html with matching SHA-256 and < 1 MiB budget', async () => {
    const origin = 'https://staging-motion.example.test';
    const app = createOnboardingRoutes({
      config: { APP_PUBLIC_ORIGIN: origin },
      runtimeRoot: REPO_ROOT,
    });

    const prepRes = await app.request('/api/onboarding/prepare?lang=zh-CN');
    assert.equal(prepRes.status, 200);
    assert.equal(prepRes.headers.get('cache-control'), 'no-store');
    const prep = (await prepRes.json()) as {
      language: string;
      origin: string;
      mcpUrl: string;
      libraryUrl: string;
      templateIds: string[];
      welcomeMarkdown: string;
      noSidebarWelcomeMarkdown: string;
      inlineHtmlUrl: string;
      inlineHtmlSha256: string;
      inlineHtmlBytes: number;
      cardPresentation: {
        tool: string;
        arguments: { templateIds: string[]; language: string; onboarding: boolean };
      };
      dshCardPresentation: {
        tool: string;
        skill: string;
        arguments: {
          action: string;
          title: string;
          brief: string;
          details: {
            onboarding: boolean;
            language: string;
            templates: Array<{
              id: string;
              title: string;
              description?: string;
              previewUrl?: string;
              posterUrl?: string;
              duration?: number;
            }>;
          };
        };
      };
      templates: Array<{
        position: number;
        templateId: string;
        title: string;
        summary: string;
        durationSeconds: number;
        previewUrl: string;
        posterUrl: string | null;
        videoUrl: string | null;
      }>;
    };

    assert.equal(prep.language, 'zh');
    assert.equal(prep.origin, origin);
    assert.equal(prep.mcpUrl, `${origin}/mcp`);
    assert.equal(prep.libraryUrl, `${origin}/?templates=1`);
    assert.equal(prep.templateIds.length, 3);
    assert.equal(new Set(prep.templateIds).size, 3);
    for (const id of prep.templateIds) {
      assert.ok((onboardingTemplateIds as readonly string[]).includes(id));
    }
    assert.ok(prep.welcomeMarkdown.includes('🎉 OpenMotion 连接好啦，右侧就是模板库！'));
    assert.ok(prep.noSidebarWelcomeMarkdown.includes(prep.libraryUrl));
    assert.ok(!prep.noSidebarWelcomeMarkdown.includes('右侧就是模板库'));
    assert.equal(prep.cardPresentation.tool, 'openmotion_show_template_recommendations');
    assert.deepEqual(prep.cardPresentation.arguments.templateIds, prep.templateIds);
    assert.equal(prep.dshCardPresentation.tool, 'propose_action');
    assert.equal(prep.dshCardPresentation.skill, 'openmotion-template-recommendations');
    assert.equal(prep.dshCardPresentation.arguments.action, 'openmotion_template_recommendation');
    assert.equal(prep.dshCardPresentation.arguments.details.onboarding, true);
    assert.equal(prep.dshCardPresentation.arguments.details.language, 'zh');
    assert.equal(prep.dshCardPresentation.arguments.details.templates.length, 3);
    for (let i = 0; i < 3; i++) {
      const raw = prep.templates[i];
      const dsh = prep.dshCardPresentation.arguments.details.templates[i];
      assert.equal(dsh.id, raw.templateId);
      assert.equal(dsh.title, raw.title);
      assert.equal(dsh.description, raw.summary);
      assert.equal(dsh.duration, raw.durationSeconds);
      assert.equal(dsh.previewUrl, raw.videoUrl, 'DSH previewUrl must be the video stream URL, not the HTML template-library URL');
      assert.equal(dsh.posterUrl, raw.posterUrl);
      assert.ok(!dsh.previewUrl?.includes('?templates=1'));
    }
    assert.equal(prep.templates.length, 3);
    assert.ok(prep.inlineHtmlBytes > 10_000 && prep.inlineHtmlBytes < ONBOARDING_HTML_BUDGET_BYTES);

    const cardsUrl = new URL(prep.inlineHtmlUrl);
    const htmlRes = await app.request(cardsUrl.pathname + cardsUrl.search);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(htmlRes.headers.get('x-content-sha256'), prep.inlineHtmlSha256);
    const html = await htmlRes.text();
    const actualSha = createHash('sha256').update(html, 'utf8').digest('hex');
    assert.equal(actualSha, prep.inlineHtmlSha256, 'cards.html bytes must match prepare SHA-256 deterministically');
    assert.ok(Buffer.byteLength(html, 'utf8') < ONBOARDING_HTML_BUDGET_BYTES);
    assert.ok(!html.includes('__OPENMOTION_INLINE_'));

    // Re-calling prepare with explicit templates returns identical selection and SHA-256.
    const frozenRes = await app.request(
      `/api/onboarding/prepare?lang=zh&templates=${encodeURIComponent(prep.templateIds.join(','))}`,
    );
    assert.equal(frozenRes.status, 200);
    const frozen = (await frozenRes.json()) as typeof prep;
    assert.deepEqual(frozen.templateIds, prep.templateIds);
    assert.equal(frozen.inlineHtmlSha256, prep.inlineHtmlSha256);

    // Invalid templates parameter returns 400.
    const badRes = await app.request('/api/onboarding/prepare?lang=en&templates=invalid-id,other,third');
    assert.equal(badRes.status, 400);
    const dupRes = await app.request(
      `/api/onboarding/cards.html?lang=en&templates=${onboardingTemplateIds[0]},${onboardingTemplateIds[0]},${onboardingTemplateIds[1]}`,
    );
    assert.equal(dupRes.status, 400);

    // Direct browser access to cards.html without templates query works cleanly.
    const defaultCardsRes = await app.request('/api/onboarding/cards.html?lang=en');
    assert.equal(defaultCardsRes.status, 200);
    assert.ok((await defaultCardsRes.text()).includes('OpenMotionTemplateCards'));
  });

  it('keeps all 4 three-of-four combinations across all 7 languages under the 1,000,000-byte budget and bounds cache memory', async () => {
    clearCloudOnboardingCaches();
    const app = createOnboardingRoutes({
      config: { APP_PUBLIC_ORIGIN: DEFAULT_CLOUD_ORIGIN },
      runtimeRoot: REPO_ROOT,
    });
    const combos = onboardingTemplateIds.map((_, dropIdx) =>
      onboardingTemplateIds.filter((_, idx) => idx !== dropIdx),
    );
    for (const lang of SUPPORTED_ONBOARDING_LANGUAGES) {
      for (const combo of combos) {
        const res = await app.request(
          `/api/onboarding/cards.html?lang=${lang}&templates=${encodeURIComponent(combo.join(','))}`,
        );
        assert.equal(res.status, 200, `${lang} ${combo.join(',')}`);
        const html = await res.text();
        const bytes = Buffer.byteLength(html, 'utf8');
        assert.ok(bytes < ONBOARDING_HTML_BUDGET_BYTES, `${lang} exceeded budget: ${bytes}`);
        assert.ok(!html.includes('__OPENMOTION_INLINE_'));
      }
    }
    const stats = getCloudOnboardingCacheStats();
    assert.equal(stats.resourceVersionCount, 1, 'Encoded preview media must be cached once per resource version');
    assert.ok(stats.documentBytes <= MAX_DOCUMENT_CACHE_BYTES, `Rendered cache (${stats.documentBytes}) must stay within ${MAX_DOCUMENT_CACHE_BYTES} bytes`);
    assert.ok(stats.documentCount < 28, 'Byte cap must evict older rendered documents instead of retaining all 28 × ~700KB copies');
  });

  it('evicts least-recently-used entries in createByteBoundedDocumentCache and blocks external media in shared inline renderer', async () => {
    const cache = createByteBoundedDocumentCache<{ id: string; bytes: number }>(100);
    cache.set('a', { id: 'a', bytes: 45 });
    cache.set('b', { id: 'b', bytes: 45 });
    assert.equal(cache.totalBytes, 90);
    // Touch 'a' so 'b' becomes least-recently-used.
    assert.equal(cache.get('a')?.id, 'a');
    cache.set('c', { id: 'c', bytes: 45 });
    assert.equal(cache.get('b'), undefined, 'LRU entry b must be evicted');
    assert.equal(cache.get('a')?.id, 'a');
    assert.equal(cache.get('c')?.id, 'c');
    assert.equal(cache.totalBytes, 90);
    cache.set('oversized', { id: 'oversized', bytes: 150 });
    assert.equal(cache.get('oversized'), undefined, 'Oversized entry must not enter cache');

    const { loadTemplatePresentation, showTemplateRecommendations } = await import(
      '../../shared/mcp-template-recommendations.ts'
    );
    const { inlineDescriptionPrefixes } = await import(
      '../../mcp-ui/template-recommendations/i18n.ts'
    );
    const directory = path.join(REPO_ROOT, 'mcp-ui/template-recommendations');
    const presentation = loadTemplatePresentation({ applicationRoot: REPO_ROOT, directory });
    const templateIds = onboardingTemplateIds.slice(0, 3);
    const recommendation = showTemplateRecommendations(presentation, {
      templateIds,
      language: 'en',
      onboarding: true,
    });
    const guarded = await renderInlineOnboardingDocument({
      directory,
      language: 'en',
      templateIds,
      previewSource: 'reference',
      presentation,
      recommendation,
      inlineDescriptionPrefixes,
      loadProjectPreviews: () => [],
    });
    assert.equal(guarded.status, 'native_required');
    assert.equal(guarded.reason, 'INLINE_EXTERNAL_MEDIA_BLOCKED');
  });

  it('loads native template presentation and cloud onboarding from the minimal api Dockerfile asset slice', async (t) => {
    const staged = await mkdtemp(path.join(os.tmpdir(), 'om-api-stage-'));
    t.after(() => rm(staged, { recursive: true, force: true }));

    // Mirror the exact files copied into `api` in deploy/Dockerfile without the ~87 MB catalog.
    const toCopy = [
      'package.json',
      'docs/install.md',
      'mcp-ui/template-recommendations/manifest.json',
      'mcp-ui/template-recommendations/inline.fragment.html',
      'mcp-ui/template-recommendations/i18n.ts',
      'mcp-ui/template-recommendations/types.ts',
      'mcp-ui/template-recommendations/LICENSE',
      'mcp-ui/template-recommendations/NOTICE.md',
      'mcp-ui/template-recommendations/assets',
      'mcp-ui/template-recommendations/project-previews',
      'mcp-ui/template-recommendations/build',
      'template-library',
      ...onboardingSourceFiles,
    ];
    for (const rel of toCopy) {
      const dest = path.join(staged, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(path.join(REPO_ROOT, rel), dest, { recursive: true });
    }

    const { loadTemplatePresentation } = await import('../../shared/mcp-template-recommendations.ts');
    const presentation = loadTemplatePresentation({
      applicationRoot: staged,
      directory: path.join(staged, 'mcp-ui/template-recommendations'),
    });
    assert.equal(presentation.tool.name, 'openmotion_show_template_recommendations');
    assert.ok(presentation.uri.startsWith('ui://openmotion/template-recommendations/'));

    const app = createOnboardingRoutes({
      config: { APP_PUBLIC_ORIGIN: 'https://minimal-api.example.test' },
      runtimeRoot: staged,
    });
    const prepRes = await app.request('/api/onboarding/prepare?lang=en');
    assert.equal(prepRes.status, 200);
    const guideRes = await app.request('/install.md');
    assert.equal(guideRes.status, 200);
    assert.ok((await guideRes.text()).includes('https://minimal-api.example.test/mcp'));
  });

  it('aligns shared/integration.ts cloud setup guide, OAuth login commands, and onboarding prompt', () => {
    const cloudInfo = buildCloudIntegrationInfo({
      publicOrigin: 'https://motion.open-design.ai',
      version: '1.0.0',
      workspaceId: 'ws-cloud',
      authMode: 'oidc',
      oauth2Enabled: true,
      patEnabled: true,
      tools: phase1Tools.map((t) => ({ name: t.name, description: t.description })),
    });

    assert.equal(setupGuideUrl(cloudInfo), 'https://motion.open-design.ai/install.md');
    assert.match(manualConnection(cloudInfo, 'codex', 'en'), /codex mcp login openmotion/);
    assert.match(manualConnection(cloudInfo, 'claude', 'en'), /claude mcp login openmotion/);
    assert.ok(
      !integrationConfig(cloudInfo, 'codex').text.includes('bearer_token_env_var'),
      'OAuth-enabled cloud Codex config should not force a PAT env var',
    );
    assert.ok(setupPrompt(cloudInfo, 'codex', 'zh-CN').includes('https://motion.open-design.ai/install.md'));
    assert.ok(setupPrompt(cloudInfo, 'codex', 'en').includes('https://motion.open-design.ai/install.md'));
  });

  it('renders the OpenMotion-styled OAuth consent page using the shared design system with escaped inputs', async () => {
    const html = renderOAuthConsentHtml({
      clientName: 'Codex <test>',
      redirectUri: 'http://127.0.0.1:54321/callback',
      workspaceName: 'Motion Team',
      workspaceId: 'ws-1',
      workspaces: [
        { id: 'ws-1', name: 'Motion Team', role: 'owner' },
        { id: 'ws-2', name: 'Design Lab', role: 'member' },
      ],
      userDisplayName: 'Alice',
      userEmail: 'alice@example.com',
      switchAccountUrl: '/auth/login?switch=1',
      scopes: ['projects:read', 'projects:write', 'assets:read', 'assets:write', 'exports:write', 'media:generate', 'mcp:tools'],
      formAction: '/oauth/authorize',
      hiddenFields: { consent_token: 'tok-123' },
    });

    assert.ok(html.includes('<html lang="zh-CN" data-motion-ui>'));
    assert.ok(html.includes('<link rel="stylesheet" href="/design-system/ui.css">'));
    assert.ok(html.includes('class="ui-button consent-action"'));
    assert.ok(html.includes('class="ui-button ui-button--primary consent-action"'));
    assert.ok(html.includes('class="ui-input ws-select"'));
    assert.ok(html.includes('class="ui-badge unverified-pill"'));
    assert.ok(html.includes('class="ui-text-link switch-link"'));

    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(styleMatch, 'OAuth consent page must include page-layout styles');
    const styleBlock = styleMatch[1];
    assert.doesNotMatch(
      styleBlock,
      /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i,
      'OAuth consent CSS must consume shared --motion-* tokens without raw color literals',
    );
    assert.ok(!styleBlock.includes('--om-'), 'OAuth consent CSS must not maintain a parallel --om-* palette');

    const tokensCss = await readFile(path.join(REPO_ROOT, 'packages/design-system/tokens.css'), 'utf8');
    const definedTokens = new Set([...tokensCss.matchAll(/(--motion-[\w-]+)\s*:/g)].map((m) => m[1]));
    for (const match of styleBlock.matchAll(/var\((--motion-[\w-]+)/g)) {
      assert.ok(definedTokens.has(match[1]), `OAuth consent page references undefined token ${match[1]}`);
    }

    assert.ok(html.includes('授权 Codex &lt;test&gt; 连接 OpenMotion'));
    assert.ok(!html.includes('Codex <test>'), 'clientName must be HTML-escaped');
    assert.ok(html.includes('应用名未经验证'));
    assert.ok(html.includes('Local application (127.0.0.1)'));
    assert.ok(html.includes('alice@example.com'));
    assert.ok(html.includes('换一个账号'));
    assert.ok(html.includes('查看并编辑已授权的视频项目'));
    assert.ok(html.includes('查看详细权限标识 (7)'));
    assert.ok(html.includes('name="consent_token" value="tok-123"'));
    assert.ok(html.includes('value="approve"') && html.includes('value="deny"'));
  });
});
