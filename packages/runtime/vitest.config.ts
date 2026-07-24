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
 *
 * vitest 4 removed `environmentMatchGlobs`; the jsdom-default / node-for-`src/ai`
 * split is expressed with `test.projects` instead.
 */
const alias = [
  { find: '@nimbalyst/runtime', replacement: path.resolve(__dirname, './src') },
  { find: '@nimbalyst/extension-sdk/file-tree', replacement: path.resolve(__dirname, '../extension-sdk/src/fileDirectoryTree.ts') },
  { find: '@nimbalyst/extension-sdk', replacement: path.resolve(__dirname, '../extension-sdk/src') },
  { find: /^@\//, replacement: `${path.resolve(__dirname, './src/editor')}/` },
];

const setupFiles = ['../../test-utils/setup.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'jsdom',
          globals: true,
          environment: 'jsdom',
          setupFiles,
          include: [
            'src/**/__tests__/**/*.test.{ts,tsx}',
            'src/**/__tests__/**/*.spec.{ts,tsx}',
          ],
          exclude: ['node_modules', 'dist', 'src/ai/**'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          setupFiles,
          include: [
            'src/ai/**/__tests__/**/*.test.{ts,tsx}',
            'src/ai/**/__tests__/**/*.spec.{ts,tsx}',
          ],
          exclude: ['node_modules', 'dist'],
        },
      },
    ],
  },
});
