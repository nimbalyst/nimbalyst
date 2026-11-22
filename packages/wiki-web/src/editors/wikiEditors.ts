/**
 * The extension editors built into the browser view, and which page each one
 * opens. Manifests are inlined at build time; a bundle is imported the first
 * time a page of its type opens (`loadBrowserExtension`).
 */
import { listBrowserExtensions, registerBrowserExtension, type BrowserExtensionManifest } from '@nimbalyst/web-editors/registry';
import { PINNED_EXTENSION_MANIFESTS, PINNED_EXTENSION_SLUGS, loadPinnedExtensionBundle } from '@nimbalyst/web-editors/bundles';
import { registerEmbeddableExtension } from '@nimbalyst/collab-bundle/editor';
import { embeddableSuffixes, matchEditor, type WikiEditorMatch } from './editorPageTypes';
import { HTML_PAGE_MANIFEST } from './html/htmlPages';
import { staticBasePath } from '../api/staticSite';

export { editorPageDescriptors, type WikiEditorMatch } from './editorPageTypes';

/**
 * Project canvas is not a pinned extension: it ships in the collab bundle, as
 * in the web console (`builtinCanvasExtension.ts` there, same id and component).
 */
export const CANVAS_MANIFEST: BrowserExtensionManifest = {
  id: 'builtin.canvas',
  name: 'Project Canvas',
  contributions: {
    customEditors: [{ filePatterns: ['*.canvas'], displayName: 'Project Canvas', component: 'ProjectCanvasEditor' }],
    newFileMenu: [{ extension: '.canvas', displayName: 'Project Canvas', icon: 'dashboard', defaultContent: '{\n  "nodes": [],\n  "edges": []\n}\n' }],
    fileIcons: { '*.canvas': 'dashboard' },
  },
  marketplace: { icon: 'dashboard' },
};

let registered = false;

/** Declares every built-in editor. Idempotent; imports no bundle. */
export function registerWikiEditors(): void {
  if (registered) return;
  registered = true;
  registerBrowserExtension({ manifest: CANVAS_MANIFEST, load: () => import('./canvas/wikiCanvasBundle') });
  registerBrowserExtension({ manifest: HTML_PAGE_MANIFEST, load: () => import('./html/wikiHtmlBundle') });
  for (const slug of PINNED_EXTENSION_SLUGS) {
    registerBrowserExtension({ manifest: PINNED_EXTENSION_MANIFESTS[slug], load: () => loadPinnedExtensionBundle(slug, staticBasePath) });
  }
  // As on desktop, every file an editor here opens can be embedded in a page.
  for (const suffix of embeddableSuffixes(listBrowserExtensions().map((entry) => entry.manifest))) registerEmbeddableExtension(suffix);
}

export function builtInManifests(): BrowserExtensionManifest[] {
  registerWikiEditors();
  return listBrowserExtensions().map((entry) => entry.manifest);
}

export function editorForFile(fileName: string): WikiEditorMatch | null {
  return matchEditor(builtInManifests(), fileName);
}
