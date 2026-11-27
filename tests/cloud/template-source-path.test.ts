import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  assembleBuiltinTemplate,
  type BuiltinTemplateDefinition,
} from '../../src/services/builtin-template-source.ts';

const definition: BuiltinTemplateDefinition = {
  id: 'demo-template',
  sortOrder: 1,
  title: 'Demo template',
  label: 'Demo',
  description: 'Fixture template for path containment tests',
  duration: 3,
  width: 1080,
  height: 1920,
  posterTime: 0,
  author: 'Test',
  sourceUrl: 'https://example.test/demo',
};

const tempRoots: string[] = [];

async function makeRepoRoot(manifestFiles: Array<{ path: string; target: string }>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'om-template-source-'));
  tempRoots.push(root);
  const templateDir = path.join(root, 'template-library', definition.id);
  await mkdir(templateDir, { recursive: true });
  await writeFile(
    path.join(templateDir, 'registry-item.json'),
    JSON.stringify({ name: definition.id, files: manifestFiles }),
    'utf8',
  );
  return root;
}

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('assembleBuiltinTemplate registry-item source path containment', () => {
  it('rejects a source path that traverses out of the template directory', async () => {
    const root = await makeRepoRoot([{ path: '../../outside.txt', target: 'assets/leak.txt' }]);
    await writeFile(path.join(root, 'outside.txt'), 'secret outside the template root', 'utf8');

    await assert.rejects(
      () => assembleBuiltinTemplate(definition, root, root),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_PATH');
        return true;
      },
    );
  });

  it('rejects an absolute source path', async () => {
    const root = await makeRepoRoot([{ path: '/etc/passwd', target: 'assets/leak.txt' }]);

    await assert.rejects(
      () => assembleBuiltinTemplate(definition, root, root),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_PATH');
        return true;
      },
    );
  });

  it('accepts a nested relative source path and proceeds to read the template', async () => {
    const root = await makeRepoRoot([{ path: 'source/index.html', target: 'index.html' }]);
    await mkdir(path.join(root, 'template-library', definition.id, 'source'), { recursive: true });
    await writeFile(
      path.join(root, 'template-library', definition.id, 'source', 'index.html'),
      '<!doctype html><html><body>demo</body></html>',
      'utf8',
    );

    // Validation passes, so the failure (if any) is the missing fixture assets further down the
    // assembly, never INVALID_PATH.
    await assert.rejects(
      () => assembleBuiltinTemplate(definition, root, root),
      (error: unknown) => {
        assert.notEqual((error as { code?: string }).code, 'INVALID_PATH');
        return true;
      },
    );
  });

  it('rejects a symlinked source file that points outside the template directory', async (t) => {
    const root = await makeRepoRoot([{ path: 'assets/leak.txt', target: 'assets/leak.txt' }]);
    const templateDir = path.join(root, 'template-library', definition.id);
    await mkdir(path.join(templateDir, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'secret.txt'), 'secret outside the template root', 'utf8');
    try {
      await symlink(path.join(root, 'secret.txt'), path.join(templateDir, 'assets', 'leak.txt'));
    } catch {
      t.skip('this platform does not allow creating symlinks without extra privileges');
      return;
    }

    await assert.rejects(
      () => assembleBuiltinTemplate(definition, root, root),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_PATH');
        assert.match(String(error), /symlink/);
        return true;
      },
    );
  });
});