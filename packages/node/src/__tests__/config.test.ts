// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, requireSyncSettings, type LoadedConfig } from '../config.js';

vi.mock('../db/openDatabase.js', () => ({ openDatabase: vi.fn() }));
vi.mock('../host/nodeHost.js', () => ({ registerNodeHostEnvironment: vi.fn() }));
vi.mock('../host/claudeCodeDeps.js', () => ({ registerClaudeCodeDeps: vi.fn() }));
vi.mock('../store/NodeSessionStore.js', () => ({ createNodeSessionStore: vi.fn() }));
vi.mock('../store/NodeAgentMessagesStore.js', () => ({ createNodeAgentMessagesStore: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/SessionManager', () => ({ SessionManager: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider', () => ({ ClaudeCodeProvider: vi.fn() }));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { setStore: vi.fn() } }));

import { NimbalystNode } from '../NimbalystNode.js';
import { openDatabase } from '../db/openDatabase.js';

describe('headless execution policy', () => {
  it.each([undefined, null, {}, { mode: 'ask' }, { mode: 'allow-all' }, { mode: 'typo' }])('rejects programmatic trust %j before opening the database', async (trust) => {
    vi.mocked(openDatabase).mockClear();
    const config = { databasePath: './agent.sqlite', resolvedDatabasePath: '/unused/agent.sqlite', configPath: '/unused/config.json', trust } as LoadedConfig;
    await expect(NimbalystNode.open(config)).rejects.toThrow(/trust/);
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('accepts only an object for provisioned mcpServers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-config-'));
    const file = join(directory, 'config.json');
    const base = { databasePath: './agent.sqlite', trust: { mode: 'bypass-all' } };
    try {
      for (const mcpServers of [null, [], ['server'], 'server', 1, true]) {
        writeFileSync(file, JSON.stringify({ ...base, mcpServers }));
        expect(() => loadConfig(file)).toThrow(/mcpServers must be an object/);
      }
      for (const mcpServers of [undefined, {}, { provisioned: { command: 'node', args: ['server.js'] } }]) {
        writeFileSync(file, JSON.stringify({ ...base, mcpServers }));
        expect(loadConfig(file).mcpServers).toEqual(mcpServers);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires an explicit supported noninteractive policy before accepting configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-config-'));
    const file = join(directory, 'config.json');
    try {
      for (const trust of [undefined, null, {}, { mode: 'ask' }, { mode: 'allow-all' }, { mode: 'typo' }]) {
        writeFileSync(file, JSON.stringify({ databasePath: './agent.sqlite', trust }));
        expect(() => loadConfig(file)).toThrow(/trust/);
      }
      writeFileSync(file, JSON.stringify({ databasePath: './agent.sqlite', trust: { mode: 'bypass-all' } }));
      expect(loadConfig(file).trust).toEqual({ mode: 'bypass-all' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('serve sync settings', () => {
  const SYNC = {
    serverUrl: 'https://sync.nimbalyst.com',
    credentialPath: './node-credential.json',
    encryptionKeySeed: 'c2VlZA==',
    personalOrgId: 'organization-1',
    personalUserId: 'member-1',
    deviceId: 'sandbox-abc',
    deviceName: 'Cloudflare sandbox',
  };

  function write(directory: string, config: Record<string, unknown>): LoadedConfig {
    const file = join(directory, 'config.json');
    writeFileSync(file, JSON.stringify({
      databasePath: './agent.sqlite',
      trust: { mode: 'bypass-all' },
      ...config,
    }));
    return loadConfig(file);
  }

  it('resolves sync paths against the config file and names every missing key at once', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-config-'));
    try {
      const loaded = write(directory, { sync: SYNC, workspacesPath: './workspaces.json' });
      // Portable with its data: a config file and its credential travel together.
      expect(loaded.resolvedCredentialPath).toBe(join(directory, 'node-credential.json'));
      expect(loaded.resolvedWorkspacesPath).toBe(join(directory, 'workspaces.json'));
      expect(requireSyncSettings(loaded)).toMatchObject({
        deviceId: 'sandbox-abc',
        credentialPath: join(directory, 'node-credential.json'),
      });

      // One error listing everything, not one restart per missing key.
      const { deviceId: _deviceId, personalUserId: _personalUserId, ...partial } = SYNC;
      expect(() => requireSyncSettings(write(directory, { sync: partial })))
        .toThrow(/sync\.personalUserId, sync\.deviceId/);

      // The one-turn CLI has no sync block at all and must still load.
      const plain = write(directory, {});
      expect(plain.resolvedCredentialPath).toBeUndefined();
      expect(() => requireSyncSettings(plain)).toThrow(/must set a "sync" object/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
