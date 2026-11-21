# Studio Routing and Lazy-Loading Architecture

This guide defines how OpenMotion Studio organizes workspace pages, code splitting, and shell dependency boundaries. Follow these rules whenever adding, moving, or modifying a Studio page.

## Directory ownership

All workspace route registration and lazy surface wiring live under `studio/src/router/`:

- `studio/src/router/lazyPages.ts` — Single source of truth for lazy-loaded workspace page and overlay components (`lazyWithChunkReload`) and `LAZY_PAGE_MODULE_PATHS`.
- `studio/src/router/routeRegistry.ts` — Declarative route table (`workspaceRouteRegistry`) defining route IDs, match precedence, `keepAlive` policy, standalone flags, tracking page names, and arrival tracking helpers.
- `studio/src/router/RouteViewport.tsx` — Renders the active workspace surface and KeepAlive slots inside `SettingsSurfaceBoundary` + `Suspense`.
- `studio/src/router/OverlayLayer.tsx` — Renders cross-cutting overlays (template library dialog and standalone card preview) without coupling them into `WorkspaceFrame.tsx`.

`studio/src/motion/WorkspaceFrame.tsx` is strictly the **App Shell** (header, project sidebar, chrome context, toasts, and keyboard shortcuts). Never import feature pages statically into `WorkspaceFrame.tsx` or `studio/src/main.tsx`.

## Rules for adding or modifying a page

1. **Register lazily via `lazyWithChunkReload`.** Add every new workspace page to `studio/src/router/lazyPages.ts` (including `LAZY_PAGE_MODULE_PATHS`) and mount it through `RouteViewport.tsx` (or `OverlayLayer.tsx` for cross-page overlays). Do not statically import page modules from `WorkspaceFrame.tsx`, `ApplicationChrome.tsx`, or `WorkspaceBreadcrumb.tsx`.
2. **Extract lightweight metadata before sharing across shell and pages.** If the shell (breadcrumbs, header menus, search) needs labels or constants from a lazy page, place those pure constants in a tiny metadata module (for example `studio/src/motion/settingsMeta.ts`) instead of importing the page component file.
3. **Keep the shell free of heavy editor parsers.** Never import `@hyperframes/parsers` (barrel entry), `studio/src/utils/sourcePatcher.ts`, or `studio/src/utils/studioHelpers.ts` from shell-reachable modules. `studio/src/shellBoundary.test.ts` enforces this boundary in CI.
4. **KeepAlive allowlist.** Only `editor`, `explore`, and `assets` stay mounted once visited (`hidden` + `aria-hidden` + `inert`). All other studios unmount when navigated away; preserve user drafts in lightweight in-memory maps (such as `studioDrafts`) rather than expanding KeepAlive without a clear UX requirement.
5. **Reserved backend and cloud prefixes.** When introducing or migrating path-based routes, never claim backend or cloud protocol prefixes:
   - `/api`, `/motion-api`, `/design-api`
   - `/mcp` (reserved for cloud Streamable HTTP MCP endpoint; use `/mcp-setup` for frontend MCP pages)
   - `/mcp-ui`, `/connect`, `/sessions`
   - `/editor-assets`, `/guide-assets`, `/design-system`, `/web`
   - `/.well-known`, `/__hyperframes_config`
6. **Root-relative asset paths.** `studio/vite.config.ts` pins `base: '/'`. Keep all HTML, CSS, font, and fetch URLs root-relative (`/...`) rather than relative (`./...`) so nested path routes resolve assets identically.

## Verification checklist

When touching Studio routes or shell imports:

- Run `npm run check`, `npm run typecheck:studio`, `npm run test:studio`, and `npm run build:studio`.
- Confirm `studio/src/shellBoundary.test.ts` passes without weakening any boundary assertions.
- Inspect `studio/build/editor-assets/` to verify the new page emits its own async chunk rather than expanding `index-*.js`.
