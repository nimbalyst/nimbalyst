// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureGitExcluded,
  syncMcpServersToAgy,
  writeManagedMcpFile,
} from '../agyMcpSync';

describe('agyMcpSync', () => {
  let tmpDir: string;
  let homeDir: string;
  let workspaceDir: string;
  let fakeNodePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-sync-'));
    homeDir = path.join(tmpDir, 'home');
    workspaceDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fakeNodePath = path.join(homeDir, '.local', 'bin', 'node');
    fs.mkdirSync(path.dirname(fakeNodePath), { recursive: true });
    fs.writeFileSync(fakeNodePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('syncs global user MCPs to ~/.gemini/config and workspace + built-in MCPs to <workspace>/.agents', async () => {
    // Seed a manual user entry in both scopes to ensure it is preserved.
    const globalDir = path.join(homeDir, '.gemini', 'config');
    const wsAgentsDir = path.join(workspaceDir, '.agents');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(wsAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { manualUserServer: { command: 'my-cli', args: [] } } }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(wsAgentsDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { manualProjectServer: { command: 'proj-cli', args: [] } } }),
      'utf8',
    );

    const fp1 = await syncMcpServersToAgy(
      workspaceDir,
      'session-A',
      async () => ({
        globalServers: {
          gmail: { command: '/usr/bin/electron', args: ['gmail.js'], env: { ELECTRON_RUN_AS_NODE: '1', FOO: 'bar' } },
          stripe: { url: 'https://mcp.stripe.com', type: 'http', headers: { Authorization: 'Bearer tok' } },
        },
        workspaceServers: {
          'nimbalyst-browser': {
            url: 'http://127.0.0.1:43210/mcp/browser?sessionId=session-A',
            type: 'sse',
            headers: { Authorization: 'Bearer internal-secret' },
          },
          'external-sse-ignored': {
            url: 'https://example.com/sse',
            type: 'sse',
          },
        },
      }),
      { homeDir, localNodePath: fakeNodePath },
    );

    const globalJson = JSON.parse(fs.readFileSync(path.join(globalDir, 'mcp_config.json'), 'utf8'));
    expect(globalJson.mcpServers.manualUserServer).toEqual({ command: 'my-cli', args: [] });
    expect(globalJson.mcpServers.gmail).toEqual({
      command: fakeNodePath,
      args: ['gmail.js'],
      env: { FOO: 'bar' },
    });
    expect(globalJson.mcpServers.stripe).toEqual({
      serverUrl: 'https://mcp.stripe.com',
      headers: { Authorization: 'Bearer tok' },
    });

    const wsJson = JSON.parse(fs.readFileSync(path.join(wsAgentsDir, 'mcp_config.json'), 'utf8'));
    expect(wsJson.mcpServers.manualProjectServer).toEqual({ command: 'proj-cli', args: [] });
    expect(wsJson.mcpServers['nimbalyst-browser']).toEqual({
      serverUrl: 'http://127.0.0.1:43210/mcp/browser?sessionId=session-A',
      headers: { Authorization: 'Bearer internal-secret' },
    });
    expect(wsJson.mcpServers['external-sse-ignored']).toBeUndefined();

    // Changing only sessionId on the internal MCP URL produces the same stable fingerprint
    const fp2 = await syncMcpServersToAgy(
      workspaceDir,
      'session-B',
      async () => ({
        globalServers: {
          gmail: { command: '/usr/bin/electron', args: ['gmail.js'], env: { ELECTRON_RUN_AS_NODE: '1', FOO: 'bar' } },
          stripe: { url: 'https://mcp.stripe.com', type: 'http', headers: { Authorization: 'Bearer tok' } },
        },
        workspaceServers: {
          'nimbalyst-browser': {
            url: 'http://127.0.0.1:43210/mcp/browser?sessionId=session-B',
            type: 'sse',
            headers: { Authorization: 'Bearer internal-secret' },
          },
        },
      }),
      { homeDir, localNodePath: fakeNodePath },
    );
    expect(fp2).toBe(fp1);
  });

  it('removes previously Nimbalyst-managed entries when disabled while keeping manual entries', async () => {
    const dir = path.join(tmpDir, 'managed-dir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { manual: { command: 'keep-me', args: [] } } }),
      'utf8',
    );

    await writeManagedMcpFile(dir, { managedA: { command: 'a', args: [] } }, fakeNodePath, true);
    let parsed = JSON.parse(fs.readFileSync(path.join(dir, 'mcp_config.json'), 'utf8'));
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['managedA', 'manual']);

    await writeManagedMcpFile(dir, {}, fakeNodePath, true);
    parsed = JSON.parse(fs.readFileSync(path.join(dir, 'mcp_config.json'), 'utf8'));
    expect(Object.keys(parsed.mcpServers)).toEqual(['manual']);
  });

  it('adds workspace MCP sync files to .git/info/exclude for standard repos and git worktrees', async () => {
    // Standard .git directory
    fs.mkdirSync(path.join(workspaceDir, '.git', 'info'), { recursive: true });
    await ensureGitExcluded(workspaceDir, ['.agents/mcp_config.json', '.agents/.nimbalyst_synced_mcps.json']);
    await ensureGitExcluded(workspaceDir, ['.agents/mcp_config.json', '.agents/.nimbalyst_synced_mcps.json']);

    const exclude1 = fs.readFileSync(path.join(workspaceDir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude1.match(/\.agents\/mcp_config\.json/g)).toHaveLength(1);
    expect(exclude1.match(/\.agents\/\.nimbalyst_synced_mcps\.json/g)).toHaveLength(1);

    // Git worktree (.git file pointing to worktree gitdir with commondir)
    const mainGitDir = path.join(tmpDir, 'main.git');
    const wtGitDir = path.join(mainGitDir, 'worktrees', 'wt1');
    const wtWorkspace = path.join(tmpDir, 'wt1');
    fs.mkdirSync(path.join(mainGitDir, 'info'), { recursive: true });
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.mkdirSync(wtWorkspace, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8');
    fs.writeFileSync(path.join(wtWorkspace, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8');

    await ensureGitExcluded(wtWorkspace, ['.agents/mcp_config.json', '.agents/.nimbalyst_synced_mcps.json']);
    const wtExclude = fs.readFileSync(path.join(mainGitDir, 'info', 'exclude'), 'utf8');
    expect(wtExclude).toContain('.agents/mcp_config.json');
    expect(wtExclude).toContain('.agents/.nimbalyst_synced_mcps.json');
  });
});
