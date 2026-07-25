/**
 * ClaudeCliSessionLauncher — main-process orchestrator that launches the genuine
 * interactive `claude` CLI on the user's subscription as a Nimbalyst session
 * (NIM-806, Phase 1).
 *
 * The single load-bearing step is **allocating the Nimbalyst session id BEFORE
 * launch** and injecting the same `sessionId`-bearing MCP URL the in-process
 * Agent-SDK path uses. The CLI then calls `mcp__nimbalyst__*` tools that hit
 * the identical handlers — so commit-proposal / AskUserQuestion widgets render in
 * the correct transcript with no new mechanism (see the plan doc, "How a rich
 * widget reaches the right transcript").
 *
 * Flow:
 *   1. Build the sessionId-bearing MCP server map via `McpConfigService`
 *      (already emits `&sessionId=` URLs + bearer headers).
 *   2. Write it to a temp `--mcp-config` file, shape `{ "mcpServers": { ... } }`.
 *   3. Resolve the `claude` executable + enhanced PATH; build the spawn config
 *      (`buildClaudeCliSpawnConfig` — strips ANTHROPIC_API_KEY, never `-p`).
 *   4. Spawn it in the ghostty-web terminal strip via
 *      `TerminalSessionManager.createClaudeCliTerminal`.
 *
 * Dependencies are injected so the orchestration is unit-testable without
 * node-pty / electron / a live MCP server.
 */

import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildClaudeCliSpawnConfig } from './claudeCliSpawnConfig';
import {
  buildPermissionHookSettingsJson,
  buildElectronNodeHookCommand,
} from './claudeCliPermissionHookConfig';
import { resolveClaudeCliJsonlPath, shouldResumeClaudeCliSession } from './claudeCliJsonlPath';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';
import type { TerminalSessionManager } from '../TerminalSessionManager';
import type { ClaudeTurnState, ParsedClaudePidFile } from './claudeCliPidState';

export interface ClaudeCliSessionLauncherDeps {
  /**
   * Build the merged, sessionId-bearing MCP server map for this session. In
   * production this is `McpConfigService.getMcpServersConfig` bound to the
   * main-process ports + bearer token.
   */
  getMcpServersConfig: (opts: {
    sessionId: string;
    workspacePath: string;
  }) => Promise<Record<string, unknown>>;
  /** Resolve the `claude` executable path. Falls back to the bare `claude`. */
  resolveClaudeExecutable: () => string;
  /** Login-shell-enhanced PATH so a GUI-launched Electron can find `claude`. */
  getEnhancedPath: () => string;
  /** Terminal manager that spawns the PTY-backed terminal strip. */
  terminalManager: Pick<TerminalSessionManager, 'createClaudeCliTerminal'>;
  /** Base env to derive the CLI env from. Defaults to `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /**
   * Start the proxy observation backend for this session (NIM-806, Phase 3).
   * Returns the `ANTHROPIC_BASE_URL` the CLI is pointed at and a `stop` to tear
   * the proxy down on PTY exit. Returns null (or is omitted) when observation is
   * disabled — the CLI then talks to the real API directly (terminal-only).
   */
  startObservation?: (opts: {
    sessionId: string;
    workspacePath: string;
  }) => Promise<{ baseUrl: string; stop: () => void } | null>;
  /** Directory for temp MCP config files. Defaults to `os.tmpdir()/nimbalyst-claude-cli`. */
  tempDir?: string;
  /** fs overrides (tests). */
  mkdir?: (dir: string, opts: { recursive: true }) => Promise<unknown>;
  writeFile?: (file: string, data: string) => Promise<void>;
  /** User home dir for the CLI jsonl resume check (NIM-806 BUG 3). Defaults to os.homedir. */
  homedir?: () => string;
  /** Existence predicate for the CLI jsonl resume check. Defaults to fs.existsSync. */
  pathExists?: (p: string) => boolean;
  /**
   * Absolute path to the PreToolUse permission hook script (NIM-806 Phase 4).
   * When set (and the nimbalyst core server is configured), the launcher registers
   * the hook via `--settings` and injects the endpoint URL/token into the CLI env,
   * so built-in tool prompts route to a Nimbalyst widget. Omit → native gate.
   */
  permissionHookScriptPath?: string;
  /** Node-capable executable to run the hook under (Electron-as-Node). Defaults to process.execPath. */
  electronExecPath?: string;
  /**
   * Resolve the workspace's Nimbalyst permission mode (NIM-806 Phase 4). In
   * production this is `PermissionService.getPermissionMode`. When it returns
   * `allow-all` or `bypass-all`, the user has explicitly trusted the workspace, so
   * we skip the gate entirely (`--dangerously-skip-permissions`) and DROP the
   * PreToolUse hook — the hook would otherwise still prompt for Bash/Edit/Write.
   * `ask` / `null` (untrusted) keep the hook + native gate. Omit to keep the gate.
   */
  getPermissionMode?: (workspacePath: string) => 'ask' | 'allow-all' | 'bypass-all' | null;
  /**
   * Load the extension Claude-plugin directories for this workspace (NIM-845).
   * In production this is `getClaudePluginPaths(wp)` mapped to `.path` — the same
   * single source of truth the SDK path uses. Each returned dir is a bare plugin
   * directory passed to the CLI via `--plugin-dir`, which is what makes namespaced
   * slash commands resolve. Omit → no extension plugins (namespaced commands won't
   * resolve, as before NIM-845).
   */
  loadPluginDirs?: (workspacePath: string) => Promise<string[]>;
  /**
   * Report whether the resolved `claude` executable accepts `--plugin-dir`
   * (NIM-845). In production this is the cached `--version` probe
   * (`resolveClaudeCliSupportsPluginDir`). Old CLIs (< 2.1.142) reject the flag as
   * an unknown option and the launch would crash, so when this returns false we
   * skip loading/passing plugin dirs entirely. Omitted → assume supported (the
   * loader is the only gate); paired with `loadPluginDirs` in production.
   */
  cliSupportsPluginDir?: (executable: string) => boolean;
}

export interface LaunchClaudeCliSessionInput {
  /** Nimbalyst session id — must be allocated before this call. */
  sessionId: string;
  workspacePath: string;
  /** Working directory for the CLI. Defaults to `workspacePath`. */
  cwd?: string;
  /** Resolved CLI model value (`--model`), e.g. `opus`. Omit to let the CLI default. */
  model?: string;
  /** Resume an existing CLI session id (`--resume <id>`). */
  resumeSessionId?: string;
  cols?: number;
  rows?: number;
  /**
   * Directories to pre-authorize for the CLI's file tools via `--add-dir`
   * (NIM-806). Production passes the workspace's chat-attachments root so pasted
   * images (stored outside the workspace cwd) read without the native permission
   * prompt. Forwarded verbatim to `buildClaudeCliSpawnConfig`.
   */
  additionalDirectories?: string[];
  /**
   * Turn-state callback from the CLI PID file, forwarded to the terminal so the
   * watcher can drive `SessionStateManager`. Provided by the production caller.
   */
  onTurnState?: (state: ClaudeTurnState, parsed: ParsedClaudePidFile | null) => void;
  /**
   * Called when the PTY exits. Production uses this to settle the AI session out
   * of "running" even if the CLI dies before the PID watcher reports idle.
   */
  onExit?: (exitCode: number) => void;
}

export interface LaunchClaudeCliSessionResult {
  /** Path to the temp MCP config file handed to the CLI via `--mcp-config`. */
  mcpConfigPath: string;
}

export class ClaudeCliSessionLauncher {
  constructor(private readonly deps: ClaudeCliSessionLauncherDeps) {}

  async launch(input: LaunchClaudeCliSessionInput): Promise<LaunchClaudeCliSessionResult> {
    const { sessionId, workspacePath } = input;
    if (!sessionId) {
      throw new Error('ClaudeCliSessionLauncher.launch: sessionId is required');
    }
    if (!workspacePath) {
      throw new Error('ClaudeCliSessionLauncher.launch: workspacePath is required');
    }
    const cwd = input.cwd || workspacePath;

    // BUG 3 (NIM-806): `--session-id <uuid>` is rejected once that id already
    // exists on disk (`Error: Session ID <uuid> is already in use.` → exit 1). On
    // a relaunch of the same Nimbalyst session (restart / re-mount / PID gone) the
    // CLI's prior jsonl is still there, so switch to `--resume <uuid>` — which also
    // restores prior context. Honor an explicit caller-provided resumeSessionId
    // first; otherwise resume iff the deterministic jsonl already exists.
    let resumeSessionId = input.resumeSessionId;
    if (!resumeSessionId) {
      // An injected homedir (tests) pins the config dir under it for isolation;
      // otherwise follow the CLI's own CLAUDE_CONFIG_DIR resolution.
      const configDir = this.deps.homedir
        ? path.join(this.deps.homedir(), '.claude')
        : resolveClaudeConfigDir();
      const pathExists = this.deps.pathExists ?? existsSync;
      const jsonlPath = resolveClaudeCliJsonlPath({ configDir, cwd, sessionId });
      if (shouldResumeClaudeCliSession({ jsonlExists: pathExists(jsonlPath) })) {
        resumeSessionId = sessionId;
      }
    }

    // 1 + 2. Build the sessionId-bearing MCP config and persist it to a temp file.
    const mcpServers = await this.deps.getMcpServersConfig({ sessionId, workspacePath });
    const mcpConfigPath = await this.writeMcpConfig(sessionId, mcpServers);
    // The map's keys are the trusted Nimbalyst MCP server names — pre-allow them so
    // the genuine CLI doesn't double-prompt on top of our widgets (NIM-806 BUG 2).
    const allowedMcpServerNames = Object.keys(mcpServers);

    // NIM-806 Phase 4: a workspace the user has explicitly trusted "allow-all" /
    // "bypass-all" skips the gate entirely — spawn the genuine CLI with
    // `--dangerously-skip-permissions` and DROP the PreToolUse hook (it would
    // otherwise still prompt for Bash/Edit/Write on top of the skip). `ask` / null
    // (untrusted) keep the hook + native gate.
    const permissionMode = this.deps.getPermissionMode?.(workspacePath) ?? null;
    const dangerouslySkipPermissions =
      permissionMode === 'allow-all' || permissionMode === 'bypass-all';

    // NIM-806 Phase 4 (Direction A): register a PreToolUse permission hook (via
    // --settings) that routes built-in tool prompts to a Nimbalyst widget. The
    // hook POSTs to the loopback `/permission` endpoint — same host + bearer as the
    // unified internal MCP server, so we lift both straight out of the eager core
    // `nimbalyst` config (the monolithic `nimbalyst-mcp` is retired). Only when
    // the hook script path is provided AND the core server is configured — and
    // never when we're skipping the gate (the two are mutually exclusive).
    let settingsJson: string | undefined;
    const permissionHookEnv: Record<string, string> = {};
    const nimbalystMcp = mcpServers['nimbalyst'] as
      | { url?: string; headers?: Record<string, string> }
      | undefined;
    if (!dangerouslySkipPermissions && this.deps.permissionHookScriptPath && nimbalystMcp?.url) {
      try {
        const mcpUrl = new URL(nimbalystMcp.url);
        const permissionUrl = `${mcpUrl.protocol}//${mcpUrl.host}/permission`;
        const token = (nimbalystMcp.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
        const command = buildElectronNodeHookCommand(
          this.deps.electronExecPath ?? process.execPath,
          this.deps.permissionHookScriptPath,
        );
        settingsJson = buildPermissionHookSettingsJson({ command });
        permissionHookEnv.NIMBALYST_PERMISSION_URL = permissionUrl;
        if (token) permissionHookEnv.NIMBALYST_PERMISSION_TOKEN = token;
      } catch (err) {
        // Never block the CLI launch over the permission hook; fall back to native.
        console.warn('[ClaudeCliSessionLauncher] failed to build permission hook settings:', err);
        settingsJson = undefined;
      }
    }

    // 2.5. Start the proxy observation backend (Phase 3) BEFORE spawn, so we can
    // point the CLI's ANTHROPIC_BASE_URL at it. Tear down on PTY exit.
    let observation: { baseUrl: string; stop: () => void } | null = null;
    if (this.deps.startObservation) {
      try {
        observation = await this.deps.startObservation({ sessionId, workspacePath });
      } catch (err) {
        // Observation is best-effort: never block the genuine CLI from launching.
        console.warn('[ClaudeCliSessionLauncher] startObservation failed; launching without proxy:', err);
        observation = null;
      }
    }
    const extraEnv: Record<string, string> | undefined =
      observation || Object.keys(permissionHookEnv).length > 0
        ? {
            ...(observation ? { ANTHROPIC_BASE_URL: observation.baseUrl } : {}),
            ...permissionHookEnv,
          }
        : undefined;

    // 2.6. Resolve the `claude` executable once (reused for the plugin-support
    // probe and the spawn config below).
    const claudeExecutable = this.deps.resolveClaudeExecutable();

    // NIM-845: load extension Claude-plugin directories so namespaced slash
    // commands (`/feedback:bug-report`, …) resolve in this CLI session. Gate on
    // `--plugin-dir` support FIRST — on an old CLI (< 2.1.142) the flag is an
    // unknown option and would crash the launch, so we skip loading entirely and
    // log once (silent to the user; commands stay unresolved as before the fix).
    let pluginDirs: string[] | undefined;
    if (this.deps.loadPluginDirs) {
      const supportsPluginDir = this.deps.cliSupportsPluginDir?.(claudeExecutable) ?? true;
      if (supportsPluginDir) {
        try {
          pluginDirs = (await this.deps.loadPluginDirs(workspacePath)).filter(
            (dir) => typeof dir === 'string' && dir.trim().length > 0,
          );
        } catch (err) {
          // Best-effort: never block the launch over plugin discovery.
          console.warn('[ClaudeCliSessionLauncher] failed to load plugin dirs; launching without extension plugins:', err);
          pluginDirs = undefined;
        }
      } else {
        console.log(
          `[ClaudeCliSessionLauncher] resolved claude (${claudeExecutable}) lacks --plugin-dir support; ` +
            'skipping extension plugins (namespaced slash commands will not resolve)',
        );
      }
    }

    // 3. Build the spawn config (resolves exec, sets enhanced PATH, strips API key).
    const spawnConfig = buildClaudeCliSpawnConfig({
      claudeExecutable,
      cwd,
      mcpConfigPath,
      model: input.model,
      sessionId,
      resumeSessionId,
      baseEnv: this.deps.baseEnv ?? process.env,
      enhancedPath: this.deps.getEnhancedPath(),
      extraEnv,
      allowedMcpServerNames,
      settingsJson,
      dangerouslySkipPermissions,
      additionalDirectories: input.additionalDirectories,
      pluginDirs,
    });

    // 4. Spawn the genuine interactive CLI in the terminal strip. Tear the proxy
    // down when the PTY exits (composed with the PID-watcher cleanup downstream).
    try {
      await this.deps.terminalManager.createClaudeCliTerminal(sessionId, {
        cwd,
        spawnConfig,
        workspacePath,
        cols: input.cols,
        rows: input.rows,
        onTurnState: input.onTurnState,
        onExit: observation || input.onExit
          ? (exitCode) => {
              observation?.stop();
              input.onExit?.(exitCode);
            }
          : undefined,
      });
    } catch (err) {
      // Spawn failed — don't leak the proxy.
      observation?.stop();
      throw err;
    }

    return { mcpConfigPath };
  }

  private async writeMcpConfig(
    sessionId: string,
    mcpServers: Record<string, unknown>
  ): Promise<string> {
    const dir = this.deps.tempDir ?? path.join(os.tmpdir(), 'nimbalyst-claude-cli');
    const mkdir = this.deps.mkdir ?? ((d: string, o: { recursive: true }) => fs.mkdir(d, o));
    const writeFile = this.deps.writeFile ?? ((f: string, d: string) => fs.writeFile(f, d, 'utf8'));

    await mkdir(dir, { recursive: true });
    // Sanitize the session id for use as a filename (ULIDs are safe; be defensive).
    const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
    const filePath = path.join(dir, `${safeId}.mcp.json`);
    await writeFile(filePath, JSON.stringify({ mcpServers }, null, 2));
    return filePath;
  }
}
