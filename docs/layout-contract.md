# Desktop & Responsive Layout Contract

This document defines the architectural layout invariants shared by OpenMotion Studio and the Electron desktop shell (`desktop/`). The automated guard [scripts/check-layout.ts](../scripts/check-layout.ts) enforces these rules during `npm run check` and CI.

## 1. Single source of truth for desktop safe-area geometry

Default safe-area CSS custom properties are declared once in [packages/design-system/base.css](../packages/design-system/base.css):

- `--om-desktop-inset-left`: left clearance inside `.om-app-header` for OS-overlaid controls (macOS traffic lights; `0px` on web, fullscreen, Windows, and Linux).
- `--om-desktop-inset-right`: right clearance inside `.om-app-header` for OS-overlaid controls (Windows `titleBarOverlay`; `0px` on web, fullscreen, macOS, and Linux).
  - **No double inset on Linux:** When `customWindowControls: true`, Studio renders `.om-desktop-window-controls` in-flow inside `.om-app-header`, so `insetRight` MUST remain `0`.
- `--om-desktop-titlebar-height`: effective header height (`46px` at 100% zoom; scaled up when zoomed out so OS DIP controls never spill below the header).
- `--om-desktop-safe-top`: vertical top clearance (`0px` on web, fullscreen, or native frame; `titleBarHeight` whenever OS overlay controls or custom frameless window controls occupy the top strip).
- `--om-workspace-top`: live offset from viewport top to `.motion-workspace` (tracks `.om-app-header` plus any stacked banners such as promo or auth-recovery notices).

Both [studio/src/utils/platformHost.ts](../studio/src/utils/platformHost.ts) and the shell-injected fallback CSS in [desktop/src/platform.ts](../desktop/src/platform.ts) keep these variables synchronized on navigation, fullscreen transitions, and page zoom changes (`Cmd/Ctrl +`, `-`, `0`, or pinch zoom).

## 2. Flex-column application shell (no fixed row counts)

`.om-application` MUST use `display: flex; flex-direction: column` (never `grid-template-rows` with a hardcoded row count).

- `.om-app-header` stays fixed-height (`flex: 0 0 var(--om-desktop-titlebar-height, 46px)`).
- Any optional top banner (`BlackFridayTopBanner`, `AuthRecoveryNotice`, future status bars) stacks automatically (`flex: 0 0 auto`).
- In desktop windowed mode (`[data-desktop="true"][data-desktop-fullscreen="false"]`), `.om-app-header` is pinned at `order: 0`, banners stack below it at `order: 1`, and `.motion-workspace` fills the remaining space (`flex: 1 1 0; min-height: 0; order: 2`).

## 3. Fixed viewport overlays and dialogs

Every `position: fixed` surface anchored to the top or vertical center of the viewport MUST respect `--om-desktop-safe-top` (or `--om-workspace-top`) and use `dvh` instead of raw `vh`:

- **Full-viewport overlays & side drawers** (e.g., `.om-gallery-surface`, `.om-media-detail-surface`, `.om-design-tpl-detail-popup`, `.om-game-project`, `.om-gen-lightbox`, `.motion-sidebar-drawer`):
  ```css
  inset: var(--om-desktop-safe-top, 0px) 0 0 0;
  height: calc(100dvh - var(--om-desktop-safe-top, 0px));
  ```
- **Centered modals & dialogs** (e.g., `.om-settings-dialog`, `.om-design-dialog-popup`, `.om-scenario-preview-dialog`):
  ```css
  top: calc(50% + var(--om-desktop-safe-top, 0px) / 2);
  max-height: calc(100dvh - var(--om-desktop-safe-top, 0px) - 32px);
  ```
- **Workspace-scoped drawers** (e.g., `.om-scenario-pool--drawer`): anchor at `top: var(--om-workspace-top, var(--motion-topbar))`.

## 4. Narrow & short window baseline (`480 × 480`)

The desktop main window enforces `minWidth: 480`, `minHeight: 480`:

- Never target a container element directly inside its own `@container` query (e.g., `.om-app-header` must use `@media` for self-styles and `@container` only for descendants).
- Scrolling surfaces with decorative wide elements (such as fanned showcase cards) must clip horizontal overflow (`overflow-x: hidden`).
- Self-contained local pages (`desktop/src/retry.html`) must use `margin: auto` inside a `min-height: 100dvh` flex column rather than `height: 100%; justify-content: center`, so tall error content scrolls cleanly without clipping the top.
- Multi-display window restoration ([desktop/src/window-state.ts](../desktop/src/window-state.ts)) must match the saved coordinates against the target display's `workArea` before clamping dimensions, so windows restored on a larger secondary monitor are not shrunk to a smaller primary laptop display.
