# `@openmotion/observability`

Dedicated observability package for OpenMotion cloud deployments, intentionally decoupled from `@openmotion/tracking` (`tracking/`).

For the complete configuration, SourceMap upload, and verification guide, see [docs/sentry-observability.md](../../docs/sentry-observability.md).

## Design Principles

- **Separate from product analytics**: `@openmotion/tracking` remains a zero-dependency, closed-schema product analytics package. `@openmotion/observability` owns engineering error monitoring, browser performance tracing (Web Vitals, fetch spans, Studio timings), scrubbing/isolation rules, and Debug ID sourcemap tooling.
- **Open-source friendly (OSI-clean & default-off)**:
  - Only `@sentry/react` (MIT) is added to `devDependencies`; no non-OSI CLI (`FSL-1.1`) packages are committed to `package-lock.json`.
  - When no `SENTRY_WEB_DSN` is configured, `api` injects nothing into Studio HTML and `initBrowserObservability()` returns `false` synchronously without even downloading the lazy `@sentry/react` chunk (zero bytes fetched, zero outbound requests).
  - Supports self-hosted Sentry or compatible ingest endpoints via arbitrary `SENTRY_WEB_DSN`.

## Entrypoints

- `./config`: Zero-dependency runtime config validation, safe inline HTML bootstrap serializer (`window.__OPENMOTION_OBSERVABILITY__`), and browser reader. Safe for Node (`--experimental-strip-types`) and browsers.
- `./sanitize`: Zero-dependency URL/header/message redaction and noise/preview-origin filtering shared by `beforeSend`, `beforeSendTransaction`, and `beforeBreadcrumb`.
- `./browser`: Lazy-loaded browser Sentry client (`@sentry/react`), early-boot buffering, React ErrorBoundary / React 19 root handlers, non-PII user/workspace/project tagging, and performance distribution metrics.
- `./vite`: Zero-dependency Vite plugin for `studio/vite.config.ts` that resolves `STUDIO_SOURCEMAP` (`true` / `false` / `'hidden'`) and injects deterministic TC39/Sentry Debug IDs into emitted JS chunks and `.js.map` files when `STUDIO_SOURCEMAP=hidden` or `SENTRY_DEBUG_IDS=true`.

## Runtime Configuration (Cloud API → Studio HTML)

Configure on the `api` service (never baked as `VITE_*` build-time variables):

- `SENTRY_WEB_DSN`: Public Sentry DSN (`https://...`, or loopback `http://...` in local tests). Empty disables web Sentry completely.
- `SENTRY_ENVIRONMENT`: Deployment environment label (defaults to `NODE_ENV`).
- `SENTRY_RELEASE`: Release label (defaults to `openmotion@<package.version>`).
- `SENTRY_TRACES_SAMPLE_RATE`: Performance trace sample rate in `[0, 1]` (default `0.1`; `0` disables traces while keeping error capture).

## SourceMap & Debug ID Pipeline

Build with `STUDIO_SOURCEMAP=hidden` (or `SENTRY_DEBUG_IDS=true`) to emit hidden `.js.map` files and deterministic Debug IDs without adding `//# sourceMappingURL=` comments. Upload the `.map` artifacts externally in release CI/CD via `sentry-cli sourcemaps upload`, and keep production images free of `.map` files (`deploy/Dockerfile` strips `.map` from `prod-base` and exposes a separate `--target studio-sourcemaps` export stage; `src/entrypoints/api.ts` also blocks `*.map` with `404` when `NODE_ENV=production`).
