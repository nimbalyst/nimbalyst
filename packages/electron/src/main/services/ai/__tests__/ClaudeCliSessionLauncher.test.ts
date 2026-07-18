import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { ClaudeCliSessionLauncher, type ClaudeCliSessionLauncherDeps } from '../ClaudeCliSessionLauncher';

type CreateClaudeCliTerminal = ClaudeCliSessionLauncherDeps['terminalManager']['createClaudeCliTerminal'];
type CreateClaudeCliTerminalArgs = Parameters<CreateClaudeCliTerminal>;

/**
 * Launcher orchestration for the genuine `claude` CLI session (NIM-806, Phase 1).
 * Dependencies are injected so this verifies the wiring without node-pty,
 * electron, or a live MCP server.
 */
describe('ClaudeCliSessionLauncher', () => {
  function makeHarness(opts: {
    startObservation?: ClaudeCliSessionLauncherDeps['startObservation'];
    createClaudeCliTerminal?: ReturnType<typeof vi.fn<CreateClaudeCliTerminal>>;
    pathExists?: (p: string) => boolean;
    homedir?: () => string;
  } = {}) {
    const writes: Array<{ file: string; data: string }> = [];
    const createClaudeCliTerminal =
      opts.createClaudeCliTerminal ??
      vi.fn<CreateClaudeCliTerminal>(async (..._args: CreateClaudeCliTerminalArgs): Promise<void> => {});
    const getMcpServersConfig = vi.fn(async (_opts: { sessionId: string; workspacePath: string }) => ({
      // The eager core `nimbalyst` server is what the launcher lifts the
      // /permission host+token from (the legacy `nimbalyst-mcp` is retired).
      'nimbalyst': {
        type: 'sse',
        url: `http://127.0.0.1:5123/mcp/core?workspacePath=%2Fwork&sessionId=${_opts.sessionId}`,
      },
    }));

    const launcher = new ClaudeCliSessionLauncher({
      getMcpServersConfig,
      resolveClaudeExecutable: () => '/usr/local/bin/claude',
      getEnhancedPath: () => '/opt/bin:/usr/bin',
      terminalManager: { createClaudeCliTerminal },
      baseEnv: { ANTHROPIC_API_KEY: 'sk-ant-leak', HOME: '/Users/me' },
      tempDir: '/tmp/claude-cli-test',
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (file: string, data: string) => {
        writes.push({ file, data });
      }),
      startObservation: opts.startObservation,
      // Default: jsonl absent → fresh `--session-id`. Tests override to simulate a relaunch.
      pathExists: opts.pathExists ?? (() => false),
      homedir: opts.homedir ?? (() => '/Users/me'),
    });

    return { launcher, writes, createClaudeCliTerminal, getMcpServersConfig };
  }

  const baseInput = {
    sessionId: 'sess-01HABC',
    workspacePath: '/work',
    model: 'opus',
  };

  it('builds the sessionId-bearing MCP config and writes it as { mcpServers: ... }', async () => {
    const { launcher, writes, getMcpServersConfig } = makeHarness();
    const result = await launcher.launch(baseInput);

    expect(getMcpServersConfig).toHaveBeenCalledWith({ sessionId: 'sess-01HABC', workspacePath: '/work' });
    expect(writes).toHaveLength(1);
    expect(result.mcpConfigPath).toBe(path.join('/tmp/claude-cli-test', 'sess-01HABC.mcp.json'));

    const parsed = JSON.parse(writes[0].data);
    expect(parsed).toHaveProperty('mcpServers');
    expect(parsed.mcpServers['nimbalyst'].url).toContain('sessionId=sess-01HABC');
  });

  it('spawns the CLI terminal with the temp mcp-config path and the session id', async () => {
    const { launcher, createClaudeCliTerminal, writes } = makeHarness();
    await launcher.launch(baseInput);

    expect(createClaudeCliTerminal).toHaveBeenCalledTimes(1);
    const [terminalId, opts] = createClaudeCliTerminal.mock.calls[0];
    expect(terminalId).toBe('sess-01HABC');
    expect(opts.workspacePath).toBe('/work');
    expect(opts.cwd).toBe('/work');

    // The spawn config must reference the same temp file we wrote.
    expect(opts.spawnConfig.args).toContain('--mcp-config');
    const mcpArg = opts.spawnConfig.args[opts.spawnConfig.args.indexOf('--mcp-config') + 1];
    expect(mcpArg).toBe(writes[0].file);
    expect(opts.spawnConfig.args).toContain('--model');
    expect(opts.spawnConfig.executable).toBe('/usr/local/bin/claude');
  });

  it('pre-allows the injected MCP servers by name (--allowedTools mcp__<server>) — NIM-806 BUG 2', async () => {
    // The MCP config map's keys ARE the trusted server names; the launcher derives
    // the allow-list from them so the CLI never double-prompts for our own widgets.
    const getMcpServersConfig = vi.fn(async (_opts: { sessionId: string; workspacePath: string }) => ({
      'nimbalyst-mcp': { type: 'sse', url: 'http://127.0.0.1:5123/mcp' },
      'nimbalyst-session-context': { type: 'sse', url: 'http://127.0.0.1:5124/mcp' },
    }));
    const createClaudeCliTerminal = vi.fn(async (..._args: CreateClaudeCliTerminalArgs): Promise<void> => {});
    const launcher = new ClaudeCliSessionLauncher({
      getMcpServersConfig,
      resolveClaudeExecutable: () => '/usr/local/bin/claude',
      getEnhancedPath: () => '/opt/bin:/usr/bin',
      terminalManager: { createClaudeCliTerminal },
      baseEnv: {},
      tempDir: '/tmp/claude-cli-test',
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    });

    await launcher.launch(baseInput);

    const opts = createClaudeCliTerminal.mock.calls[0][1];
    const args = opts.spawnConfig.args;
    const i = args.indexOf('--allowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args.slice(i + 1, args.indexOf('--disallowedTools'))).toEqual([
      'mcp__nimbalyst-mcp',
      'mcp__nimbalyst-session-context',
    ]);
  });

  it('registers the PreToolUse permission hook (--settings + env) when a hook script + the core server are present — NIM-806 Phase 4', async () => {
    const getMcpServersConfig = vi.fn(async (_opts: { sessionId: string; workspacePath: string }) => ({
      'nimbalyst': {
        type: 'sse',
        url: 'http://127.0.0.1:5123/mcp/core?sessionId=sess-01HABC',
        headers: { Authorization: 'Bearer secret-token-xyz' },
      },
    }));
    const createClaudeCliTerminal = vi.fn(async (..._args: CreateClaudeCliTerminalArgs): Promise<void> => {});
    const launcher = new ClaudeCliSessionLauncher({
      getMcpServersConfig,
      resolveClaudeExecutable: () => '/usr/local/bin/claude',
      getEnhancedPath: () => '/opt/bin:/usr/bin',
      terminalManager: { createClaudeCliTerminal },
      baseEnv: {},
      tempDir: '/tmp/claude-cli-test',
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      permissionHookScriptPath: '/app/resources/claudeCliPermissionHook.cjs',
      electronExecPath: '/app/electron',
    });
    await launcher.launch(baseInput);

    const cfg = createClaudeCliTerminal.mock.calls[0][1].spawnConfig;
    // --settings registers a PreToolUse hook running the script under Electron-as-Node.
    const i = cfg.args.indexOf('--settings');
    expect(i).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(cfg.args[i + 1]);
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('/app/resources/claudeCliPermissionHook.cjs');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('ELECTRON_RUN_AS_NODE=1');
    // The endpoint URL + bearer are injected into the CLI env (lifted from the MCP config).
    expect(cfg.env.NIMBALYST_PERMISSION_URL).toBe('http://127.0.0.1:5123/permission');
    expect(cfg.env.NIMBALYST_PERMISSION_TOKEN).toBe('secret-token-xyz');
  });

  it('omits the permission hook when no hook script path is provided (keeps native gate)', async () => {
    const { launcher, createClaudeCliTerminal } = makeHarness();
    await launcher.launch(baseInput);
    const cfg = createClaudeCliTerminal.mock.calls[0][1].spawnConfig;
    expect(cfg.args).not.toContain('--settings');
    expect(cfg.env.NIMBALYST_PERMISSION_URL).toBeUndefined();
  });

  // NIM-806 Phase 4: an "allow-all"/"bypass-all" workspace skips the gate entirely
  // — spawn the genuine CLI with --dangerously-skip-permissions and DROP the
  // PreToolUse hook (the hook would otherwise still prompt for Bash/Edit/Write).
  function makeHookHarness(getPermissionMode?: (workspacePath: string) => 'ask' | 'allow-all' | 'bypass-all' | null) {
    const getMcpServersConfig = vi.fn(async (_opts: { sessionId: string; workspacePath: string }) => ({
      'nimbalyst': {
        type: 'sse',
        url: 'http://127.0.0.1:5123/mcp/core?sessionId=sess-01HABC',
        headers: { Authorization: 'Bearer secret-token-xyz' },
      },
    }));
    const createClaudeCliTerminal = vi.fn(async (..._args: CreateClaudeCliTerminalArgs): Promise<void> => {});
    const launcher = new ClaudeCliSessionLauncher({
      getMcpServersConfig,
      resolveClaudeExecutable: () => '/usr/local/bin/claude',
      getEnhancedPath: () => '/opt/bin:/usr/bin',
      terminalManager: { createClaudeCliTerminal },
      baseEnv: {},
      tempDir: '/tmp/claude-cli-test',
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      permissionHookScriptPath: '/app/resources/claudeCliPermissionHook.cjs',
      electronExecPath: '/app/electron',
      getPermissionMode,
    });
    return { launcher, createClaudeCliTerminal };
  }

  it.each(['allow-all', 'bypass-all'] as const)(
    'skips the gate (--dangerously-skip-permissions, no hook) when the workspace is %s',
    async (mode) => {
      const { launcher, createClaudeCliTerminal } = makeHookHarness(() => mode);
      await launcher.launch(baseInput);
      const cfg = createClaudeCliTerminal.mock.calls[0][1].spawnConfig;
      expect(cfg.args).toContain('--dangerously-skip-permissions');
      // The hook must NOT also be registered (it would prompt on top of the skip).
      expect(cfg.args).not.toContain('--settings');
      expect(cfg.env.NIMBALYST_PERMISSION_URL).toBeUndefined();
    }
  );

  it('keeps the PreToolUse hook and does NOT skip permissions when the workspace is ask', async () => {
    const { launcher, createClaudeCliTerminal } = makeHookHarness(() => 'ask');
    await launcher.launch(baseInput);
    const cfg = createClaudeCliTerminal.mock.calls[0][1].spawnConfig;
    expect(cfg.args).not.toContain('--dangerously-skip-permissions');
    expect(cfg.args).toContain('--settings');
  });

  it('keeps the gate when no permission mode is resolvable (untrusted default)', async () => {
    const { launcher, createClaudeCliTerminal } = makeHookHarness(() => null);
    await launcher.launch(baseInput);
    const cfg = createClaudeCliTerminal.mock.calls[0][1].spawnConfig;
    expect(cfg.args).not.toContain('--dangerously-skip-permissions');
    expect(cfg.args).toContain('--settings');
  });

  // NIM-845: extension Claude-plugins (namespaced slash commands) load via
  // `--plugin-dir <dir>`. The launcher resolves the dirs from the injected loader
  // and passes them through — but ONLY when the resolved CLI supports the flag
  // (cliSupportsPluginDir). On an old CLI the flag would be rejected as unknown
  // and crash the launch, so they're omitted (silent skip, namespaced commands
  // simply won't resolve, as before the fix).
  function makePluginHarness(opts: {
    loadPluginDirs?: ClaudeCliSessionLauncherDeps['loadPluginDirs'];
    cliSupportsPluginDir?: ClaudeCliSessionLauncherDeps['cliSupportsPluginDir'];
  }) {
    const createClaudeCliTerminal = vi.fn(async (..._args: CreateClaudeCliTerminalArgs): Promise<void> => {});
    const launcher = new ClaudeCliSessionLauncher({
      getMcpServersConfig: vi.fn(async (_opts: { sessionId: string; workspacePath: string }) => ({
        'nimbalyst': { type: 'sse', url: 'http://127.0.0.1:5123/mcp/core' },
      })),
      resolveClaudeExecutable: () => '/usr/local/bin/claude',
      getEnhancedPath: () => '/opt/bin:/usr/bin',
      terminalManager: { createClaudeCliTerminal },
      baseEnv: {},
      tempDir: '/tmp/claude-cli-test',
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      loadPluginDirs: opts.loadPluginDirs,
      cliSupportsPluginDir: opts.cliSupportsPluginDir,
    });
    return { launcher, createClaudeCliTerminal };
  }

  it('passes loader-returned plugin dirs as --plugin-dir when the CLI supports the flag', async () => {
    const loadPluginDirs = vi.fn(async () => ['/ext/a/plugin', '/ext/b/plugin']);
    const cliSupportsPluginDir = vi.fn(() => true);
    const { launcher, createClaudeCliTerminal } = makePluginHarness({ loadPluginDirs, cliSupportsPluginDir });
    await launcher.launch(baseInput);

    expect(loadPluginDirs).toHaveBeenCalledWith('/work');
    expect(cliSupportsPluginDir).toHaveBeenCalledWith('/usr/local/bin/claude');
    const args = createClaudeCliTerminal.mock.calls[0][1].spawnConfig.args;
    const i = args.indexOf('--plugin-dir');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('/ext/a/plugin');
    expect(args.filter((a) => a === '--plugin-dir')).toHaveLength(2);
  });

  it('omits --plugin-dir (and does NOT load dirs) when the resolved CLI lacks support', async () => {
    const loadPluginDirs = vi.fn(async () => ['/ext/a/plugin']);
    const cliSupportsPluginDir = vi.fn(() => false);
    const { launcher, createClaudeCliTerminal } = makePluginHarness({ loadPluginDirs, cliSupportsPluginDir });
    await launcher.launch(baseInput);

    expect(cliSupportsPluginDir).toHaveBeenCalledWith('/usr/local/bin/claude');
    // No point loading dirs we can't pass — the loader must not run.
    expect(loadPluginDirs).not.toHaveBeenCalled();
    expect(createClaudeCliTerminal.mock.calls[0][1].spawnConfig.args).not.toContain('--plugin-dir');
  });

  it('still launches when the plugin-dir loader throws (best-effort; namespaced commands just stay unresolved)', async () => {
    const loadPluginDirs = vi.fn(async () => {
      throw new Error('plugin scan boom');
    });
    const { launcher, createClaudeCliTerminal } = makePluginHarness({
      loadPluginDirs,
      cliSupportsPluginDir: () => true,
    });
    await launcher.launch(baseInput);
    expect(createClaudeCliTerminal).toHaveBeenCalledTimes(1);
    expect(createClaudeCliTerminal.mock.calls[0][1].spawnConfig.args).not.toContain('--plugin-dir');
  });

  it('omits --plugin-dir when no loader is wired (default deps)', async () => {
    const { launcher, createClaudeCliTerminal } = makeHarness();
    await launcher.launch(baseInput);
    expect(createClaudeCliTerminal.mock.calls[0][1].spawnConfig.args).not.toContain('--plugin-dir');
  });

  it('never lets ANTHROPIC_API_KEY cross into the CLI env (CLAUDE.md implicit-key rule)', async () => {
    const { launcher, createClaudeCliTerminal } = makeHarness();
    await launcher.launch(baseInput);

    const opts = createClaudeCliTerminal.mock.calls[0][1];
    expect(opts.spawnConfig.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts.spawnConfig.env.HOME).toBe('/Users/me');
    expect(opts.spawnConfig.env.PATH).toBe('/opt/bin:/usr/bin');
  });

  it('never runs headless (-p / --print)', async () => {
    const { launcher, createClaudeCliTerminal } = makeHarness();
    await launcher.launch(baseInput);
    const opts = createClaudeCliTerminal.mock.calls[0][1];
    expect(opts.spawnConfig.args).not.toContain('-p');
    expect(opts.spawnConfig.args).not.toContain('--print');
  });

  it('requires a sessionId and workspacePath', async () => {
    const { launcher } = makeHarness();
    await expect(launcher.launch({ ...baseInput, sessionId: '' })).rejects.toThrow(/sessionId is required/);
    await expect(launcher.launch({ ...baseInput, workspacePath: '' })).rejects.toThrow(/workspacePath is required/);
  });

  it('starts proxy observation, injects ANTHROPIC_BASE_URL, and wires teardown on exit', async () => {
    const stop = vi.fn();
    const startObservation = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:51234', stop }));
    const { launcher, createClaudeCliTerminal } = makeHarness({ startObservation });

    await launcher.launch(baseInput);

    expect(startObservation).toHaveBeenCalledWith({ sessionId: 'sess-01HABC', workspacePath: '/work' });
    const opts = createClaudeCliTerminal.mock.calls[0][1];
    expect(opts.spawnConfig.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:51234');
    // Teardown wired but not yet fired (PTY still alive).
    expect(typeof opts.onExit).toBe('function');
    expect(stop).not.toHaveBeenCalled();
    opts.onExit?.(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('composes proxy teardown with the caller onExit callback', async () => {
    const stop = vi.fn();
    const onExit = vi.fn();
    const startObservation = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:51234', stop }));
    const { launcher, createClaudeCliTerminal } = makeHarness({ startObservation });

    await launcher.launch({ ...baseInput, onExit });

    const opts = createClaudeCliTerminal.mock.calls[0][1];
    opts.onExit?.(7);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(7);
  });

  it('launches without a base URL when observation is disabled (returns null)', async () => {
    const startObservation = vi.fn(async () => null);
    const { launcher, createClaudeCliTerminal } = makeHarness({ startObservation });
    await launcher.launch(baseInput);
    const opts = createClaudeCliTerminal.mock.calls[0][1];
    expect(opts.spawnConfig.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(opts.onExit).toBeUndefined();
  });

  it('still launches the CLI if startObservation throws (observation is best-effort)', async () => {
    const startObservation = vi.fn(async () => {
      throw new Error('proxy boom');
    });
    const { launcher, createClaudeCliTerminal } = makeHarness({ startObservation });
    await launcher.launch(baseInput);
    expect(createClaudeCliTerminal).toHaveBeenCalledTimes(1);
    const opts = createClaudeCliTerminal.mock.calls[0][1];
    expect(opts.spawnConfig.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  // NIM-806 BUG 3: `--session-id <uuid>` is rejected once the CLI's jsonl for
  // that id exists ("Session ID … is already in use" → exit 1). On a relaunch we
  // must switch to `--resume <uuid>`; on a first launch we keep `--session-id`.
  const uuidInput = {
    sessionId: 'c261169b-d681-43e7-9c59-de4035b65cef',
    workspacePath: '/work',
    model: 'opus',
  };

  it('spawns FRESH with --session-id when the CLI jsonl does not exist', async () => {
    const { launcher, createClaudeCliTerminal } = makeHarness({ pathExists: () => false });
    await launcher.launch(uuidInput);
    const args = createClaudeCliTerminal.mock.calls[0][1].spawnConfig.args;
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(uuidInput.sessionId);
    expect(args).not.toContain('--resume');
  });

  it('RESUMES with --resume (not --session-id) when the CLI jsonl already exists', async () => {
    // The probed path is the deterministic ~/.claude/projects/<enc-cwd>/<id>.jsonl.
    const expectedJsonl =
      path.join('/Users/me', '.claude', 'projects', '-work', 'c261169b-d681-43e7-9c59-de4035b65cef.jsonl');
    const pathExists = vi.fn((p: string) => p === expectedJsonl);
    const { launcher, createClaudeCliTerminal } = makeHarness({ pathExists });
    await launcher.launch(uuidInput);

    expect(pathExists).toHaveBeenCalledWith(expectedJsonl);
    const args = createClaudeCliTerminal.mock.calls[0][1].spawnConfig.args;
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(uuidInput.sessionId);
    expect(args).not.toContain('--session-id');
  });

  it('honors an explicit resumeSessionId without probing the filesystem', async () => {
    const pathExists = vi.fn(() => false);
    const { launcher, createClaudeCliTerminal } = makeHarness({ pathExists });
    await launcher.launch({ ...uuidInput, resumeSessionId: 'prior-cli-id' });

    expect(pathExists).not.toHaveBeenCalled();
    const args = createClaudeCliTerminal.mock.calls[0][1].spawnConfig.args;
    expect(args[args.indexOf('--resume') + 1]).toBe('prior-cli-id');
    expect(args).not.toContain('--session-id');
  });

  it('stops the proxy if the terminal spawn throws (no leak)', async () => {
    const stop = vi.fn();
    const startObservation = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:51234', stop }));
    const createClaudeCliTerminal = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const { launcher } = makeHarness({ startObservation, createClaudeCliTerminal });
    await expect(launcher.launch(baseInput)).rejects.toThrow(/spawn failed/);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
