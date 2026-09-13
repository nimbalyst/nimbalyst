// @vitest-environment node
/**
 * Cursor Agent is the only provider told about MCP servers through a file, and
 * that file is `~/.cursor/mcp.json` — which the user also owns and edits. So
 * the properties under test are "we did not clobber their config", plus the one
 * that matters most: the resolved, credential-bearing server map never lands
 * anywhere inside a repository, and any copy an earlier build left in one gets
 * cleaned up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// The service resolves its target from `os.homedir()`, so the only way to
// exercise the real write path without touching the developer's own
// `~/.cursor/mcp.json` is to point homedir at a temp dir for the duration.
const fakeHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome.dir || actual.homedir() };
});

import {
  HeadlessAgentMcpConfigService,
  mergeNimbalystMcpServers,
  cleanWorkspaceMcpConfig,
  resolveHeadlessAgentMcpConfigPath,
  type HeadlessAgentMcpTarget,
} from '../HeadlessAgentMcpConfigService';

describe('mergeNimbalystMcpServers', () => {
  it('keeps every server the user added and namespaces only its own', () => {
    const merged = mergeNimbalystMcpServers(
      {
        mcpServers: {
          'my-server': { command: 'mine' },
          'nimbalyst:stale': { command: 'old' },
        },
        someOtherSetting: true,
      },
      { trackers: { command: 'node', args: ['trackers.js'] } },
    );

    expect(merged.mcpServers).toEqual({
      'my-server': { command: 'mine' },
      'nimbalyst:trackers': { command: 'node', args: ['trackers.js'] },
    });
    // Unrelated top-level keys survive a merge untouched.
    expect(merged.someOtherSetting).toBe(true);
  });

  it('removes stale Nimbalyst entries when the enabled set is empty', () => {
    const merged = mergeNimbalystMcpServers(
      { mcpServers: { 'nimbalyst:gone': { command: 'x' }, keep: { command: 'y' } } },
      {},
    );
    expect(merged.mcpServers).toEqual({ keep: { command: 'y' } });
  });
});

describe('resolveHeadlessAgentMcpConfigPath', () => {
  it('resolves to the home file for every target, with no way to name a workspace', () => {
    // Every target this service accepts, so a new one cannot quietly reopen a
    // credential-bearing file for an agent that gets its servers inline. Grok
    // is not a target: it receives them through ACP `session/new`, and the
    // `~/.grok/mcp.json` this used to write is mode 0644 resolved secrets.
    const targets: HeadlessAgentMcpTarget[] = ['cursor-agent'];
    for (const target of targets) {
      expect(resolveHeadlessAgentMcpConfigPath(target, '/home/u'))
        .toBe(path.join('/home/u', '.cursor', 'mcp.json'));
    }
    // A stray second argument is the homedir, not a workspace. The signature
    // taking no workspace at all is the guarantee: there is no argument a
    // caller could pass to get a path inside a repository back.
    expect(resolveHeadlessAgentMcpConfigPath('cursor-agent', '/proj'))
      .toBe(path.join('/proj', '.cursor', 'mcp.json'));
  });
});

describe('cleanWorkspaceMcpConfig', () => {
  let workspace: string;
  const cursorDir = () => path.join(workspace, '.cursor');
  const legacyPath = () => path.join(cursorDir(), 'mcp.json');
  const writeLegacy = async (contents: string) => {
    await fs.mkdir(cursorDir(), { recursive: true });
    await fs.writeFile(legacyPath(), contents, 'utf8');
  };

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-mcp-clean-'));
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('does nothing when the workspace has no such file', async () => {
    expect(await cleanWorkspaceMcpConfig(workspace)).toBeNull();
    await expect(fs.access(cursorDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a malformed file untouched rather than guessing at its contents', async () => {
    await writeLegacy('{ this is not json');
    expect(await cleanWorkspaceMcpConfig(workspace)).toBeNull();
    expect(await fs.readFile(legacyPath(), 'utf8')).toBe('{ this is not json');
  });

  it("leaves a file with no Nimbalyst entries untouched -- it is someone else's", async () => {
    const theirs = `${JSON.stringify({ mcpServers: { mine: { command: 'x' } } }, null, 2)}\n`;
    await writeLegacy(theirs);
    expect(await cleanWorkspaceMcpConfig(workspace)).toBeNull();
    expect(await fs.readFile(legacyPath(), 'utf8')).toBe(theirs);
  });

  it('deletes the file and the directory when the whole thing was ours', async () => {
    await writeLegacy(JSON.stringify({ mcpServers: { 'nimbalyst:trackers': { command: 'node' } } }));

    expect(await cleanWorkspaceMcpConfig(workspace)).toBe(legacyPath());

    await expect(fs.access(legacyPath())).rejects.toMatchObject({ code: 'ENOENT' });
    // Nothing else put anything in `.cursor/`, so we were the only reason it existed.
    await expect(fs.access(cursorDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('strips only our keys and keeps the directory when the user has other config there', async () => {
    await writeLegacy(
      JSON.stringify({
        mcpServers: { 'nimbalyst:trackers': { command: 'node' }, mine: { command: 'x' } },
        someOtherSetting: true,
      }),
    );
    await fs.writeFile(path.join(cursorDir(), 'rules.md'), 'theirs', 'utf8');

    expect(await cleanWorkspaceMcpConfig(workspace)).toBe(legacyPath());

    const parsed = JSON.parse(await fs.readFile(legacyPath(), 'utf8'));
    expect(parsed.mcpServers).toEqual({ mine: { command: 'x' } });
    expect(parsed.someOtherSetting).toBe(true);
    expect(await fs.readFile(path.join(cursorDir(), 'rules.md'), 'utf8')).toBe('theirs');
  });

  it('keeps a now-empty file that still carries the user other top-level settings', async () => {
    await writeLegacy(
      JSON.stringify({ mcpServers: { 'nimbalyst:trackers': { command: 'node' } }, someOtherSetting: true }),
    );

    expect(await cleanWorkspaceMcpConfig(workspace)).toBe(legacyPath());

    const parsed = JSON.parse(await fs.readFile(legacyPath(), 'utf8'));
    expect(parsed).toEqual({ mcpServers: {}, someOtherSetting: true });
  });
});

/** Every file under `dir`, relative and sorted; `[]` when it does not exist. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
}

describe('HeadlessAgentMcpConfigService.sync', () => {
  let workspace: string;
  const service = new HeadlessAgentMcpConfigService();
  const homeConfigPath = () => path.join(fakeHome.dir, '.cursor', 'mcp.json');
  const workspaceConfigPath = () => path.join(workspace, '.cursor', 'mcp.json');

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-mcp-ws-'));
    fakeHome.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-mcp-home-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(fakeHome.dir, { recursive: true, force: true });
    fakeHome.dir = '';
  });

  it('writes resolved credentials to the home file and nothing at all into the workspace', async () => {
    const { path: written } = await service.sync(
      'cursor-agent',
      {
        discord: { command: 'node', env: { DISCORD_TOKEN: 'sk-live-abc123' } },
        vendor: { command: 'some-mcp', args: ['--api-key', 'SYNTH_ARGV'] },
      },
      workspace,
    );

    expect(written).toBe(homeConfigPath());
    const raw = await fs.readFile(homeConfigPath(), 'utf8');
    // The servers still work: the home file is where the CLI reads them from,
    // and it is the same class of material as the ~/.claude.json they came from.
    expect(raw).toContain('sk-live-abc123');
    expect(raw).toContain('SYNTH_ARGV');
    // The guarantee is about the destination, not the content: no byte of this
    // is reachable from `git add -A` in the user's repository.
    await expect(fs.access(path.join(workspace, '.cursor'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Belt and braces against the whole workspace tree, so a future change that
    // writes the map somewhere else under the repo is caught here too.
    expect(await filesUnder(workspace)).toEqual([]);
  });

  it('creates the home file 0600, and leaves an existing file its own mode', async () => {
    await service.sync('cursor-agent', { trackers: { command: 'node' } }, workspace);
    expect((await fs.stat(homeConfigPath())).mode & 0o777).toBe(0o600);

    await fs.chmod(homeConfigPath(), 0o644);
    await service.sync('cursor-agent', { other: { command: 'node' } }, workspace);
    // The user's own file keeps the permissions they (or Cursor) gave it.
    expect((await fs.stat(homeConfigPath())).mode & 0o777).toBe(0o644);
  });

  it('does not rewrite an unchanged file', async () => {
    await service.sync('cursor-agent', { trackers: { command: 'node' } }, workspace);
    const second = await service.sync('cursor-agent', { trackers: { command: 'node' } }, workspace);
    // Rewriting on every turn would churn a file the user may have open.
    expect(second.path).toBeNull();
  });

  it('leaves a malformed home config alone rather than replacing it', async () => {
    await fs.mkdir(path.dirname(homeConfigPath()), { recursive: true });
    await fs.writeFile(homeConfigPath(), '{ this is not json', 'utf8');

    const { path: written } = await service.sync('cursor-agent', { trackers: { command: 'node' } }, workspace);

    expect(written).toBeNull();
    // The user's file is configuration we failed to read, not configuration
    // that is worthless. Overwriting it destroys settings we cannot see.
    expect(await fs.readFile(homeConfigPath(), 'utf8')).toBe('{ this is not json');
  });

  it('creates nothing on an empty map when no file exists yet', async () => {
    const { path: written } = await service.sync('cursor-agent', {}, workspace);

    expect(written).toBeNull();
    await expect(fs.access(path.join(fakeHome.dir, '.cursor'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still clears its own stale entries from a home file that already exists', async () => {
    await service.sync('cursor-agent', { trackers: { command: 'node' } }, workspace);

    const { path: written } = await service.sync('cursor-agent', {}, workspace);

    expect(written).toBe(homeConfigPath());
    expect(JSON.parse(await fs.readFile(homeConfigPath(), 'utf8')).mcpServers).toEqual({});
  });

  it('leaves an unrelated config completely alone when there is nothing of ours in it', async () => {
    // Compact, hand-written, no trailing newline: exactly what gets reformatted
    // if the no-op check compares serialized text instead of structure.
    const theirs = '{"mcpServers":{"cursor-ide":{"command":"x"}},"someOtherSetting":true}';
    await fs.mkdir(path.dirname(homeConfigPath()), { recursive: true });
    await fs.writeFile(homeConfigPath(), theirs, 'utf8');

    const { path: written } = await service.sync('cursor-agent', {}, workspace);

    expect(written).toBeNull();
    expect(await fs.readFile(homeConfigPath(), 'utf8')).toBe(theirs);
  });

  it('does not reformat a compact file whose Nimbalyst set already matches', async () => {
    // Non-empty map, so the empty-map guard is not what protects this: only a
    // structural no-op check does. A textual comparison reindents the file on
    // every single turn.
    const theirs = '{"mcpServers":{"nimbalyst:trackers":{"command":"node"}}}';
    await fs.mkdir(path.dirname(homeConfigPath()), { recursive: true });
    await fs.writeFile(homeConfigPath(), theirs, 'utf8');

    const { path: written } = await service.sync('cursor-agent', { trackers: { command: 'node' } }, workspace);

    expect(written).toBeNull();
    expect(await fs.readFile(homeConfigPath(), 'utf8')).toBe(theirs);
  });

  it('does not add an mcpServers key to a config that never had one', async () => {
    // Empty map against a file with no `mcpServers` at all: the merge result
    // differs structurally (it gains `mcpServers: {}`), so only the empty-map
    // rule keeps us from editing a file that has nothing of ours in it.
    const theirs = '{"someOtherSetting":true}';
    await fs.mkdir(path.dirname(homeConfigPath()), { recursive: true });
    await fs.writeFile(homeConfigPath(), theirs, 'utf8');

    const { path: written } = await service.sync('cursor-agent', {}, workspace);

    expect(written).toBeNull();
    expect(await fs.readFile(homeConfigPath(), 'utf8')).toBe(theirs);
  });

  it('replaces the file rather than overwriting it in place', async () => {
    // The in-process queue orders our own syncs, but the Cursor app and a
    // second Nimbalyst instance read this file whenever they like. A rename is
    // what makes a reader see either the whole old document or the whole new
    // one; an in-place write exposes a truncated file. A fresh inode is the
    // observable signature of that rename.
    await service.sync('cursor-agent', { trackers: { command: 'node' } }, workspace);
    const before = (await fs.stat(homeConfigPath())).ino;

    await service.sync('cursor-agent', { other: { command: 'node' } }, workspace);

    expect((await fs.stat(homeConfigPath())).ino).not.toBe(before);
  });

  it('survives concurrent syncs of unequal length without ever leaving invalid JSON', async () => {
    // Two workspaces starting turns at once share this one file. Interleaved
    // read-merge-writes used to leave the shorter document's trailing bytes
    // after the longer one, which no JSON parser will accept.
    const payloadFor = (index: number): Record<string, { command: string; args?: string[] }> =>
      index % 2 === 0
        ? { short: { command: 'a' } }
        : Object.fromEntries(
            Array.from({ length: 40 }, (_, slot) => [
              `long-${slot}`,
              { command: 'b'.repeat(200), args: ['--flag', 'c'.repeat(200)] },
            ]),
          );

    const reads: Promise<void>[] = [];
    const syncs = Array.from({ length: 30 }, (_, index) => {
      const done = service.sync('cursor-agent', payloadFor(index), workspace);
      reads.push(
        done.then(async () => {
          const raw = await fs.readFile(homeConfigPath(), 'utf8');
          // Throws, and fails the test, on a torn document.
          expect(() => JSON.parse(raw)).not.toThrow();
        }),
      );
      return done;
    });

    await Promise.all(syncs);
    await Promise.all(reads);

    // Last writer wins, intact: index 29 is odd, so the long payload.
    const finalConfig = JSON.parse(await fs.readFile(homeConfigPath(), 'utf8'));
    expect(Object.keys(finalConfig.mcpServers).sort()).toEqual(
      Object.keys(payloadFor(29))
        .map((name) => `nimbalyst:${name}`)
        .sort(),
    );
  });

  it('leaves no temp files behind', async () => {
    await service.sync('cursor-agent', { trackers: { command: 'node' } }, workspace);
    await service.sync('cursor-agent', { other: { command: 'node' } }, workspace);
    expect(await fs.readdir(path.dirname(homeConfigPath()))).toEqual(['mcp.json']);
  });

  it('cleans up the in-workspace file an earlier build wrote, and says which one', async () => {
    await fs.mkdir(path.dirname(workspaceConfigPath()), { recursive: true });
    await fs.writeFile(
      workspaceConfigPath(),
      JSON.stringify({ mcpServers: { 'nimbalyst:discord': { env: { DISCORD_TOKEN: 'sk-live-abc123' } } } }),
      'utf8',
    );

    const { cleanedWorkspacePath } = await service.sync(
      'cursor-agent',
      { trackers: { command: 'node' } },
      workspace,
    );

    expect(cleanedWorkspacePath).toBe(workspaceConfigPath());
    await expect(fs.access(workspaceConfigPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
