import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT,
  collectNodeTypes,
  compareNodeTypes,
  findWiringViolations,
  formatViolations,
  REPO_ROOT,
} from '../check-shared-document-nodes.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-shared-document-nodes.mjs',
);

function fixtureDir() {
  return mkdtempSync(path.join(tmpdir(), 'shared-doc-nodes-gate-'));
}

function fixture(dir, name, source) {
  const file = path.join(dir, name);
  writeFileSync(file, source, 'utf8');
  return file;
}

const CONTRACT_MODULE = path.join(REPO_ROOT, CONTRACT.module);

/**
 * The shape that actually shipped and broke the web console: a host that
 * registers one reference node and not the other. Measured the same way the
 * gate measures a real host -- bundle the registration, run it, read the node
 * types out of the extension store.
 */
test('flags a host that registers only one of the contract node types', async () => {
  const dir = fixtureDir();
  const partial = fixture(dir, 'partialHost.ts', `
    import { registerTrackerReferenceContributions } from ${JSON.stringify(CONTRACT_MODULE)};
    export function registerPartialHost(): void {
      registerTrackerReferenceContributions();
    }
  `);

  const contractTypes = await collectNodeTypes(CONTRACT.probe);
  assert.ok(contractTypes.includes('document-reference'), contractTypes.join(','));

  const hosts = [{ id: 'partial-host', label: 'partial host', fix: 'partialHost.ts' }];
  const measured = await collectNodeTypes({
    kind: 'extension-store',
    imports: [{ from: partial, names: ['registerPartialHost'] }],
    calls: ['registerPartialHost'],
  });
  assert.deepEqual(measured, ['tracker-reference']);

  const violations = compareNodeTypes(contractTypes, new Map([['partial-host', measured]]), hosts);
  assert.deepEqual(
    violations.map((violation) => [violation.kind, violation.host, violation.type]),
    [['missing-node-type', 'partial-host', 'document-reference']],
  );
  // The 2am reader gets the node type, the host, and where to fix it.
  const message = formatViolations(violations, hosts);
  assert.match(message, /document-reference/);
  assert.match(message, /partial host/);
  assert.match(message, /partialHost\.ts/);
});

test('a host with every contract type passes, and a host that never reported fails', () => {
  const hosts = [
    { id: 'complete', label: 'complete host', fix: 'a.ts' },
    { id: 'silent', label: 'silent host', fix: 'b.ts' },
  ];
  const violations = compareNodeTypes(
    ['tracker-reference', 'document-reference'],
    new Map([['complete', ['tracker-reference', 'document-reference', 'image']]]),
    hosts,
  );
  assert.deepEqual(
    violations.map((violation) => [violation.kind, violation.host]),
    [['probe-missing', 'silent']],
  );
});

// A gate that passes when it measured nothing is worse than no gate.
test('an empty contract is a failure, not a vacuous pass', () => {
  const hosts = [{ id: 'anything', label: 'anything', fix: 'a.ts' }];
  const violations = compareNodeTypes([], new Map([['anything', []]]), hosts);
  assert.deepEqual(violations.map((violation) => violation.kind), ['empty-contract']);
});

test('flags an entry that no longer imports its registration module', () => {
  const dir = fixtureDir();
  fixture(dir, 'referenceNodes.ts', 'export const registered = true;\n');
  fixture(dir, 'mount.tsx', "import './somethingElse';\nexport const mounted = true;\n");
  fixture(dir, 'somethingElse.ts', 'export const other = true;\n');

  const hosts = [{
    id: 'bundle',
    label: 'bundle host',
    entry: 'mount.tsx',
    wiring: [{ module: 'referenceNodes.ts' }],
    fix: 'referenceNodes.ts',
  }];
  const violations = findWiringViolations(hosts, dir);
  assert.deepEqual(
    violations.map((violation) => [violation.kind, violation.target]),
    [['missing-import', 'referenceNodes.ts']],
  );

  // Restoring the side-effect import satisfies the same requirement.
  fixture(dir, 'mount.tsx', "import './referenceNodes';\nexport const mounted = true;\n");
  assert.deepEqual(findWiringViolations(hosts, dir), []);
});

test('flags an entry that imports the registrar but never calls it', () => {
  const dir = fixtureDir();
  fixture(dir, 'registerLinks.ts', 'export function registerLinks(): void {}\n');
  fixture(dir, 'App.tsx', `
    import { registerLinks } from './registerLinks';
    export const App = () => null;
    void registerLinks;
  `);

  const hosts = [{
    id: 'renderer',
    label: 'renderer host',
    entry: 'App.tsx',
    wiring: [{ symbol: 'registerLinks', call: true }],
    fix: 'registerLinks.ts',
  }];
  const violations = findWiringViolations(hosts, dir);
  assert.deepEqual(
    violations.map((violation) => [violation.kind, violation.target]),
    [['missing-call', 'registerLinks']],
  );

  fixture(dir, 'App.tsx', `
    import { registerLinks } from './registerLinks';
    registerLinks();
    export const App = () => null;
  `);
  assert.deepEqual(findWiringViolations(hosts, dir), []);
});

test('passes over the real repository and exits zero', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
