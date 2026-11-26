# OpenMotion Desktop Client Architecture Map & Runbook

Companion reference for [SKILL.md](../SKILL.md).

## 1. Repository module map

### Shared contracts & built-in security bounds (`shared/`)

| File | Responsibility |
| --- | --- |
| `shared/desktop-contract.ts` | Frozen `UniversalHostBridge` interface, `HOST_CAPABILITIES` names/v1 versions, error codes, atom request/result types, and desktop preference types. |
| `shared/desktop-schemas.ts` | Zod v4 validation registry (`validateHostMethodParams`) shared across Electron IPC, Web Connect Script HTTP, and `LocalAtomsRuntime`. Keep out of `studio/src/main.tsx` static import graph. |
| `shared/desktop-builtin-rules.ts` | Hardcoded shell security envelope: default channel URLs, allowed domain scopes (`stable` vs `test`), built-in config field types (`remote_mcp_entry`), built-in publisher allowlist (`BUILTIN_PUBLISHERS` with build-time injected Apple Team ID & Windows Authenticode thumbprints), built-in third-party CLI templates (`codex`, `claude`), `murmur-engine` argv bounds, and typed placeholder validators. |
| `shared/signed-config.ts` | Two-tier signed config envelope/payload types and `validateSignedConfigPayloadBounds` (rejects out-of-scope URLs, sensitive home paths like `.ssh`/`.aws`, unknown publishers, or forbidden `murmur` subcommands). |
| `shared/desktop-auth-handoff.ts` | PKCE S256 + loopback browser sign-in contract shared between cloud API (`/auth/desktop/start`, `/auth/desktop/exchange`) and desktop shell. |
| `shared/connect-script-protocol.ts` | Loopback HTTP + SSE contract (`127.0.0.1:43118`, `/v1/health`, `/v1/info`, `/v1/capabilities`, `/v1/invoke`, `/v1/events`, header `x-openmotion-connect-token`). |
| `shared/platform-host.ts` | Cross-host UI types (`DesktopChromeInsets`, `DesktopUpdateState`, `DesktopMenuAction`, `DesktopDiagnosticExportResult`) and `resolveDesktopChrome`. |
| `shared/desktop-telemetry.ts` | Zero-PII desktop telemetry categories and outcome enums. |
| `shared/engine-command-contract.ts` | Shared `MURMUR_COMPONENT_ID` and engine status/command definitions. |

### Electron thin shell (`desktop/`)

| File | Responsibility |
| --- | --- |
| `desktop/src/main.ts` | Top-level Electron lifecycle, single-instance lock, channel resolution, `BrowserWindow` creation, navigation/crash/unresponsive guards, menu setup, signed-config background refresh, and quit flow. |
| `desktop/src/main-capabilities.ts` | Registers all 12 capability modules (`window`, `updater`, `diagnostics`, `account`, `signedConfig`, `telemetry`, `preferences`, and the 5 `atom.*` capabilities). |
| `desktop/src/main-ipc.ts` | Registers IPC handlers (`HOST_IPC_CHANNELS.*`) with strict sender authorization and forwards updater/auth events to the renderer. |
| `desktop/src/main-env-runtime.ts` | `test`/`dev` environment switcher modal window, floating env badge, isolated session partition swaps, clear-storage/reload, copy diagnostics, and `env=` deep-link confirmation dialog. |
| `desktop/src/main-downloads.ts` | Session `will-download` progress/wake-lock/notification controller and manual update check feedback dialog presenter. |
| `desktop/src/main-boot-overlay.ts` | Embedded `WebContentsView` cold-start splash overlay lifecycle (eliminates jump-resizing splash windows). |
| `desktop/src/preload.ts` | Exposes frozen `__OPENMOTION_HOST__` on allowed top-level Studio frames, `__OPENMOTION_LOCAL_PAGE__` on `splash.html`/`retry.html`, and `__OPENMOTION_ENV_SWITCHER__` on `env-switcher.html`. |
| `desktop/src/capability-registry.ts` | Main-process dispatch registry + builder factories for `window`, `updater`, `diagnostics`, `account`, and `preferences` modules. |
| `desktop/src/ipc-guard.ts` | `authorizePrivilegedIpcSender`, `authorizeSplashSender`, `authorizeEnvSwitcherSender`, and `resolveAllowedStudioOrigins`. |
| `desktop/src/window-policy.ts` | Pure evaluators for `will-navigate`, `will-redirect`, and `setWindowOpenHandler` (popup hardening + external billing redirect). |
| `desktop/src/auth-handoff.ts` | System-browser PKCE S256 login flow with ephemeral loopback server and `session.fetch` cookie exchange. |
| `desktop/src/env-switcher.ts` | URL validation, persistent `dev-env.json` store, `--studio-url` argv extraction, and `persist:om-env-<hash>` partition resolution. |
| `desktop/src/updater.ts` | Channel-aware `electron-updater` generic R2 feed controller (`stable` / `test`), with no GitHub Releases fallback. |
| `desktop/src/protocol.ts` | Safe `openmotion://open` deep-link parser and router (`source`, `path`, `tab`, plus `test`/`dev`-only `env`). |
| `desktop/src/platform.ts` | OS-specific window options, traffic-light safe-area CSS injection, and Windows title-bar overlay styling. |
| `desktop/src/menu.ts`, `desktop/src/context-menu.ts` | Localized (`en` / `zh-CN`) macOS HIG application menu, Dock menu, and native context menu. |
| `desktop/src/prefs.ts`, `desktop/src/window-state.ts`, `desktop/src/data-layout.ts` | Out-of-bundle atomic JSON stores under `<userData>` (`desktop-prefs.json`, `window-state.json`, structured directories). |
| `desktop/src/safe-secret-store.ts`, `desktop/src/logger.ts`, `desktop/src/telemetry.ts`, `desktop/src/sentry.ts`, `desktop/src/ux-controllers.ts` | Electron `safeStorage` secret adapter, redacted rotating logs + diagnostic zip, zero-PII telemetry, zero-dep Sentry envelope reporter, wake lock, task progress, and renderer crash guard. |
| `desktop/scripts/build.mjs` | esbuild bundler for `dist/main.mjs` & `dist/preload.cjs`, trust-anchor validation + `define` injection, static HTML/scripts/brand asset copy, and icon generation. |
| `desktop/config/test.payload.json`, `desktop/config/stable.payload.json` | Git-audited source payloads signed and published by `.github/workflows/desktop-signed-config.yml`. |

### Shared host-agnostic packages (`packages/`)

| Package | Responsibility |
| --- | --- |
| `packages/local-atoms/` | Shared implementation of `atom.detect`, `atom.exec`, `atom.installComponent`, `atom.credential`, `atom.config`, `PathResolver`, `SerialMutationQueue`, and `FeatureConfirmationGate`. |
| `packages/signed-config/` | Ed25519 two-tier certificate + envelope verifier, canonical JSON serializer, anti-rollback `SignedConfigManager` store, and bundled channel defaults. |
| `packages/connect-script/` | Local loopback HTTP + SSE server (`server.ts`), interactive CLI (`cli.ts`), and terminal confirmation prompt (`terminal-confirm.ts`) exposing the same `UniversalHostBridge` to browser Studio. |

### Studio consumer side (`studio/src/`)

| File | Responsibility |
| --- | --- |
| `studio/src/utils/platformHost.ts` | Unified bridge client (`getDesktopHostBridge()`, `getActiveHostBridge()`, `useHostCapabilities()`, `hasHostCapability()`, chrome/theme/locale/updater/preferences helpers). |
| `studio/src/utils/localConnectBridge.ts` | Browser loopback adapter implementing `UniversalHostBridge` over `fetch` + SSE with in-memory pairing token. |
| `studio/src/motion/DesktopConnectPanel.tsx` | Local Agent connection UI driven by `atom.detect` / `atom.exec` / `atom.config` and `minShellVersion` gating. |

## 2. Frozen capability inventory (v1.0.0)

- **Shell capabilities:** `window`, `updater`, `diagnostics`, `account`, `signedConfig`, `telemetry`, `preferences`.
- **Atomic local capabilities:** `atom.detect`, `atom.exec`, `atom.installComponent`, `atom.credential`, `atom.config`.

## 3. Environment switching matrix

| Channel | Default Studio URL | Env Switcher enabled? | Allowed origins | Session partition |
| --- | --- | --- | --- | --- |
| `stable` | `https://motion.open-design.ai` | **No** (fail-closed) | `*.open-design.ai` only | Default session |
| `test` | Built-in test channel default (`DEFAULT_STUDIO_URLS.test`) | **Yes** | `*.open-design.ai`, built-in staging domain, optional `OPENMOTION_DESKTOP_ALLOWED_ENV_DOMAINS`, plus `http://127.0.0.1:<port>` / `http://localhost:<port>` | Default for base test; `persist:om-env-<sha256>` for any override |
| `dev` | `http://127.0.0.1:4173` | **Yes** | Same as `test` + loopback | Default for base dev; `persist:om-env-<sha256>` for any override |

## 4. Two-tier Signed Config key & rotation runbook

The offline root private key stays outside Git and outside GitHub Actions. Operational daily/quarterly signing keys are signed by the root key with a bounded validity window and stored in GitHub Actions Secrets.

### Key & certificate commands (`scripts/sign-desktop-config.mjs`)

```bash
# Generate an offline Ed25519 keypair (0600 private key; never printed to stdout)
node --experimental-strip-types scripts/sign-desktop-config.mjs keygen \
  --private-out /secure/path/daily-YYYY-MM-DD.pem \
  --public-out /secure/path/daily-YYYY-MM-DD.pub.pem \
  --spki-out /secure/path/daily-YYYY-MM-DD.spki.txt

# Issue a time-bounded operational signing certificate using the offline root key (e.g. 90 days = 2160h)
node --experimental-strip-types scripts/sign-desktop-config.mjs issue-daily-cert \
  --key-id "daily-YYYY-MM-DD-01" \
  --root-key /secure/path/root.pem \
  --daily-pub /secure/path/daily-YYYY-MM-DD.pub.pem \
  --ttl-hours 2160 \
  --out /secure/path/daily-YYYY-MM-DD-01.cert.json

# Emergency revocation list (signed by the offline root key)
node --experimental-strip-types scripts/sign-desktop-config.mjs sign-revocations \
  --root-key /secure/path/root.pem \
  --revoked "compromised-key-id" \
  --out /secure/path/revocations.json
```

### Required GitHub Actions Variables & Secrets (`nexu-io/openmotion`)

- **Variables:**
  - `OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI` — base64 Ed25519 SPKI root public key baked into desktop builds and used by `verify-config`.
  - `OPENMOTION_MURMUR_APPLE_TEAM_ID` — optional override; `desktop-release.yml` automatically falls back to org secret `APPLE_TEAM_ID`.
  - `OPENMOTION_MURMUR_WIN_THUMBPRINTS` — comma-separated SHA-256/SHA-1 Windows Authenticode signer cert thumbprints once a Windows code-signing certificate is provisioned.
- **Secrets:**
  - `OPENMOTION_DESKTOP_DAILY_PRIVATE_KEY_PEM` — operational Ed25519 private key PEM.
  - `OPENMOTION_DESKTOP_DAILY_CERT_JSON` — root-signed operational certificate JSON.
  - `OPENMOTION_DESKTOP_REVOCATIONS_JSON` — optional root-signed revocation list JSON.
  - `CLOUDFLARE_R2_RELEASES_AK` / `CLOUDFLARE_R2_RELEASES_SK` (with `CLOUDFLARE_R2_RELEASES_*` vars) — R2 release bucket access.
  - `FEISHU_DESKTOP_NOTIFY_WEBHOOK` / `FEISHU_DESKTOP_NOTIFY_SECRET` — Feishu release card notifications.
