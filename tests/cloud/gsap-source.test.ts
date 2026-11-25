import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import { applyCanvasCommand } from '../../packages/edit-core/canvas-commands.ts';
import { extractGsapScriptBlock } from '../../packages/edit-core/gsap-block.ts';
import { applyGsapMutationsInMemory } from '../../packages/edit-core/gsap-mutations.ts';
import { createTextPatch } from '../../shared/create-text-patch.ts';
import { applyTextPatch } from '../../shared/text-patch.ts';

const timeline = 'const tl=gsap.timeline();\r\ntl.to("#title",{x:10,duration:1},0);';

test('writes the selected timeline to its own source span, including when other scripts are identical', () => {
  const replacements = timeline.replace('x:10', 'x:40');
  const prefix = "<!doctype HTML>\r\n<html lang='en'><body>" +
    `<!-- <script>${timeline}</script> -->\r\n` +
    `<template><script>${timeline}</script></template>` +
    `<script src='unused.js'>${timeline}</script>\r\n<SCRIPT data-note='>'>`;
  const suffix = `</SCRIPT><script>${timeline}</script></body></html>\r\n`;
  const file = prefix + timeline + suffix;
  const block = extractGsapScriptBlock(file)!;
  assert.equal(block.replaceScript(timeline), file);
  assert.equal(block.replaceScript(replacements), prefix + replacements + suffix);
  const selected = block.document.querySelector('script[data-note]')!;
  selected.replaceWith(selected.cloneNode(true));
  assert.throws(() => block.replaceScript(replacements), /Cannot locate/);
});

test('a final timeline script inside a fragment keeps preceding scripts, comments and trailing newlines intact', () => {
  const prefix = "<!-- preserve -->\r\n<template><script>/* inert */</script></template>\r\n" +
    "<template><p title='authored quote'>Text</p><script>";
  const suffix = '</script></template>\r\n';
  const file = prefix + timeline + suffix;
  const next = timeline.replace('duration:1', 'duration:3');
  assert.equal(extractGsapScriptBlock(file)!.replaceScript(next), prefix + next + suffix);
});

test('batched animations preserve template markup and clear only the animated elements’ old offsets', () => {
  const target = "<div id='title' data-hf-id='hf-title' data-hf-studio-rotation='8' data-hf-studio-path-offset='3 4'>Title</div>";
  const prefix = "<template data-note='>'>\r\n<div data-composition-id='scene' data-hf-id='hf-root'>" +
    target + "<i id='other' data-hf-id='hf-other' data-hf-studio-rotation='9'>Other</i></div>\r\n<script>";
  const suffix = '</script>\r\n</template>\r\n';
  const file = prefix + timeline + suffix;
  const noChange = applyGsapMutationsInMemory(file, [{ type: 'shift-positions-batch', shifts: [] }]);
  assert.ok(noChange.ok);
  assert.equal(noChange.after, file);
  const batch = applyGsapMutationsInMemory(file, [
    { type: 'delete-all-for-selector', targetSelector: '#title' },
    { type: 'add', targetSelector: '#title', method: 'to', properties: { x: 42 }, duration: 1, position: 0 },
  ]);
  assert.ok(batch.ok);
  const cleanPrefix = prefix.replace(" data-hf-studio-rotation='8' data-hf-studio-path-offset='3 4'", '');
  assert.equal(batch.after, cleanPrefix + batch.scriptText + suffix);
  assert.deepEqual(batch.mutationChanges, [true, true]);
});

test('the first move of an animated Welcome title preserves the fragment and can be sent as a patch', () => {
  const html = readFileSync(new URL('../../template-library/openmotion-welcome/compositions/intro.html', import.meta.url), 'utf8');
  const after = applyCanvasCommand(html, { kind: 'moveCanvasElement', target: { id: 'intro-kicker' }, mode: 'wholePath', delta: { x: 18.61, y: 1.283 }, time: 2.8 });
  const authored = stampHfIdsInPlace(html);
  const original = extractGsapScriptBlock(authored)!;
  const changed = extractGsapScriptBlock(after)!;
  assert.notEqual(changed.scriptText, original.scriptText);
  assert.equal(after, original.replaceScript(changed.scriptText));
  const patch = createTextPatch(html, after);
  assert.ok(patch);
  assert.equal(applyTextPatch(html, patch), after);
});
