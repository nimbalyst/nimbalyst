// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fsWithoutAsar, removeDirectoryTree } from '../directoryRemoval';

// Electron's asar patch exists only in its main process, so these tests pin
// the choice of module; a tree holding an `.asar` file cannot hang under Node.
describe('fsWithoutAsar', () => {
  it('loads original-fs in Electron, whose fs reads every .asar file as a directory', () => {
    const originalFs = { promises: {} };
    const load = vi.fn(() => originalFs);

    expect(fsWithoutAsar({ ...process.versions, electron: '43.2.0' }, load)).toBe(originalFs);
    expect(load).toHaveBeenCalledWith('original-fs');
  });

  it('uses plain fs outside Electron', () => {
    const load = vi.fn();
    const { electron: _electron, ...versions } = process.versions;

    expect(fsWithoutAsar(versions as NodeJS.ProcessVersions, load)).toBe(fs);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('removeDirectoryTree', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('deletes a tree, including an .asar file and a .git file', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-rmtree-'));
    const target = path.join(root, 'checkout');
    const resources = path.join(target, 'node_modules', 'electron', 'dist', 'resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, 'default_app.asar'), 'asar');
    fs.writeFileSync(path.join(target, '.git'), 'gitdir: elsewhere\n');

    await removeDirectoryTree(target);

    expect(fs.existsSync(target)).toBe(false);
  });

  it('waits for a slow delete to finish, so no delete goes on after the caller has given up', async () => {
    // A caller that stopped waiting would report the worktree as still there
    // and show its sessions again while the delete went on, deleting
    // whatever was written into the checkout in the meantime.
    vi.useFakeTimers();
    try {
      let finish = () => {};
      const rm = vi.fn(() => new Promise<void>((resolve) => {
        finish = resolve;
      }));
      let outcome = 'pending';
      const removal = removeDirectoryTree('/slow', { fsModule: { promises: { rm } } as never })
        .then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(outcome).toBe('pending');

      finish();
      await removal;
      expect(outcome).toBe('resolved');
      expect(rm).toHaveBeenCalledWith('/slow', { recursive: true, force: true, maxRetries: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes on a failed delete', async () => {
    const rm = vi.fn(async () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });

    await expect(removeDirectoryTree('/busy', { fsModule: { promises: { rm } } as never })).rejects.toThrow('EBUSY');
  });
});
