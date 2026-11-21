# OpenMotion Cloud & Container Deployment

OpenMotion runs as a container-first, stateless cloud stack backed by **PostgreSQL 17**, **Redis 7** (`noeviction` for BullMQ), and **S3-compatible object storage** (RustFS locally, S3/R2 in cloud).

## Container Architecture

A single multi-target [Dockerfile](Dockerfile) (`node:26.11.1-bookworm-slim`, matching CI) produces four role-specific images from a shared build cache:

| Target | Contents | Responsibility |
| --- | --- | --- |
| `api` | Node.js + Studio SPA + `/app/fonts/` (**no Chromium, no FFmpeg**) | Stateless HTTP/SSE Studio server, Motion API, and Streamable HTTP `/mcp` endpoint (`read_only` rootfs). |
| `worker-media` | Node.js + `ffmpeg` / `ffprobe` (**no Chromium**) | BullMQ `media-ingest`, `media-generate`, and two-phase `blob-gc` worker (`WORKER_ROLE=media`). |
| `worker-render` | Node.js + `chromium` + `ffmpeg` + Noto fonts + `/app/fonts/` | Isolated BullMQ `render-export` worker (`WORKER_ROLE=render`) with ephemeral `/tmp` hydration and strict env stripping. |
| `catalog-sync` | Node.js + `template-library/` + `library/templates/catalog/` | One-shot Job syncing built-in and repository templates into S3 CAS (`catalog/blobs/{sha256}`) and PostgreSQL. |

Both `api` and `worker-render` bake the exact same `/app/fonts/` catalog (bundled Studio/template fonts and Noto Core/CJK/Color Emoji) so preview typography matches headless Chromium exports without placing browser or media binaries on `api`.

## Local Docker Compose Quick Start (`AUTH_MODE=dev`)

### Prerequisites

- Docker Engine + Docker Compose v2+.
- **Memory recommendation (Colima / Docker Desktop):** Allocate at least **8 GiB RAM** to your Linux VM for smooth 1080p Chromium + FFmpeg exports (e.g., `colima start --cpu 4 --memory 8`). On smaller 3.8 GiB Colima dev VMs, the default Compose limits (`RENDER_SHM_SIZE=512m`, `RENDER_MEM_LIMIT=2g`) remain bootable; raise them to `RENDER_SHM_SIZE=1g` and `RENDER_MEM_LIMIT=4g` on `>= 8 GiB` hosts.

### Start the Local Stack

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build
```

Startup runs three one-shot bootstrap services automatically before `api` starts:

1. `s3-init` (`scripts/init-s3.ts`): Creates the `openmotion` bucket in RustFS and applies the canonical S3 CORS policy via `PutBucketCorsCommand` (`GET`, `HEAD`, `PUT` + `Range`/`ETag`/`Content-Range` headers) required for direct browser uploads and `302` presigned media playback.
2. `db-migrate` (`src/db/migrate.ts`): Applies Drizzle SQL migrations under a PostgreSQL advisory lock.
3. `catalog-sync` (`scripts/sync-catalog-cas.ts`): Ingests template blobs into `catalog/blobs/{sha256}` and upserts `catalog_templates` metadata.

### Local Endpoints

| Service | Loopback URL | Notes |
| --- | --- | --- |
| OpenMotion Studio & API | `http://127.0.0.1:4173` | Runs with `AUTH_MODE=dev`, `MODEL_GATEWAY_MODE=mock`, and a read-only root filesystem (`tmpfs: /tmp:size=64m`). |
| Remote MCP (Streamable HTTP) | `http://127.0.0.1:4173/mcp` | Authenticate with `Authorization: Bearer <DEV_PAT>` in local dev mode. |
| RustFS S3 API | `http://127.0.0.1:9000` | Signed into browser presigned URLs via `S3_PUBLIC_ENDPOINT`. Internal containers talk to `http://s3:9000`. |
| RustFS Console | `http://127.0.0.1:9001` | Sign in with `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` from `deploy/.env`. |
| PostgreSQL 17 | `127.0.0.1:5432` | Database `openmotion` (credentials in `deploy/.env`). |

Stop containers while keeping volumes (`pg_data`, `redis_data`, `s3_data`):

```bash
docker compose -f deploy/docker-compose.yml down
```

Remove all local state and volumes:

```bash
docker compose -f deploy/docker-compose.yml down -v
```

## Connect an AI Agent (Streamable HTTP MCP)

OpenMotion exposes MCP directly over **Streamable HTTP** at `/mcp` without any local stdio process or container-exec wrapper.

Install the OpenMotion product Skill in your host Agent:

```sh
npx skills add nexu-io/openmotion --skill openmotion
```

Point your MCP client at the Streamable HTTP endpoint using the `DEV_PAT` from `deploy/.env` (default `om_pat_devlocal_000000000000000000000000`):

```json
{
  "mcpServers": {
    "openmotion": {
      "type": "http",
      "url": "http://127.0.0.1:4173/mcp",
      "headers": {
        "Authorization": "Bearer om_pat_devlocal_000000000000000000000000"
      }
    }
  }
}
```

In production (`AUTH_MODE=oidc`), remote MCP clients authenticate via **OAuth 2.1 + PKCE** (`/.well-known/oauth-protected-resource`) or workspace-scoped **Personal Access Tokens (PATs)** created in Studio.

## Key Environment Variables

All runtime variables are validated strictly by [`src/infra/config.ts`](../src/infra/config.ts):

| Variable | Default (Compose) | Purpose |
| --- | --- | --- |
| `APP_PUBLIC_ORIGIN` | `http://127.0.0.1:4173` | Canonical external origin for OAuth metadata, MCP URLs, S3 CORS, and CSRF checks. |
| `PREVIEW_PUBLIC_ORIGIN` | *(empty)* | Optional cookie-less preview origin (e.g. `https://preview.openmotion.example.com`). When configured on a distinct host, `api` isolates preview iframes from session cookies and blocks `/motion-api/*`, `/auth/*`, `/oauth/*`, `/mcp`, and mutations with `403 PREVIEW_ORIGIN_ISOLATED`. Leave empty for single-host local Compose dev. |
| `PREVIEW_TOKEN_TTL_SEC` | `900` | Lifetime (seconds) of HS256 project-scoped preview tokens minted by `POST /api/projects/:id/preview-token`. |
| `AUTH_MODE` | `dev` | `dev` for local Compose; `oidc` required in production (`NODE_ENV=production` refuses `AUTH_MODE=dev` unless `ALLOW_INSECURE_DEV_AUTH=true`). |
| `DEV_PAT` | `om_pat_devlocal_...` | Synthetic local Bearer token for `/mcp` when `AUTH_MODE=dev`. |
| `MCP_MAX_BODY_BYTES` | `10485760` | 10 MiB JSON-RPC body cap for large project edits on `/mcp`. |
| `MODEL_GATEWAY_MODE` | `mock` | `mock` returns deterministic media fixtures locally; set `opendesign` + `OPENDESIGN_S2S_API_KEY` for live media generation. |
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | `http://s3:9000` / `http://127.0.0.1:9000` | Dual S3 clients: internal container I/O vs browser-reachable presigned URLs. |
| `S3_PRESIGN_CACHE_WINDOW_SEC` | `3600` | UTC time-window alignment (seconds) for cacheable `immutable` Presigned GET URLs on content-addressed blobs/proxies/thumbnails. |
| `BLOB_GC_GRACE_SECONDS` | `604800` | 7-day grace period (seconds) before Mark-and-Sweep CAS GC physically deletes verified-unreferenced blobs. |
| `HISTORY_COALESCE_WINDOW_MS` | `4000` | Edit-window duration (ms) for coalescing rapid interactive Studio edits into the head unpinned version (`0` disables coalescing). |
| `SENTRY_WEB_DSN` | *(empty)* | Optional Sentry public DSN injected into Studio `index.html` at runtime by `api` (via `@openmotion/observability`). Leave empty to disable web Sentry completely. |
| `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` | `NODE_ENV` / `openmotion@<version>` | Runtime Sentry environment and release labels injected alongside `SENTRY_WEB_DSN`. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Browser performance tracing sample rate in `[0, 1]` (`0` disables performance traces while keeping error capture). |
| `RENDER_SHM_SIZE` / `RENDER_MEM_LIMIT` | `512m` / `2g` | Chromium `/dev/shm` and container memory limit on `worker-render`. Raise to `1g`–`2g` / `4g` on `>= 8 GiB` hosts. |

### Web Sentry SourceMaps & Observability Guide

Production images never ship `.map` files (`deploy/Dockerfile` strips `*.map` from `prod-base`, and `api` returns `404` for `*.map` when `NODE_ENV=production`). To build `api` with embedded deterministic Debug IDs, export matching hidden `.js.map` files from the shared BuildKit cache, and upload them externally via `sentry-cli`:

```bash
SHA="$(git rev-parse --short HEAD)"
IMAGE_TAG="openmotion-${SHA}"
SENTRY_RELEASE="openmotion@${SHA}"

docker buildx build -f deploy/Dockerfile --target api --build-arg STUDIO_SOURCEMAP=hidden -t "openmotion-api:${IMAGE_TAG}" .
docker buildx build -f deploy/Dockerfile --target studio-sourcemaps --build-arg STUDIO_SOURCEMAP=hidden --output type=local,dest=./dist/studio-sourcemaps .

sentry-cli sourcemaps upload --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" --release "$SENTRY_RELEASE" --url-prefix "~/editor-assets" ./dist/studio-sourcemaps
rm -rf ./dist/studio-sourcemaps
```

See the full configuration, privacy, metrics, and troubleshooting guide in [`docs/sentry-observability.md`](../docs/sentry-observability.md).

## Kubernetes + KEDA Deployment (`deploy/k8s/`)

Production manifests live under [`deploy/k8s/`](k8s/kustomization.yaml) and target Kubernetes with an Ingress controller (such as NGINX) and **KEDA v2** installed.

### 1. Provision Secrets & Config

1. Review [`deploy/k8s/configmap.yaml`](k8s/configmap.yaml) and update `APP_PUBLIC_ORIGIN`, `PREVIEW_PUBLIC_ORIGIN`, `OIDC_ISSUER` (OpenMotion supports both asymmetric JWKS IdPs and HS256 ID tokens issued by OpenDesign / Vela Better Auth with `disableJwtPlugin: true`; pair with `MCP_OAUTH_MODE=proxy`), `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`, `MCP_OAUTH_ISSUER`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, and `S3_BUCKET` for your cluster.
2. Provision both `openmotion-secrets` and `openmotion-keda-redis-auth` in namespace `openmotion` using [`deploy/k8s/secret.example.yaml`](k8s/secret.example.yaml) as a template (via External Secrets Operator, Sealed Secrets, or SOPS — never commit live credentials).
3. Ensure your S3/R2 bucket has the canonical CORS policy applied for both `APP_PUBLIC_ORIGIN` and `PREVIEW_PUBLIC_ORIGIN` (run `scripts/init-s3.ts` with `S3_CORS_ALLOWED_ORIGINS=$PREVIEW_PUBLIC_ORIGIN` or configure the same `GET`/`HEAD`/`PUT` + `Range`/`ETag`/`Content-Range` rules via Terraform).
4. Update `deploy/k8s/ingress.yaml` with both your main Studio domain (`motion.example.com`) and dedicated cookie-less preview domain (`preview.openmotion.example.com`) plus TLS certificate secret, and update `deploy/k8s/networkpolicy.yaml` if PostgreSQL, Redis, or S3 run outside the cluster (pin exact PrivateLink / VPC endpoint CIDRs rather than opening `0.0.0.0/0` to `worker-render`).

### 2. Render & Apply Manifests

Preview the rendered Kustomize output:

```bash
kubectl kustomize deploy/k8s
```

Apply the stack:

```bash
kubectl apply -k deploy/k8s
```

Wait for pre-release schema migration and template catalog sync jobs:

```bash
kubectl -n openmotion wait --for=condition=complete job/openmotion-db-migrate --timeout=300s
kubectl -n openmotion wait --for=condition=complete job/openmotion-catalog-sync --timeout=900s
```

### 3. Autoscaling & Graceful Export Drain

- **`api`**: Managed by `HorizontalPodAutoscaler` (`api-hpa.yaml`, 2–20 replicas) and `PodDisruptionBudget` (`minAvailable: 1`). Ingress disables proxy buffering (`proxy-buffering: "off"`) with 3600s read/send timeouts for SSE (`/api/events`, `/api/render/:id/progress`) and Streamable HTTP `/mcp`.
- **`worker-render`**: Managed by KEDA `ScaledObject` (`worker-render-keda.yaml`) targeting BullMQ `render-export` (`minReplicaCount: 1`, `maxReplicaCount: 30`, `cooldownPeriod: 300`, scale-down stabilization `300s`), paired with `terminationGracePeriodSeconds: 1800` so in-flight video renders complete and upload cleanly before pod termination.
  - *Prioritized BullMQ v5 note:* Because `QueueService.enqueueRenderExport` assigns BullMQ priorities (`export_render=1`, `render_thumbnail=5`), waiting jobs enter the `bull:render-export:prioritized` ZSET before transitioning to `bull:render-export:active`. KEDA's native `redis` scaler evaluates Redis Lists (`wait`/`active`), so `minReplicaCount` defaults to `1` (warm pool) to prevent prioritized jobs from deadlocking at zero replicas; lower `minReplicaCount` to `0` only after pairing with a Prometheus/BullMQ ZSET queue-depth trigger.

### 4. Security Hardening Summary

- **Cookie-less Preview Subdomain Isolation:** Setting `PREVIEW_PUBLIC_ORIGIN` (e.g. `https://preview.openmotion.example.com`) alongside the dedicated Ingress rule isolates rendered project HTML/JS previews onto a separate cookie-less origin. The `api` Preview Host Isolation middleware ignores all session cookies, authenticates `/api/projects/:id/preview*` strictly via short-lived project-scoped HS256 preview tokens (`POST /api/projects/:id/preview-token`), applies `Content-Security-Policy: frame-ancestors 'self' <APP_PUBLIC_ORIGIN>;`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`, and immediately rejects `/motion-api/*`, `/auth/*`, `/oauth/*`, `/mcp`, and any mutating HTTP method with `403 PREVIEW_ORIGIN_ISOLATED`.
- **Pod Security `restricted`:** All pods run non-root (`runAsUser: 1000`), drop `ALL` Linux capabilities, enforce `seccompProfile: RuntimeDefault`, disable `automountServiceAccountToken`, and mount `readOnlyRootFilesystem: true` with bounded `emptyDir` scratch mounts (`/tmp`, plus memory-backed `/dev/shm` on `worker-render`).
- **Least-Privilege Secret Projection:** `worker-render` NEVER receives `OPENDESIGN_*`, `OIDC_*`, `SESSION_SECRET`, or `DEV_PAT` environment variables, and strips all remaining infrastructure credentials (`DATABASE_URL`, `REDIS_URL`, `S3_*`) before spawning Chromium/FFmpeg.
- **Strict Default-Deny `NetworkPolicy`:** `deploy/k8s/networkpolicy.yaml` denies all ingress and egress by default across `openmotion`. `worker-render` permits egress **only** to cluster DNS and PostgreSQL, Redis, and S3 endpoints — blocking all public internet egress, cloud metadata (`169.254.169.254/32`), and the Kubernetes API server.
