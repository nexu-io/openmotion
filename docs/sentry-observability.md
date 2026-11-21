# Web Sentry Observability & SourceMap Guide

OpenMotion cloud deployments provide opt-in Web error monitoring and browser performance tracing through the standalone internal package [`packages/observability`](../packages/observability/README.md) (`@openmotion/observability`).

## 1. Architecture & Open-Source Boundaries

- **Decoupled from `@openmotion/tracking`**: `tracking/` remains a zero-dependency, closed-schema product analytics package; `@openmotion/observability` owns engineering stability and APM signals.
- **Default-off & zero-cost when unconfigured**:
  - No DSN, organization slug, or internal endpoint is hardcoded in the repository.
  - When `SENTRY_WEB_DSN` is unset, `api` injects no bootstrap script into Studio HTML and `@openmotion/observability/browser` never dynamically imports `@sentry/react` (zero extra JS downloaded, zero outbound requests).
- **Pure OSI dependency tree**:
  - Only `@sentry/react` (MIT) is in root `devDependencies` (never installed into `prod-base` Node containers via `npm ci --omit=dev`).
  - Deterministic Debug ID injection is implemented directly in [`packages/observability/vite.ts`](../packages/observability/vite.ts) with zero external build-plugin dependencies; SourceMap upload is performed externally in release CI via `sentry-cli` so no non-OSI CLI package enters `package-lock.json`.
- **Privacy & preview isolation**:
  - Sentry v11 automatic PII collection (`userInfo`, `cookies`, `httpHeaders`, `httpBodies`, `urlQueryParams`) is explicitly disabled.
  - Only opaque IDs (`user.id`, `workspace_id`, `project_id`) are attached — never emails, display names, or session cookies.
  - `beforeSend` / `beforeSendTransaction` / `beforeBreadcrumb` redact `preview_token`, S3 `X-Amz-*` signatures, OAuth `code`/`state`, tokens, and emails, and strip `request.cookies` / `request.data`.
  - `tracePropagationTargets` is restricted to same-origin `/api/` and `/motion-api/` routes so cross-origin S3 presigned uploads are never broken by extra CORS tracing headers.
  - Untrusted project previews on `PREVIEW_PUBLIC_ORIGIN` never receive the Studio bootstrap script and errors originating from `PREVIEW_PUBLIC_ORIGIN` or `/api/projects/*/preview` are dropped.

---

## 2. Prerequisites in Sentry

1. Create a **React / Browser** project in Sentry (SaaS `sentry.io` or self-hosted Sentry / GlitchTip).
2. Collect the **public DSN** from **Project Settings → Client Keys (DSN)**:
   ```text
   https://<public-key>@<sentry-host>/<project-id>
   ```
3. For SourceMap upload in release CI/CD (kept exclusively in CI secrets, never in Git or container runtime env):
   - `SENTRY_ORG`: Organization slug.
   - `SENTRY_PROJECT`: Project slug.
   - `SENTRY_AUTH_TOKEN`: Organization or user auth token with `project:releases` and `org:read` scopes.
   - `SENTRY_URL` *(optional, self-hosted only)*: Base URL of your Sentry instance (e.g. `https://sentry.example.com`).

---

## 3. Runtime Configuration (Web Reporting)

Studio is built once into a container image and configured at runtime via environment variables on the `api` service (never baked as `VITE_*` variables). All keys are validated by [`src/infra/config.ts`](../src/infra/config.ts):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SENTRY_WEB_DSN` | *(empty — disabled)* | Public Sentry DSN (`https://...`, or loopback `http://127.0.0.1:...` for local ingestion mocks). |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Sentry environment tag (`production`, `staging`, `development`, etc.). |
| `SENTRY_RELEASE` | `openmotion@<version>` | Release tag attached to events. Should match the release passed when uploading SourceMaps. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Browser performance trace sample rate (`0` to `1`). Set `0` to disable performance tracing while keeping error reporting. |

### Local Development (`npm run dev`)

Add temporary local overrides to `.env.development` (never commit real DSNs):

```bash
SENTRY_WEB_DSN=https://<public-key>@<sentry-host>/<project-id>
SENTRY_ENVIRONMENT=development
SENTRY_RELEASE=openmotion@local-dev
SENTRY_TRACES_SAMPLE_RATE=1
```

### Local Docker Compose (`deploy/docker-compose.yml`)

Copy `deploy/.env.example` to `deploy/.env` and set the `SENTRY_WEB_*` variables (`api` only; never passed to `worker-render`):

```bash
cp deploy/.env.example deploy/.env
# Edit deploy/.env and set SENTRY_WEB_DSN, SENTRY_ENVIRONMENT, SENTRY_RELEASE, SENTRY_TRACES_SAMPLE_RATE
docker compose -f deploy/docker-compose.yml up -d
```

### Cloud Kubernetes (`deploy/k8s/`)

Set the values in [`deploy/k8s/configmap.yaml`](../deploy/k8s/configmap.yaml) (already mapped onto `openmotion-api` with `optional: true` in [`deploy/k8s/api-deployment.yaml`](../deploy/k8s/api-deployment.yaml)):

```yaml
  SENTRY_WEB_DSN: "https://<public-key>@<sentry-host>/<project-id>"
  SENTRY_ENVIRONMENT: "production"
  SENTRY_RELEASE: "openmotion@<release-tag-or-sha>"
  SENTRY_TRACES_SAMPLE_RATE: "0.1"
```

---

## 4. SourceMap Build & Upload

Production containers never ship `.map` files (`deploy/Dockerfile` strips `*.map` from `prod-base`, and `src/entrypoints/api.ts` returns `404` for `*.map` whenever `NODE_ENV=production`).

When built with `STUDIO_SOURCEMAP=hidden` (or `SENTRY_DEBUG_IDS=true`), [`packages/observability/vite.ts`](../packages/observability/vite.ts) emits hidden `.js.map` files without `//# sourceMappingURL=` comments and appends deterministic TC39/Sentry Debug IDs to both `.js` chunks and `.js.map` files. Because Debug IDs are deterministic from chunk content, the `api` image and exported sourcemaps share identical Debug IDs.

### Option A: Docker Multi-Target Release Build (Recommended for Cloud CI)

Build the production `api` image with hidden sourcemaps + Debug IDs (`.map` files are automatically stripped from the final `api` image), then export the matching `studio-sourcemaps` artifacts from the shared BuildKit cache and upload with `sentry-cli`:

```bash
SHA="$(git rev-parse --short HEAD)"
IMAGE_TAG="openmotion-${SHA}"
SENTRY_RELEASE="openmotion@${SHA}"

# 1. Build & push production api image (contains JS with Debug IDs, zero .map files)
docker buildx build \
  -f deploy/Dockerfile \
  --target api \
  --build-arg STUDIO_SOURCEMAP=hidden \
  -t "ghcr.io/nexu-io/openmotion-api:${IMAGE_TAG}" \
  .

# 2. Export the matching hidden .js + .js.map files from the same build cache
docker buildx build \
  -f deploy/Dockerfile \
  --target studio-sourcemaps \
  --build-arg STUDIO_SOURCEMAP=hidden \
  --output type=local,dest=./dist/studio-sourcemaps \
  .

# 3. Upload SourceMaps to Sentry (Debug IDs are already embedded; no `inject` step needed)
sentry-cli sourcemaps upload \
  --org "$SENTRY_ORG" \
  --project "$SENTRY_PROJECT" \
  --release "$SENTRY_RELEASE" \
  --url-prefix "~/editor-assets" \
  ./dist/studio-sourcemaps

# 4. Remove temporary exported maps from CI runner
rm -rf ./dist/studio-sourcemaps
```

> For self-hosted Sentry, pass `--url "$SENTRY_URL"` (or export `SENTRY_URL`).

### Option B: Direct Node Build + Upload

```bash
RELEASE="openmotion@$(git rev-parse --short HEAD)"

STUDIO_SOURCEMAP=hidden npm run build:studio

sentry-cli sourcemaps upload \
  --org "$SENTRY_ORG" \
  --project "$SENTRY_PROJECT" \
  --release "$RELEASE" \
  --url-prefix "~/editor-assets" \
  studio/build/editor-assets

find studio/build -type f -name '*.map' -delete
```

---

## 5. What Signals Are Captured

### Errors & Crash Boundaries
- Unhandled `window` errors and unhandled Promise rejections (including early-boot errors buffered while the lazy Sentry chunk downloads).
- React ErrorBoundary crashes via `StudioErrorBoundary` (`error_boundary: StudioErrorBoundary` + `componentStack`).
- React 19 root `onUncaughtError` / `onRecoverableError` (intentionally omitting `onCaughtError` to prevent duplicate ErrorBoundary reports).
- Per-session cap of **50** error events to prevent runaway render loops from exhausting quota.

### Filtered Noise (Dropped Automatically)
- `ResizeObserver loop` browser warnings.
- `AbortError` request cancellations.
- Composition media load errors (`MEDIA_ERR_SRC_NOT_SUPPORTED`, `EncodingError`, 404 asset fetch errors).
- Browser extension-only stack traces (`chrome-extension://`, `moz-extension://`, `safari-extension://`).
- Errors originating from `PREVIEW_PUBLIC_ORIGIN` or `/api/projects/*/preview`.

### Performance Tracing & Editor Metrics
- Automatic `browserTracingIntegration`: Page load, SPA navigations, Web Vitals (LCP / INP / CLS / TTFB / FCP), Long Tasks, Long Animation Frames, and `/api/*` + `/motion-api/*` fetch spans.
- Custom distribution metrics (`Sentry.metrics.distribution`):
  - `openmotion.studio.load_ms` — Studio editor initial mount duration (`embedded`, `project_scope`).
  - `openmotion.preview.first_frame_ms` — Composition preview first-frame paint latency (`clip_count`, `media_clip_count`).
  - `openmotion.timeline.scroll_frame_latency_p95_ms` — Timeline scroll burst P95 frame latency (`zoom_mode`, `total_clip_count`, `mounted_clip_count`).

### Context Tags (Non-PII Only)
- `app_surface` (`studio-web`), `deployment_mode` (`cloud-container`), `app_version`, `embedded`
- `user.id` (opaque ID only), `workspace_id`, `workspace_role`, `auth_mode`, `project_id`, `studio_page`

---

## 6. Verification Checklist

1. **Runtime injection check**:
   ```bash
   curl -s http://127.0.0.1:4173/ | grep '__OPENMOTION_OBSERVABILITY__'
   ```
   - With `SENTRY_WEB_DSN` unset: returns no match; Network tab shows no Sentry chunk loaded and zero outbound Sentry requests.
   - With `SENTRY_WEB_DSN` set: `<head>` includes `window.__OPENMOTION_OBSERVABILITY__=Object.freeze({...})`.
2. **Production `.map` protection check**:
   ```bash
   curl -I https://<your-domain>/editor-assets/<chunk>.js.map
   ```
   Must return `404` when `NODE_ENV=production`.
3. **Debug ID check after `STUDIO_SOURCEMAP=hidden npm run build:studio`**:
   - Built JS chunks under `studio/build/editor-assets/*.js` end with `//# debugId=<uuid>` and contain **no** `//# sourceMappingURL=`.
   - Matching `.js.map` files contain `"debugId":"<uuid>"`.
4. **End-to-end Sentry check (staging)**:
   - Open Studio, trigger a controlled uncaught error in browser DevTools (`setTimeout(() => { throw new Error('sentry-smoke-check'); }, 0)`), and verify the event arrives in Sentry with deobfuscated TypeScript stack frames and sanitized URLs.
