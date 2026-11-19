# Studio component library

Preview a control and follow its production example before changing or adding UI. Start Vite from the repository root after installing dependencies:

```sh
npm exec vite -- --config studio/vite.config.ts --host 127.0.0.1
```

Open `/component-library.html` on the local URL Vite prints. Use the [design system](design-system.md) to change shared tokens or visual rules.

| Preview | Use | Production reference |
| --- | --- | --- |
| `#button` | Use a native `<button type="button" className="om-button">` for an ordinary action. Add `data-primary` for a primary action or use `type="submit"` to submit a form. | [Shared CSS](../packages/design-system/studio/application.css) and [asset actions](../studio/src/motion/AssetsPage.tsx) |
| `#search` | Use `SearchField` for application search. It owns markup, clearing and focus return. The page owns query timing, shortcuts and input composition where applicable. | [SearchField](../studio/src/components/ui/SearchField.tsx), [template library](../studio/src/motion/TemplateLibraryDialog.tsx) and [asset toolbar](../studio/src/motion/AssetGalleryToolbar.tsx) |
| `#switch` | Use the application settings `Toggle` for an immediate on/off preference. Give it an accessible name and let the feature own persistence. | [Toggle](../studio/src/motion/settingsPrimitives.tsx), [model settings](../studio/src/motion/ModelSettings.tsx) and [privacy settings](../studio/src/motion/PrivacySettings.tsx) |

## Update a shared control

1. Review two production uses. Reuse shared CSS with a native element when it covers the control. Reuse or extract a React control when multiple pages need to maintain its structure or behavior together.
2. Change the shared source. When the recommended usage or a demonstrated state changes, update the relevant preview and guide in the same PR. Add a new example when it documents a shared pattern in actual use.
3. Check the preview and two affected product screens in the browser. Verify light and dark themes plus keyboard focus and any affected states. Link the relevant preview and product examples in the PR.
