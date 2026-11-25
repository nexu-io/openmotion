const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync, statSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Fast macOS notarization hook for electron-builder (`afterSign`).
 *
 * Why custom instead of `@electron/notarize` default `ditto`:
 * - `zip -1 -y -q -r` archives the ~270MB Electron `.app` in ~3-4s instead of
 *   ~20s with `ditto`'s higher default compression while preserving symlinks.
 * - Submits directly via Apple's native `xcrun notarytool submit --wait --output-format json`,
 *   printing structured timing and automatically fetching `notarytool log` on rejection.
 * - Staples the ticket onto `.app` before electron-builder creates `.dmg` and `.zip`.
 */
function resolveNotaryCredentials(env = process.env) {
  const apiKey = (env.OM_APPLE_API_KEY || env.APPLE_API_KEY || '').trim();
  const apiKeyId = (env.OM_APPLE_API_KEY_ID || env.APPLE_API_KEY_ID || '').trim();
  const apiIssuer = (env.OM_APPLE_API_ISSUER || env.APPLE_API_ISSUER || '').trim();
  if (apiKey && apiKeyId && apiIssuer) {
    return {
      mode: 'api-key',
      args: ['--key', apiKey, '--key-id', apiKeyId, '--issuer', apiIssuer],
    };
  }

  const appleId = (env.OM_APPLE_ID || env.APPLE_ID || '').trim();
  const password = (env.OM_APPLE_APP_SPECIFIC_PASSWORD || env.APPLE_APP_SPECIFIC_PASSWORD || '').trim();
  const teamId = (env.OM_APPLE_TEAM_ID || env.APPLE_TEAM_ID || '').trim();
  if (appleId && password && teamId) {
    return {
      mode: 'apple-id',
      args: ['--apple-id', appleId, '--password', password, '--team-id', teamId],
    };
  }

  return null;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function notarizeMacApp(context) {
  if (!context || context.electronPlatformName !== 'darwin') {
    return { skipped: true, reason: 'non-darwin' };
  }
  if (process.env.OM_SKIP_NOTARIZE === '1' || process.env.OM_SKIP_NOTARIZE === 'true') {
    console.log('[notarize] Skipped (OM_SKIP_NOTARIZE=1).');
    return { skipped: true, reason: 'skip-env' };
  }

  const creds = resolveNotaryCredentials(process.env);
  if (!creds) {
    console.log('[notarize] Skipped (no Apple notarization credentials set).');
    return { skipped: true, reason: 'no-credentials' };
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appName = `${productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!existsSync(appPath)) {
    throw new Error(`[notarize] Expected signed macOS app bundle at ${appPath}`);
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'om-notarize-'));
  const zipPath = path.join(tempDir, `${productFilename}.zip`);

  try {
    const t0 = Date.now();
    console.log(`[notarize] Archiving ${appName} with fast zip -1...`);
    execFileSync('/usr/bin/zip', ['-1', '-y', '-q', '-r', zipPath, appName], {
      cwd: context.appOutDir,
      stdio: 'pipe',
    });
    const zipMs = Date.now() - t0;
    const zipMb = (statSync(zipPath).size / (1024 * 1024)).toFixed(1);
    console.log(`[notarize] Archived ${zipMb} MB in ${formatSeconds(zipMs)}; submitting via notarytool (${creds.mode})...`);

    const t1 = Date.now();
    const rawOut = execFileSync(
      'xcrun',
      ['notarytool', 'submit', zipPath, ...creds.args, '--wait', '--output-format', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const submitMs = Date.now() - t1;

    let result;
    try {
      result = JSON.parse(rawOut);
    } catch {
      throw new Error(`[notarize] Failed to parse notarytool JSON output: ${rawOut.slice(0, 500)}`);
    }

    const status = String(result.status || '');
    const submissionId = String(result.id || '');
    console.log(`[notarize] notarytool finished in ${formatSeconds(submitMs)} (status=${status}, id=${submissionId})`);

    if (status !== 'Accepted') {
      let logDetails = '';
      if (submissionId) {
        try {
          logDetails = execFileSync(
            'xcrun',
            ['notarytool', 'log', submissionId, ...creds.args],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          );
        } catch (logErr) {
          logDetails = `Unable to fetch notarytool log: ${logErr instanceof Error ? logErr.message : String(logErr)}`;
        }
      }
      throw new Error(
        `[notarize] Apple notarization failed (status=${status}, id=${submissionId}).\n${logDetails}`,
      );
    }

    const t2 = Date.now();
    execFileSync('xcrun', ['stapler', 'staple', '-v', appPath], { stdio: 'inherit' });
    const stapleMs = Date.now() - t2;
    console.log(
      `[notarize] Stapled ${appName} in ${formatSeconds(stapleMs)} (total=${formatSeconds(Date.now() - t0)})`,
    );

    return { skipped: false, submissionId, status };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = notarizeMacApp;
module.exports.resolveNotaryCredentials = resolveNotaryCredentials;
