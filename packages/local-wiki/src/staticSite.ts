/**
 * The static website format: what `nim wiki export --static` writes and what
 * the browser app reads in place of the `nim wiki serve` API.
 *
 *   index.html, <path>/index.html   one per page, prerendered, booting the app
 *   assets/, extensions/            the browser app's own build
 *   _wiki/manifest.json             StaticSiteManifest
 *   _wiki/info.json                 what GET /api/info returns, with no paths
 *   _wiki/snapshot.json             wiki.snapshot(), exported pages only
 *   _wiki/types.json                GET /api/types
 *   _wiki/trackers/<type>.json      wiki.trackerSnapshot(type)
 *   _wiki/bodies/<id>.json          wiki.readBody(id)
 *   _wiki/search.json               SearchDoc[] for searchDocs()
 *   _wiki/links.json                id -> StaticSiteLink[], both directions
 *   _wiki/files/<wiki path>         files pages link to
 */

/** Bumped when a file above changes incompatibly. */
export const STATIC_SITE_FORMAT = 1;

/** Site-relative folder of the data files; a page path never starts with it. */
export const STATIC_SITE_DATA_DIR = '_wiki';

export interface StaticSiteManifest {
  format: number;
  generatedAt: string;
  title: string;
  nimVersion: string;
  /** The page `/` shows. */
  homeId: string | null;
  /** Page or typed page id to its site path, without slashes at either end (`competitors/acme`). */
  pages: Record<string, string>;
  /** Type id to its site path. */
  types: Record<string, string>;
}

/** Structural twin of `TrackerPageLink` from the runtime, which this package must not import. */
export interface StaticSiteLink {
  direction: 'out' | 'in';
  predicateId: string | null;
  relationshipTypeKey: string | null;
  otherItemId: string;
  otherTitle: string;
  otherIssueKey: string | null;
  /** The other page's type, or `page` for a plain page. */
  otherTypeId: string;
  sentence: string | null;
  sourceFieldId: string;
}

/** Set on `window.__NIMBALYST_WIKI_STATIC__` by every exported page before the app loads. */
export interface StaticSiteConfig {
  format: number;
  /** URL mount path with leading/trailing slashes; absent in older root exports. */
  basePath?: string;
  /** Site path of the data folder, with slashes (`/_wiki/`). */
  dataPath: string;
}

/** Where an exported site's "Made with Nimbalyst" mark links. */
export const NIMBALYST_SITE_URL = 'https://nimbalyst.com';

/** The Nimbalyst mark, as the Share Link pages draw it; the exported app and its prerendered pages both show it. */
export const NIMBALYST_MARK_SVG = `<svg class="nimbalyst-mark" width="16" height="16" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="m196.4 23.3c-.5 8.3-12.4 6.9-14.8 14.9-1.8 6.1 9.8 9.9 6 15-4.9 6.7-14.2-.9-20.5 4.6-4.8 4.2 2.9 13.6-3.1 15.9-7.8 2.9-11.5-8.4-19.7-7.2-6.3.9-4.9 13-11.2 11.7-8.1-1.7-5.1-13.3-12.7-16.7-5.8-2.7-11.2 8.3-15.7 3.8C99 59.3 107.7 51.2 103.2 44.3 99.8 38.9 89.3 45.2 87.9 39 86.1 30.8 97.9 28.8 97.9 20.5 97.9 14.1 85.7 13.8 87.9 7.8 90.8 0 101.8 4.6 106.3-2.4c3.5-5.4-6.6-12.2-1.5-16.1 6.6-5 13.4 4.9 20.9 1.4 5.8-2.7 1-13.9 7.4-14.4 8.3-.6 8.6 11.3 16.9 12.5 6.3.9 8.4-11.1 14-8.1 7.3 3.9 1.1 14.2 7.4 19.6 4.8 4.2 13.1-4.8 16.2.8 4 7.3-6.7 12.6-4.4 20.5 1.8 6.1 13.6 3 13.2 9.4z" fill="#6395ff" transform="matrix(7.6 0 0 7.6-560 327)"/><text x="306" y="669" font-family="system-ui,sans-serif" font-size="528" font-weight="bold" fill="#fff">#</text></svg>`;
