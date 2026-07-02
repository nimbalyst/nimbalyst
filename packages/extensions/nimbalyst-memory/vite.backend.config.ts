import { defineConfig } from 'vite';
import { resolve } from 'path';
import { builtinModules } from 'module';

// Backend module bundle. Runs in an Electron utility-process (Node), loaded by
// the host's extensionBackendBootstrap via dynamic import.
//
// The engine (../engine/dist) is BUNDLED IN (relative import) so the utility
// process needs no @nimbalyst/memory-engine resolution. Its pure-JS deps are
// ALSO bundled so the module is self-contained in a packaged build, where only
// a hand-picked whitelist of node_modules ships and the utility process (loaded
// from resources/extensions/...) cannot resolve arbitrary hoisted modules.
// Bundling fast-glob / chokidar / js-yaml / picomatch is what makes the memory
// engine actually start in production instead of crashing on its first import.
//
// Kept EXTERNAL:
//   - better-sqlite3 is a native module (cannot be bundled); it ships to
//     Contents/Resources/node_modules via electron-builder extraResources and
//     resolves from the extension's on-disk location at runtime.
//   - @huggingface/transformers is an optional local-embedder dep (unused in
//     the OpenAI-only v1; externalized so it never bundles).
export default defineConfig({
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/backend.ts'),
      formats: ['es'],
      fileName: () => 'backend.js',
    },
    rollupOptions: {
      external: [
        // Node builtins, whether imported as `node:fs` or bare `fs` (chokidar's
        // ESM uses bare specifiers, which Vite would otherwise browser-shim).
        /^node:/,
        ...builtinModules,
        'better-sqlite3',
        '@huggingface/transformers',
        /^@nimbalyst\//,
      ],
      output: { inlineDynamicImports: true },
    },
    target: 'node18',
    outDir: 'dist',
    // Do NOT wipe dist — the shell build (vite.config.ts) emits index.js here.
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
  },
});
