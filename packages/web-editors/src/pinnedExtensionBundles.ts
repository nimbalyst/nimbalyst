/// <reference path="./globals.d.ts" />
/**
 * Lazy loaders for the build-time-pinned extension bundles. A production build
 * emits each URL as an unreferenced entry, so importing this tiny module never
 * pulls an editor's dependencies into an app's initial payload.
 *
 * The two maps below are the only place a pinned extension is named in app
 * source. They exist because Vite's `define` substitutes bare identifiers, so
 * each slug needs one written-out identifier somewhere; everything else about a
 * pin is derived from its slug in `pinnedExtensions.mjs`. An app that does not
 * build a pin defines both of its identifiers as `null` (`pinnedExtensionDefines`
 * in `vite.mjs`), and the pin is left out of `PINNED_EXTENSION_SLUGS`.
 *
 * Keep one promise per slug for the page lifetime: an extension bundle may
 * register a custom element as a module side effect and must evaluate once.
 */

import type { BrowserExtensionManifest } from './browserExtensionRegistry';

export type PinnedExtensionSlug =
  | 'csv-spreadsheet'
  | 'mockuplm'
  | 'excalidraw'
  | 'datamodellm'
  | 'mindmap'
  | 'namenym'
  | 'calc-sheets';

const PINNED_BUNDLE_URLS: Record<PinnedExtensionSlug, string | null> = {
  'csv-spreadsheet': __PINNED_CSV_SPREADSHEET_EXTENSION_URL__,
  mockuplm: __PINNED_MOCKUPLM_EXTENSION_URL__,
  excalidraw: __PINNED_EXCALIDRAW_EXTENSION_URL__,
  datamodellm: __PINNED_DATAMODELLM_EXTENSION_URL__,
  mindmap: __PINNED_MINDMAP_EXTENSION_URL__,
  namenym: __PINNED_NAMENYM_EXTENSION_URL__,
  'calc-sheets': __PINNED_CALC_SHEETS_EXTENSION_URL__,
};

const ALL_PINNED_EXTENSION_MANIFESTS: Record<PinnedExtensionSlug, BrowserExtensionManifest | null> = {
  'csv-spreadsheet': __PINNED_CSV_SPREADSHEET_EXTENSION_MANIFEST__ as BrowserExtensionManifest | null,
  mockuplm: __PINNED_MOCKUPLM_EXTENSION_MANIFEST__ as BrowserExtensionManifest | null,
  excalidraw: __PINNED_EXCALIDRAW_EXTENSION_MANIFEST__ as BrowserExtensionManifest | null,
  datamodellm: __PINNED_DATAMODELLM_EXTENSION_MANIFEST__ as BrowserExtensionManifest | null,
  mindmap: __PINNED_MINDMAP_EXTENSION_MANIFEST__ as BrowserExtensionManifest | null,
  namenym: __PINNED_NAMENYM_EXTENSION_MANIFEST__ as BrowserExtensionManifest | null,
  'calc-sheets': __PINNED_CALC_SHEETS_EXTENSION_MANIFEST__ as BrowserExtensionManifest | null,
};

/** The pins this app was built with. */
export const PINNED_EXTENSION_SLUGS = (Object.keys(ALL_PINNED_EXTENSION_MANIFESTS) as PinnedExtensionSlug[])
  .filter((slug) => ALL_PINNED_EXTENSION_MANIFESTS[slug] !== null && PINNED_BUNDLE_URLS[slug] !== null);

/** Each built pin's own `manifest.json`, inlined at build time. */
export const PINNED_EXTENSION_MANIFESTS = ALL_PINNED_EXTENSION_MANIFESTS as Record<PinnedExtensionSlug, BrowserExtensionManifest>;

const loadedBundles = new Map<PinnedExtensionSlug, Promise<unknown>>();

export function loadPinnedExtensionBundle(slug: PinnedExtensionSlug, basePath = '/'): Promise<unknown> {
  let bundle = loadedBundles.get(slug);
  if (!bundle) {
    const pinnedUrl = PINNED_BUNDLE_URLS[slug];
    const url = pinnedUrl?.startsWith('/') ? `${basePath}${pinnedUrl.slice(1)}` : pinnedUrl;
    bundle = url ? import(/* @vite-ignore */ url) : Promise.reject(new Error(`The ${slug} editor is not built into this app`));
    loadedBundles.set(slug, bundle);
  }
  return bundle;
}
