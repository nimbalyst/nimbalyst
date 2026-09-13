// Shared by the reporter, pre-push reuse policy, and CI runner. An invocation
// with extra filters, projects, shards, or retries is never a full-suite result.
export const fullSuiteArgs = ['--run', '--reporter=dot', '--reporter=./scripts/vitest-run-log-reporter.mjs', '--silent=passed-only'];
export const fullSuiteInvocation = fullSuiteArgs.join(' ');
export const isFullSuiteInvocation = (argv) => argv.join(' ') === fullSuiteInvocation;

export const scriptTests = [
  "scripts/__tests__/prepush-test-gate.test.mjs",
  "scripts/__tests__/ensure-sandbox-dependencies.test.mjs",
  "scripts/__tests__/check-analytics-allowlist.test.mjs",
  "scripts/__tests__/check-collab-client-boundaries.test.mjs",
  "scripts/__tests__/check-identity-scopes.test.mjs",
  "scripts/__tests__/check-json-accessor-indexes.test.mjs",
  "scripts/__tests__/check-main-bundle-graph.test.mjs",
  "scripts/__tests__/check-push-authors.test.mjs",
  "scripts/__tests__/check-renderer-sync-sockets.test.mjs",
  "scripts/__tests__/check-runtime-host-boundary.test.mjs",
  "scripts/__tests__/check-shared-document-nodes.test.mjs",
  "scripts/__tests__/check-text-file-nuls.test.mjs",
  "scripts/__tests__/check-toolchain.test.mjs",
  "scripts/__tests__/check-tracker-policy-reads.test.mjs",
  "scripts/__tests__/main-bundle-require-policy.test.mjs",
  "scripts/__tests__/run-workspace-script.test.mjs",
  "scripts/__tests__/vitest-tree-fingerprint.test.mjs",
  "packages/electron/scripts/__tests__/dev-user2.test.mjs",
  "scripts/__tests__/vitest-run-log-reporter.test.mjs",
  "scripts/__tests__/check-ui-invariants.test.mjs",
  "scripts/__tests__/validation-inventory.test.mjs"
];

const workspaceDeps = [['npm', 'run', 'build:workspace-deps']];
const bundleBuild = [['npm', 'run', 'build', '--workspace=@nimbalyst/collab-bundle']];
const preparedTypecheck = [
  ['npm', 'run', 'build', '--prefix', 'packages/extensions/nimbalyst-memory/engine'],
  ['npm', 'run', 'typecheck'],
];
export const tasks = {
  // Runtime declarations and the memory engine are prerequisites of discovered
  // workspace typechecks. Both the hook and CI use this inventory.
  'workspace-deps': workspaceDeps,
  'bundle-build': bundleBuild,
  typecheck: [
    ...workspaceDeps,
    ['npm', 'run', 'build', '--workspace=@nimbalyst/runtime', '--', '--logLevel', 'warn'],
    ...preparedTypecheck,
  ],
  'typecheck-ready': preparedTypecheck,
  scripts: [['node', '--test', '--test-reporter=dot', ...scriptTests], ['node', 'scripts/check-ui-invariants.mjs']],
  sandbox: [['npm', 'run', 'test:cloudflare-sandbox']],
  'unit-build': [...workspaceDeps, ...bundleBuild],
  unit: [['npm', 'run', 'test:prepush']],
  transcript: [['npm', 'run', 'ios:build:transcript']],
};

// Deliberately small allowlist. Markdown under packages, .claude, or general
// docs can be fixtures, bundled prompts, or checked architectural contracts.
export function classifyChanges(files) {
  const docsOnly = files.length > 0 && files.every(file => ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE'].includes(file));
  // Sandbox reads its package, container pins, protocol/runtime/node sources,
  // and root tooling. Only proven renderer-only edits bypass its extra gate.
  const rendererOnly = files.length > 0 && files.every(file =>
    /^packages\/electron\/src\/renderer\/.*\.(tsx?|css)$/.test(file));
  return { docsOnly, sandbox: !docsOnly && !rendererOnly };
}
