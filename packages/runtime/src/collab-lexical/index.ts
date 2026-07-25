/**
 * Lexical-coupled collaboration entry point.
 *
 * These three modules are the only parts of the sync layer that reach into the
 * Lexical editor graph -- `@lexical/*`, `runtime/src/editor`, the decorator
 * nodes, and transitively `react-dom` and `prismjs`.
 *
 * They live behind their own subpath rather than in the `@nimbalyst/runtime/sync`
 * barrel because the Electron main process imports that barrel for the sync
 * plumbing it genuinely owns (providers, tracker sync, key management). The
 * runtime package is not marked side-effect-free, so re-exporting these from
 * the barrel pulled the entire editor graph into the main bundle even with no
 * main-process importer left. Rollup then WATCHED all of it, so editing any UI
 * file rebuilt main and electron-vite restarted the app -- reloading every open
 * workspace window.
 *
 * Import this only from a codec host (renderer, web console, mobile WKWebView).
 * If main-process code ever needs one of these, that is the signal that the
 * work belongs on a codec host instead -- see
 * `nimbalyst-local/plans/collab-conversion-off-main.md` and
 * `scripts/check-main-bundle-graph.mjs`.
 */
export { CollabLexicalProvider } from '../sync/CollabLexicalProvider';
export { HeadlessLexicalYDoc } from '../sync/HeadlessLexicalYDoc';
export type { HeadlessLexicalYDocOptions } from '../sync/HeadlessLexicalYDoc';
export { MarkdownCollabContentAdapter } from '../sync/MarkdownCollabContentAdapter';
