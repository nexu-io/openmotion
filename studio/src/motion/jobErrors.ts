import type { GenerationJob } from '../../../shared/gateway';

export type JobBillingAction = 'topup' | 'upgrade';

const PLAN_ENTITLEMENT_ERROR_CODES = new Set([
  'tier_model_not_entitled',
  'tier_request_kind_not_entitled',
  'model_access_denied',
]);

export function formatGenerationJobError(
  error: string | undefined,
  t: (key: string) => string,
): string | undefined {
  if (!error) return undefined;
  if (error.startsWith('SAVE_NOT_AVAILABLE:')) {
    return t('The retained files are missing, changed or unreadable. Saving cannot be retried. No new generation was requested.');
  }
  if (error.startsWith('CODEX_IMAGE_PROXY_AUTH_REQUIRED:')) {
    return t('The local Codex proxy requires its own authentication. In Codex settings, select the configured proxy provider and check its endpoint and credentials. Signing in again alone will not fix a missing proxy key. Your original asset is unchanged; no automatic retry was made.');
  }
  if (error.startsWith('CODEX_IMAGE_AUTH_REQUIRED:')) {
    return t('The configured Codex image service rejected authorization. Check the active provider, endpoint and authentication in Codex settings; sign in again only if your account session has expired. Your original asset is unchanged; no automatic retry was made.');
  }
  if (error.startsWith('ASSET_MEDIA_RUNTIME_NOT_READY:')) {
    return t('Local media components are unavailable. Prepare or repair this installation, then submit again. No model request was made; your original asset is unchanged.');
  }
  return t(error);
}

export function jobErrorCode(job: GenerationJob): string | undefined {
  if (typeof job.errorCode === 'string' && job.errorCode) return job.errorCode;
  const err = job.result && typeof job.result === 'object' && !Array.isArray(job.result)
    ? (job.result as { error?: unknown }).error
    : undefined;
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return undefined;
}

export function jobBillingAction(job: GenerationJob): JobBillingAction | null {
  if (job.state !== 'failed') return null;
  const code = jobErrorCode(job);
  if (code === 'insufficient_balance') return 'topup';
  if (code && PLAN_ENTITLEMENT_ERROR_CODES.has(code)) return 'upgrade';
  const error = job.error ?? '';
  if (error.startsWith('Your OpenDesign balance is too low')) return 'topup';
  if (error.startsWith('Your OpenDesign plan does not include this model.')) return 'upgrade';
  return null;
}
