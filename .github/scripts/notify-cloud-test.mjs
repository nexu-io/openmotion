import { execFileSync } from 'node:child_process';

const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const sha = env.GITHUB_SHA;
const base = `${env.GITHUB_SERVER_URL}/${repo}`;
const api = (path) => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${path}`], { encoding: 'utf8' }));

const failed = [
  ['代码检查', env.CHECKS_RESULT], ['镜像构建', env.IMAGES_RESULT], ['提交部署', env.PROMOTE_RESULT],
].filter(([, result]) => result === 'failure').map(([name]) => name);
const status = failed.length ? `${failed.join('、')}失败` : '已提交部署，等待集群同步';
const lines = [`OpenMotion 默认测试环境 · ${status}`];
try {
  const pulls = api(`commits/${sha}/pulls?per_page=100`).filter(pr => pr.merged_at && pr.base.ref === 'main' && pr.base.repo.full_name === repo);
  if (pulls.length) {
    for (const pr of pulls) lines.push(`#${pr.number} ${pr.title}`, `PR 作者：@${pr.user.login}`, pr.html_url);
  } else {
    const commit = api(`commits/${sha}`);
    lines.push(`直接提交：${commit.commit.message.split('\n')[0]}`, `提交作者：${commit.author ? '@' + commit.author.login : commit.commit.author.name}`);
  }
} catch {
  console.warn('::warning::Could not retrieve PR metadata from GitHub');
  lines.push('GitHub 暂未返回 PR 信息');
}
lines.push(`版本：${sha.slice(0, 12)}`);
if (env.ORBIT_RECEIPT) lines.push(`部署单：${env.ORBIT_RECEIPT}`);
lines.push(`${base}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`);

const webhook = env.FEISHU_DEPLOY_NOTIFY_WEBHOOK?.trim();
if (!webhook) throw new Error('Missing deployment group webhook');
const response = await fetch(webhook, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ msg_type: 'text', content: { text: lines.join('\n') } }),
}).catch(() => { throw new Error('Could not reach the Feishu webhook'); });
if (!response.ok) throw new Error(`Feishu returned HTTP ${response.status}`);
const { code } = await response.json();
if (code !== 0) throw new Error(`Feishu rejected the notification (code ${code})`);
