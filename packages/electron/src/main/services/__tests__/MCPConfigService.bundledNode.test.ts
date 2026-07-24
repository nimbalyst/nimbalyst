import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MCPConfigService } from '../MCPConfigService';

// Regression coverage for nimbalyst#197. When running inside Electron,
// MCP server configs that say `command: "node"` should be transparently
// rewritten to invoke Electron's bundled Node runtime via
// `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, so users on a fresh
// Windows / macOS / Linux box without system Node installed don't have
// to install it before MCP works.

describe('MCPConfigService.isBareNodeCommand', () => {
  it('matches the bare token `node`', () => {
    expect(MCPConfigService.isBareNodeCommand('node')).toBe(true);
  });

  it('matches `node.exe` for Windows config files', () => {
    expect(MCPConfigService.isBareNodeCommand('node.exe')).toBe(true);
    expect(MCPConfigService.isBareNodeCommand('NODE.EXE')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(MCPConfigService.isBareNodeCommand('NODE')).toBe(true);
    expect(MCPConfigService.isBareNodeCommand('Node')).toBe(true);
  });

  it('does NOT match absolute paths to node', () => {
    expect(MCPConfigService.isBareNodeCommand('/usr/local/bin/node')).toBe(false);
    expect(MCPConfigService.isBareNodeCommand('C:\\Program Files\\nodejs\\node.exe')).toBe(false);
    expect(MCPConfigService.isBareNodeCommand('/Users/me/.nvm/versions/node/v22.11.0/bin/node')).toBe(false);
  });

  it('does NOT match other JavaScript runtimes', () => {
    expect(MCPConfigService.isBareNodeCommand('npx')).toBe(false);
    expect(MCPConfigService.isBareNodeCommand('npm')).toBe(false);
    expect(MCPConfigService.isBareNodeCommand('bun')).toBe(false);
    expect(MCPConfigService.isBareNodeCommand('deno')).toBe(false);
    expect(MCPConfigService.isBareNodeCommand('python')).toBe(false);
  });

  it('handles undefined / non-string input safely', () => {
    expect(MCPConfigService.isBareNodeCommand(undefined)).toBe(false);
    // Cast through unknown so the test still exercises the type guard at
    // runtime even though the type signature accepts string | undefined.
    expect(MCPConfigService.isBareNodeCommand(null as unknown as string)).toBe(false);
    expect(MCPConfigService.isBareNodeCommand('' as string)).toBe(false);
  });

  it('trims whitespace around the command before matching', () => {
    expect(MCPConfigService.isBareNodeCommand('  node  ')).toBe(true);
    expect(MCPConfigService.isBareNodeCommand('node ')).toBe(true);
  });
});

describe('MCPConfigService.processServerConfigForRuntime - bundled Node runtime substitution (#197)', () => {
  let originalElectronVersion: string | undefined;
  let service: MCPConfigService;

  beforeEach(() => {
    // Snapshot whatever process.versions.electron is in the host environment
    // (it's undefined under vitest unless we set it). Restore after each test.
    originalElectronVersion = process.versions.electron;
    service = new MCPConfigService();
  });

  afterEach(() => {
    if (originalElectronVersion === undefined) {
      delete (process.versions as { electron?: string }).electron;
    } else {
      (process.versions as { electron?: string }).electron = originalElectronVersion;
    }
    vi.restoreAllMocks();
  });

  it('substitutes process.execPath for `node` when running inside Electron', () => {
    (process.versions as { electron?: string }).electron = '41.0.0';

    const result = service.processServerConfigForRuntime({
      command: 'node',
      args: ['/Users/me/server.js'],
    } as any);

    expect(result.command).toBe(process.execPath);
    expect(result.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
    // Args unchanged
    expect(result.args).toEqual(['/Users/me/server.js']);
  });

  it('also substitutes `node.exe` and case-variants', () => {
    (process.versions as { electron?: string }).electron = '41.0.0';

    const exe = service.processServerConfigForRuntime({ command: 'node.exe', args: [] } as any);
    expect(exe.command).toBe(process.execPath);
    expect(exe.env?.ELECTRON_RUN_AS_NODE).toBe('1');

    const upper = service.processServerConfigForRuntime({ command: 'NODE', args: [] } as any);
    expect(upper.command).toBe(process.execPath);
  });

  it('preserves user-provided env vars and only adds ELECTRON_RUN_AS_NODE', () => {
    (process.versions as { electron?: string }).electron = '41.0.0';

    const result = service.processServerConfigForRuntime({
      command: 'node',
      args: [],
      env: { POSTGRES_URL: 'postgres://localhost/x', NODE_ENV: 'production' },
    } as any);

    expect(result.env).toMatchObject({
      POSTGRES_URL: 'postgres://localhost/x',
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it('does NOT substitute when command is an absolute path', () => {
    (process.versions as { electron?: string }).electron = '41.0.0';

    const result = service.processServerConfigForRuntime({
      command: '/usr/local/bin/node',
      args: ['/server.js'],
    } as any);

    expect(result.command).toBe('/usr/local/bin/node');
    expect(result.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('does NOT substitute other commands (npx, npm, bun, deno, python)', () => {
    (process.versions as { electron?: string }).electron = '41.0.0';

    for (const cmd of ['npx', 'npm', 'bun', 'deno', 'python']) {
      const result = service.processServerConfigForRuntime({ command: cmd, args: [] } as any);
      // On non-Windows the command stays as-is. On Windows the platform
      // resolver may map `npx`->`npx.cmd` etc, but `ELECTRON_RUN_AS_NODE`
      // must NOT be set for any of these.
      expect(result.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    }
  });

  it('does NOT substitute when not running in Electron (process.versions.electron undefined)', () => {
    delete (process.versions as { electron?: string }).electron;

    const result = service.processServerConfigForRuntime({
      command: 'node',
      args: ['/server.js'],
    } as any);

    // Outside Electron the command is NOT replaced with `process.execPath`
    // and `ELECTRON_RUN_AS_NODE` is NOT injected. The exact command string
    // depends on the host platform's normal command-resolution rules
    // (Windows maps `node` -> `node.exe` for shell-execution policy
    // reasons), so we assert the substitution did not happen rather than
    // the post-platform-resolution string.
    expect(result.command).not.toBe(process.execPath);
    expect(result.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('does NOT touch SSE-transport servers (no command in the first place)', () => {
    (process.versions as { electron?: string }).electron = '41.0.0';

    const result = service.processServerConfigForRuntime({
      type: 'sse',
      url: 'http://127.0.0.1:9000/mcp',
    } as any);

    expect(result.command).toBeUndefined();
    expect(result.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
