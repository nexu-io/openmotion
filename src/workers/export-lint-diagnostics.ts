import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ExportLintFinding } from '../contracts/jobs.ts';
import { runHyperframesIsolated, type IsolatedExecuteOptions } from '../../hyperframes.ts';

/** Inspect the same hydrated version while it is still available, using the stripped render environment. */
export async function diagnoseFailedRender(
  runtimeRoot: string,
  directory: string,
  compositionPath: string,
  options: IsolatedExecuteOptions,
): Promise<ExportLintFinding[]> {
  const target = compositionPath === 'index.html' ? '.' : compositionPath;
  const root = await realpath(directory);
  const report = await runHyperframesIsolated(runtimeRoot, root, ['lint', target, '--json'], options);
  const { findings, filesScanned } = JSON.parse(report.stdout);
  if (!filesScanned || !Array.isArray(findings)) throw new Error('Missing native lint findings');
  const errors: ExportLintFinding[] = [];
  for (const finding of findings) {
    if (finding?.severity !== 'error' || typeof finding.code !== 'string' || typeof finding.message !== 'string') continue;
    const file = typeof finding.file === 'string'
      ? path.relative(root, path.resolve(root, finding.file))
      : undefined;
    errors.push({
      code: finding.code,
      message: finding.message,
      ...(file && !file.startsWith('../') && file !== '..' ? { file } : {}),
      ...(Number.isInteger(finding.line) && { line: finding.line }),
      ...(Number.isInteger(finding.column) && { column: finding.column }),
      ...(typeof finding.fixHint === 'string' && { fixHint: finding.fixHint }),
    });
  }
  return errors;
}
