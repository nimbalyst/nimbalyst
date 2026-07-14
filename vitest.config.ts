import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import {createRequire} from 'module';

const runtimeRequire = createRequire(
  path.resolve(__dirname, './packages/runtime/package.json'),
);
const lexicalDir = path.dirname(runtimeRequire.resolve('lexical'));
const lexicalScopeDir = path.join(path.dirname(lexicalDir), '@lexical');

// `monaco-editor`'s ESM entry statically imports `.css`, which vitest's node
// loader cannot handle. No unit test exercises real Monaco, so alias the
// package (and its deep `esm/.../editor.api.js` entry, used by `y-monaco`) to a
// lightweight stub. `y-monaco` must be inlined (see `server.deps.inline`) so
// this alias is applied to its transitive monaco import.
const monacoStub = path.resolve(__dirname, './test-utils/monacoStub.ts');

const alias = [
  {
    find: '@nimbalyst/runtime',
    replacement: path.resolve(__dirname, './packages/runtime/src'),
  },
  {
    find: '@nimbalyst/extension-sdk/file-tree',
    replacement: path.resolve(__dirname, './packages/extension-sdk/src/fileDirectoryTree.ts'),
  },
  {
    find: '@nimbalyst/extension-sdk',
    replacement: path.resolve(__dirname, './packages/extension-sdk/src'),
  },
  {
    find: /^monaco-editor(\/.*)?$/,
    replacement: monacoStub,
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
];

const setupFiles = ['./test-utils/setup.ts', './packages/electron/vitest.setup.ts'];

// Authoritative timeouts. The pre-push suite runs all ~630 files at full
// parallelism, often on a dev machine that is also running the dev server and
// other AI sessions -- so a worker can be starved for several seconds and a
// heavy test (module-graph dynamic imports, better-sqlite3 migrations, large
// lexical diffs, the ~4s claude-cli MCP config chain) blows past the 5s vitest
// default. These used to be bumped via `beforeAll(() => vi.setConfig(...))` in
// the electron setup file, but the vitest 4 upgrade stopped that side-effect
// from taking effect (tests fell back to the 5s default and flaked). Set it
// declaratively here instead -- and in each project, since `test.projects`
// entries do NOT inherit root-level `test` timeouts.
const TEST_TIMEOUT_MS = 20000;
const HOOK_TIMEOUT_MS = 20000;

const include = [
  'packages/**/__tests__/**/*.test.{ts,tsx}',
  'packages/**/__tests__/**/*.spec.{ts,tsx}',
];

const baseExclude = ['node_modules', 'dist', 'build', '.idea', '.git', '.cache'];

// Paths that must run under the node environment (vitest 4 removed
// `environmentMatchGlobs`; expressed with `test.projects` instead).
const nodeOnly = ['packages/electron/src/main/**', 'packages/runtime/src/ai/**'];

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    // Tests under packages/electron/src/main touch better-sqlite3, whose
    // build/Release/.node binary is compiled for Electron (NODE_MODULE_VERSION
    // 145) and unloadable under the system Node that vitest runs against.
    // The globalSetup fetches a Node-ABI prebuild into a side cache and sets
    // NIMBALYST_BETTER_SQLITE3_NATIVE; SQLiteDatabase reads that env to load
    // the right binary via better-sqlite3's `nativeBinding` option without
    // disturbing the Electron binary that the dev server depends on.
    globalSetup: ['./packages/electron/vitest.globalSetup.ts'],
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
    },
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'jsdom',
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          globals: true,
          environment: 'jsdom',
          setupFiles,
          include,
          exclude: [...baseExclude, ...nodeOnly],
          // Inline so vite transforms it and our monaco-editor stub alias
          // applies to its transitive `monaco-editor/esm/.../editor.api.js`.
          server: { deps: { inline: [/y-monaco/] } },
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'node',
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          globals: true,
          environment: 'node',
          setupFiles,
          include: [
            'packages/electron/src/main/**/__tests__/**/*.{test,spec}.{ts,tsx}',
            'packages/runtime/src/ai/**/__tests__/**/*.{test,spec}.{ts,tsx}',
          ],
          exclude: baseExclude,
          server: { deps: { inline: [/y-monaco/] } },
        },
      },
    ],
  },
});
