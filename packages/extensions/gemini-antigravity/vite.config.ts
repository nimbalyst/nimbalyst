import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Node built-in modules that the backend (utilityProcess.fork) entry needs
// to keep external. Renderer half does NOT get these; renderer stays
// browser-safe.
const NODE_BUILTINS = [
  'child_process',
  'https',
  'http',
  'fs',
  'fs/promises',
  'path',
  'crypto',
  'os',
  'net',
  'url',
  'util',
  'events',
  'stream',
  'buffer',
];

// Renderer-side externals: React + extension SDK stay external so the host
// provides them. No Node builtins here -- renderer code must not touch
// child_process / fs / net at all.
const RENDERER_EXTERNALS: (string | RegExp)[] = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  /^@nimbalyst\//,
  '@nimbalyst/extension-sdk',
];

// Backend-side externals: Node builtins + SDK. React is NOT a backend
// dependency, but we keep the SDK external because the host passes the
// runtime in via the utility-process bridge.
const BACKEND_EXTERNALS: (string | RegExp)[] = [
  /^@nimbalyst\//,
  '@nimbalyst/extension-sdk',
  ...NODE_BUILTINS,
  // Cover `node:` prefixed imports as well so either style stays external.
  ...NODE_BUILTINS.map((m) => `node:${m}`),
];

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  mode: 'production',
  build: {
    lib: {
      // Multi-entry: renderer half (`index`) + backend module (`agent`).
      // The backend entry is a Node-style module loaded via
      // electron.utilityProcess.fork in the host, so it must NOT bundle
      // Node builtins or React.
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        agent: resolve(__dirname, 'src/backend/agent.ts'),
      },
      name: 'GeminiAntigravityExtension',
      formats: ['es'],
      // Force flat output names: dist/index.js + dist/agent.js
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // Different externals per entry: renderer stays browser-safe;
      // backend treats Node builtins as external so utilityProcess.fork
      // can resolve them at runtime.
      external: (id, _parentId, _isResolved) => {
        // Renderer externals always apply
        for (const ext of RENDERER_EXTERNALS) {
          if (typeof ext === 'string') {
            if (id === ext) return true;
          } else if (ext.test(id)) {
            return true;
          }
        }
        // Backend-only externals (Node builtins + node: prefixed). These
        // are harmless to also externalise for the renderer entry --
        // the renderer never imports them.
        for (const ext of BACKEND_EXTERNALS) {
          if (typeof ext === 'string') {
            if (id === ext) return true;
          } else if (ext.test(id)) {
            return true;
          }
        }
        return false;
      },
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
        // Flat asset name for the renderer CSS bundle.
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.some((name) => name.endsWith('.css'))) {
            return 'index.css';
          }
          return assetInfo.names?.[0] || 'asset';
        },
        // Keep chunks alongside their entries (dist/index.js,
        // dist/agent.js). `inlineDynamicImports` is incompatible with
        // multi-entry builds, so we drop it and rely on rollup's
        // default code-splitting between the two entries.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // Backend entry targets Node (electron utilityProcess.fork). Renderer
    // entry is loaded into the Electron renderer. Both run on modern V8
    // shipped with current Electron, so esnext is safe for both halves.
    target: 'esnext',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
