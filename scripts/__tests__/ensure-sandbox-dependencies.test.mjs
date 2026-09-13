import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSandboxDependencies } from '../ensure-sandbox-dependencies.mjs';

test('reuses intact installs, reinstalls changed inputs or damaged content, and never blesses a failed install', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandbox-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'package.json'), '{}');
  writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  const modules = path.join(dir, 'node_modules');
  const entry = path.join(modules, 'entry.js');
  let installs = 0;
  const install = () => { installs++; mkdirSync(modules, { recursive: true }); writeFileSync(entry, 'valid'); };
  const ensure = () => ensureSandboxDependencies(dir, install);
  assert.equal(ensure(), true);
  assert.equal(ensure(), false);
  for (const input of ['package.json', 'package-lock.json']) {
    writeFileSync(path.join(dir, input), '{"changed":true}');
    assert.equal(ensure(), true);
    assert.equal(ensure(), false);
  }
  writeFileSync(entry, 'damaged');
  assert.equal(ensure(), true);
  rmSync(entry);
  assert.equal(ensure(), true);
  rmSync(modules, { recursive: true });
  assert.throws(() => ensureSandboxDependencies(dir, () => { throw new Error('offline'); }), /offline/);
  assert.equal(ensure(), true);
  assert.equal(ensure(), false);
  assert.equal(installs, 6);
});
