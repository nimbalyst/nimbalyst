import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react({
      // Use jsx-runtime instead of jsx-dev-runtime in production
      // The host app's jsx-dev-runtime has jsxDEV as undefined in production
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
  ],
  // Replace process.env.NODE_ENV with "production" during build
  // This is necessary because some dependencies (like use-sync-external-store)
  // use process.env.NODE_ENV for conditional exports, and the browser doesn't have process
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // Ensure production mode for JSX transform
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'DatamodelLMExtension',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      // Externalize ONLY libraries that must be singletons (React, Lexical)
      // Extensions should bundle their own utility libraries for version independence
      external: [
        // React core - multiple instances break hooks
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        // Lexical - extensions contribute nodes to host's editor
        'lexical',
        /^@lexical\//,
        // Nimbalyst services
        /^@nimbalyst\/runtime/,
        '@nimbalyst/editor-context',
        // yJS must resolve to the host's copy at runtime -- `instanceof Y.Doc`
        // checks fail if the extension bundles its own (same constraint as
        // React). The host's runtime exposes both modules.
        'yjs',
        /^y-protocols(\/.*)?$/,
      ],
      // NOTE: zustand, html2canvas, @xyflow/react are bundled by the extension
      // This gives the extension control over its own versions
      output: {
        // Provide global variables for externals
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
        // Vite 7 changed how CSS files are named - force it to use index.css
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
            return 'index.css';
          }
          return assetInfo.names?.[0] || 'asset';
        },
      },
    },
    // Output to dist directory
    outDir: 'dist',
    // Don't empty outDir (preserve other assets)
    emptyOutDir: true,
    // Generate sourcemaps for debugging
    sourcemap: true,
  },
  // Resolve aliases
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
