import { createRequire } from 'node:module';
import path from 'node:path';
import { canvasStyleRewriter } from '../packages/edit-core/composition-canvas.ts';
import { loadCaptionSourceOperations } from './transcript-captions.ts';

/** Bind both parsers from the installed authoring runtime, including when opened from a ZIP. */
export async function loadCanvasSourceOperations(runtimeRoot: string) {
  const { parseHTML } = await loadCaptionSourceOperations(runtimeRoot);
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const nativeRequire = createRequire(require.resolve('hyperframes/package.json'));
  return { parseHTML, rewriteStyles: canvasStyleRewriter(nativeRequire('css-tree')) };
}
