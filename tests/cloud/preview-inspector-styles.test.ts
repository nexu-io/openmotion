import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PREVIEW_INSPECTOR_STYLES } from '../../src/studio/engine/preview-inspector-styles.ts';
import { findBlockColorRule } from '../../shared/preview-style-draft.ts';

function inspector() {
  let size = '42px';
  const element = { closest: () => null, style: {
    getPropertyValue: () => size,
    getPropertyPriority: () => '',
    setProperty: (_name: string, value: string) => { size = value; },
  } };
  const send = runInNewContext(PREVIEW_INSPECTOR_STYLES + '\npreviewInspectorStyles', {
    inspectorElement: (message: { hfId?: string }) => message.hfId === 'title' ? element : null,
    CSS: { supports: () => true }, sourceVersions: { 'intro.html': 'v1' },
    sourceIdentity: (version: string) => ({fileVersion: version}),
  });
  return {
    get: () => size, scriptSets: (value: string) => { size = value; },
    show: (id: string, value: string, version = 'v1') => send({phase: 'show', editId: id, hfId: 'title',
      sourceFile: 'intro.html', fileVersion: version, styles: [['font-size', value]]}),
    settle: (id: string, saved: boolean) => send({phase: 'settle', editId: id, saved}),
  };
}

it('paints without waiting for persistence and rolls back only rejected inspector changes', () => {
  for (const older of [true, false]) for (const newer of [true, false]) for (const reverse of [true, false]) {
    const view = inspector();
    view.show('a', '44px');
    assert.equal(view.get(), '44px');
    view.show('b', '48px');
    assert.equal(view.get(), '48px');
    if (reverse) {
      view.settle('b', newer);
      view.settle('a', older);
    } else {
      view.settle('a', older);
      assert.equal(view.get(), '48px');
      view.settle('b', newer);
    }
    assert.equal(view.get(), newer ? '48px' : older ? '44px' : '42px');
  }
});

it('ignores stale targets and leaves a later runtime style alone on failure', () => {
  const view = inspector();
  view.show('wrong', '44px', 'retired');
  assert.equal(view.get(), '42px');
  view.show('a', '44px');
  view.scriptSets('54px');
  view.settle('a', false);
  assert.equal(view.get(), '54px');
});

it('only paints a CSS color rule whose selector belongs exclusively to the edited file', () => {
  let color = '#333333';
  const style = {
    getPropertyValue: (name: string) => name === '--title' ? color : '',
    getPropertyPriority: () => '',
    setProperty: (_name: string, value: string) => { color = value; },
  };
  let files = ['intro.html', 'intro.html'];
  const document = {
    defaultView: { CSS: { supports: () => true } },
    styleSheets: [{ ownerNode: { nodeName: 'STYLE' }, cssRules: [{ selectorText: '.intro', style }] }],
    querySelectorAll: () => files.map(path => ({ closest: () => ({ getAttribute: () => path }) })),
  };
  const send = runInNewContext(PREVIEW_INSPECTOR_STYLES + '\npreviewInspectorStyles', {
    document, sourceVersions: { 'intro.html': 'v1' }, sourceIdentity: (fileVersion: string) => ({ fileVersion }),
    compositionPath: 'index.html',
  });
  const show = (id: string, value: string, fileVersion = 'v1') => send({
    phase: 'show', editId: id, sourceFile: 'intro.html', fileVersion, blockColor: { key: '--title', value },
  });
  show('stale', '#aaaaaa', 'v0');
  assert.equal(color, '#333333');
  show('invalid', 'url(https://example.test)');
  assert.equal(color, '#333333');
  show('first', '#aaaaaa');
  show('second', '#bbbbbb');
  send({ phase: 'settle', editId: 'first', saved: false });
  assert.equal(color, '#bbbbbb');
  send({ phase: 'settle', editId: 'second', saved: false });
  assert.equal(color, '#333333');
  files = ['intro.html', 'other.html'];
  show('shared', '#cccccc');
  assert.equal(color, '#333333');
});

it('recognizes the shipped root color selector when the block is previewed on its own', () => {
  const path = 'compositions/logo-outro.html';
  const selector = 'html:has(> body > [data-composition-id="logo-outro"]), [data-composition-id="logo-outro"]';
  const style = { getPropertyValue: (key: string) => key === '--bg-color' ? '#0a0a0f' : '' };
  const doc = {
    defaultView: { CSS: { supports: () => true } },
    styleSheets: [{ ownerNode: { nodeName: 'STYLE' }, cssRules: [{ selectorText: selector, style }] }],
    querySelectorAll: (query: string) => {
      assert.equal(query, selector);
      return [{ closest: () => null }, { closest: () => ({ getAttribute: () => path }) }];
    },
  } as unknown as Document;
  assert.equal(findBlockColorRule(doc, path, '--bg-color', '#123456', path), style);
  assert.equal(findBlockColorRule(doc, path, '--bg-color', '#123456', 'index.html'), undefined);
});
