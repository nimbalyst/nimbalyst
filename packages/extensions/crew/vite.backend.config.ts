import { defineConfig } from 'vite';
import { resolve } from 'path';
import { builtinModules } from 'module';

// Backend module bundle. Runs in an Electron utility-process (Node), loaded by
// the host's extensionBackendBootstrap via dynamic import. Pure-JS deps
// (js-yaml) are bundled so the module is self-contained in a packaged build,
// where the utility process cannot resolve arbitrary hoisted node_modules.
export default defineConfig({
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/backend.ts'),
      formats: ['es'],
      fileName: () => 'backend.js',
    },
    rollupOptions: {
      external: [/^node:/, ...builtinModules, /^@nimbalyst\//],
      output: { inlineDynamicImports: true },
    },
    target: 'node18',
    outDir: 'dist',
    // The panel build (vite.config.ts) emits index.js here too.
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
  },
});
