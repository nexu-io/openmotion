import { readLocale } from './i18n/localePreference';
import { importLocaleChunk } from './i18n/importLocaleChunk';
import { bindVitePreloadErrorReload, warmModule } from './utils/chunkLoadRecovery';
import { isInitialExplore } from './router/initialExplore';
import { loadExplorePage } from './router/pageImports';

const unbindPreloadErrorReload = bindVitePreloadErrorReload();
import.meta.hot?.dispose(unbindPreloadErrorReload);

// Discover the shell, selected dictionary and confirmed landing route together.
// Mount still waits for localization; the page uses its normal Suspense boundary.
void import('./main');
const locale = readLocale();
if (locale !== 'en') void importLocaleChunk(locale).catch(() => {});
if (isInitialExplore(location)) void warmModule(loadExplorePage);
