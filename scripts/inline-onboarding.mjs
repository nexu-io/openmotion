import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runFile } from './runtime-assets.mjs';
import { selectOnboardingTemplateIds } from '../shared/onboarding-templates.ts';
import {
  normalizeOnboardingLanguage,
  renderInlineOnboardingDocument,
} from '../shared/inline-onboarding-renderer.ts';

// A current host can render this read-only production view without loading a
// new MCP tool. Domain work continues through the installation's existing CLI.
export function onboardingPresentationInstructions(status) {
  const completion = 'Complete onboarding in this same installation turn. Do not enqueue a user message, defer to another turn or send a separate success reply. ';
  if (status === 'host_cards') return completion + 'Use cardPresentation with a supported native MCP App or DSH action card and the same three prepared IDs/order and request language. A host with HTML document support can display inlinePresentation instead. Share the maintained welcome once, open the template library and show the three cards. Use text with the same names, summaries and preview links only when no card surface is supported or presentation fails. Never claim that a prepared file or a shell tool call displayed a native card.';
  if (status === 'prepared') return completion + 'Publish this prepared document with --publish-from PATH --sha256 SHA256 --host-directory DIRECTORY into the active chat\'s explicitly permitted visualization directory. Reuse the template library tab or open preview.previewUrl once using the supported host browser surface (the right-hand browser on Codex). Use only that opening call\'s result or initial page state; no hidden-tab reveal, additional snapshot, screenshot, inventory or media audit is needed. Finish required browser bookkeeping, then emit the published finalReplyMarkdown verbatim when the library opened successfully. Do not summarize its welcome. If the library failed, was only queued or its opening cannot be confirmed, replace the library-visible heading with the actual result and usable URL; preserve the introduction and cards. Do not wait for media validation or native activation, call the native card tool, reinstall, resample or enqueue a message. For a welcome already delivered, publish with --welcome-delivered. Publication does not establish visible delivery or native activation.';
  if (status === 'native_required') return completion + 'Open the real template library once, then show these exact three prepared references through the natively discovered presentation Tool with onboarding:true. The persistent conversation component puts the maintained welcome above all three cards. Preserve the IDs/order and immutable resource URI; never resample or substitute builtins. Detailed library inspection, image decoding, advancing video playback and enlarged-preview checks are not installation gates. Do not run or wait for media acceptance before completing installation; record media failures separately for development/release acceptance. Do not repeat the welcome in the final reply. If native discovery is stale, use the supported automatic host action and the saved recovery command in this same turn. Without a compatible host connection, report the concrete dependency and keep activation incomplete; a library webpage, shell presentation call or host security change does not satisfy native delivery. If library opening failed, was queued or cannot be confirmed, set onboarding:false and provide a truthful welcome and usable URL in reply text instead of the component-owned success welcome.';
  return 'Try a supported native MCP App or DSH action-card surface with the prepared three IDs before using text. If cards are unsupported or fail, give the same three template names, summaries and usable preview links in the same order, preserving the shared localized introduction. Use the maintained fallback welcome after successful library opening; otherwise replace its library-visible heading with the actual result and usable URL. Do not add page or media checks, repeat setup or delay installation completion.';
}

export async function prepareInlineOnboarding({ appRoot, output, language = 'en', templateIds = selectOnboardingTemplateIds() }) {
  assert(path.isAbsolute(output) && output.endsWith('.html'), 'Inline onboarding requires an absolute HTML output path supplied by the calling host');
  return JSON.parse(await runFile(process.execPath, ['--experimental-strip-types', path.join(appRoot, 'scripts/inline-onboarding.mjs'),
    '--output', output, '--language', language, '--template-ids', JSON.stringify(templateIds)], { cwd: appRoot }));
}

export async function renderInlineOnboarding({ appRoot, output, language = 'en', templateIds = selectOnboardingTemplateIds(), previewSource = 'project' }) {
  assert(['project', 'reference'].includes(previewSource), 'Unknown preview source');
  language = normalizeOnboardingLanguage(language);
  const { loadTemplatePresentation, loadInlineProjectPreviews, showTemplateRecommendations } = await import('../shared/mcp-template-recommendations.ts');
  const { welcomeMarkdown, inlineDescriptionPrefixes } = await import('../mcp-ui/template-recommendations/i18n.ts');
  const directory = path.join(appRoot, 'mcp-ui/template-recommendations');
  const presentation = loadTemplatePresentation({ applicationRoot: appRoot, directory });
  const recommendation = showTemplateRecommendations(presentation, {
    templateIds, language, ...(templateIds.some(id => id.startsWith('motion-')) ? { onboarding: true } : {}),
  });
  const rendered = await renderInlineOnboardingDocument({
    directory,
    language,
    templateIds,
    previewSource,
    presentation,
    recommendation,
    inlineDescriptionPrefixes,
    loadProjectPreviews: referenceIds => loadInlineProjectPreviews(referenceIds, { applicationRoot: appRoot, directory }),
  });
  if (rendered.status === 'native_required') {
    return { status: 'native_required', mode: 'native-mcp-app', reason: rendered.reason,
      resourceVersion: rendered.resourceVersion, resourceUri: rendered.resourceUri,
      templateIds: [...rendered.templateIds], language: rendered.language,
      welcomeMarkdown: welcomeMarkdown(rendered.language),
      publicationRequired: false, nativeMcpSessionVerified: false,
      presentation: { tool: 'openmotion_show_template_recommendations', arguments: { templateIds, language: rendered.language, onboarding: true } },
      instructions: onboardingPresentationInstructions('native_required') };
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, rendered.html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { status: 'prepared', mode: 'inline-document', path: output, bytes: rendered.bytes,
    previewSource: rendered.previewSource,
    sha256: rendered.sha256, resourceVersion: rendered.resourceVersion,
    templateIds: [...rendered.templateIds], language: rendered.language,
    welcomeMarkdown: welcomeMarkdown(rendered.language),
    publicationRequired: true,
    draftBehavior: 'clipboard-copy; no task submission', nativeMcpSessionVerified: false,
    instructions: onboardingPresentationInstructions('prepared') };
}

export async function publishInlineOnboarding({ source, expectedSHA256, hostDirectory, welcomeDelivered = false }) {
  assert(typeof source === 'string' && path.isAbsolute(source) && source.endsWith('.html'), 'Pass an absolute prepared HTML source');
  assert(typeof hostDirectory === 'string' && path.isAbsolute(hostDirectory), 'Pass the active chat\'s explicitly permitted visualization directory');
  assert(/^[a-f0-9]{64}$/.test(expectedSHA256), 'Publication requires the prepared SHA256');
  const fragment = await readFile(source);
  assert(fragment.length < 1_000_000, 'Inline onboarding exceeds the host document budget');
  const sha256 = createHash('sha256').update(fragment).digest('hex');
  assert.equal(sha256, expectedSHA256, 'Prepared onboarding SHA256 mismatch');
  // The generated, hash-verified document already freezes the request language.
  // Read its JSON without executing scripts; this also supports saved documents
  // prepared before the complete-reply handoff was added.
  const recommendations = [...fragment.toString('utf8').matchAll(/^  const recommendation = (.+);$/gm)];
  assert.equal(recommendations.length, 1, 'Prepared onboarding recommendation is missing or ambiguous');
  const { language } = JSON.parse(recommendations[0][1]);
  const { isLanguage, welcomeMarkdown: localizedWelcome } = await import('../mcp-ui/template-recommendations/i18n.ts');
  assert(isLanguage(language), 'Prepared onboarding language is unsupported');
  assert.equal(typeof welcomeDelivered, 'boolean', 'Use a boolean welcome-delivered flag');
  const welcomeMarkdown = welcomeDelivered ? '' : localizedWelcome(language);
  await mkdir(hostDirectory, { recursive: true });
  const output = path.join(hostDirectory, path.basename(source));
  try { await writeFile(output, fragment, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert((await lstat(output)).isFile(), 'Refusing a non-regular host document');
    assert.equal(createHash('sha256').update(await readFile(output)).digest('hex'), sha256, 'Refusing to overwrite a different host document');
  }
  const contentReference = 'visualize' + JSON.stringify({ path: output }) + '';
  return { status: 'published', path: output, sha256, bytes: fragment.length,
    publicationRequired: false, nativeMcpSessionVerified: false,
    language, welcomeMarkdown, contentReference,
    finalReplyMarkdown: [welcomeMarkdown, contentReference].filter(Boolean).join('\n\n'),
    instructions: 'Open or reuse the library once and finish required browser bookkeeping; use the opening call result without further inspection. If opening succeeded, emit finalReplyMarkdown verbatim. If opening failed, was queued or cannot be confirmed, replace the library-visible heading with the actual result and usable URL, preserving the introduction and cards. Publication does not verify visible delivery or native MCP activation.' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, language: { type: 'string' },
    'template-ids': { type: 'string' },
    'publish-from': { type: 'string' }, sha256: { type: 'string' }, 'host-directory': { type: 'string' }, 'welcome-delivered': { type: 'boolean' } } });
  assert(!values['welcome-delivered'] || values['publish-from'], 'Use --welcome-delivered only when publishing a prepared document');
  if (values['publish-from']) {
    console.log(JSON.stringify(await publishInlineOnboarding({ source: values['publish-from'], expectedSHA256: values.sha256,
      hostDirectory: values['host-directory'], welcomeDelivered: values['welcome-delivered'] }), null, 2));
  } else {
    assert(values.output && path.isAbsolute(values.output) && values.output.endsWith('.html'), 'Pass --output with an absolute .html path');
    console.log(JSON.stringify(await renderInlineOnboarding({ appRoot: fileURLToPath(new URL('../', import.meta.url)), output: values.output, language: values.language,
      ...(values['template-ids'] ? { templateIds: JSON.parse(values['template-ids']) } : {}) }), null, 2));
  }
}
