import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { compositionVariableValues, setBlockParameter } from '../../packages/edit-core/composition-variable.ts';
import { getMotionComponent, motionComponentCards, prepareMotionComponent } from '../../src/services/motion-component-registry.ts';
import { primaryFile } from '../../src/services/motion-component-source.ts';

test('bundled blocks install offline and each advertised control has one editable binding', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('A bundled block must install offline'); });
  const sources = await readdir(new URL('../../library/components/registry/blocks/', import.meta.url));
  assert.deepEqual(sources.sort(), [
    'data-chart.html', 'logo-outro.html', 'vfx-liquid-background.html',
    'vfx-liquid-glass.html', 'vfx-magnetic.html', 'vfx-portal.html',
  ]);
  for (const filename of sources) {
    const name = filename.replace(/\.html$/, '');
    const item = getMotionComponent(name);
    assert.ok(item.type === 'hyperframes:block', name);
    const path = primaryFile(item).target;
    const [file] = await prepareMotionComponent(item, new Set(), true);
    assert.ok(file?.op === 'upsert_binary' && file.path === path, name);
    const source = file.data.toString('utf8');
    const params = item.params ?? [];
    const keys = params.map(param => param.key);
    const values = compositionVariableValues(source, keys);
    assert.ok(values?.size && values.size === params.length, name);
    for (const param of params) {
      assert.ok(source.includes('var(' + param.key + ')'), 'The authored block must consume ' + name + ' ' + param.key);
      assert.equal(values.get(param.key)?.toLowerCase(), param.default.toLowerCase(), name + ' ' + param.key);
      const after = setBlockParameter(source, param.key, '#426d8e', path);
      assert.deepEqual(compositionVariableValues(after, keys), new Map(values).set(param.key, '#426d8e'));
    }
    assert.deepEqual(await prepareMotionComponent(item, new Set([path])), [], 'Preserve installed ' + name);
  }
  const magnetic = motionComponentCards.find(card => card.name === 'vfx-magnetic');
  assert.deepEqual(magnetic?.params?.map(param => param.key), ['--bg-color']);
});

test('Magnetic keeps the original page visible when the browser cannot upload DOM textures', async () => {
  const source = await readFile(new URL('../../library/components/registry/blocks/vfx-magnetic.html', import.meta.url), 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const content = {};
  let visible: unknown;
  const canvas = { getContext: () => ({}), replaceWith: (node: unknown) => { visible = node; } };
  const timeline = { to() {}, seek() {} };
  runInNewContext(script, {
    window: {}, document: { getElementById: (id: string) => id === 'gl-canvas' ? canvas : content },
    gsap: { timeline: () => timeline }, setTimeout: (callback: () => void) => callback(),
  });
  assert.equal(visible, content);
  assert.match(source, /\.page-content\s*\{[^}]*background:\s*var\(--bg-color\)/);
});
