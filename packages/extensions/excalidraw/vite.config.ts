import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Plugin to inject a process shim at the top of the bundle
function processShimPlugin(): Plugin {
  return {
    name: 'process-shim',
    renderChunk(code) {
      // Inject process shim at the top of the bundle
      const shim = `
if (typeof process === 'undefined') {
  globalThis.process = { env: { NODE_ENV: 'production' }, browser: true, platform: '' };
}
`;
      return shim + code;
    },
  };
}

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
    processShimPlugin(),
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
