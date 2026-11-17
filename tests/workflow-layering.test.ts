import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getWorkflow, readWorkflowResource, workflowDocumentAliases, workflowReferences } from '../shared/workflow.ts';

test('legacy director resources return the shared body while references use production identity', async () => {
  for (const [legacy, canonical] of Object.entries(workflowDocumentAliases)) {
    const section = canonical.endsWith('/review.md') ? 'review' : 'decisions';
    const current = await getWorkflow(section, 'production');
    const previous = JSON.parse((await readWorkflowResource(`openmotion://workflow/director/${section}`, '/unused')).text);
    assert.equal(previous.workflow, 'director');
    assert.equal(previous.section, section);
    assert.equal(previous.documentId, canonical);
    assert.equal(previous.content, current.content);
    assert.equal(previous.contentHash, current.contentHash);
    assert.deepEqual(previous.references, current.references);
    const linked = workflowReferences(`[legacy](../openmotion-director/references/${legacy.split('/').at(-1)})`, 'skills/openmotion-recreate/SKILL.md');
    assert.deepEqual(linked, [{ workflow: 'production', section, documentId: canonical }]);
    const forwarding = await readFile(new URL('../' + legacy, import.meta.url), 'utf8');
    assert.deepEqual(workflowReferences(forwarding, legacy), linked);
    assert.ok(!forwarding.includes(current.content), 'Old local paths must not maintain another rule body');
  }
});

test('shared audio execution and review do not require original sound design or contributor evaluation', async () => {
  const sound = await getWorkflow('sound');
  const review = await getWorkflow('review');
  for (const document of [sound, review]) {
    assert.ok(!document.references.some(reference => reference.workflow === 'director'));
    assert.ok(!document.content.includes('## Skill 自身的行为验证'));
  }
  assert.match(sound.content, /锁定画面版本/);
  assert.match(sound.content, /实际使用的音频版本/);
  assert.match(sound.content, /正常速度声画体验/);
});

test('template orchestration depends on shared execution without reverse overrides', async () => {
  for (const section of ['context', 'native', 'production', 'templates', 'verification']) {
    const document = await getWorkflow(section);
    assert.ok(!document.references.some(reference => reference.workflow === 'template'), section);
  }
  const unchanged = await getWorkflow('unchanged', 'template');
  for (const section of ['native', 'production', 'verification']) {
    assert.ok(unchanged.references.some(reference => reference.workflow === 'production' && reference.section === section));
  }
  for (const section of ['firstuse', 'recipes']) {
    assert.equal((await getWorkflow(section, 'template')).workflow, 'template');
  }
  const catalog = await getWorkflow('templates');
  assert.ok(!catalog.content.includes('## First-run experience defaults'));
  assert.ok(!catalog.content.includes('## `product-proof`'));
});

test('final presentation timeout preserves file verification and pending editor evidence', async () => {
  const runtime = await getWorkflow('production');
  const verification = await getWorkflow('verification');
  const native = await getWorkflow('native');
  assert.match(runtime.content, /openmotion_show_video` in its own host tool call/);
  assert.match(runtime.content, /about 60 seconds[\s\S]*already verified MP4's absolute file path and finish/);
  assert.match(runtime.content, /timeout cannot turn a pending\/hidden\/unavailable editor into confirmed delivery/);
  assert.match(verification.content, /Retain all actual-file playback checks above/);
  assert.match(verification.content, /Play from start to end/);
  assert.match(verification.content, /Replay from the beginning/);
  assert.match(native.content, /only a visible preview with the latest content actually inspected can be `confirmed`/);
});

test('cold-start scoped examples expose only the shared methods needed by each request', async () => {
  const context = await getWorkflow('context');
  const cases = [
    { request: '局部改字', sections: ['edit', 'production', 'native', 'review'] },
    { request: '换已选现成音乐', sections: ['edit', 'materials', 'production', 'sound', 'review', 'native'] },
    { request: '原样模板，明确要 HTML／工程文件', sections: ['production', 'native', 'verification'] },
    { request: '原样模板，明确要 MP4', sections: ['verification'] },
  ];
  for (const { request, sections } of cases) {
    const row = context.content.split('\n').find(line => line.startsWith(`| ${request}`));
    assert.ok(row, request);
    const references = workflowReferences(row, context.documentId);
    assert.deepEqual(references.map(reference => reference.section), sections, request);
    for (const reference of references) {
      assert.equal(reference.workflow, 'production');
      const response = JSON.parse((await readWorkflowResource(`openmotion://workflow/${reference.workflow}/${reference.section}`, '/unused')).text);
      assert.equal(response.documentId, reference.documentId);
      assert.ok(!response.references.some(target => target.workflow === 'director'), request);
    }
  }
  const unchanged = await getWorkflow('unchanged', 'template');
  assert.deepEqual(unchanged.references.map(reference => reference.section), ['production', 'verification', 'native']);
  assert.match(unchanged.content, /HTML\/project-only requests finish[\s\S]*without an export or MP4 playback task/);
  assert.match(unchanged.content, /Read the engine authoring guide, creative review, material selection and edit references when the task actually needs authoring or a detected defect/);
  assert.match(context.content, /`references` 是发现索引，不代表每个目标都必读/);
});
