/**
 * The `nim wiki serve` browser app.
 *
 * Built against the prebuilt `@nimbalyst/collab-bundle` entries, the same
 * artifact the web console loads, rather than against runtime source. That
 * bundle leaves React, Lexical, Yjs and RevoGrid to the host, so this build
 * supplies exactly one copy of each (`dedupe`). Its heavy renderers (mermaid
 * and its diagram engines, katex, the prettier parsers) are already dynamic
 * imports there and stay separate chunks here, fetched only when a page needs
 * them. No sign-in or analytics are imported.
 *
 * Extension editors (drawing, mind map, spreadsheet, calc sheet, data model,
 * mockup) are pinned through `@nimbalyst/web-editors`, as in the web console:
 * each is its own lazy entry at `/extensions/<slug>/<version>/index.js`,
 * fetched the first time a page of its type opens. `scripts/build.mjs` builds
 * them in production mode first; their `@nimbalyst/runtime` imports resolve to
 * the browser bridge (`src/editors/wikiRuntimeBridge.tsx`).
 *
 * Tailwind runs here: the bundle's components are authored against Tailwind
 * utilities plus `--nim-*` tokens, and the bundle's own CSS carries neither.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig, parseAst } from 'vite';
import { PINNED_EXTENSIONS } from '@nimbalyst/web-editors/pinned';
import {
  pinnedExtensionBuildInputs,
  pinnedExtensionBundleEntries,
  pinnedExtensionDefines,
  pinnedExtensionEntryFileNames,
  resolvePinnedExtensionBundle,
  webEditorsSourceDir,
} from '@nimbalyst/web-editors/vite';
import { WIKI_EDITOR_SLUGS } from './scripts/wikiEditorPins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = path.resolve(here, '../runtime/src');
const collabBundleDist = path.resolve(here, '../collab-bundle/dist');
const wikiRuntimeBridge = path.join(here, 'src/editors/wikiRuntimeBridge.tsx');
const resolvePath = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

const hostSingletons = [
  'react',
  'react-dom',
  'lexical',
  '@lexical/code',
  '@lexical/code-core',
  '@lexical/code-prism',
  '@lexical/extension',
  '@lexical/hashtag',
  '@lexical/headless',
  '@lexical/history',
  '@lexical/html',
  '@lexical/link',
  '@lexical/list',
  '@lexical/mark',
  '@lexical/markdown',
  '@lexical/overflow',
  '@lexical/react',
  '@lexical/rich-text',
  '@lexical/selection',
  '@lexical/table',
  '@lexical/utils',
  '@lexical/yjs',
  '@revolist/react-datagrid',
  '@revolist/revogrid',
  'y-protocols',
  'yjs',
];

/**
 * The bundle's chunks that carry first-party markup. `chunks/` also holds the
 * vendor payloads (mermaid, katex, parsers), which contribute no classes and
 * would only slow the scan; `bundle-report.json` maps chunks to source modules.
 */
function collabBundleContent(): string[] {
  let report: { chunks: Array<{ fileName: string; modules: Array<string | null> }> };
  try {
    report = JSON.parse(readFileSync(path.join(collabBundleDist, 'bundle-report.json'), 'utf8'));
  } catch {
    throw new Error(`No ${collabBundleDist}/bundle-report.json. Build @nimbalyst/collab-bundle first: pnpm --filter @nimbalyst/collab-bundle run build`);
  }
  const files = report.chunks
    .filter((chunk) => chunk.modules.some((id) => id?.startsWith('/packages/runtime/src/')
      || id?.startsWith('/packages/collab-client/src/')
      || id?.startsWith('/packages/collab-bundle/src/')))
    .map((chunk) => path.join(collabBundleDist, chunk.fileName));
  if (files.length === 0) throw new Error(`No first-party chunks in ${collabBundleDist}/bundle-report.json`);
  return files;
}

const tailwindConfig = {
  // Touch devices keep `:hover` on the last tapped row; see the web console's config.
  future: { hoverOnlyWhenSupported: true },
  content: [path.join(here, 'index.html'), path.join(here, 'src/**/*.{ts,tsx}'), ...collabBundleContent()],
  darkMode: ['variant', '&:is(.dark-theme *, [data-theme="dark"] *)'] as ['variant', string],
  theme: {
    extend: {
      colors: {
        nim: {
          DEFAULT: 'var(--nim-bg)',
          secondary: 'var(--nim-bg-secondary)',
          tertiary: 'var(--nim-bg-tertiary)',
          hover: 'var(--nim-bg-hover)',
          selected: 'var(--nim-bg-selected)',
          active: 'var(--nim-bg-active)',
        },
        'nim-text': {
          DEFAULT: 'var(--nim-text)',
          muted: 'var(--nim-text-muted)',
          faint: 'var(--nim-text-faint)',
          disabled: 'var(--nim-text-disabled)',
        },
        'nim-border': { DEFAULT: 'var(--nim-border)', focus: 'var(--nim-border-focus)' },
        'nim-primary': { DEFAULT: 'var(--nim-primary)', hover: 'var(--nim-primary-hover)' },
        'nim-on-primary': 'var(--nim-on-primary)',
        'nim-link': { DEFAULT: 'var(--nim-link)', hover: 'var(--nim-link-hover)' },
        'nim-success': 'var(--nim-success)',
        'nim-warning': 'var(--nim-warning)',
        'nim-error': 'var(--nim-error)',
        'nim-info': 'var(--nim-info)',
      },
      backgroundColor: {
        nim: 'var(--nim-bg)',
        'nim-secondary': 'var(--nim-bg-secondary)',
        'nim-tertiary': 'var(--nim-bg-tertiary)',
        'nim-hover': 'var(--nim-bg-hover)',
        'nim-selected': 'var(--nim-bg-selected)',
        'nim-active': 'var(--nim-bg-active)',
        'nim-primary': 'var(--nim-primary)',
        'nim-primary-hover': 'var(--nim-primary-hover)',
      },
      textColor: {
        nim: 'var(--nim-text)',
        'nim-muted': 'var(--nim-text-muted)',
        'nim-faint': 'var(--nim-text-faint)',
        'nim-disabled': 'var(--nim-text-disabled)',
        'nim-link': 'var(--nim-link)',
        'nim-link-hover': 'var(--nim-link-hover)',
        'nim-primary': 'var(--nim-primary)',
        'nim-on-primary': 'var(--nim-on-primary)',
        'nim-success': 'var(--nim-success)',
        'nim-warning': 'var(--nim-warning)',
        'nim-error': 'var(--nim-error)',
        'nim-info': 'var(--nim-info)',
      },
      borderColor: {
        nim: 'var(--nim-border)',
        'nim-focus': 'var(--nim-border-focus)',
        'nim-primary': 'var(--nim-primary)',
      },
    },
  },
};

export default defineConfig(({ command, mode }) => {
  const editorBundles = PINNED_EXTENSIONS
    .filter((pin) => WIKI_EDITOR_SLUGS.includes(pin.slug))
    .map((pin) => resolvePinnedExtensionBundle({ command, mode, pin, resolveFrom: here, label: 'wiki-web' }));
  return {
  root: here,
  base: '/',
  plugins: [react(), pinnedExtensionBundleEntries(editorBundles, { parseAst })],
  define: pinnedExtensionDefines(editorBundles),
  // JS chunks (including lazy preloads) and CSS resolve assets relative to
  // themselves. The exporter rebases the HTML entry URLs for its mount path.
  experimental: { renderBuiltUrl: (_filename, { hostType }) => ({ relative: hostType !== 'html' }) },
  resolve: {
    dedupe: hostSingletons,
    alias: [
      // Theme palettes, the Monaco editor for calc sheets, and what the runtime bridge re-exports.
      { find: /^@nimbalyst\/runtime-source\//, replacement: `${runtimeSource}/` },
      // Extension bundles externalize these; resolve them to the host's one copy.
      { find: /^@revolist\/react-datagrid$/, replacement: resolvePath('@revolist/react-datagrid') },
      { find: /^@revolist\/revogrid$/, replacement: resolvePath('@revolist/revogrid') },
      // The collab bundle owns a compiled copy of the comment UI; a second copy would split its registries.
      { find: '@nimbalyst/runtime/editor/commenting/ui', replacement: resolvePath('@nimbalyst/collab-bundle/commenting-ui') },
      { find: /^@nimbalyst\/runtime$/, replacement: wikiRuntimeBridge },
      // Monaco without its language workers; see monacoCore.ts.
      { find: /^monaco-editor$/, replacement: path.join(here, 'src/editors/monacoCore.ts') },
    ],
  },
  server: { fs: { allow: [here, runtimeSource, webEditorsSourceDir, collabBundleDist, ...editorBundles.map((bundle) => path.dirname(bundle.entryPath))] } },
  // RevoGrid self-registers <revo-grid>; pre-bundling can split it across two
  // module ids and render the grid blank (dev server only).
  optimizeDeps: { exclude: ['@revolist/react-datagrid', '@revolist/revogrid', '@nimbalyst/collab-bundle'] },
  css: { postcss: { plugins: [tailwindcss(tailwindConfig), autoprefixer()] } },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    // The editor chunk is large by nature; the size budget lives in scripts/check-size.mjs.
    chunkSizeWarningLimit: 4000,
    // Merged with the editors' own dependencies into THIRD_PARTY_LICENSES.md by scripts/build.mjs.
    license: true,
    rollupOptions: {
      // Each pinned editor entry is `export * from <bundle>`; with the default
      // (`false`) its re-exports are tree-shaken away. See the web console's config.
      preserveEntrySignatures: 'exports-only',
      input: {
        app: path.join(here, 'index.html'),
        ...pinnedExtensionBuildInputs(editorBundles),
      },
      output: { entryFileNames: pinnedExtensionEntryFileNames(editorBundles) },
    },
  },
  };
});
