import { readLocale } from './i18n/localePreference';
import { importLocaleChunk } from './i18n/importLocaleChunk';
import { bindVitePreloadErrorReload } from './utils/chunkLoadRecovery';

const unbindPreloadErrorReload = bindVitePreloadErrorReload();
import.meta.hot?.dispose(unbindPreloadErrorReload);

// The shell still waits for its selected dictionary before painting localized UI.
// Both downloads can start as soon as the document has been parsed.
void import('./main');
const locale = readLocale();
if (locale !== 'en') void importLocaleChunk(locale).catch(() => {});
