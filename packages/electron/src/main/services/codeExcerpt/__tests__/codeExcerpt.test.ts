// @vitest-environment node
/**
 * What an excerpt may read: committed content of tracked, non-dot files in the
 * calling window's own workspace. Never the working tree, never an ignored or
 * untracked file, never a root the renderer picked.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => ({ id: 1 }) } }));
vi.mock('../../../window/WindowManager', () => ({ getWindowId: () => 7 }));
vi.mock('../../../window/captureWindowWorkspace', () => ({ resolveSenderWorkspacePath: () => '/the/window/workspace' }));

import { readCodeExcerptFile, resolveExcerptPath } from '../readCodeExcerptFile';
import { registerCodeExcerptHandlers } from '../../../ipc/CodeExcerptHandlers';

let repo = '';
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });

beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'excerpt-')));
  git('init', '-q');
  // Never let a fixture commit land in the real checkout.
  expect(realpathSync(git('rev-parse', '--show-toplevel').trim())).toBe(repo);
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src/a.ts'), 'one\ntwo\n');
  writeFileSync(path.join(repo, '.env'), 'SECRET=committed\n');
  writeFileSync(path.join(repo, '.gitignore'), 'secret.txt\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, 'src/a.ts'), 'one\nlocal edit\n');
  writeFileSync(path.join(repo, 'secret.txt'), 'TOKEN=ignored\n');
  writeFileSync(path.join(repo, 'untracked.ts'), 'draft\n');
});

afterAll(() => handlers.clear());

describe('readCodeExcerptFile', () => {
  it('reads the committed text of a tracked file, not the working tree', async () => {
    const file = await readCodeExcerptFile(repo, 'src/a.ts');
    expect(file.text).toBe('one\ntwo\n');
    expect(file.head).toMatch(/^[0-9a-f]{9}$/);
  });

  it.each(['.env', 'secret.txt', 'untracked.ts'])('never returns the contents of %s', async (relative) => {
    const file = await readCodeExcerptFile(repo, relative);
    expect(file.text).toBeNull();
  });

  it('keeps paths inside the workspace', () => {
    expect(resolveExcerptPath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
    expect(resolveExcerptPath('/repo', '../other/secret')).toBeNull();
    expect(resolveExcerptPath('/repo', 'src/../../etc/passwd')).toBeNull();
    expect(resolveExcerptPath('/repo', '/etc/passwd')).toBeNull();
    expect(resolveExcerptPath('/repo', '')).toBeNull();
  });
});

describe('code-excerpt:read', () => {
  it('rejects a workspacePath that is not the calling window workspace', async () => {
    registerCodeExcerptHandlers();
    const handler = handlers.get('code-excerpt:read')!;
    await expect(Promise.resolve().then(() => handler({ sender: { id: 3 } }, { workspacePath: '/', path: 'etc/hosts' }))).rejects.toThrow(/workspace/i);
  });
});
