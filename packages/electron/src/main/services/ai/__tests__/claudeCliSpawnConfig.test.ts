import { describe, it, expect } from 'vitest';
import { buildClaudeCliSpawnConfig, resolveClaudeCliModelArg } from '../claudeCliSpawnConfig';

/**
 * Spawn-config builder for the genuine `claude` CLI on the subscription
 * (NIM-806, Phase 1). Pure arg/env construction so it is verifiable without
 * spawning a process.
 */
describe('buildClaudeCliSpawnConfig', () => {
  const base = { cwd: '/work/proj', baseEnv: {} as Record<string, string | undefined> };

  it('defaults the executable to `claude`', () => {
    expect(buildClaudeCliSpawnConfig(base).executable).toBe('claude');
  });

  it('honors a resolved executable path', () => {
    expect(buildClaudeCliSpawnConfig({ ...base, claudeExecutable: '/usr/local/bin/claude' }).executable).toBe(
      '/usr/local/bin/claude'
    );
  });

  it('passes --mcp-config and --model', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, mcpConfigPath: '/tmp/mcp.json', model: 'opus' });
    expect(cfg.args).toContain('--mcp-config');
    expect(cfg.args[cfg.args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json');
    expect(cfg.args).toContain('--model');
    expect(cfg.args[cfg.args.indexOf('--model') + 1]).toBe('opus');
  });

  it('resumes a session with --resume <id>', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, resumeSessionId: 'abc-123' });
    expect(cfg.args).toContain('--resume');
    expect(cfg.args[cfg.args.indexOf('--resume') + 1]).toBe('abc-123');
  });

  it('pins the CLI session id to the Nimbalyst session id when it is a valid UUID', () => {
    const id = '21e3c905-7f60-4066-96e0-a645a7bdc382';
    const cfg = buildClaudeCliSpawnConfig({ ...base, sessionId: id });
    expect(cfg.args).toContain('--session-id');
    expect(cfg.args[cfg.args.indexOf('--session-id') + 1]).toBe(id);
  });

  it('omits --session-id for a non-UUID session id (the CLI rejects non-UUIDs)', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, sessionId: 'not-a-uuid' });
    expect(cfg.args).not.toContain('--session-id');
  });

  it('does NOT pass --session-id when resuming (would conflict with --resume)', () => {
    const id = '21e3c905-7f60-4066-96e0-a645a7bdc382';
    const cfg = buildClaudeCliSpawnConfig({ ...base, sessionId: id, resumeSessionId: 'prev-cli-id' });
    expect(cfg.args).not.toContain('--session-id');
    expect(cfg.args).toContain('--resume');
  });

  it('injects ANTHROPIC_BASE_URL from extraEnv (proxy observation)', () => {
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      extraEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:54321' },
    });
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:54321');
  });

  it('does NOT run headless: never adds -p / --print', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, model: 'opus', mcpConfigPath: '/tmp/mcp.json' });
    expect(cfg.args).not.toContain('-p');
    expect(cfg.args).not.toContain('--print');
  });

  it('strips ANTHROPIC_API_KEY (CLAUDE.md implicit-key rule) so a stray shell key cannot override the CLI login', () => {
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      baseEnv: { ANTHROPIC_API_KEY: 'sk-ant-leak', HOME: '/Users/me' },
    });
    expect(cfg.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.env.HOME).toBe('/Users/me');
  });

  it('strips CLAUDECODE so a Nimbalyst process launched inside a Claude Code session does not make the child CLI refuse to start', () => {
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      baseEnv: { CLAUDECODE: '1', HOME: '/Users/me' },
    });
    expect(cfg.env.CLAUDECODE).toBeUndefined();
    expect(cfg.env.HOME).toBe('/Users/me');
  });

  it('sets terminal env (TERM/COLORTERM) and the enhanced PATH', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, enhancedPath: '/opt/bin:/usr/bin' });
    expect(cfg.env.TERM).toBe('xterm-256color');
    expect(cfg.env.COLORTERM).toBe('truecolor');
    expect(cfg.env.PATH).toBe('/opt/bin:/usr/bin');
  });

  it('merges observation extraEnv (e.g. Phase 3 ANTHROPIC_BASE_URL) but still strips the API key', () => {
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      baseEnv: { ANTHROPIC_API_KEY: 'sk-ant-leak' },
      extraEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:51234' },
    });
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:51234');
    expect(cfg.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('drops undefined env values', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, baseEnv: { FOO: undefined, BAR: 'x' } });
    expect('FOO' in cfg.env).toBe(false);
    expect(cfg.env.BAR).toBe('x');
  });

  it('resolves a combined 1M model id to the CLI `[1m]` form (never passes the `-1m` suffix or provider prefix to --model)', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, model: 'claude-code-cli:opus-1m' });
    expect(cfg.args).toContain('--model');
    expect(cfg.args[cfg.args.indexOf('--model') + 1]).toBe('opus[1m]');
  });

  it('spawns the pinned Fable 5 selection with --model claude-fable-5 (not the bare `fable-5` the CLI rejects)', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, model: 'claude-code-cli:fable-5' });
    expect(cfg.args[cfg.args.indexOf('--model') + 1]).toBe('claude-fable-5');
  });

  // NIM-806: the genuine CLI ships its own built-in AskUserQuestion that renders
  // in the TUI and never routes through MCP. Disallow it so the model is forced
  // onto our mcp__nimbalyst-mcp__AskUserQuestion equivalent (which renders a
  // Nimbalyst widget and answers over IPC). ExitPlanMode is deliberately NOT
  // disallowed -- there is no MCP replacement for it yet.
  it('disallows the built-in AskUserQuestion so it routes to our MCP widget instead of the TUI', () => {
    const cfg = buildClaudeCliSpawnConfig(base);
    expect(cfg.args).toContain('--disallowedTools');
    expect(cfg.args[cfg.args.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion');
    // Must not strip the still-native ExitPlanMode (no MCP equivalent exists).
    expect(cfg.args.join(' ')).not.toContain('ExitPlanMode');
  });

  it('appends a system prompt steering the model to our MCP interactive tools (Mainframe-style nudge)', () => {
    const cfg = buildClaudeCliSpawnConfig(base);
    expect(cfg.args).toContain('--append-system-prompt');
    const nudge = cfg.args[cfg.args.indexOf('--append-system-prompt') + 1] ?? '';
    expect(nudge).toContain('mcp__nimbalyst-mcp__AskUserQuestion');
    expect(nudge).toContain('mcp__nimbalyst-mcp__PromptForUserInput');
  });

  it('nudges the model to name the session via update_session_meta on its first turn', () => {
    // The CLI never receives Nimbalyst's full system prompt and has no
    // out-of-band naming path, so without this nudge a claude-code-cli session
    // is never named. The naming MCP server is in --mcp-config; the model just
    // needs to be told to call the tool.
    const cfg = buildClaudeCliSpawnConfig(base);
    const nudge = cfg.args[cfg.args.indexOf('--append-system-prompt') + 1] ?? '';
    expect(nudge).toContain('mcp__nimbalyst-session-naming__update_session_meta');
  });

  it('keeps the disallow flag followed by a non-variadic flag so it consumes only AskUserQuestion', () => {
    // commander treats --disallowedTools as variadic; a value-bearing flag must
    // follow it (here --append-system-prompt) so it does not swallow later args.
    const cfg = buildClaudeCliSpawnConfig({ ...base, mcpConfigPath: '/tmp/mcp.json' });
    const i = cfg.args.indexOf('--disallowedTools');
    expect(cfg.args[i + 1]).toBe('AskUserQuestion');
    expect(cfg.args[i + 2]).toBe('--append-system-prompt');
  });

  // NIM-806 BUG 2: the genuine interactive CLI gates every MCP tool call behind
  // its own built-in TUI permission prompt ("Do you want to proceed?"), which
  // double-prompts on top of our rendered widget. Pre-allow our trusted Nimbalyst
  // MCP servers at the server level (`mcp__<server>`) so the CLI never prompts for
  // them; built-in Bash/Edit/Write are NOT pre-allowed and still get the gate.
  it('pre-allows trusted MCP servers via --allowedTools mcp__<server> (server-level)', () => {
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      allowedMcpServerNames: ['nimbalyst-mcp', 'nimbalyst-session-context'],
    });
    expect(cfg.args).toContain('--allowedTools');
    const i = cfg.args.indexOf('--allowedTools');
    expect(cfg.args[i + 1]).toBe('mcp__nimbalyst-mcp');
    expect(cfg.args[i + 2]).toBe('mcp__nimbalyst-session-context');
  });

  it('does NOT blanket-allow built-in tools (Bash/Edit/Write keep the normal gate)', () => {
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      allowedMcpServerNames: ['nimbalyst-mcp'],
    });
    const joined = cfg.args.join(' ');
    expect(joined).not.toContain('Bash');
    expect(joined).not.toContain('Edit');
    expect(joined).not.toContain('Write');
  });

  it('omits --allowedTools when there are no MCP servers to allow', () => {
    expect(buildClaudeCliSpawnConfig(base).args).not.toContain('--allowedTools');
    expect(buildClaudeCliSpawnConfig({ ...base, allowedMcpServerNames: [] }).args).not.toContain('--allowedTools');
  });

  // NIM-806 Phase 4 (Direction A): register the PreToolUse permission hook via
  // --settings so built-in tool prompts route to a Nimbalyst widget.
  it('emits --settings with the given JSON when provided', () => {
    const settings = JSON.stringify({ hooks: { PreToolUse: [] } });
    const cfg = buildClaudeCliSpawnConfig({ ...base, settingsJson: settings });
    const i = cfg.args.indexOf('--settings');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(cfg.args[i + 1]).toBe(settings);
  });

  it('omits --settings when no JSON is provided (native gate kept)', () => {
    expect(buildClaudeCliSpawnConfig(base).args).not.toContain('--settings');
  });

  // NIM-806 Phase 4: trusted "allow-all"/"bypass-all" workspaces skip the gate
  // entirely via the genuine CLI's own `--dangerously-skip-permissions`.
  it('emits --dangerously-skip-permissions when dangerouslySkipPermissions is set', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, dangerouslySkipPermissions: true });
    expect(cfg.args).toContain('--dangerously-skip-permissions');
  });

  it('omits --dangerously-skip-permissions by default (gated)', () => {
    expect(buildClaudeCliSpawnConfig(base).args).not.toContain('--dangerously-skip-permissions');
    expect(
      buildClaudeCliSpawnConfig({ ...base, dangerouslySkipPermissions: false }).args
    ).not.toContain('--dangerously-skip-permissions');
  });

  it('still denies the built-in AskUserQuestion under --dangerously-skip-permissions (MCP routing kept)', () => {
    // Skipping permission checks must NOT re-enable the native TUI question prompt;
    // we still force the model onto our MCP question tool.
    const cfg = buildClaudeCliSpawnConfig({ ...base, dangerouslySkipPermissions: true });
    expect(cfg.args).toContain('--disallowedTools');
    expect(cfg.args).toContain('--append-system-prompt');
  });

  it('places --settings (value-bearing) BEFORE the --allowedTools variadic', () => {
    // --settings takes a single JSON value; if it landed inside/after a variadic
    // the value would be swallowed. It must precede the variadics.
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      settingsJson: '{"hooks":{}}',
      allowedMcpServerNames: ['nimbalyst-mcp'],
    });
    const s = cfg.args.indexOf('--settings');
    const allowed = cfg.args.indexOf('--allowedTools');
    const disallowed = cfg.args.indexOf('--disallowedTools');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(allowed);
    expect(s).toBeLessThan(disallowed);
    expect(cfg.args[s + 1]).toBe('{"hooks":{}}');
  });

  it('keeps both variadics terminated: --allowedTools … --disallowedTools … --append-system-prompt', () => {
    // Both --allowedTools and --disallowedTools are variadic in commander. The
    // allow variadic must be terminated by the --disallowedTools flag, and the
    // disallow variadic by the value-bearing --append-system-prompt. Crucially,
    // the earlier value-bearing flags (--model/--mcp-config/--session-id) precede
    // the variadics so they cannot be swallowed.
    const id = '21e3c905-7f60-4066-96e0-a645a7bdc382';
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      sessionId: id,
      model: 'opus',
      mcpConfigPath: '/tmp/mcp.json',
      allowedMcpServerNames: ['nimbalyst-mcp', 'nimbalyst-session-context'],
    });
    const allowIdx = cfg.args.indexOf('--allowedTools');
    const disallowIdx = cfg.args.indexOf('--disallowedTools');
    const appendIdx = cfg.args.indexOf('--append-system-prompt');
    // ordering: allow < disallow < append
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(disallowIdx).toBeGreaterThan(allowIdx);
    expect(appendIdx).toBeGreaterThan(disallowIdx);
    // the allow variadic stops at --disallowedTools (no value-bearing flag swallowed)
    expect(cfg.args.slice(allowIdx + 1, disallowIdx)).toEqual([
      'mcp__nimbalyst-mcp',
      'mcp__nimbalyst-session-context',
    ]);
    // value-bearing flags survived intact, ahead of the variadics
    expect(cfg.args[cfg.args.indexOf('--model') + 1]).toBe('opus');
    expect(cfg.args[cfg.args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json');
    expect(cfg.args[cfg.args.indexOf('--session-id') + 1]).toBe(id);
    expect(cfg.args.indexOf('--model')).toBeLessThan(allowIdx);
    expect(cfg.args.indexOf('--mcp-config')).toBeLessThan(allowIdx);
    expect(cfg.args.indexOf('--session-id')).toBeLessThan(allowIdx);
  });

  // NIM-806 (input integration): pasted chat attachments are stored OUTSIDE the
  // workspace cwd (under <userData>/chat-attachments/...). Pre-authorize that root
  // via `--add-dir` so the CLI's Read tool auto-allows it instead of showing the
  // native "read outside working directory" prompt on every pasted image.
  it('emits --add-dir for each additional directory', () => {
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      additionalDirectories: ['/data/chat-attachments/proj', '/data/extra'],
    });
    const i = cfg.args.indexOf('--add-dir');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(cfg.args[i + 1]).toBe('/data/chat-attachments/proj');
    expect(cfg.args[i + 2]).toBe('/data/extra');
  });

  it('filters empty/whitespace directories and omits --add-dir when none remain', () => {
    expect(buildClaudeCliSpawnConfig(base).args).not.toContain('--add-dir');
    expect(
      buildClaudeCliSpawnConfig({ ...base, additionalDirectories: [] }).args,
    ).not.toContain('--add-dir');
    expect(
      buildClaudeCliSpawnConfig({ ...base, additionalDirectories: ['', '   '] }).args,
    ).not.toContain('--add-dir');
  });

  it('places --add-dir before the variadics and terminates it (does not swallow later flags)', () => {
    const cfg = buildClaudeCliSpawnConfig({
      ...base,
      additionalDirectories: ['/data/attachments'],
      settingsJson: '{"hooks":{}}',
      allowedMcpServerNames: ['nimbalyst-mcp'],
    });
    const addDir = cfg.args.indexOf('--add-dir');
    const settings = cfg.args.indexOf('--settings');
    const allowed = cfg.args.indexOf('--allowedTools');
    const disallowed = cfg.args.indexOf('--disallowedTools');
    // value-bearing --settings precedes --add-dir; --add-dir precedes the variadics
    expect(settings).toBeLessThan(addDir);
    expect(addDir).toBeLessThan(allowed);
    expect(addDir).toBeLessThan(disallowed);
    // --add-dir consumes exactly its one directory, stopping at the next flag
    expect(cfg.args.slice(addDir + 1, allowed)).toEqual(['/data/attachments']);
    // the disallow built-in survived intact (not swallowed by --add-dir)
    expect(cfg.args[disallowed + 1]).toBe('AskUserQuestion');
  });

  it('does NOT disallow our MCP AskUserQuestion (different tool name from the built-in)', () => {
    const cfg = buildClaudeCliSpawnConfig({ ...base, allowedMcpServerNames: ['nimbalyst-mcp'] });
    // --disallowedTools only carries the bare built-in name, never the mcp__ one
    // (the disallow variadic is terminated by the next flag, so its values are
    // exactly the slice up to --append-system-prompt).
    const i = cfg.args.indexOf('--disallowedTools');
    const appendIdx = cfg.args.indexOf('--append-system-prompt');
    const disallowed = cfg.args.slice(i + 1, appendIdx);
    expect(disallowed).toEqual(['AskUserQuestion']);
    expect(disallowed).not.toContain('mcp__nimbalyst-mcp__AskUserQuestion');
  });
});

describe('resolveClaudeCliModelArg', () => {
  it('strips the provider prefix and translates -1m to the CLI `[1m]` form (NIM-809)', () => {
    expect(resolveClaudeCliModelArg('claude-code-cli:opus-1m')).toBe('opus[1m]');
    expect(resolveClaudeCliModelArg('claude-code-cli:sonnet')).toBe('sonnet');
    expect(resolveClaudeCliModelArg('claude-code:haiku')).toBe('haiku');
  });

  it('collapses pinned opus variants to the CLI `opus` alias (non-extended → no [1m])', () => {
    expect(resolveClaudeCliModelArg('claude-code-cli:opus-4-7')).toBe('opus');
    expect(resolveClaudeCliModelArg('claude-code-cli:opus-4-6')).toBe('opus');
  });

  it('resolves the pinned fable-5 variant to its full claude-fable-5 model id (CLI has no bare `fable` alias)', () => {
    // Unlike opus pins, `fable-5` has no CLI alias to collapse to, so it must use
    // the full Anthropic id from CLAUDE_CODE_PINNED_SDK_MODELS. Passing bare
    // `fable-5` would make `claude --model fable-5` fail at launch.
    expect(resolveClaudeCliModelArg('claude-code-cli:fable-5')).toBe('claude-fable-5');
    expect(resolveClaudeCliModelArg('claude-code-cli:fable-5-1m')).toBe('claude-fable-5[1m]');
  });

  it('passes a bare variant through (normalized), translating -1m to [1m]', () => {
    expect(resolveClaudeCliModelArg('opus')).toBe('opus');
    expect(resolveClaudeCliModelArg('opus-1m')).toBe('opus[1m]');
    expect(resolveClaudeCliModelArg('SONNET')).toBe('sonnet');
  });

  it('passes an unrecognized bare model name through unchanged (CLI accepts full model names)', () => {
    expect(resolveClaudeCliModelArg('claude-opus-4-1-20250805')).toBe('claude-opus-4-1-20250805');
  });

  it('drops a non-claude combined id (never sent to claude --model) and empty input', () => {
    expect(resolveClaudeCliModelArg('openai:gpt-5')).toBeUndefined();
    expect(resolveClaudeCliModelArg(undefined)).toBeUndefined();
    expect(resolveClaudeCliModelArg('   ')).toBeUndefined();
  });
});
