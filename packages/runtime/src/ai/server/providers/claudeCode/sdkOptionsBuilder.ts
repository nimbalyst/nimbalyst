/**
 * Builds the SDK options object for a Claude Code query() call.
 *
 * Consolidates all the configuration loading, environment setup, session
 * resumption, tool restrictions, and prompt construction that happens
 * before the streaming loop begins.
 */

import type { ContentBlockParam, TextBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import path from 'path';
import { app } from 'electron';
import { ClaudeCodeDeps } from './dependencyInjection';
import { resolveClaudeAgentCliPath } from './cliPathResolver';
import { DEFAULT_EFFORT_LEVEL, type ThinkingMode } from '../../effortLevels';

type SessionMode = 'planning' | 'agent' | 'auto' | undefined;

type SDKUserMessage = {
  type: 'user';
  message: MessageParam;
  parent_tool_use_id: string | null;
};

export interface BuildSdkOptionsDeps {
  resolveModelVariant: () => string;
  mcpConfigService: { getMcpServersConfig: (params: { sessionId?: string; workspacePath: string }) => Promise<Record<string, any>> };
  createCanUseToolHandler: (sessionId?: string, workspacePath?: string, permissionsPath?: string) => any;
  toolHooksService: {
    createPreToolUseHook: () => any;
    createPostToolUseHook: () => any;
    createPermissionDeniedHook: () => any;
  };
  teammateManager: {
    lastUsedCwd?: string | undefined;
    lastUsedSessionId?: string | undefined;
    lastUsedPermissionsPath?: string | undefined;
    packagedBuildOptions?: any;
    resolveTeamContext: (sessionId?: string) => Promise<string | undefined>;
  };
  sessions: { getSessionId: (sessionId: string) => string | null | undefined };
  config: { model?: string; apiKey?: string; effortLevel?: string; thinkingMode?: ThinkingMode };
  abortController: AbortController;
}

export interface BuildSdkOptionsParams {
  message: string;
  workspacePath: string;
  sessionId?: string;
  documentContext?: any;
  settingsEnv: Record<string, string>;
  shellEnv: Record<string, string>;
  systemPrompt: string;
  currentMode: SessionMode;
  imageContentBlocks: ContentBlockParam[];
  documentContentBlocks: ContentBlockParam[];
  permissionsPath?: string;
  mcpConfigWorkspacePath?: string;
  isMetaAgent?: boolean;
}

/**
 * Controls the lifetime of the prompt AsyncIterable so the SDK keeps the
 * binary's stdin pipe open for the duration of the turn. Calling end() lets
 * the generator return, which in turn lets the SDK call transport.endInput()
 * and close stdin normally.
 *
 * We always use an AsyncIterable prompt (never a bare string) so the SDK
 * sets isSingleUserTurn=false and does NOT preemptively close stdin when
 * `type: 'result'` arrives -- that forced close is the root cause of the
 * "Tool permission request failed: Error: Stream closed" errors on turns
 * where the binary emits a late can_use_tool after result.
 *
 * See nimbalyst-local/plans/stream-closed-native-binary-investigation.md
 * for full root cause and history of the previous reverted attempt.
 */
export interface PromptStreamController {
  end(reason: string): void;
  isEnded(): boolean;
}

export interface BuildSdkOptionsResult {
  options: any;
  promptInput: AsyncIterable<SDKUserMessage>;
  promptController: PromptStreamController;
  helperMethod: 'native' | 'custom';
}

function canDisableThinkingForModel(model: string | undefined): boolean {
  const normalized = model?.toLowerCase() ?? '';
  if (!normalized || normalized.includes('fable') || normalized.includes('haiku')) {
    return false;
  }
  return normalized.includes('opus') || normalized.includes('sonnet');
}

export function createPersistentPromptStream(
  initialMessage: SDKUserMessage,
): { iterable: AsyncIterable<SDKUserMessage>; controller: PromptStreamController } {
  let ended = false;
  let endResolve: (() => void) | null = null;
  const endPromise = new Promise<void>((resolve) => {
    endResolve = () => {
      ended = true;
      resolve();
    };
  });

  async function* generator(): AsyncGenerator<SDKUserMessage> {
    yield initialMessage;
    // Block here so the SDK's streamInput() doesn't finish iterating and
    // doesn't call transport.endInput() to close the binary's stdin. The
    // ClaudeCodeProvider arms a grace-period timer on the first `result`
    // chunk and calls controller.end() to release us; safety nets in
    // sendMessage's finally block and abort() ensure we always exit.
    await endPromise;
  }

  return {
    iterable: generator(),
    controller: {
      end: (reason: string) => {
        if (!ended && endResolve) {
          // console.log(`[CLAUDE-CODE] PromptStreamController.end(reason="${reason}")`);
          endResolve();
        }
      },
      isEnded: () => ended,
    },
  };
}

/**
 * Resolve the SDK `permissionMode` from the session mode.
 *
 * - `planning` -> `plan` (SDK enforces read-only planning, scoped to plan file)
 * - `auto` -> `auto` (SDK classifier approves safe ops silently and escalates
 *   destructive or uncertain ones through `canUseTool` to the regular
 *   permission prompt; silent auto-deny only fires for SDK-level deny rules
 *   or `dontAsk` mode, not as the classifier's default response to risky tools)
 * - everything else (incl. `agent` and `undefined`) -> `default`
 *
 * See issue #371 and @anthropic-ai/claude-agent-sdk PermissionMode.
 */
export function resolvePermissionMode(
  currentMode: SessionMode
): 'plan' | 'auto' | 'default' {
  if (currentMode === 'planning') return 'plan';
  if (currentMode === 'auto') return 'auto';
  return 'default';
}

export async function buildSdkOptions(
  deps: BuildSdkOptionsDeps,
  params: BuildSdkOptionsParams
): Promise<BuildSdkOptionsResult> {
  const {
    resolveModelVariant,
    mcpConfigService,
    createCanUseToolHandler,
    toolHooksService,
    teammateManager,
    sessions,
    config,
    abortController,
  } = deps;

  const {
    message,
    workspacePath,
    sessionId,
    documentContext,
    settingsEnv,
    shellEnv,
    systemPrompt,
    currentMode,
    imageContentBlocks,
    documentContentBlocks,
    permissionsPath,
    mcpConfigWorkspacePath,
    isMetaAgent,
  } = params;

  let helperMethod: 'native' | 'custom' = 'native';

  // Determine which settings sources to use based on user preferences
  let settingSources: string[] = ['local'];
  if (ClaudeCodeDeps.claudeCodeSettingsLoader) {
    try {
      const ccSettings = await ClaudeCodeDeps.claudeCodeSettingsLoader();
      if (ccSettings.userCommandsEnabled) {
        settingSources.push('user');
      }
      if (ccSettings.projectCommandsEnabled) {
        settingSources.push('project');
      }
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to load Claude Code settings, using defaults:', error);
      settingSources = ['user', 'project', 'local'];
    }
  } else {
    settingSources = ['user', 'project', 'local'];
  }

  const enhancedPath = ClaudeCodeDeps.enhancedPathLoader?.() || undefined;
  const customPath = ClaudeCodeDeps.customClaudeCodePathLoader?.(workspacePath) || '';
  let resolvedBinaryPath: string | undefined;
  try {
    resolvedBinaryPath = await resolveClaudeAgentCliPath(enhancedPath);
  } catch (err) {
    // NIM-1573: In packaged builds there is no SDK self-resolve fallback --
    // letting pathToClaudeCodeExecutable become undefined makes the native SDK
    // emit a misleading "does not match this system's libc ... musl"
    // ReferenceError (e.g. after an interrupted CLI self-update orphaned the
    // bundled binary). Fail honestly with resolveClaudeAgentCliPath's
    // "repair Nimbalyst" message instead, so the provider's catch surfaces it
    // verbatim. In dev the SDK resolves its own native binary via
    // require.resolve, so a failure here is non-fatal; a user-configured custom
    // path also overrides.
    if (app.isPackaged && !customPath) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    resolvedBinaryPath = undefined;
  }
  const effectivePath = customPath || resolvedBinaryPath;
  // console.log(`[CLAUDE-CODE] Binary path: custom=${customPath || '(none)'} resolved=${resolvedBinaryPath ?? '(none)'} effective=${effectivePath ?? '(none)'}`);
  const resolvedModel = resolveModelVariant();

  const options: any = {
    pathToClaudeCodeExecutable: effectivePath,
    systemPrompt: isMetaAgent
      ? systemPrompt  // Plain string — fully replaces CC system prompt
      : {
          type: 'preset',
          preset: 'claude_code',
          append: systemPrompt
        },
    settingSources,
    mcpServers: await mcpConfigService.getMcpServersConfig({ sessionId, workspacePath: mcpConfigWorkspacePath || workspacePath }),
    // NIM-843 (SDK path): use ONLY the mcpServers we pass above and ignore the
    // SDK's own discovery (~/.claude.json, project .mcp.json, user settings,
    // claude.ai connectors). settingSources includes 'user'/'project' to load
    // slash commands/skills/hooks, but that also re-merges their mcpServers on
    // top of our filtered list — leaking user-disabled third-party servers into
    // sessions, ignoring the `disabled`/`enabledForProviders` toggle. strictMcpConfig
    // gates MCP only, so commands/skills/hooks from settingSources still load.
    // This mirrors the CLI path's `--strict-mcp-config` (claudeCliSpawnConfig.ts).
    strictMcpConfig: true,
    cwd: workspacePath,
    abortController,
    model: resolvedModel,
    // IMPORTANT: Do NOT add manual tool restrictions or prompt injections for plan mode here.
    // The SDK's `permissionMode: 'plan'` natively enforces planning restrictions (scopes
    // Write to the plan file only). Manual filtering was removed in favour of this approach.
    //
    // `permissionMode: 'auto'` delegates decisions to the SDK's classifier. The
    // classifier approves safe operations silently and ESCALATES destructive or
    // uncertain ones to `canUseTool` (which renders the normal permission prompt
    // for the user). It does not silently deny destructive tools by default --
    // silent auto-deny is reserved for SDK-level deny rules / dontAsk mode.
    // Because escalation still hits `canUseTool`, Nimbalyst's workspace rules
    // (allow-all / bypass-all in immediateToolDecision.ts) continue to apply on
    // the escalation path.
    permissionMode: resolvePermissionMode(currentMode),
    // When plan tracking is enabled, direct plan files to the project's plans folder
    // (relative to cwd). This applies whenever the agent enters plan mode, even mid-session.
    settings: {
      ...(ClaudeCodeDeps.planTrackingEnabled && { plansDirectory: 'nimbalyst-local/plans' }),
    },
    canUseTool: createCanUseToolHandler(sessionId, workspacePath, permissionsPath),
    hooks: {
      'PreToolUse': [{ hooks: [toolHooksService.createPreToolUseHook()] }],
      'PostToolUse': [{ hooks: [toolHooksService.createPostToolUseHook()] }],
      // PermissionDenied fires when the SDK denies a tool call without
      // escalating through canUseTool (auto-mode classifier confident deny,
      // headless auto-deny, deny rules, dontAsk mode). In auto-mode sessions
      // we mirror the Claude Code CLI behaviour and re-prompt the user
      // instead of leaving the call dead -- returning `retry: true` from the
      // hook causes the SDK to re-run the original tool call.
      'PermissionDenied': [{ hooks: [toolHooksService.createPermissionDeniedHook()] }],
    },
  };

  if (config.thinkingMode === 'disabled') {
    if (canDisableThinkingForModel(resolvedModel)) {
      options.thinking = { type: 'disabled' as const };
    } else {
      console.warn(`[CLAUDE-CODE] Extended thinking cannot be disabled for model "${resolvedModel}"; omitting SDK thinking option.`);
    }
  }

  if (currentMode === 'planning') {
    console.log('[CLAUDE-CODE] Plan mode active: delegating tool restrictions to SDK permissionMode=plan');
  } else if (currentMode === 'auto') {
    console.log('[CLAUDE-CODE] Auto mode active: SDK classifier handling permission decisions');
  }

  // Capture lead config for teammate spawning
  teammateManager.lastUsedCwd = workspacePath;
  teammateManager.lastUsedSessionId = sessionId;
  teammateManager.lastUsedPermissionsPath = permissionsPath;

  // Load extension plugins
  if (ClaudeCodeDeps.extensionPluginsLoader) {
    try {
      const extensionPlugins = await ClaudeCodeDeps.extensionPluginsLoader(workspacePath);
      if (extensionPlugins.length > 0) {
        options.plugins = extensionPlugins;
      }
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to load extension plugins:', error);
    }
  }

  // Add additional directories based on workspace context
  if (ClaudeCodeDeps.additionalDirectoriesLoader) {
    try {
      const additionalDirs = ClaudeCodeDeps.additionalDirectoriesLoader(workspacePath);
      if (additionalDirs.length > 0) {
        options.additionalDirectories = additionalDirs;
      }
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to load additional directories:', error);
    }
  }

  // Set up environment variables.
  // Strip API keys from every env source we compose so we never silently use
  // a key the user didn't explicitly configure in Nimbalyst settings. A user's
  // .env file with ANTHROPIC_API_KEY was picked up here and billed their
  // personal Anthropic account $100+.
  //
  // Defense-in-depth: the main-process bootstrap already deletes these from
  // process.env before any code runs, and we also strip them from shell/settings
  // overlays here. Do not set ANTHROPIC_API_KEY='' for login-based sessions:
  // the Claude native binary treats the mere presence of that variable as an
  // API-key auth signal, which can shadow a valid OAuth/CLI login and produce
  // "Authentication failed" even though accountInfo() succeeds in settings.
  const { ANTHROPIC_API_KEY: _envAnthropicKey, OPENAI_API_KEY: _envOpenaiKey, ...sanitizedProcessEnv } = process.env;
  const { ANTHROPIC_API_KEY: _shellAnthropicKey, OPENAI_API_KEY: _shellOpenaiKey, ...sanitizedShellEnv } = shellEnv;
  const { ANTHROPIC_API_KEY: _settingsAnthropicKey, OPENAI_API_KEY: _settingsOpenaiKey, ...sanitizedSettingsEnv } = settingsEnv;

  const enableAgentTeams = sanitizedSettingsEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
  const env: any = {
    ...sanitizedProcessEnv,
    ...sanitizedShellEnv,
    ...sanitizedSettingsEnv,
    // 'true' = unconditional tool-search deferral: every MCP tool defers
    // regardless of the model's context window, except the core subset marked
    // always-load via per-tool _meta (CORE_ALWAYS_LOAD_TOOLS). The CLI's `auto:N` mode is all-or-nothing against a
    // threshold of N% of the context window (integer N only), so the previous
    // `auto:2` default meant a 20K-token eager floor on 1M-context models —
    // any tool corpus under that loaded entirely upfront on every session.
    // Default only — a user-set ENABLE_TOOL_SEARCH (settings env vars, shell,
    // or process env) must win, otherwise the `ENABLE_TOOL_SEARCH = false`
    // remediation that buildBedrockToolErrorGuidance tells users to apply is
    // silently clobbered. (NIM-1475)
    ...(sanitizedProcessEnv.ENABLE_TOOL_SEARCH == null &&
      sanitizedShellEnv.ENABLE_TOOL_SEARCH == null &&
      sanitizedSettingsEnv.ENABLE_TOOL_SEARCH == null && {
        ENABLE_TOOL_SEARCH: 'true',
      }),
    // The bundled SDK at assistant.mjs sets CLAUDE_CODE_ENTRYPOINT to "sdk-ts"
    // when not already set in the environment. Anthropic's backend treats
    // `cli` traffic as first-party and `sdk-ts` traffic as third-party,
    // which puts the latter into a deprioritized lane that gets throttled
    // first under load. Users on Pro/Max OAuth report rate-limit errors when
    // running Nimbalyst alongside the standalone Claude Code CLI even at low
    // usage; setting this to `cli` aligns Nimbalyst's classification with
    // the official CLI and removes that asymmetry. The user can still
    // override via their own env var if they want the original sdk-ts label.
    ...(process.env.CLAUDE_CODE_ENTRYPOINT == null && { CLAUDE_CODE_ENTRYPOINT: 'cli' }),
    ...(config.effortLevel && config.effortLevel !== DEFAULT_EFFORT_LEVEL && {
      CLAUDE_CODE_EFFORT_LEVEL: config.effortLevel
    }),
    // The bundled claude binary runs a per-tool idle-timeout watchdog (default
    // 300s) over MCP servers whose transport is http/sse/ws. ALL Nimbalyst
    // in-app MCP servers use SSE, and the interactive input tools
    // (PromptForUserInput, AskUserQuestion) block indefinitely waiting for the
    // human — so the watchdog aborts them at 300s and the prompt collapses
    // (#758). Our SSE servers are local in-process, so a "hung" tool is our own
    // bug rather than a flaky network the watchdog guards against; disable it
    // by default. A user-set value (settings/shell/process env) still wins.
    ...(sanitizedProcessEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT == null &&
      sanitizedShellEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT == null &&
      sanitizedSettingsEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT == null && {
        CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0',
      }),
    // NIM-1573: Pin the bundled native CLI's self-updater OFF. We ship a
    // version-pinned binary and spawn it in place from app.asar.unpacked; the
    // CLI's AutoUpdater does a non-atomic in-place `rename claude.exe ->
    // claude.exe.old.<ts>` + re-download on version drift, and an interrupted
    // update leaves an orphan with no `claude.exe`, permanently breaking Claude
    // Code (surfacing a misleading libc/musl ReferenceError). The updater's gate
    // honors DISABLE_UPDATES / DISABLE_AUTOUPDATER. Default only -- a user-set
    // value (settings/shell/process env) still wins.
    ...(sanitizedProcessEnv.DISABLE_AUTOUPDATER == null &&
      sanitizedShellEnv.DISABLE_AUTOUPDATER == null &&
      sanitizedSettingsEnv.DISABLE_AUTOUPDATER == null && {
        DISABLE_AUTOUPDATER: '1',
      }),
    ...(sanitizedProcessEnv.DISABLE_UPDATES == null &&
      sanitizedShellEnv.DISABLE_UPDATES == null &&
      sanitizedSettingsEnv.DISABLE_UPDATES == null && {
        DISABLE_UPDATES: '1',
      }),
  };

  // NIM-376: Overlay enhanced PATH so the Claude Code SDK can find stdio MCP
  // subprocess binaries (`npx`, `uvx`, `docker`, ...) when Nimbalyst is launched
  // from Dock/Finder. GUI-launched Electron on macOS has a minimal PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew/nvm/volta,
  // and CLIManager's cachedShellEnvironment deliberately strips PATH so
  // shellEnv can't contribute it either.
  if (enhancedPath) {
    env.PATH = enhancedPath;
  }

  // NIM-838: On Windows, force HOME to mirror USERPROFILE so the native binary
  // resolves the same ~/.claude root on every spawn, regardless of whether its
  // internal logic prefers HOME (Unix-style) or USERPROFILE. process.env on
  // Windows usually has USERPROFILE but no HOME, leaving the binary to make a
  // platform-specific choice; a mismatch between turn-1 write and turn-2 read
  // would manifest exactly as the resume failures we're seeing.
  if (process.platform === 'win32') {
    const winHome = env.USERPROFILE || process.env.USERPROFILE;
    if (winHome) {
      env.HOME = winHome;
      env.USERPROFILE = winHome;
    }
  }

  if (enableAgentTeams) {
    env.CLAUDE_CODE_ENABLE_TASKS = '1';
  }

  const effectiveTeamContext = enableAgentTeams
    ? await teammateManager.resolveTeamContext(sessionId)
    : undefined;

  if (effectiveTeamContext) {
    env.CLAUDE_CODE_TEAM_NAME = effectiveTeamContext;
    env.CLAUDE_CODE_TASK_LIST_ID = effectiveTeamContext;
    env.CLAUDE_CODE_AGENT_ID = `team-lead@${effectiveTeamContext}`;
    env.CLAUDE_CODE_AGENT_NAME = 'team-lead';
    env.CLAUDE_CODE_AGENT_TYPE = 'team-lead';
  }

  // Production packaged build setup.
  // The env built above already starts from process.env (with API keys stripped).
  // The native binary only needs HOME/USERPROFILE (already in process.env) to
  // find ~/.claude/. We no longer overlay setupClaudeCodeEnvironment() because
  // it was designed for the old Node.js execution path and its Object.assign
  // clobbered our sanitized env.
  if (app.isPackaged) {
    if (customPath) {
      helperMethod = 'custom';
    } else {
      console.log(`[ClaudeCodeProvider] Pre-resolved native binary for packaged build: ${resolvedBinaryPath ?? '(resolveClaudeAgentCliPath returned undefined)'}`);
    }

    teammateManager.packagedBuildOptions = {
      env: env as Record<string, string | undefined>,
      pathToClaudeCodeExecutable: customPath || resolvedBinaryPath,
    };
  }

  // Per-session API key
  if (config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey;
    if (teammateManager.packagedBuildOptions?.env) {
      teammateManager.packagedBuildOptions.env.ANTHROPIC_API_KEY = config.apiKey;
    }
  }

  options.env = env;

  // Handle session resumption and branching
  if (sessionId) {
    const claudeSessionId = sessions.getSessionId(sessionId);
    if (claudeSessionId) {
      options.resume = claudeSessionId;
    } else {
      const branchedFromSessionId = documentContext?.branchedFromSessionId;
      const branchedFromProviderSessionId = documentContext?.branchedFromProviderSessionId;
      if (branchedFromSessionId && branchedFromProviderSessionId) {
        options.resume = branchedFromProviderSessionId;
        options.forkSession = true;
      } else if (branchedFromSessionId) {
        const sourceClaudeSessionId = sessions.getSessionId(branchedFromSessionId);
        if (sourceClaudeSessionId) {
          options.resume = sourceClaudeSessionId;
          options.forkSession = true;
        } else {
          console.warn('[CLAUDE-CODE] Cannot branch: source provider session ID not available. branchedFromSessionId:', branchedFromSessionId);
        }
      }
    }
  }

  // Build prompt input. Always use a persistent AsyncIterable (never a bare
  // string) so isSingleUserTurn=false in the SDK -- this prevents the SDK
  // from closing the binary's stdin pipe on `type: 'result'` and avoids the
  // "Stream closed" tool permission errors on long turns.
  const hasAttachmentBlocks = imageContentBlocks.length > 0 || documentContentBlocks.length > 0;
  const userContent: string | ContentBlockParam[] = hasAttachmentBlocks
    ? [
        ...imageContentBlocks,
        ...documentContentBlocks,
        { type: 'text', text: message } as TextBlockParam,
      ]
    : message;

  const initialMessage: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: userContent as any },
    parent_tool_use_id: null,
  };

  const { iterable: promptInput, controller: promptController } =
    createPersistentPromptStream(initialMessage);

  return { options, promptInput, promptController, helperMethod };
}
