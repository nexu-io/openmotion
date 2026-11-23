import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PREVIEW_THUMBNAIL_CAPTURE } from '../../src/studio/engine/preview-thumbnail-capture.ts';
import { PREVIEW_BRIDGE_SCRIPT } from '../../src/studio/engine/preview-bridge.ts';
import { SNAPDOM_VENDOR_PATH } from '../../src/studio/routes/preview.ts';

describe('preview-thumbnail-capture embedded bridge script', () => {
  it('parses as valid ES5 browser code and registers capture-frames in preview-bridge', () => {
    assert.doesNotThrow(() => new vm.Script(`(function(){${PREVIEW_THUMBNAIL_CAPTURE}})()`));
    assert.match(PREVIEW_BRIDGE_SCRIPT, /capture-frames/);
    assert.match(PREVIEW_BRIDGE_SCRIPT, /thumbnail-capture/);
    assert.equal(SNAPDOM_VENDOR_PATH, '/api/vendor/snapdom.js');
  });
});
