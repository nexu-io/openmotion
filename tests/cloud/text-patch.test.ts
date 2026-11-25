import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { createTextPatch } from '../../shared/create-text-patch.ts';
import { applyTextPatch } from '../../shared/text-patch.ts';

it('serializes multiple replacements against UTF-8 byte positions in the same original source', () => {
  const before = '\uFEFF片头🚀\r\nfont-size:48px;\r\ncolor:red;\n' + 'unchanged '.repeat(40);
  const after = before.replace('🚀', '🌙').replace('48', '100').replace('red', '蓝');
  const patch = createTextPatch(before, after);
  assert.ok(patch && patch.length === 3);
  assert.equal(applyTextPatch(before, JSON.parse(JSON.stringify(patch))), after);
  assert.equal(applyTextPatch(before, []), before);
});

it('inserts and deletes at file boundaries and preserves every other input byte', () => {
  const text = 'a'.repeat(4096) + '中';
  for (const next of ['⭐' + text, text + '🙂', text.slice(1), text.slice(0, -1)]) {
    const patch = createTextPatch(text, next);
    assert.ok(patch);
    assert.equal(applyTextPatch(text, patch), next);
  }
  assert.equal(createTextPatch('a'.repeat(2000), 'b'.repeat(2000)), null);
});

it('rejects overlapping, out-of-range and split Unicode operations', () => {
  for (const invalid of [[[1, 0, 'a']], [[0, 1, 'b']], [[0, 3, ''], [2, 1, '']],
    [[4, 1, '']], [[-1, 1, '']], [[0, -1, '']], [[0, 0, '\uD800']], [[null, 0, '']]]) {
    assert.throws(() => applyTextPatch('中a', invalid), RangeError);
  }
});

it('keeps two distant edits in large multiline HTML in one small patch', () => {
  const middle = Array.from({ length: 3500 }, (_, i) => `<div data-hf-id="hf-${i}">第 ${i} 段</div>\r\n`).join('');
  const before = '\uFEFF<h1>片头🌙</h1>\r\n' + middle + '<footer>旧片尾</footer>\n';
  const after = before.replace('🌙', '🎄圣诞').replace('旧片尾', '新片尾');
  assert.ok(Buffer.byteLength(middle) > 128 * 1024);
  const patch = createTextPatch(before, after);
  assert.equal(patch?.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(patch)) < 160);
  assert.equal(applyTextPatch(before, patch), after);
});

it('falls back for wholesale rewrites and very dense line tokenization', () => {
  const lines = Array.from({ length: 3200 }, (_, i) => `<div class="row" data-long-name="heading-${i}">abc</div>\n`).join('');
  assert.equal(createTextPatch(lines, '---\n' + lines.replaceAll('abc', 'xyz') + 'end'), null);
  const dense = '<i/>\n'.repeat(30000);
  assert.equal(createTextPatch('a\n' + dense + 'b', 'c\n' + dense + 'd'), null);
});

it('compares the actual payload after exceeding the diff CPU budget', () => {
  const changed = 'a\n'.repeat(300 * 1024);
  const replacement = 'b\n'.repeat(300 * 1024);
  const tail = 'c'.repeat(1024 * 1024 - changed.length);
  const before = changed + tail;
  const after = replacement + tail;
  const patch = createTextPatch(before, after);
  assert.ok(patch);
  assert.equal(patch.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify({ patch })) < Buffer.byteLength(JSON.stringify({ content: after })));
  assert.equal(applyTextPatch(before, patch), after);
});

it('sends a localized 300 KiB edit in a multi-megabyte file as a patch', () => {
  const before = 'a'.repeat(5 * 1024 * 1024);
  const offset = 2 * 1024 * 1024;
  const replacement = 'b'.repeat(300 * 1024);
  for (const removed of [0, replacement.length]) {
    const after = before.slice(0, offset) + replacement + before.slice(offset + removed);
    const patch = createTextPatch(before, after);
    assert.ok(patch);
    assert.equal(patch.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(patch)) < 301 * 1024);
    assert.equal(applyTextPatch(before, patch), after);
  }
});
