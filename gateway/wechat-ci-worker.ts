/** Isolates miniprogram-ci and its subprocess manager from the local daemon. */
import { setDefaultResultOrder } from 'node:dns';
import { writeSync } from 'node:fs';
import { setDefaultAutoSelectFamily } from 'node:net';
import { pathToFileURL } from 'node:url';

export type WechatCiJob = {
  kind: 'preview' | 'upload';
  appid: string;
  projectPath: string;
  privateKeyPath: string;
  version?: string;
  desc?: string;
  qrcodeOutputDest?: string;
};
export type WechatCiResult = { ok: true; data: unknown } | { ok: false; message: string; errCode?: string | number };

/** The loader seam lets subprocess tests exercise the real fatal-error handlers without the SDK or network. */
export async function runWechatCiWorker(loadCi: () => Promise<any> = () => import('miniprogram-ci')) {
  // WeChat checks the caller against the IP allowlist. macOS rotates temporary IPv6 addresses, so an
  // allowlisted IPv6 goes stale; send WeChat requests over the stable IPv4 address instead.
  setDefaultResultOrder('ipv4first');
  setDefaultAutoSelectFamily(false);
  let reported = false;
  const report = (result: WechatCiResult) => {
    if (reported) return;
    reported = true;
    // fd 3 is the only result channel; SDK stdout and stderr remain ordinary chatter.
    try { writeSync(3, JSON.stringify(result) + '\n'); }
    finally { process.exit(result.ok ? 0 : 1); }
  };
  const fail = (error: unknown) => {
    const value = error as { message?: unknown; code?: unknown; errCode?: unknown; errMsg?: unknown } | null;
    let message = String(value?.message ?? error).replace(/^(?:(?:Error|CodeError):\s*)+/, '');
    if (value?.errMsg !== undefined) {
      const detail = `${String(value.errCode ?? value.code ?? '')}: ${String(value.errMsg)}`;
      if (!message.includes(detail)) message += `; ${detail}`;
    }
    const code = value?.code ?? value?.errCode;
    report({ ok: false, message, ...(code !== undefined ? { errCode: String(code) } : {}) });
  };
  process.on('unhandledRejection', fail);
  process.on('uncaughtException', fail);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WechatCiJob;
    let ci: any;
    try { ci = await loadCi(); }
    catch { report({ ok: false, message: 'miniprogram-ci could not be loaded', errCode: 'WECHAT_CI_MISSING' }); return; }
    const project = new ci.Project({ appid: job.appid, type: 'miniGame', projectPath: job.projectPath,
      privateKeyPath: job.privateKeyPath, ignores: ['node_modules/**/*', 'mock-*.js', 'port-report.json'] });
    const common = { project, setting: { es6: true, minify: true }, robot: 1, onProgressUpdate: () => {} };
    const result = job.kind === 'preview'
      ? await ci.preview({ ...common, desc: job.desc || 'OpenDesign preview', qrcodeFormat: 'image', qrcodeOutputDest: job.qrcodeOutputDest })
      : await ci.upload({ ...common, version: job.version, desc: job.desc });
    report({ ok: true, data: job.kind === 'preview' ? null : { ...(result?.subPackageInfo !== undefined ? { subPackageInfo: result.subPackageInfo } : {}) } });
  } catch (error) { fail(error); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) void runWechatCiWorker();
