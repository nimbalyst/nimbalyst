// @vitest-environment node

import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { directorySizeBytes } from '../../recovery/recoveryFs';
import { dirSizeBytes } from '../dirSize';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp('/tmp/nim-dir-size-');
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('directory size', () => {
  it('measures a deeply nested real directory at the platform path limit', async () => {
    const root = await makeTempRoot();
    let current = root;
    // macOS PATH_MAX is 1024 bytes. One-character components make 450 levels
    // the deepest useful real-filesystem fixture with room for the payload.
    for (let depth = 0; depth < 450; depth += 1) {
      current = path.join(current, 'd');
      await fs.mkdir(current);
    }
    const contents = 'deep-directory-payload';
    await fs.writeFile(path.join(current, 'data'), contents);

    await expect(directorySizeBytes(root)).resolves.toBe(Buffer.byteLength(contents));
  });

  it('keeps the synchronous and asynchronous variants equivalent', async () => {
    const root = await makeTempRoot();
    await fs.mkdir(path.join(root, 'nested'));
    await Promise.all([
      fs.writeFile(path.join(root, 'one'), '1234'),
      fs.writeFile(path.join(root, 'nested', 'two'), '56789'),
    ]);

    expect(await directorySizeBytes(root)).toBe(dirSizeBytes(root));
  });
});
