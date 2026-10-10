// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspaceFileForOpen } from '../workspaceFileForOpen';

describe('resolveWorkspaceFileForOpen', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-link-'));
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.mkdir(path.join(root, 'sub'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves an existing workspace file, relative or absolute', async () => {
    const expected = path.join(root, 'package.json');
    expect(await resolveWorkspaceFileForOpen(root, 'package.json')).toBe(expected);
    expect(await resolveWorkspaceFileForOpen(root, expected)).toBe(expected);
  });

  it('rejects missing files, directories, and anything outside the workspace', async () => {
    expect(await resolveWorkspaceFileForOpen(root, 'missing.json')).toBeNull();
    expect(await resolveWorkspaceFileForOpen(root, 'sub')).toBeNull();
    expect(await resolveWorkspaceFileForOpen(root, '../package.json')).toBeNull();
    expect(await resolveWorkspaceFileForOpen(root, path.join(os.tmpdir()))).toBeNull();
  });
});
