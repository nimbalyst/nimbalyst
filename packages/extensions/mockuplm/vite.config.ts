import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const PROCESS_SHIM_BANNER = `
if (typeof process === 'undefined') {
  globalThis.process = { env: { NODE_ENV: 'production' }, browser: true, platform: '' };
}
`;

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
      babel: {
        // Force production mode for JSX transform regardless of NODE_ENV
        plugins: [
          ['@babel/plugin-transform-react-jsx', { runtime: 'automatic', development: false }]
        ]
      }
    }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'MockupLMExtension',
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
        // React). The host's runtime exposes both modules via the import map.
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
