import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BASELINE_PATH,
  scanIdentityScopeViolations,
} from '../check-identity-scopes.mjs';

function withFixture(source, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-scope-check-'));
  const target = path.join(root, 'src');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'fixture.ts'), source);
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('rejects bare identity and JWT declarations', () => {
  withFixture(`
    interface Wrong { userId: string }
    interface AlsoWrong { teamMemberId: string }
    const useJwt = (jwt: string) => jwt;
    interface Seam { getJwt: () => Promise<string> }
  `, (root) => {
    const violations = scanIdentityScopeViolations({ root, targets: ['src'] });
    assert.deepEqual(violations.map(({ rule }) => rule), [
      'bare member identity',
      'bare member identity',
      'bare JWT',
      'erased getJwt return type',
    ]);
  });
});

test('allows branded declarations and a documented scope-neutral escape', () => {
  withFixture(`
    interface Scoped { teamMemberId: TeamMemberId; jwt: TeamJwt }
    // identity-scope-allow: decoder accepts either JWT brand
    const decode = (jwt: string) => jwt.split('.');
  `, (root) => {
    assert.deepEqual(scanIdentityScopeViolations({ root, targets: ['src'] }), []);
  });
});

test('catches identity names an exact-name allowlist would miss', () => {
  withFixture(`
    interface Wrong { authorUserId: string }
    interface AlsoWrong { creatorMemberId: string }
    interface JwtWrong { sessionJwt: string }
  `, (root) => {
    assert.deepEqual(scanIdentityScopeViolations({ root, targets: ['src'] }).map(({ rule }) => rule), [
      'bare member identity',
      'bare member identity',
      'bare JWT',
    ]);
  });
});

test('a baselined declaration is forgiven exactly once per occurrence', () => {
  withFixture([
    'interface One {',
    '  memberId: string;',
    '}',
    'interface Two {',
    '  memberId: string;',
    '}',
  ].join('\n'), (root) => {
    const baseline = new Map([['src/fixture.ts', ['memberId: string;']]]);
    const violations = scanIdentityScopeViolations({ root, targets: ['src'], baseline });
    assert.equal(violations.length, 1, 'the second occurrence must still fail');
  });
});

test('the repository identity paths satisfy the gate, modulo the recorded baseline', () => {
  const baseline = new Map(Object.entries(
    JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')),
  ));
  assert.deepEqual(scanIdentityScopeViolations({ baseline }), []);
});

test('every baseline entry still matches a real declaration', () => {
  // A stale entry silently widens the gate, so shrinking the baseline must be
  // the only way an entry ever leaves it.
  const baseline = new Map(Object.entries(
    JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')),
  ));
  const unbaselined = scanIdentityScopeViolations();
  for (const [file, sources] of baseline) {
    for (const source of sources) {
      assert.ok(
        unbaselined.some((v) => v.file === file && v.source === source),
        `stale baseline entry (declaration is gone -- delete it): ${file} :: ${source}`,
      );
    }
  }
});
