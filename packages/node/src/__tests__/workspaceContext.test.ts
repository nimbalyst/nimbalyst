// @vitest-environment node
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {it, expect} from 'vitest';
import {readWorkspaceContext, expandRemoteCommand} from '../serve/workspaceContext.js';

it('lists the selected checkout and expands only its bounded explicit command catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-context-test-'));
  const root = join(directory, 'repo');
  try {
    await mkdir(join(root, '.claude', 'commands'), {recursive: true});
    execFileSync('git', ['init', '--quiet'], {cwd: root});
    await writeFile(join(root, 'remote-file.ts'), 'export {};');
    await writeFile(join(root, '.claude', 'commands', 'review.md'), 'Review $ARGUMENTS');
    await writeFile(join(directory, 'outside.md'), 'ambient command');
    await symlink(join(directory, 'outside.md'), join(root, '.claude', 'commands', 'outside.md'));
    await writeFile(join(root, '.claude', 'commands', 'too-large.md'), 'x'.repeat(32001));
    const context = await readWorkspaceContext(root);
    expect(context.files).toContain('remote-file.ts');
    expect(context.commands.map(command => command.name)).toEqual(['review']);
    expect(await expandRemoteCommand('/review README', root)).toContain('Review README');
    await expect(expandRemoteCommand('/outside', root)).rejects.toThrow('not available on this machine');
    expect(await expandRemoteCommand('Ordinary text', root)).toBe('Ordinary text');
  } finally {await rm(directory, {recursive: true, force: true});}
});
