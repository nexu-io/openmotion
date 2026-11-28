// Local development guidance only. Never change the checkout or restart a running service.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const oneDay = 24 * 60 * 60_000;

export async function checkSourceUpdate({ cwd = process.cwd(), fetcher = fetch, now = Date.now() } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (git('branch', '--show-current') !== 'main') return;
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)nexu-io\/openmotion(?:\.git)?$/i.test(git('remote', 'get-url', 'origin'))) return;
  const head = git('rev-parse', 'HEAD');
  const cachePath = git('rev-parse', '--path-format=absolute', '--git-path', 'openmotion-update-check.json');
  const cached = await readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
  if (cached?.head === head && now >= cached.checkedAt && now - cached.checkedAt < oneDay) return;
  if (git('status', '--porcelain')) return;
  // Only send a revision already known to belong to the public tracking branch.
  git('merge-base', '--is-ancestor', head, 'refs/remotes/origin/main');
  const response = await fetcher('https://api.github.com/repos/nexu-io/openmotion/compare/' + head + '...main', {
    signal: AbortSignal.timeout(2500), headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) return;
  const comparison = await response.json();
  await writeFile(cachePath, JSON.stringify({ head, checkedAt: now })).catch(() => {});
  if (comparison.status === 'ahead') {
    return 'OpenMotion has an update. After active exports finish, run git pull --ff-only, npm ci and npm run build:studio, then restart the local service.';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !process.env.CI) {
  try {
    const message = await checkSourceUpdate();
    if (message) console.info(message);
  } catch { /* Offline or non-Git environments can start normally. */ }
}
