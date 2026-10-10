import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..').replaceAll('\\', '/');
const runtimeSource = fileURLToPath(new URL('../runtime/src', import.meta.url));
const collabClientSource = fileURLToPath(new URL('../collab-client/src', import.meta.url));
const emptyBrowserModule = '\0nimbalyst-empty-browser-module';
const excludedDesktopPlugin = '\0nimbalyst-excluded-desktop-plugin';

/**
 * Workarounds inherited from the existing iOS editor build.
 *
 * The agent-toolset is Node-only and cannot enter any browser graph. The
 * SpeechToText surface depends on desktop dictation wiring, so this artifact
 * replaces it with a null component while retaining the shared editor's
 * headless extensions and markdown behavior.
 *
 * DraggableBlockPlugin is deliberately NOT excluded. It was inherited from the
 * iOS stub list, where a touch host has no hover affordance to hang it on, but
 * the browser console is a pointer-driven host running the same editor at the
 * same widths as desktop — dropping it left web users without the block handle
 * that desktop has. The plugin itself is pure DOM/Lexical, and Editor.tsx
 * already gates it behind the shared `isSmallWidthViewport` check.
 *
 * The iOS-only IIFE output and crossorigin/module-script rewriting are
 * intentionally absent. They compensate for WKWebView's file:// null origin;
 * browser and in-page hosts have a real HTTP origin and should consume ESM.
 */
function browserHostWorkarounds(): Plugin[] {
  return [
    {
      name: 'stub-anthropic-agent-toolset',
      enforce: 'pre',
      resolveId(source) {
        return source.includes('tools/agent-toolset') ? emptyBrowserModule : null;
      },
      load(id) {
        return id === emptyBrowserModule ? 'export default {};' : null;
      },
    },
    {
      name: 'exclude-desktop-editor-plugins',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer?.replaceAll('\\', '/').endsWith('/runtime/src/editor/Editor.tsx')) {
          return null;
        }
        if (source === './plugins/SpeechToTextPlugin') {
          return excludedDesktopPlugin;
        }
        return null;
      },
      load(id) {
        return id === excludedDesktopPlugin
          ? 'export default function ExcludedDesktopPlugin() { return null; }'
          : null;
      },
    },
  ];
}

function bundleGraphReport(): Plugin {
  const normalizeModuleId = (id: string | null) => {
    if (id === null) return null;
    const normalized = id.replaceAll('\\', '/');
    const virtualPrefix = normalized.startsWith('\0') ? '\0' : '';
    const pathPart = virtualPrefix ? normalized.slice(1) : normalized;
    return pathPart.startsWith(`${repoRoot}/`)
      ? `${virtualPrefix}${pathPart.slice(repoRoot.length)}`
      : normalized;
  };

  return {
    name: 'collab-bundle-graph-report',
    generateBundle(_options, outputBundle) {
      const modules = Array.from(this.getModuleIds(), (id) => {
        const info = this.getModuleInfo(id);
        return {
          id: normalizeModuleId(id),
          external: info?.isExternal ?? false,
          importers: (info?.importers ?? []).map(normalizeModuleId),
          dynamicImporters: (info?.dynamicImporters ?? []).map(normalizeModuleId),
        };
      });
      const chunks = Object.values(outputBundle)
        .filter((output): output is Extract<typeof output, { type: 'chunk' }> => output.type === 'chunk')
        .map((chunk) => ({
          fileName: chunk.fileName,
          name: chunk.name,
          isEntry: chunk.isEntry,
          facadeModuleId: normalizeModuleId(chunk.facadeModuleId),
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          exports: chunk.exports,
          modules: Object.keys(chunk.modules).map((id) => normalizeModuleId(id)),
          codeBytes: Buffer.byteLength(chunk.code),
        }));
      this.emitFile({
        type: 'asset',
        fileName: 'bundle-report.json',
        source: JSON.stringify({ modules, chunks }, null, 2),
      });
    },
  };
}

function isHostSingleton(id: string): boolean {
  return id === 'react'
    || id.startsWith('react/')
    || id === 'react-dom'
    || id.startsWith('react-dom/')
    || id === 'lexical'
    || id.startsWith('lexical/')
    || id.startsWith('@lexical/')
    || id === '@revolist/react-datagrid'
    || id.startsWith('@revolist/react-datagrid/')
    || id === '@revolist/revogrid'
    || id.startsWith('@revolist/revogrid/')
    || id === 'yjs'
    || id.startsWith('yjs/');
}

export default defineConfig({
  define: {
    // Connection lifecycle diagnostics are a desktop-development facility.
    // Force them out of this eager browser artifact even when the invoking
    // shell happens to carry NODE_ENV=development.
    'import.meta.env.VITE_COLLAB_CONNECTION_DIAGNOSTICS': JSON.stringify('off'),
  },
  plugins: [
    ...browserHostWorkarounds(),
    react({
      jsxRuntime: 'automatic',
      include: [
        '**/*.{tsx,ts,jsx,js}',
        '../runtime/**/*.{tsx,ts,jsx,js}',
        '../collab-client/**/*.{tsx,ts,jsx,js}',
      ],
    }),
    bundleGraphReport(),
  ],
  resolve: {
    // These are host-owned peers. `dedupe` protects linked workspace installs;
    // `optimizeDeps.exclude` below prevents Vite from prebundling a private
    // optimized copy (the NIM-2165 class of blank/crashing dual-runtime bug).
    dedupe: [
      'react',
      'react-dom',
      'lexical',
      '@lexical/yjs',
      '@revolist/react-datagrid',
      '@revolist/revogrid',
      'yjs',
      'jotai',
      'jotai-family',
    ],
    alias: [
      {
        find: '@nimbalyst/tracker-core',
        replacement: fileURLToPath(new URL('../tracker-core/src', import.meta.url)),
      },
      {
        find: '@nimbalyst/tracker-engine',
        replacement: fileURLToPath(new URL('../tracker-engine/src', import.meta.url)),
      },
      // The bare root resolves to the browser barrel: `trackers-ui` re-exports
      // it wholesale, and the full root carries authoring-only classifiers no
      // browser surface calls. See `tracker-schema/src/browser.ts`.
      {
        find: /^@nimbalyst\/tracker-schema$/,
        replacement: fileURLToPath(new URL('../tracker-schema/src/browser.ts', import.meta.url)),
      },
      {
        find: '@nimbalyst/tracker-schema',
        replacement: fileURLToPath(new URL('../tracker-schema/src', import.meta.url)),
      },
      {
        find: /^@nimbalyst\/runtime\/(.+)$/,
        replacement: `${runtimeSource}/$1`,
      },
      {
        find: '@nimbalyst/runtime',
        replacement: resolve(runtimeSource, 'index.ts'),
      },
      {
        find: /^@nimbalyst\/collab-client\/(.+)$/,
        replacement: `${collabClientSource}/$1/index.ts`,
      },
      {
        find: '@nimbalyst/collab-client',
        replacement: resolve(collabClientSource, 'core/index.ts'),
      },
    ],
  },
  optimizeDeps: {
    exclude: [
      'react',
      'react-dom',
      'lexical',
      '@lexical/yjs',
      '@revolist/react-datagrid',
      '@revolist/revogrid',
      'yjs',
      'jotai',
      'jotai-family',
    ],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: {
        // Not consumed by this package's own entries. It exists so a browser
        // host can resolve an extension's externalized comment-UI import to the
        // one instance this build already owns. See src/commenting-ui.ts.
        'commenting-ui': resolve(import.meta.dirname, 'src/commenting-ui.ts'),
        // Its own entry so a host that never opens a board never fetches
        // `@xyflow/react`. See src/canvas.ts.
        canvas: resolve(import.meta.dirname, 'src/canvas.ts'),
        editor: resolve(import.meta.dirname, 'src/editor/index.ts'),
        'docs-ui': resolve(import.meta.dirname, 'src/docs-ui.ts'),
        'feedback-ui': resolve(import.meta.dirname, 'src/feedback-ui.ts'),
        'trackers-ui': resolve(import.meta.dirname, 'src/trackers-ui.ts'),
        'quick-open': resolve(import.meta.dirname, 'src/quick-open.ts'),
        inbox: resolve(import.meta.dirname, 'src/inbox.ts'),
        pages: resolve(import.meta.dirname, 'src/pages.ts'),
      },
      formats: ['es'],
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: isHostSingleton,
      preserveEntrySignatures: 'exports-only',
      output: {
        // Keep public source maps and their relative module mappings, but do
        // not copy source-file contents (including path examples) into dist.
        sourcemapExcludeSources: true,
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo) => assetInfo.name?.endsWith('.css')
          ? 'styles.css'
          : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
