# syntax=docker/dockerfile:1.7
# Multi-target container build for OpenMotion cloud services.
# Node version matches .github/workflows/ci.yml.
ARG NODE_VERSION=26.11.1

# -----------------------------------------------------------------------------
# Stage 1: deps-build — full devDependencies to build Studio, MCP UI & tracking
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps-build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
ARG STUDIO_SOURCEMAP=false
ARG SENTRY_DEBUG_IDS=
RUN STUDIO_SOURCEMAP="${STUDIO_SOURCEMAP}" \
    SENTRY_DEBUG_IDS="${SENTRY_DEBUG_IDS}" \
    npm run build:studio \
  && rm -rf /app/studio-prod-build /app/studio-sourcemaps \
  && cp -a /app/studio/build /app/studio-prod-build \
  && find /app/studio-prod-build -type f -name '*.map' -delete \
  && mkdir -p /app/studio-sourcemaps \
  && find /app/studio/build/editor-assets -maxdepth 1 -type f \( -name '*.js' -o -name '*.js.map' \) -exec cp -p {} /app/studio-sourcemaps/ \; \
  && npm run build:tracking \
  && npm run build:observability

# -----------------------------------------------------------------------------
# Stage 2: fonts-catalog — deterministic font catalog baked identically into
# BOTH `api` and `worker-render` so preview and export typography match 100%,
# while keeping `api` strictly free of Chromium and FFmpeg binaries.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS fonts-catalog
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/fonts/bundled/design-system /app/fonts/bundled/studio /app/fonts/noto /app/fonts/licenses

COPY packages/design-system/fonts/ /app/fonts/bundled/design-system/
COPY library/skills/openmotion-design-remix/vendor/fonts/ /app/fonts/bundled/studio/

RUN for dir in /usr/share/fonts/truetype/noto /usr/share/fonts/opentype/noto; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type f \( -name '*.ttf' -o -name '*.otf' -o -name '*.ttc' \) -exec cp -p {} /app/fonts/noto/ \; ; \
      fi; \
    done \
  && for pkg in fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji; do \
      if [ -f "/usr/share/doc/${pkg}/copyright" ]; then \
        cp -p "/usr/share/doc/${pkg}/copyright" "/app/fonts/licenses/${pkg}-copyright.txt"; \
      fi; \
    done

# -----------------------------------------------------------------------------
# Stage 3: prod-base — lean production Node runtime shared by all targets.
# Intentionally EXCLUDES library/templates/catalog/ (~87 MB) so api and worker
# images stay small and diskless.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS prod-base
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Application source, migrations, skills, design-system, and runtime helpers.
COPY src/ ./src/
COPY shared/ ./shared/
COPY gateway/ ./gateway/
COPY tracking/ ./tracking/
COPY skills/ ./skills/
COPY library/components/registry/ ./library/components/registry/
COPY library/design/ ./library/design/
COPY library/skills/ ./library/skills/
COPY docs/transcripts.md docs/install.md ./docs/
COPY packages/design-system/ ./packages/design-system/
COPY packages/edit-core/ ./packages/edit-core/
COPY packages/motion-package/ ./packages/motion-package/
COPY packages/observability/ ./packages/observability/
COPY templates/compositions/ ./templates/compositions/
COPY templates/index.html ./templates/index.html
COPY web/ ./web/
COPY mcp-ui/template-recommendations/manifest.json \
     mcp-ui/template-recommendations/inline.fragment.html \
     mcp-ui/template-recommendations/i18n.ts \
     mcp-ui/template-recommendations/types.ts \
     mcp-ui/template-recommendations/LICENSE \
     mcp-ui/template-recommendations/NOTICE.md \
     ./mcp-ui/template-recommendations/
COPY mcp-ui/template-recommendations/assets/ ./mcp-ui/template-recommendations/assets/
COPY mcp-ui/template-recommendations/project-previews/ ./mcp-ui/template-recommendations/project-previews/
# Curated 4-template onboarding metadata (~320 KB total) required by
# `loadTemplatePresentation()` and `/api/onboarding/*` while keeping the ~87 MB
# full catalog excluded from the lean `api` image.
COPY library/templates/catalog/motion-664184d9-593e-4984-b473-701248b69cfe/template.json \
     library/templates/catalog/motion-664184d9-593e-4984-b473-701248b69cfe/TEMPLATE.md \
     ./library/templates/catalog/motion-664184d9-593e-4984-b473-701248b69cfe/
COPY library/templates/catalog/motion-664184d9-593e-4984-b473-701248b69cfe/source/motion.md \
     library/templates/catalog/motion-664184d9-593e-4984-b473-701248b69cfe/source/preview.html \
     library/templates/catalog/motion-664184d9-593e-4984-b473-701248b69cfe/source/manifest.json \
     ./library/templates/catalog/motion-664184d9-593e-4984-b473-701248b69cfe/source/
COPY library/templates/catalog/motion-f6f244d1-c549-4081-8a5d-f0e1e3660044/template.json \
     library/templates/catalog/motion-f6f244d1-c549-4081-8a5d-f0e1e3660044/TEMPLATE.md \
     ./library/templates/catalog/motion-f6f244d1-c549-4081-8a5d-f0e1e3660044/
COPY library/templates/catalog/motion-f6f244d1-c549-4081-8a5d-f0e1e3660044/source/motion.md \
     library/templates/catalog/motion-f6f244d1-c549-4081-8a5d-f0e1e3660044/source/preview.html \
     library/templates/catalog/motion-f6f244d1-c549-4081-8a5d-f0e1e3660044/source/manifest.json \
     ./library/templates/catalog/motion-f6f244d1-c549-4081-8a5d-f0e1e3660044/source/
COPY library/templates/catalog/motion-0ad92fd0-b2fb-4885-957c-b71152df15fd/template.json \
     library/templates/catalog/motion-0ad92fd0-b2fb-4885-957c-b71152df15fd/TEMPLATE.md \
     ./library/templates/catalog/motion-0ad92fd0-b2fb-4885-957c-b71152df15fd/
COPY library/templates/catalog/motion-0ad92fd0-b2fb-4885-957c-b71152df15fd/source/motion.md \
     library/templates/catalog/motion-0ad92fd0-b2fb-4885-957c-b71152df15fd/source/preview.html \
     library/templates/catalog/motion-0ad92fd0-b2fb-4885-957c-b71152df15fd/source/manifest.json \
     ./library/templates/catalog/motion-0ad92fd0-b2fb-4885-957c-b71152df15fd/source/
COPY library/templates/catalog/motion-a28f0e5d-aa8b-45a7-87f9-9afcac65a09b/template.json \
     library/templates/catalog/motion-a28f0e5d-aa8b-45a7-87f9-9afcac65a09b/TEMPLATE.md \
     ./library/templates/catalog/motion-a28f0e5d-aa8b-45a7-87f9-9afcac65a09b/
COPY library/templates/catalog/motion-a28f0e5d-aa8b-45a7-87f9-9afcac65a09b/source/motion.md \
     library/templates/catalog/motion-a28f0e5d-aa8b-45a7-87f9-9afcac65a09b/source/preview.html \
     library/templates/catalog/motion-a28f0e5d-aa8b-45a7-87f9-9afcac65a09b/source/manifest.json \
     ./library/templates/catalog/motion-a28f0e5d-aa8b-45a7-87f9-9afcac65a09b/source/
COPY scripts/verify-export.ts scripts/init-s3.ts scripts/lint-project.mjs scripts/zip.mjs ./scripts/
COPY hyperframes.ts server.ts template-library.ts LICENSE ./

# Built frontend (strictly stripped of `.map` files), MCP Apps card bundle, and compiled tracking/observability artifacts.
COPY --from=deps-build /app/studio-prod-build ./studio/build
COPY --from=deps-build /app/web/inline-video.html ./web/inline-video.html
COPY --from=deps-build /app/mcp-ui/template-recommendations/build ./mcp-ui/template-recommendations/build
COPY --from=deps-build /app/tracking/dist ./tracking/dist
COPY --from=deps-build /app/packages/observability/dist ./packages/observability/dist

# -----------------------------------------------------------------------------
# Target 1: api — stateless, diskless HTTP/SSE/MCP server (NO Chromium/FFmpeg)
# -----------------------------------------------------------------------------
FROM prod-base AS api
COPY --chown=node:node template-library/ ./template-library/
COPY --from=fonts-catalog --chown=node:node /app/fonts /app/fonts

ENV NODE_ENV=production \
    WORKER_ROLE=api \
    PORT=4173 \
    BIND_HOST=0.0.0.0 \
    HOME=/tmp \
    TMPDIR=/tmp

USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'4173')+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "--experimental-strip-types", "src/entrypoints/api.ts"]

# -----------------------------------------------------------------------------
# Target 2: worker-media — media ingest, probing, thumbnails, generation, GC
# Node + FFmpeg/ffprobe ONLY (NO Chromium)
# -----------------------------------------------------------------------------
FROM prod-base AS worker-media
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    WORKER_ROLE=media \
    MEDIA_CONCURRENCY=20 \
    HYPERFRAMES_FFMPEG_PATH=/usr/bin/ffmpeg \
    HYPERFRAMES_FFPROBE_PATH=/usr/bin/ffprobe \
    HOME=/tmp \
    TMPDIR=/tmp

USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "--experimental-strip-types", "src/entrypoints/worker.ts"]

# -----------------------------------------------------------------------------
# Target 3: worker-render — isolated headless Chromium + FFmpeg export pool
# -----------------------------------------------------------------------------
FROM prod-base AS worker-render
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    fontconfig \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

COPY --from=fonts-catalog --chown=node:node /app/fonts /app/fonts
RUN printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n  <dir>/app/fonts</dir>\n</fontconfig>\n' \
      > /etc/fonts/conf.d/99-openmotion-fonts.conf \
  && fc-cache -f

ENV NODE_ENV=production \
    WORKER_ROLE=render \
    RENDER_CONCURRENCY=1 \
    HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium \
    HYPERFRAMES_FFMPEG_PATH=/usr/bin/ffmpeg \
    HYPERFRAMES_FFPROBE_PATH=/usr/bin/ffprobe \
    HYPERFRAMES_FONT_CACHE_DIR=/tmp/hf-font-cache \
    HOME=/tmp \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config

USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "--experimental-strip-types", "src/entrypoints/worker.ts"]

# -----------------------------------------------------------------------------
# Target 4: catalog-sync — one-shot Job image syncing built-in & repository
# template catalogs into S3 CAS (catalog/blobs/{sha256}) and PostgreSQL
# -----------------------------------------------------------------------------
FROM prod-base AS catalog-sync
COPY --chown=node:node template-library/ ./template-library/
COPY --chown=node:node library/templates/catalog/ ./library/templates/catalog/
COPY --chown=node:node scripts/sync-catalog-cas.ts ./scripts/sync-catalog-cas.ts

ENV NODE_ENV=production \
    HOME=/tmp \
    TMPDIR=/tmp

USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "--experimental-strip-types", "scripts/sync-catalog-cas.ts"]

# -----------------------------------------------------------------------------
# Target 5: studio-sourcemaps — scratch export stage for CI Sentry uploads.
# Build alongside `api` with `--build-arg STUDIO_SOURCEMAP=hidden` and export via
# `--target studio-sourcemaps --output type=local,dest=./dist/studio-sourcemaps`.
# -----------------------------------------------------------------------------
FROM scratch AS studio-sourcemaps
COPY --from=deps-build /app/studio-sourcemaps/ /
