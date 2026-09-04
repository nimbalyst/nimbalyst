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

// `electron-log/renderer` exports a Proxy that answers every property with a
// function, `then` included. Awaiting that namespace -- which vitest does for
// every module it evaluates -- treats it as a thenable and calls
// `then(resolve, reject)`, which logs the two callbacks and never resolves. The
// import hangs during evaluation, where `testTimeout` cannot reach it, so the
// run waits forever. See the stub's header.
const electronLogStub = path.resolve(__dirname, './test-utils/electronLogStub.ts');

const alias = [
  {
    find: '@nimbalyst/tracker-core',
    replacement: path.resolve(__dirname, './packages/tracker-core/src'),
  },
  {
    find: '@nimbalyst/runtime',
    replacement: path.resolve(__dirname, './packages/runtime/src'),
  },
  {
    find: '@nimbalyst/extension-sdk/file-tree',
    replacement: path.resolve(__dirname, './packages/extension-sdk/src/fileDirectoryTree.ts'),
  },
  {
    find: '@nimbalyst/extension-sdk/file-mask',
    replacement: path.resolve(__dirname, './packages/extension-sdk/src/fileMask.ts'),
  },
  {
    find: '@nimbalyst/extension-sdk/git-operation-log',
    replacement: path.resolve(__dirname, './packages/extension-sdk/src/gitOperationLog.ts'),
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
    find: /^electron-log\/renderer$/,
    replacement: electronLogStub,
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

// Authoritative timeouts. The pre-push suite runs all ~1070 files at full
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

// A full `vitest --run` used to emit ~1MB of output, ~90% of it console noise
// from tests that PASSED (a single info-level log in a hot path can add half a
// megabyte, since vitest prints a `stdout | <path> > <test name>` header line
// for every console call). 'passed-only' suppresses console output for passing
// tests and still prints it in full for failures, so nothing diagnostic is
// lost. Set per-project: `test.projects` entries do NOT inherit root-level
// `test` options.
const SILENT: 'passed-only' = 'passed-only';

const include = [
  'packages/**/__tests__/**/*.test.{ts,tsx}',
  'packages/**/__tests__/**/*.spec.{ts,tsx}',
];

// `temptests/` is the gitignored home for throwaway probes (see CLAUDE.md), so
// its files never reach CI. Collecting them locally means a scratch probe --
// often written to fail on purpose so it prints a value -- blocks the pre-push
// gate for unrelated work.
const baseExclude = ['node_modules', 'dist', 'build', '.idea', '.git', '.cache', '**/temptests/**'];

// Paths that must run under the node environment (vitest 4 removed
// `environmentMatchGlobs`; expressed with `test.projects` instead).
// `packages/runtime/src/ui/git` also holds React components, so only the pure
// diff-model test is routed here rather than the whole directory.
const nodeOnly = [
  'packages/electron/src/main/**',
  // Pure property-contract modules with no DOM. Their `// @vitest-environment
  // node` pragmas were inert once vitest 4 replaced `environmentMatchGlobs`
  // with projects, so they were paying for jsdom while claiming not to.
  'packages/electron/src/shared/analytics/**',
  'packages/runtime/src/ai/**',
  'packages/runtime/src/ui/git/__tests__/unifiedDiffModel.test.ts',
  // The recovery planner is a pure function over three numbers.
  'packages/runtime/src/sync/__tests__/trackerIdentityRecovery.test.ts',
  // `feedback-ui` is otherwise React components; only the pure scroll-carry
  // arithmetic is routed here, for the same reason as the diff model above.
  'packages/collab-client/src/feedback-ui/__tests__/artifactScrollCarry.test.ts',
  // Layout <-> saved-view definition translation is pure object shuffling.
  'packages/electron/src/renderer/components/TrackerMode/__tests__/trackerViewDefinition.test.ts',
  // `EmbedFrame` is otherwise React components; the drop payload is pure
  // string handling over a `getData` stub and needs no DOM.
  'packages/electron/src/renderer/components/EmbedFrame/__tests__/canvasDropSource.test.ts',
  'packages/electron/src/renderer/components/EmbedFrame/__tests__/resolveCollaborativeEmbedRequest.test.ts',
  // Headless collab acquisition is Y.Doc + codec plumbing with the room
  // boundary stubbed; it never mounts an editor, which is the whole point.
  'packages/electron/src/renderer/services/__tests__/HeadlessCollabDocument.test.ts',
  'packages/electron/src/renderer/services/__tests__/codecOnlyHeadlessEdit.test.ts',
  // `nim` is a terminal process; nothing under it can touch a DOM. These were
  // running in the jsdom project purely because they matched the default
  // include, paying an environment they cannot use.
  'packages/cli/src/**',
  'packages/tracker-core/src/**',
  // The memory engine is host-agnostic with zero app imports, so nothing under
  // it can reach a DOM. Its tests carried `// @vitest-environment node` pragmas
  // that were inert for the same reason as the ones above, and the extension's
  // own `src/` is excluded because that half really is React.
  'packages/extensions/nimbalyst-memory/engine/src/**',
];

// The node project's `include` and the jsdom project's `exclude` must describe
// the same set, and they were two hand-maintained lists. Adding a directory to
// one but not the other drops its tests from BOTH projects and the suite still
// reports green, so this derives the include instead of restating it.
const nodeOnlyInclude = nodeOnly.map((entry) =>
  entry.endsWith('/**') ? `${entry}/__tests__/**/*.{test,spec}.{ts,tsx}` : entry,
);

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    // Every run records its failures to `.vitest/last-run.log`. The suite takes
    // minutes; losing which tests failed to a dot reporter or a truncated pipe
    // should never cost a second run to find out.
    reporters: ['default', './scripts/vitest-run-log-reporter.mjs'],
    // Tests under packages/electron/src/main touch better-sqlite3. Version 13
    // ships Node-API prebuilds that are stable across supported Node and
    // Electron hosts. The globalSetup still provisions an isolated side-cache
    // binary and sets NIMBALYST_BETTER_SQLITE3_NATIVE so tests do not rebuild or
    // replace the workspace installation used by the running dev server.
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
          silent: SILENT,
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
          silent: SILENT,
          globals: true,
          environment: 'node',
          setupFiles,
          include: nodeOnlyInclude,
          exclude: baseExclude,
          server: { deps: { inline: [/y-monaco/] } },
        },
      },
    ],
  },
});
