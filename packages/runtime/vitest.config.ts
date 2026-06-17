import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Package-scoped vitest config mirroring the ROOT vitest.config.ts settings
 * for runtime files. Without it, running `npx vitest` from inside
 * packages/runtime fell back to vitest defaults — node environment (React
 * component tests die with "document is not defined") and node-modules
 * resolution of `@nimbalyst/runtime/...` (hits the stale dist/ exports map
 * instead of src). CI runs the root config; this exists so per-package runs
 * report the same results.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    environmentMatchGlobs: [
      ['src/ai/**/*.{test,spec}.{ts,tsx}', 'node'],
    ],
    setupFiles: ['../../test-utils/setup.ts'],
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/__tests__/**/*.spec.{ts,tsx}',
    ],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: [
      { find: '@nimbalyst/runtime', replacement: path.resolve(__dirname, './src') },
      { find: /^@\//, replacement: `${path.resolve(__dirname, './src/editor')}/` },
    ],
  },
});
