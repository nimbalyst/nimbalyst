// The release decision behind /publish-npm: what to do given local and npm versions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decide } from '../npm-publish-status.mjs';

test('a group publishes only when it changed, and never with mismatched or older versions', () => {
  assert.equal(decide({ localVersions: ['0.1.0', '0.1.0'], published: '0.1.0', changed: false }).status, 'up to date');
  assert.equal(decide({ localVersions: ['0.1.0', '0.1.0'], published: '0.1.0', changed: true }).status, 'bump+publish');
  assert.equal(decide({ localVersions: ['0.1.1', '0.1.1'], published: '0.1.0', changed: true }).status, 'publish (already bumped)');
  // Numeric, not lexical: 0.10.0 is newer than 0.9.0.
  assert.equal(decide({ localVersions: ['0.10.0'], published: '0.9.0', changed: false }).status, 'publish (already bumped)');
  assert.equal(decide({ localVersions: ['0.1.0'], published: '0.2.0', changed: true }).status, 'LOCAL BEHIND NPM');
  assert.equal(decide({ localVersions: ['0.1.1', '0.1.0'], published: '0.1.0', changed: true }).status, 'VERSIONS DIFFER');
  assert.equal(decide({ localVersions: ['0.1.0'], published: null, changed: true }).status, 'never published');
});

// The 0.3.0 publish failed after a green dry run: only the verify job checked
// out the mind map extension, and the publish job rebuilds wiki-web on its own runner.
test('every publish-cli job that builds wiki-web has the mind map checkout', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/publish-cli.yml', import.meta.url), 'utf8');
  const jobs = workflow.split(/\r?\n {2}(?=[a-z-]+:\r?\n)/).slice(1);
  const building = jobs.filter((job) => job.includes('@nimbalyst/wiki-web run build'));
  assert.equal(building.length, 2);
  for (const job of building) {
    const name = job.slice(0, job.indexOf(':'));
    assert.match(job, /repository: nimbalyst\/nimbalyst-mindmap/, `${name} checks out the mind map extension`);
    assert.match(job, /NIMBALYST_EXTENSION_CHECKOUTS:/, `${name} points the build at the checkouts`);
  }
});
