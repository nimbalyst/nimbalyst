import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitStatusService } from '../GitStatusService';

const execFileAsync = promisify(execFile);

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-status-sub-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

describe('GitStatusService with a subfolder workspace (#124)', () => {
  it('reports status for files when the workspace is inside the repo', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);
    const sub = path.join(tmpRoot, 'home');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'tracked.txt'), 'v1\n', 'utf8');
    await git(['add', '.'], tmpRoot);
    await git(['commit', '-q', '-m', 'init'], tmpRoot);
    await fs.writeFile(path.join(sub, 'tracked.txt'), 'v2\n', 'utf8');

    const service = new GitStatusService();
    const abs = path.join(sub, 'tracked.txt');
    const result = await service.getFileStatus(sub, [abs]);

    // Today this comes back 'untracked' because the owning-root walk is
    // bounded by the workspace and never finds tmpRoot/.git above it.
    expect(result[abs]?.status).toBe('modified');
  });

  it('lists uncommitted files across the whole repo, including outside the workspace', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);
    const sub = path.join(tmpRoot, 'home');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, '.gitignore'), 'node_modules\n', 'utf8');
    await git(['add', '.'], tmpRoot);
    await git(['commit', '-q', '-m', 'init'], tmpRoot);
    await fs.writeFile(path.join(sub, 'inner.txt'), 'inner\n', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'root.txt'), 'root\n', 'utf8');

    const service = new GitStatusService();
    const files = await service.getUncommittedFiles(sub);

    expect(files).toContain(path.join(tmpRoot, 'home', 'inner.txt'));
    expect(files).toContain(path.join(tmpRoot, 'root.txt'));
  });
});
