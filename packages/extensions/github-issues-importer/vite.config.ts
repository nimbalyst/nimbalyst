import { defineConfig } from 'vite';
import { resolve } from 'path';

// Renderer/main bundle. This importer has no renderer surface (no settings
// panel in v1 — bindings derive from the workspace's GitHub remote), so the
// main entry is an inert module. The manifest still requires `main`.
export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  mode: 'production',
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [/^@nimbalyst\//],
      output: { inlineDynamicImports: true },
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
