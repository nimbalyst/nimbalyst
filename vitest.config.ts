import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import {createRequire} from 'module';

const runtimeRequire = createRequire(
  path.resolve(__dirname, './packages/runtime/package.json'),
);
const lexicalDir = path.dirname(runtimeRequire.resolve('lexical'));
const lexicalScopeDir = path.join(path.dirname(lexicalDir), '@lexical');

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    environmentMatchGlobs: [
      ['packages/electron/src/main/**/*.{test,spec}.{ts,tsx}', 'node'],
      ['packages/runtime/src/ai/**/*.{test,spec}.{ts,tsx}', 'node']
    ],
    setupFiles: ['./test-utils/setup.ts', './packages/electron/vitest.setup.ts'],
    // Tests under packages/electron/src/main touch better-sqlite3, whose
    // build/Release/.node binary is compiled for Electron (NODE_MODULE_VERSION
    // 145) and unloadable under the system Node that vitest runs against.
    // The globalSetup fetches a Node-ABI prebuild into a side cache and sets
    // NIMBALYST_BETTER_SQLITE3_NATIVE; SQLiteDatabase reads that env to load
    // the right binary via better-sqlite3's `nativeBinding` option without
    // disturbing the Electron binary that the dev server depends on.
    globalSetup: ['./packages/electron/vitest.globalSetup.ts'],
    include: [
      'packages/**/__tests__/**/*.test.{ts,tsx}',
      'packages/**/__tests__/**/*.spec.{ts,tsx}'
    ],
    exclude: [
      'node_modules',
      'dist',
      'build',
      '.idea',
      '.git',
      '.cache'
    ],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test-utils/',
        'dist/',
        '**/*.d.ts',
        '**/__tests__/**',
        '**/index.ts'
      ]
    }
  },
  resolve: {
    alias: [
      {
        find: '@nimbalyst/runtime',
        replacement: path.resolve(__dirname, './packages/runtime/src'),
      },
      {
        find: /^@\//,
        replacement: `${path.resolve(__dirname, './packages/runtime/src/editor')}/`,
      },
      {
        find: /^lexical$/,
        replacement: lexicalDir,
      },
      {
        find: /^@lexical\/(.*)$/,
        replacement: `${lexicalScopeDir}/$1`,
      },
    ],
  }
});
