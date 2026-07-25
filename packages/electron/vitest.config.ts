import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.globalSetup.ts'],
    include: [
      'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'src/**/__tests__/**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    ],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'out/',
        'release/'
      ]
    },
    testTimeout: 10000,
    hookTimeout: 10000
  },
  resolve: {
    alias: [
      // Mirror tsconfig.json paths so Vitest can resolve cross-package imports.
      // Use array form so we can match @nimbalyst/runtime/<deep-path> with a regex.
      { find: /^@nimbalyst\/runtime$/, replacement: path.resolve(__dirname, '../runtime/src/index.ts') },
      { find: /^@nimbalyst\/runtime\/(.+)$/, replacement: path.resolve(__dirname, '../runtime/src') + '/$1' },
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Monaco's ESM entry imports raw `.css`, which Node's externalized-dep
      // loader rejects ("Unknown file extension .css"). No electron unit test
      // renders Monaco; it is only reachable transitively via the
      // `@nimbalyst/runtime/editor` barrel. Stub it out.
      { find: /^monaco-editor$/, replacement: path.resolve(__dirname, './test-stubs/monaco-stub.ts') },
      { find: /^@monaco-editor\/react$/, replacement: path.resolve(__dirname, './test-stubs/monaco-stub.ts') },
      { find: /^y-monaco$/, replacement: path.resolve(__dirname, './test-stubs/monaco-stub.ts') }
    ]
  },
  define: {
    'process.env.NODE_ENV': '"test"'
  }
});