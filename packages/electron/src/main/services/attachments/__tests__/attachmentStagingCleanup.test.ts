// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ATTACHMENT_STAGING_MAX_AGE_MS, reapAttachmentStagingDirectory } from '../attachmentStagingCleanup';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fs.rm(fixture, { recursive: true, force: true })));
});

describe('attachmentStagingCleanup', () => {
  it('removes orphan owners and expired files while retaining fresh owned files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-cleanup-'));
    fixtures.push(root);
    const now = Date.now();
    const owned = path.join(root, 'saved', 'active-session');
    const orphan = path.join(root, 'saved', 'missing-session');
    await fs.mkdir(owned, { recursive: true });
    await fs.mkdir(orphan, { recursive: true });
    const freshFile = path.join(owned, 'fresh.txt');
    const oldFile = path.join(owned, 'old.txt');
    await fs.writeFile(freshFile, 'fresh');
    await fs.writeFile(oldFile, 'old');
    await fs.writeFile(path.join(orphan, 'orphan.txt'), 'orphan');
    const oldTime = new Date(now - ATTACHMENT_STAGING_MAX_AGE_MS - 1_000);
    await fs.utimes(oldFile, oldTime, oldTime);

    const result = await reapAttachmentStagingDirectory({
      directory: root,
      mode: 'workspace',
      validSessionIds: ['active-session'],
      now,
    });

    expect(result).toEqual({ removedFiles: 1, removedOwnerDirectories: 1 });
    await expect(fs.readFile(freshFile, 'utf-8')).resolves.toBe('fresh');
    await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves temp mode to OS cleanup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-cleanup-temp-'));
    fixtures.push(root);
    const result = await reapAttachmentStagingDirectory({
      directory: root,
      mode: 'temp',
      validSessionIds: [],
    });
    expect(result).toEqual({ removedFiles: 0, removedOwnerDirectories: 0 });
  });
});
