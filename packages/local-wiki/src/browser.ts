/**
 * The parts of the library a browser can load: no `node:fs`. The browser app
 * (`@nimbalyst/wiki-web`) imports this, never the package root.
 */
export { searchDocs, type SearchDoc } from './search.js';
export { STATIC_SITE_FORMAT, STATIC_SITE_DATA_DIR, NIMBALYST_MARK_SVG, NIMBALYST_SITE_URL } from './staticSite.js';
export type { StaticSiteManifest, StaticSiteLink, StaticSiteConfig } from './staticSite.js';
