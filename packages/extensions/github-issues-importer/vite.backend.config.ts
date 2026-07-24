import { defineConfig } from 'vite';
import { resolve } from 'path';

// Backend module bundle. Runs in an Electron utility-process (Node), loaded by
// the host's extensionBackendBootstrap via dynamic import. Node built-ins stay
// external; @nimbalyst/* imports are type-only and erased.
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
        /^node:/,
        'child_process',
        'os',
        'path',
        'util',
        /^@nimbalyst\//,
      ],
      output: { inlineDynamicImports: true },
    },
    target: 'node18',
    outDir: 'dist',
    // Do NOT wipe dist — the renderer build (vite.config.ts) runs first and
    // emits index.js into the same directory.
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
  },
});
