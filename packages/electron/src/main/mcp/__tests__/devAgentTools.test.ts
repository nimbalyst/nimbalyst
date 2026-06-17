/**
 * Security + behavior tests for the dev-agent write_file tool.
 *
 * write_file is the new write capability for the standard (non-meta) extension
 * agent session. It is gated on workspace-files and MUST NOT let the model
 * write outside the bound workspace - including through an existing symlink
 * whose link file lives inside the workspace but points outside it (Node's
 * writeFile follows symlinks). These tests drive the real dispatchDevAgentTool.
 */
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchDevAgentTool } from '../devAgentTools';

const cleanup: string[] = [];

afterEach(async () => {
  for (const d of cleanup.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'nim-devtools-ws-'));
  cleanup.push(ws);
  return ws;
}

describe('dispatchDevAgentTool write_file', () => {
  it('writes a file with the given content under the workspace', async () => {
    const ws = await makeWorkspace();
    const out = await dispatchDevAgentTool('write_file', ws, {
      path: 'notes/report.md',
      content: 'hello world',
    });
    expect(out).toMatch(/Wrote notes[/\\]report\.md/);
    const written = await readFile(join(ws, 'notes', 'report.md'), 'utf8');
    expect(written).toBe('hello world');
  });

  it('rejects an absolute path outside the workspace', async () => {
    const ws = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'nim-outside-'));
    cleanup.push(outside);
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'ORIGINAL', 'utf8');

    const out = await dispatchDevAgentTool('write_file', ws, {
      path: victim, // absolute, outside the workspace
      content: 'PWNED',
    });
    expect(out).toMatch(/outside the workspace/i);
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL');
  });

  it('does not follow an in-workspace symlink that points outside the workspace', async () => {
    const ws = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'nim-outside-'));
    cleanup.push(outside);
    const victim = join(outside, 'secret.txt');
    await writeFile(victim, 'ORIGINAL', 'utf8');

    // Some platforms (Windows without Developer Mode) can't create symlinks
    // unprivileged - skip there; CI (Linux) exercises the guard.
    try {
      await symlink(victim, join(ws, 'link'));
    } catch {
      return;
    }

    const out = await dispatchDevAgentTool('write_file', ws, {
      path: 'link', // in-workspace symlink -> outside victim
      content: 'PWNED',
    });
    expect(out).toMatch(/outside the workspace|symlink escape/i);
    // The escape was blocked: the outside victim is untouched.
    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL');
  });

  it('rejects a parent-traversal path', async () => {
    const ws = await makeWorkspace();
    await mkdir(join(ws, 'sub'), { recursive: true });
    const out = await dispatchDevAgentTool('write_file', ws, {
      path: 'sub/../../escape.txt',
      content: 'PWNED',
    });
    expect(out).toMatch(/outside the workspace/i);
  });
});
