import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createManifestValidationPlugin } from '@nimbalyst/extension-sdk/vite';

export default defineConfig({
  plugins: [
    react({
      // Use jsx-runtime instead of jsx-dev-runtime in production
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
    // Validate manifest.main and manifest.styles point to real files after build
    createManifestValidationPlugin(),
    // Custom plugin to copy PDF.js worker after build
    {
      name: 'copy-pdfjs-worker',
      closeBundle() {
        // Copy the PDF.js worker to the dist folder
        // Try extension's own node_modules first, then fall back to monorepo root
        const localWorkerSrc = resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
        const rootWorkerSrc = resolve(__dirname, '../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
        const workerDest = resolve(__dirname, 'dist/pdf.worker.min.mjs');

        try {
          mkdirSync(dirname(workerDest), { recursive: true });
          // Try local first, then root
          try {
            copyFileSync(localWorkerSrc, workerDest);
          } catch {
            copyFileSync(rootWorkerSrc, workerDest);
          }
          console.log('Copied PDF.js worker to dist/');
        } catch (error) {
          console.error('Failed to copy PDF.js worker:', error);
        }
      },
    },
  ],
  // Replace process.env.NODE_ENV with "production" during build
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // Ensure production mode for JSX transform
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      // pdf-viewer uses pdfjs-dist and virtua from the host via __nimbalyst_extensions
      // These are NOT ES module imports, but direct window access at runtime
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        // Host-provided singletons — must NOT be bundled. Bundling
        // @nimbalyst/runtime drags in @anthropic-ai/sdk, whose agent-toolset
        // imports Node built-ins (node:crypto/node:path) that break the
        // browser build. Mirrors the canonical extension externals.
        'lexical',
        /^@lexical\//,
        /^@nimbalyst\/runtime/,
        '@nimbalyst/editor-context',
        'yjs',
        /^y-protocols(\/.*)?$/,
        'pdfjs-dist',
        'virtua',
      ],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'pdfjs-dist': 'pdfjsLib',
          virtua: 'Virtua',
        },
        // Vite 7 changed how CSS files are named - force it to use style.css
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
            return 'style.css';
          }
          return assetInfo.names?.[0] || 'asset';
        },
        // Inline dynamic imports to prevent code splitting issues in extension context
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
