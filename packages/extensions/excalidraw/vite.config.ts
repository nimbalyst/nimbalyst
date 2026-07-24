import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const PROCESS_SHIM_BANNER = `
if (typeof process === 'undefined') {
  globalThis.process = { env: { NODE_ENV: 'production' }, browser: true, platform: '' };
}
`;

// mermaid >= 11.13 prefixes every SVG element id with the render id
// (e.g. "mermaid-to-excalidraw-6-Client" instead of "Client"), but
// @excalidraw/mermaid-to-excalidraw 2.2.2 still looks subgraphs up by their
// bare id. The lookup misses, the parser throws "SubGraph element not found",
// and every diagram with a subgraph silently degrades to a rasterized SVG
// image. Patch the lookup at bundle time to fall back to a suffix match.
// Remove once upstream handles prefixed ids (tracked as NIM-1596).
const SUBGRAPH_LOOKUP = 'containerEl.querySelector(`[id=\'${data.id}\']`)';
const SUBGRAPH_LOOKUP_PATCHED =
  '(containerEl.querySelector(`[id=\'${data.id}\']`) || containerEl.querySelector(`[id$=\'-${data.id}\']`))';

function patchMermaidToExcalidrawSubgraphLookup() {
  return {
    name: 'patch-mermaid-to-excalidraw-subgraph-lookup',
    transform(code: string, id: string) {
      if (!id.includes('mermaid-to-excalidraw') || !id.includes('flowchart')) return null;
      if (!code.includes(SUBGRAPH_LOOKUP)) return null;
      return { code: code.replaceAll(SUBGRAPH_LOOKUP, SUBGRAPH_LOOKUP_PATCHED), map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
    patchMermaidToExcalidrawSubgraphLookup(),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'ExcalidrawExtension',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'lexical',
        /^@lexical\//,
        /^@nimbalyst\/runtime/,
        '@nimbalyst/editor-context',
        // yJS must resolve to the host's copy at runtime -- `instanceof Y.Doc`
        // checks fail if the extension bundles its own (same constraint as
        // React). The host's runtime exposes both modules.
        'yjs',
        /^y-protocols(\/.*)?$/,
      ],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
        banner: PROCESS_SHIM_BANNER,
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
            return 'index.css';
          }
          return assetInfo.names?.[0] || 'asset';
        },
        // Inline dynamic imports to prevent code splitting issues in extension context
        inlineDynamicImports: true,
      },
    },
    // Excalidraw 0.18 ships fonts as external .woff2 files referenced by
    // relative url() in its CSS (and via bundled font-loading code). The host
    // injects extension CSS as an inline <style> and loads index.js via a
    // module loader, so emitted asset files with relative URLs would not
    // resolve at runtime. Inline every asset as a base64 data URI instead
    // (0.17.6 already shipped its fonts pre-inlined, so this preserves the
    // prior single-bundle behavior). `true` forces inlining regardless of size.
    assetsInlineLimit: () => true,
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
