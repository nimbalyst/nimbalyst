import { defineConfig } from 'vitest/config';
import path from 'path';

// Mirror tsconfig.json paths so Vitest can resolve cross-package imports.
// Use array form so we can match @nimbalyst/runtime/<deep-path> with a regex.
const alias = [
  { find: /^@nimbalyst\/runtime$/, replacement: path.resolve(__dirname, '../runtime/src/index.ts') },
  { find: /^@nimbalyst\/runtime\/(.+)$/, replacement: path.resolve(__dirname, '../runtime/src') + '/$1' },
  { find: '@nimbalyst/tracker-core', replacement: path.resolve(__dirname, '../tracker-core/src') },
  { find: '@nimbalyst/tracker-schema', replacement: path.resolve(__dirname, '../tracker-schema/src') },
  { find: '@nimbalyst/tracker-engine', replacement: path.resolve(__dirname, '../tracker-engine/src') },
  { find: /^@nimbalyst\/local-wiki$/, replacement: path.resolve(__dirname, '../local-wiki/src/index.ts') },
  { find: /^@nimbalyst\/extension-sdk\/git-operation-log$/, replacement: path.resolve(__dirname, '../extension-sdk/src/gitOperationLog.ts') },
  { find: '@', replacement: path.resolve(__dirname, './src') },
  // Monaco's ESM entry imports raw `.css`, which Node's externalized-dep
  // loader rejects ("Unknown file extension .css"). No electron unit test
  // renders Monaco; it is only reachable transitively via the
  // `@nimbalyst/runtime/editor` barrel. Stub it out.
  // `electron-log/renderer` exports a Proxy that answers every property with a
  // function, `then` included. Awaiting that namespace -- which vitest does for
  // every module it evaluates -- treats it as a thenable and calls
  // `then(resolve, reject)`, which logs the two callbacks and never resolves.
  // The import hangs during evaluation, where `testTimeout` cannot reach it, so
  // the run waits forever. The root config stubs it for this reason; without
  // the same alias here, `npm test` in this package stalled indefinitely after
  // ~152 files on the first renderer test that reaches electron-log.
  { find: /^electron-log\/renderer$/, replacement: path.resolve(__dirname, '../../test-utils/electronLogStub.ts') },
  { find: /^monaco-editor$/, replacement: path.resolve(__dirname, './test-stubs/monaco-stub.ts') },
  { find: /^@monaco-editor\/react$/, replacement: path.resolve(__dirname, './test-stubs/monaco-stub.ts') },
  { find: /^y-monaco$/, replacement: path.resolve(__dirname, './test-stubs/monaco-stub.ts') }
];

// This config's root is packages/electron, but renderer components pull in
// `@nimbalyst/runtime`, whose barrel reaches `?raw` imports over in
// packages/runtime. Vite gates `?raw` on the fs allow-list, and when that
// list is inferred rather than stated a worker can deny them ("Denied ID
// .../plan.yaml?raw") depending on which test files share the run. Naming
// the repo root makes it deterministic.
const fsAllow = [path.resolve(__dirname, '../..')];

// Both setup files, in the same order as the root config. The root suite loads
// `test-utils/setup.ts` (jsdom polyfills, notably window.matchMedia) alongside
// this package's own setup; loading only the local one here meant a renderer
// test that passed under `npm run test:prepush` failed under `npm test` here
// with `window.matchMedia is not a function`.
const setupFiles = ['../../test-utils/setup.ts', './vitest.setup.ts'];

// Only `.test.`/`.spec.` files, matching the root config. The previous second
// pattern (`src/**/__tests__/**/*.{js,ts,tsx,...}`) collected every file in a
// `__tests__` directory, so a shared helper with no suite in it was reported as
// a failing file ("No test suite found in ..."). The first pattern already
// reaches files inside `__tests__`, so nothing is lost; exactly one file in the
// package matched only the broad pattern, and it declares no tests.
const include = ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'];

// Paths that must run under the node environment. This mirrors the electron
// entries in the root `vitest.config.ts` `nodeOnly` list; the two must agree,
// because a file routed to jsdom here and node there (or the reverse) passes in
// one suite and fails in the other, which is exactly the divergence that made
// `npm test` in this package unusable while `npm run test:prepush` was green.
//
// Per-file `@vitest-environment` pragmas still win over this routing, so a file
// that states its own environment is unaffected by which project collects it.
const nodeOnly = [
  'src/main/**',
  // Pure property contracts default to Node here.
  'src/shared/analytics/**',
  // Layout <-> saved-view definition translation is pure object shuffling.
  'src/renderer/components/TrackerMode/__tests__/trackerViewDefinition.test.ts',
  // `EmbedFrame` is otherwise React components; the drop payload is pure
  // string handling over a `getData` stub and needs no DOM.
  'src/renderer/components/EmbedFrame/__tests__/canvasDropSource.test.ts',
  'src/renderer/components/EmbedFrame/__tests__/resolveCollaborativeEmbedRequest.test.ts',
  // Headless collab acquisition is Y.Doc + codec plumbing with the room
  // boundary stubbed; it never mounts an editor, which is the whole point.
  'src/renderer/services/__tests__/HeadlessCollabDocument.test.ts',
  'src/renderer/services/__tests__/codecOnlyHeadlessEdit.test.ts'
];

// The node project's `include` and the jsdom project's `exclude` must describe
// the same set, and as two hand-maintained lists they drift: adding a directory
// to one but not the other drops its tests from BOTH projects and the suite
// still reports green. Derive the include instead of restating it, as the root
// config does.
const nodeOnlyInclude = nodeOnly.map((entry) =>
  entry.endsWith('/**') ? `${entry}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}` : entry,
);

const baseExclude = ['**/node_modules/**', 'dist', 'out', 'release', '**/temptests/**'];

const TEST_TIMEOUT_MS = 10000;
const HOOK_TIMEOUT_MS = 10000;

export default defineConfig({
  test: {
    globalSetup: ['./vitest.globalSetup.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'out/',
        'release/'
      ]
    },
    // Two projects rather than one node environment. `src/renderer` is React and
    // needs a DOM; only 189 of its 449 test files declared `@vitest-environment
    // jsdom`, and the rest relied on the root config defaulting to jsdom. Under
    // a single node environment here they failed on `window is not defined`.
    // `test.projects` entries do NOT inherit root-level `test` options, so the
    // shared ones are repeated in each.
    projects: [
      {
        resolve: { alias },
        server: { fs: { allow: fsAllow } },
        define: { 'process.env.NODE_ENV': '"test"' },
        test: {
          name: 'jsdom',
          globals: true,
          environment: 'jsdom',
          setupFiles,
          include,
          exclude: [...baseExclude, ...nodeOnlyInclude],
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS
        }
      },
      {
        resolve: { alias },
        server: { fs: { allow: fsAllow } },
        define: { 'process.env.NODE_ENV': '"test"' },
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          // The root config's node project adds `setup-ai.ts` on top of the
          // shared two; without it the AI host tests see an undefined module
          // surface (`Cannot read properties of undefined (reading 'env')`).
          setupFiles: [...setupFiles, '../../test-utils/setup-ai.ts'],
          include: nodeOnlyInclude,
          exclude: baseExclude,
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS
        }
      }
    ]
  }
});
