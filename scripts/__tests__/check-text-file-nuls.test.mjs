import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  findTrackedTextFilesWithNuls,
  isTextLikePath,
} from '../check-text-file-nuls.mjs';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'nimbalyst-text-nuls-'));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

test('classifies source and config files without treating binary assets as text', () => {
  assert.equal(isTextLikePath('packages/app/src/example.ts'), true);
  assert.equal(isTextLikePath('.gitattributes'), true);
  assert.equal(isTextLikePath('design/example.excalidraw'), true);
  assert.equal(isTextLikePath('assets/example.png'), false);
  assert.equal(isTextLikePath('samples/example.db'), false);
});

test('finds raw NULs in tracked text files and ignores binary assets', () => {
  execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot });
  writeFileSync(path.join(fixtureRoot, 'bad.ts'), Buffer.from('const key = "left\0right";\n'));
  writeFileSync(path.join(fixtureRoot, 'good.ts'), 'const key = "left\\u0000right";\n');
  writeFileSync(path.join(fixtureRoot, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  execFileSync('git', ['add', '.'], { cwd: fixtureRoot });

  assert.deepEqual(findTrackedTextFilesWithNuls({ cwd: fixtureRoot }), ['bad.ts']);

  execFileSync(
    'git',
    ['-c', 'user.name=Nimbalyst Test', '-c', 'user.email=test@nimbalyst.local', 'commit', '--quiet', '-m', 'fixture'],
    { cwd: fixtureRoot },
  );
  assert.deepEqual(findTrackedTextFilesWithNuls({ cwd: fixtureRoot, ref: 'HEAD' }), ['bad.ts']);
});
