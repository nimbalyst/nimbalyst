import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\user-data') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('electron-log', () => ({
  default: {
    scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    transports: { file: {}, console: {} },
  },
}));
vi.mock('electron-log/main', () => ({
  default: {
    initialize: vi.fn(),
    scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    transports: { file: {}, console: {} },
  },
}));
vi.mock('electron-store', () => ({
  default: class ElectronStore {
    get = vi.fn((_key: string, defaultValue: unknown) => defaultValue);
    set = vi.fn();
    delete = vi.fn();
  },
}));

import { buildClaudeMetaAgentMcpConfig } from '../../services/mcpServerConfig';
import { ClaudeCodeProvider } from '../ClaudeCodeProvider';

describe('ClaudeCodeProvider visibility-control MCP context', () => {
  it('rebuilds a worktree meta-agent profile from the canonical MCP workspace', async () => {
    const getMcpServersConfig = vi.fn(async (options) => ({
      host: { url: `http://127.0.0.1/mcp/host?workspacePath=${options.workspacePath}` },
    }));

    const result = await buildClaudeMetaAgentMcpConfig(
      { getMcpServersConfig } as any,
      {
        sessionId: 'worktree-meta-agent',
        providerWorkspacePath: 'C:\\repo-worktrees\\repair',
        mcpConfigWorkspacePath: 'C:\\repo',
      },
    );

    expect(getMcpServersConfig).toHaveBeenCalledTimes(1);
    expect(getMcpServersConfig).toHaveBeenCalledWith({
      sessionId: 'worktree-meta-agent',
      workspacePath: 'C:\\repo',
      profile: 'meta-agent',
    });
    expect(JSON.stringify(result)).not.toContain('repo-worktrees');
  });

  it('passes the canonical MCP workspace through the actual provider turn construction', async () => {
    const provider = new ClaudeCodeProvider();
    await provider.initialize({ model: 'claude-code:opus' } as any);
    vi.spyOn(provider as any, 'getAgentRole').mockResolvedValue('meta-agent');
    vi.spyOn(provider as any, 'getWorkflowPreset').mockResolvedValue('default');
    const getMcpServersConfig = vi.fn(async (options: any) => {
      if (options.profile === 'meta-agent') throw new Error('stop-after-production-meta-config');
      return {};
    });
    (provider as any).mcpConfigService = { getMcpServersConfig };

    const chunks: unknown[] = [];
    for await (const chunk of provider.sendMessage(
      'verify configuration',
      {
        mcpConfigWorkspacePath: 'C:\\repo',
        permissionsPath: 'C:\\repo',
      } as any,
      'worktree-meta-agent',
      [],
      'C:\\repo-worktrees\\repair',
    )) {
      chunks.push(chunk);
    }

    expect(getMcpServersConfig).toHaveBeenCalledWith({
      sessionId: 'worktree-meta-agent',
      workspacePath: 'C:\\repo',
      profile: 'meta-agent',
    });
    expect(JSON.stringify(getMcpServersConfig.mock.calls)).not.toContain('repo-worktrees\\\\repair\",\"profile\":\"meta-agent');
    expect(chunks.length).toBeGreaterThan(0);
  });
});
