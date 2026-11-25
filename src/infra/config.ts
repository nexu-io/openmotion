import { z } from 'zod';
import {
  DEFAULT_TRACES_SAMPLE_RATE,
  parseSentryDsn,
} from '../../packages/observability/config.ts';

const booleanEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.string().min(1).optional());

const optionalUrl = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return value;
}, z.string().url().optional());

const rawConfigSchema = z.object({
  // Core service
  APP_PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:4173'),
  PREVIEW_PUBLIC_ORIGIN: optionalUrl,
  PRISM_CONTENT_ENV: z.preprocess(value => value === '' ? undefined : value, z.enum(['dev', 'prod']).optional()),
  PRISM_PUBLIC_ORIGIN: optionalUrl,
  CATALOG_FILMSTRIP_AUTO_BAKE: booleanEnv.default(true),
  PREVIEW_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  PORT: z.coerce.number().int().min(1).max(65535).default(4173),
  BIND_HOST: z.string().min(1).default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WORKER_ROLE: z.enum(['api', 'media', 'render']).default('api'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Postgres
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),

  // Redis
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_CACHE_URL: optionalNonEmptyString,
  REDIS_CACHE_TTL_SEC: z.coerce.number().int().min(10).max(86_400).default(3600),

  // Object Storage (S3 / R2 / MinIO / RustFS)
  S3_ENDPOINT: optionalUrl,
  S3_PUBLIC_ENDPOINT: optionalUrl,
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('openmotion'),
  S3_ACCESS_KEY_ID: optionalNonEmptyString,
  S3_SECRET_ACCESS_KEY: optionalNonEmptyString,
  S3_FORCE_PATH_STYLE: booleanEnv.default(true),
  S3_PRESIGN_PUT_TTL_SEC: z.coerce.number().int().min(30).max(86_400).default(900),
  S3_PRESIGN_GET_TTL_SEC: z.coerce.number().int().min(30).max(86_400).default(300),
  S3_PRESIGN_CACHE_WINDOW_SEC: z.coerce.number().int().positive().default(3600),

  // Auth & sessions
  TEXT_PATCH_WRITES: booleanEnv.default(false),
  AUTH_MODE: z.enum(['oidc', 'dev']).default('oidc'),
  ALLOW_INSECURE_DEV_AUTH: booleanEnv.default(false),
  DEV_WORKSPACE_ID: z.string().uuid().default('00000000-0000-4000-8000-000000000001'),
  DEV_USER_ID: z.string().uuid().default('00000000-0000-4000-8000-000000000002'),
  DEV_PAT: z.string().min(16).default('om_pat_devlocal_000000000000000000000000'),
  SESSION_SECRET: optionalNonEmptyString,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  // OIDC
  OIDC_ISSUER: optionalUrl,
  OIDC_CLIENT_ID: optionalNonEmptyString,
  OIDC_CLIENT_SECRET: optionalNonEmptyString,
  OIDC_CALLBACK_URL: optionalUrl,
  OIDC_SCOPES: z.string().min(1).default('openid profile email'),
  OIDC_CLAIM_SUB: z.string().min(1).default('sub'),
  OIDC_CLAIM_EMAIL: z.string().min(1).default('email'),
  OIDC_CLAIM_NAME: z.string().min(1).default('name'),
  OIDC_CLAIM_WORKSPACE: optionalNonEmptyString,

  // Remote MCP OAuth 2.1
  MCP_OAUTH_MODE: z.enum(['proxy', 'delegated']).default('proxy'),
  MCP_OAUTH_ISSUER: optionalUrl,
  MCP_MAX_BODY_BYTES: z.coerce.number().int().min(1024 * 1024).max(64 * 1024 * 1024).default(10_485_760),
  OAUTH_DCR_ALLOWED_HTTPS_HOSTS: optionalNonEmptyString,
  OAUTH_DCR_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(1000).default(10),

  // Unified OpenDesign Model Gateway & AMR Identity
  MODEL_GATEWAY_MODE: z.enum(['opendesign', 'mock']).default('opendesign'),
  OPENDESIGN_API_URL: z.string().url().default('https://amr-api.open-design.ai'),
  OPENDESIGN_LINK_URL: z.string().url().default('https://amr-link.open-design.ai'),
  // OpenDesign web console that account/plan links open; non-production environments point at their own console.
  OPENDESIGN_CONSOLE_URL: z.string().url().default('https://open-design.ai/cloud'),
  OPENDESIGN_INTERNAL_API_TOKEN: optionalNonEmptyString,
  OPENDESIGN_S2S_API_KEY: optionalNonEmptyString,
  AMR_IDENTITY_CACHE_TTL_SEC: z.coerce.number().int().min(1).max(60).default(60),
  OPENDESIGN_ASR_URL: optionalUrl,
  OPENDESIGN_BILLING_SYNC_ENABLED: booleanEnv.default(false),
  ALLOW_DOH_FAKEIP_FALLBACK: booleanEnv.default(false),

  // Worker tuning, history coalescing & GC
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(20),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  BLOB_GC_GRACE_SECONDS: z.coerce.number().int().min(0).default(604_800),
  HISTORY_COALESCE_WINDOW_MS: z.coerce.number().int().min(0).default(4000),

  // Cloud web observability (Sentry DSN injected into Studio HTML at runtime; empty = disabled)
  SENTRY_WEB_DSN: optionalUrl,
  SENTRY_ENVIRONMENT: optionalNonEmptyString,
  SENTRY_RELEASE: optionalNonEmptyString,
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(DEFAULT_TRACES_SAMPLE_RATE),
});

export type AppConfig = z.infer<typeof rawConfigSchema>;

export function parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`INVALID_CONFIG: ${details}`);
  }

  const config = parsed.data;

  // Hard production safety latch: never allow dev auth bypass in production unless explicitly overridden.
  if (config.NODE_ENV === 'production' && config.AUTH_MODE === 'dev' && !config.ALLOW_INSECURE_DEV_AUTH) {
    throw new Error(
      'INSECURE_CONFIG: Refusing startup with NODE_ENV=production and AUTH_MODE=dev. Set AUTH_MODE=oidc, or explicitly set ALLOW_INSECURE_DEV_AUTH=true only for non-production sandboxes.',
    );
  }

  // OIDC requirements on API role.
  if (config.WORKER_ROLE === 'api' && config.AUTH_MODE === 'oidc') {
    const missing: string[] = [];
    if (!config.OIDC_ISSUER) missing.push('OIDC_ISSUER');
    if (!config.OIDC_CLIENT_ID) missing.push('OIDC_CLIENT_ID');
    if (!config.SESSION_SECRET || config.SESSION_SECRET.length < 32) {
      missing.push('SESSION_SECRET (minimum 32 characters)');
    }
    if (missing.length > 0) {
      throw new Error(`INVALID_CONFIG: AUTH_MODE=oidc requires ${missing.join(', ')}`);
    }
  }

  // OpenDesign internal token requirement when live gateway mode is active on api or media worker.
  if (
    (config.WORKER_ROLE === 'api' || config.WORKER_ROLE === 'media') &&
    config.MODEL_GATEWAY_MODE === 'opendesign' &&
    !config.OPENDESIGN_INTERNAL_API_TOKEN &&
    !config.OPENDESIGN_S2S_API_KEY
  ) {
    throw new Error(
      'INVALID_CONFIG: MODEL_GATEWAY_MODE=opendesign requires OPENDESIGN_INTERNAL_API_TOKEN (or OPENDESIGN_S2S_API_KEY; set MODEL_GATEWAY_MODE=mock for local dev/tests).',
    );
  }

  if (config.SENTRY_WEB_DSN && !parseSentryDsn(config.SENTRY_WEB_DSN)) {
    throw new Error(
      'INVALID_CONFIG: SENTRY_WEB_DSN must be a valid Sentry DSN URL (https://<public-key>@<host>/<project-id>, or loopback http:// for local testing).',
    );
  }

  return Object.freeze(config);
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = parseConfig(process.env);
  }
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = null;
}
