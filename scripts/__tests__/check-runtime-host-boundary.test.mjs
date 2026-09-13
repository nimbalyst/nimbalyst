import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findRuntimeHostViolations,
  collectRuntimeHostImports,
  measureHeadlessClosure,
  HEADLESS_CLOSURE_FILE_BUDGET,
} from '../check-runtime-host-boundary.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-runtime-host-boundary.mjs',
);

test('catches both host escapes that actually happened', () => {
  const violations = findRuntimeHostViolations([
    // The eight call sites that read app.isPackaged / app.getAppPath.
    { file: 'packages/runtime/src/electron/claudeCodeEnvironment.ts', specifier: 'electron', resolved: 'electron' },
    // ClaudeCodeProvider's relative path out of the package, resolved as the
    // gate resolves it. This one pulled ~51 desktop-app files into the graph.
    {
      file: 'packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts',
      specifier: '../../../../../electron/src/main/HistoryManager',
      resolved: path.join('/repo', 'packages', 'electron', 'src', 'main', 'HistoryManager'),
    },
  ]);

  assert.deepEqual(violations.map(({ name }) => name), ['electron', 'packages/electron']);
});

test('catches the CommonJS and test-file bypasses a source scan can miss', () => {
  const violations = findRuntimeHostViolations([
    // require('electron') / import electron = require('electron'), which the
    // first version of this gate read straight past.
    { file: 'a.cts', specifier: 'electron', resolved: 'electron' },
    // Shipped code importing a test file would launder an Electron import
    // through the scan's own exclusion, since test files are never scanned.
    {
      file: 'packages/runtime/src/ai/thing.ts',
      specifier: './__tests__/helper',
      resolved: path.join('/repo', 'packages', 'runtime', 'src', 'ai', '__tests__', 'helper'),
    },
    {
      file: 'packages/runtime/src/ai/other.ts',
      specifier: './helper.test.ts',
      resolved: path.join('/repo', 'packages', 'runtime', 'src', 'ai', 'helper.test.ts'),
    },
  ]);

  assert.deepEqual(
    violations.map(({ name }) => name),
    ['electron', 'test file from shipped code'],
  );
  assert.equal(violations[1].hits.length, 2);
});

test('does not fire on the runtime paths that merely look host-shaped', () => {
  const violations = findRuntimeHostViolations([
    // The module kept at src/electron/ for its mock specifier; it is runtime's
    // own file, not the desktop package.
    {
      file: 'packages/runtime/src/ai/server/providers/claudeCode/cliPathResolver.ts',
      specifier: '../../../../electron/claudeCodeEnvironment',
      resolved: path.join('/repo', 'packages', 'runtime', 'src', 'electron', 'claudeCodeEnvironment'),
    },
    { file: 'x.ts', specifier: 'electron-store', resolved: 'electron-store' },
  ]);

  assert.deepEqual(violations, []);
});

test('runtime source currently satisfies the boundary', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[runtime-host-boundary\] runtime source clean \(\d+ imports scanned\)\.$/m);
});

test('scans a non-trivial number of real imports, so a silent no-op is visible', () => {
  assert.ok(collectRuntimeHostImports().length > 1000);
});

// The source scan cannot see this one. Reverting `ai/server/types.ts` to import
// the `@nimbalyst/extension-sdk` barrel instead of the deep path takes this
// closure from 101/0 to 676/181 -- verified by doing exactly that and watching
// the gate go red -- while every import line still looks perfectly ordinary.
test('the headless entry points reach no React and no desktop app', () => {
  const closure = measureHeadlessClosure();

  assert.equal(closure.tsx, 0, 'a React component is reachable from session execution');
  assert.equal(closure.electron, 0, 'packages/electron is reachable from session execution');
  assert.ok(
    closure.files <= HEADLESS_CLOSURE_FILE_BUDGET,
    `closure grew to ${closure.files}, over the ${HEADLESS_CLOSURE_FILE_BUDGET} budget`,
  );
});
