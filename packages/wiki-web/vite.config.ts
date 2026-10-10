/**
 * The `nim wiki serve` browser app.
 *
 * Built against the prebuilt `@nimbalyst/collab-bundle` entries, the same
 * artifact the web console loads, rather than against runtime source. That
 * bundle leaves React, Lexical, Yjs and RevoGrid to the host, so this build
 * supplies exactly one copy of each (`dedupe`). Its heavy renderers (mermaid
 * and its diagram engines, katex, the prettier parsers) are already dynamic
 * imports there and stay separate chunks here, fetched only when a page needs
 * them. No extension editors, Monaco, sign-in or analytics are imported.
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
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = path.resolve(here, '../runtime/src');
const collabBundleDist = path.resolve(here, '../collab-bundle/dist');

const hostSingletons = [
  'react',
  'react-dom',
  'lexical',
  '@lexical/code',
  '@lexical/code-core',
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

export default defineConfig({
  root: here,
  base: '/',
  plugins: [react()],
  resolve: {
    dedupe: hostSingletons,
    alias: [
      // Theme palettes only: a pure module of two color tables, no registry.
      { find: /^@nimbalyst\/runtime-source\//, replacement: `${runtimeSource}/` },
    ],
  },
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
  },
});
