/**
 * Spawn-config builder for the genuine `claude` CLI on the user's subscription
 * (NIM-806, Phase 1). Pure construction of `{ executable, args, env }` so it is
 * unit-testable without spawning a process; the caller hands the result to
 * node-pty (the existing ghostty-web terminal strip).
 *
 * This runs the REAL interactive CLI — never `-p`/`--print` (the headless path).
 * Structure for the native transcript comes from the observation backend
 * (terminal-only → jsonl → proxy), not from headless mode.
 *
 * The CLI authenticates with whatever it's logged into — the user's call. We do
 * NOT model billing here. The one guard we keep is dropping `ANTHROPIC_API_KEY`
 * from the env we hand the CLI, per CLAUDE.md → "Never Use Environment Variables
 * as Implicit API Key Sources": a stray key in the user's shell env (e.g. from
 * an unrelated `.env`) silently overriding their `claude` login is the exact
 * documented $100 incident. Phase 3's proxy is wired via `extraEnv`
 * (ANTHROPIC_BASE_URL), never a key.
 */

import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { normalizeClaudeCodeVariant } from '@nimbalyst/runtime/ai/modelConstants';

/**
 * Resolve a Nimbalyst model id to the alias the genuine `claude` CLI accepts for
 * `--model` (`opus` / `sonnet` / `haiku`, with an optional `[1m]` suffix).
 *
 * Nimbalyst stores the combined `provider:variant` form (e.g.
 * `claude-code-cli:opus-1m`); the provider prefix and Nimbalyst's internal `-1m`
 * suffix are not valid `claude --model` values. For extended-context variants we
 * translate `-1m` to the CLI's own `[1m]` form (e.g. `opus[1m]`) so the launched
 * session actually runs at 1M context — the CLI strips `[1m]` before sending the
 * model id, same as the Agent SDK (see `resolveClaudeCodeModelVariant`). Dropping
 * the suffix instead silently downgraded 1M selections to 200k (NIM-809).
 *
 * Returns `undefined` when there's nothing usable (let the CLI default). A bare
 * full model name (no recognizable variant) passes through unchanged since the
 * CLI also accepts full Anthropic model IDs.
 */
export function resolveClaudeCliModelArg(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;

  // Combined "provider:variant" id → take the variant part; bare value → itself.
  const parsed = ModelIdentifier.tryParse(trimmed);
  const isExtended = parsed ? parsed.isExtendedContext : /-1m$/i.test(trimmed);
  const variantInput = parsed ? parsed.baseVariant : trimmed.toLowerCase().replace(/-1m$/, '');

  const variant = normalizeClaudeCodeVariant(variantInput);
  if (variant) {
    // Collapse pinned opus variants (opus-4-7 / opus-4-6) to the CLI's `opus` alias.
    const alias = variant.startsWith('opus') ? 'opus' : variant;
    return isExtended ? `${alias}[1m]` : alias;
  }

  // Unknown format: a bare full model name is fine to pass through; a non-claude
  // combined id (e.g. `openai:gpt-5`) must never reach `claude --model`.
  return parsed ? undefined : trimmed;
}

export interface ClaudeCliSpawnInput {
  /** Resolved `claude` binary path, or the bare command. Default `claude`. */
  claudeExecutable?: string;
  /** Working directory for the CLI (workspace or worktree path). */
  cwd: string;
  /** Path to the sessionId-bearing MCP config file written for this session. */
  mcpConfigPath?: string;
  /**
   * Nimbalyst session id. When it is a valid UUID and we're not resuming, it is
   * passed as `--session-id` so the CLI's own session id equals ours — making
   * the proxy/jsonl observation paths deterministically attributable to this
   * Nimbalyst session. Ignored if `resumeSessionId` is set (the two conflict).
   */
  sessionId?: string;
  /** Resolved Claude model variant (e.g. `opus`, `sonnet`). */
  model?: string;
  /** Resume an existing CLI session id (`--resume <id>`). */
  resumeSessionId?: string;
  /** Resume the most recent CLI session (`--continue`). Ignored if `resumeSessionId` is set. */
  continueSession?: boolean;
  /** Base environment to derive from (typically `process.env`). */
  baseEnv: Record<string, string | undefined>;
  /** Login-shell-enhanced PATH so GUI-launched Electron can find `claude`. */
  enhancedPath?: string;
  /**
   * Observation-backend env overrides. Phase 3 passes `ANTHROPIC_BASE_URL` here
   * to point the CLI at the local SSE-tee proxy. Never used to inject API keys.
   */
  extraEnv?: Record<string, string>;
  /**
   * Names of trusted MCP servers to pre-allow (NIM-806 BUG 2). Each becomes a
   * server-level `mcp__<server>` entry in `--allowedTools`, so the genuine CLI
   * never shows its built-in TUI permission prompt for those servers' tools (our
   * own Nimbalyst MCP servers — they render durable-prompt widgets and are answered
   * over IPC, so a second TUI gate double-prompts on top of the widget). Built-in
   * Bash/Edit/Write are deliberately NOT included — they keep the normal gate.
   */
  allowedMcpServerNames?: string[];
  /**
   * JSON string for `--settings` (NIM-806 Phase 4, Direction A). Used to register
   * a `PreToolUse` permission hook so built-in Bash/Edit/Write requests route to
   * a Nimbalyst ToolPermission widget instead of the native TUI prompt. (The
   * interactive CLI ignores `--permission-prompt-tool`; a PreToolUse hook is the
   * mechanism that works interactively.) The CLI accepts a JSON string or a file
   * path here. Omit to keep the native gate.
   */
  settingsJson?: string;
  /**
   * Skip the CLI's permission gate entirely via its own
   * `--dangerously-skip-permissions` (NIM-806 Phase 4). Set only for workspaces the
   * user has explicitly trusted "allow-all"/"bypass-all": the genuine CLI then runs
   * every built-in tool without prompting, so we drop the PreToolUse hook
   * (`settingsJson`) — the two are mutually exclusive (the launcher never sets both).
   * We still deny the built-in `AskUserQuestion` (MCP routing is unaffected by the
   * permission skip). Defaults to the gated path when unset/false.
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * Extra directories to pre-authorize for the CLI's file tools via `--add-dir`
   * (NIM-806 — input integration). Pasted chat attachments are written OUTSIDE
   * the workspace cwd (under `<userData>/chat-attachments/<workspaceDir>/...`), so
   * referencing one by path makes the genuine CLI show its native "read outside
   * working directory" permission prompt on every pasted image. Listing that root
   * here adds it to the CLI's allowed working set so its read-only tools
   * auto-allow it (exactly as they do inside the workspace). Empty/whitespace
   * entries are skipped; omit for no extra directories.
   */
  additionalDirectories?: string[];
  /**
   * Extension Claude-plugin directories to load for this session via
   * `--plugin-dir <dir>` (NIM-845). Each is a bare plugin directory (one
   * containing `.claude-plugin/plugin.json` + `commands/`) — the CLI analog of
   * the Agent SDK's `{ type: 'local', path }`. Loading them is what makes
   * namespaced slash commands (`/feedback:bug-report`, `/planning:design`, …)
   * resolve in a `claude-code-cli` session; without them the binary honestly
   * reports `Unknown command`. The launcher only populates this when the resolved
   * CLI is new enough to accept `--plugin-dir` (≥ 2.1.142 — see
   * `claudeCliPluginSupport.ts`); on older CLIs it's omitted (the flag would be
   * rejected as unknown and crash the launch). Empty/whitespace entries are
   * skipped; omit for no extension plugins.
   */
  pluginDirs?: string[];
  /** Extra CLI args appended verbatim (escape hatch for flags we pass through). */
  extraArgs?: string[];
  /** Platform (process.platform); injectable for cross-platform tests. */
  platform?: NodeJS.Platform;
}

export interface ClaudeCliSpawnConfig {
  executable: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Env keys we strip before spawning the genuine `claude` CLI.
 *
 * - `ANTHROPIC_API_KEY` — CLAUDE.md implicit-API-key rule: a stray shell key must
 *   never override (or get billed against) the CLI's own subscription login.
 * - `CLAUDECODE` — the running `claude` CLI sets this in its child env so nested
 *   processes know they're inside a Claude Code session. If Nimbalyst itself was
 *   launched from inside a `claude` session (e.g. dev started from Claude Code),
 *   the main process inherits `CLAUDECODE=1` and would forward it to our spawned
 *   CLI, which can then refuse to start.
 */
const FORBIDDEN_ENV_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'CLAUDECODE'];

/**
 * Built-in CLI tools we deny so the model uses our MCP equivalents instead.
 *
 * The genuine `claude` CLI ships its own built-in `AskUserQuestion` that renders
 * in the TUI and never routes through MCP — so a Nimbalyst durable-prompt widget
 * can't observe or answer it. Denying it forces the model onto our
 * `mcp__nimbalyst__AskUserQuestion`, which blocks on IPC and is answered by
 * the widget rendered above the terminal (NIM-806).
 *
 * `ExitPlanMode` is intentionally NOT here: there is no MCP replacement for it
 * yet, so denying it would strip plan-approval with nothing to take its place.
 * It keeps rendering natively in the TUI (answerable there) until Phase 4.
 */
const CLAUDE_CLI_DISALLOWED_TOOLS: readonly string[] = ['AskUserQuestion'];

/** RFC-4122 UUID matcher — the only `--session-id` value the CLI accepts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * System-prompt nudge steering the model to our MCP interactive tools.
 *
 * Mirrors Mainframe's technique (a system-prompt append telling Claude to use
 * the structured question tool) but points at our MCP tools rather than the
 * built-in, since in our interactive-PTY posture the built-in renders in the
 * terminal with no clean answer path. Paired with the disallow above for
 * reliability.
 */
const CLAUDE_CLI_INTERACTIVE_TOOLS_NUDGE = [
  'You are running inside Nimbalyst, a desktop GUI that manages your session.',
  'When you need user input, a decision, or disambiguation, call the',
  'mcp__nimbalyst__AskUserQuestion tool (multiple-choice) or the',
  'mcp__nimbalyst__PromptForUserInput tool (richer structured input) —',
  'they render as interactive UI elements the user can click. Do not ask',
  'questions in plain text.',
].join(' ');

/**
 * Session-naming nudge. Unlike the Agent-SDK path, the genuine CLI never
 * receives Nimbalyst's full system prompt (we only `--append-system-prompt` a
 * snippet), and it has no out-of-band naming path (the SDK names sessions via
 * the in-process `generateSessionTitle`, which an external process can't reach).
 * So without this nudge a `claude-code-cli` session is never named at all. The
 * eager core `nimbalyst` MCP server (which now carries `update_session_meta`,
 * MCP consolidation Phase 5) IS in the CLI's `--mcp-config`, so the tool is
 * callable — the model just has to be told to call it. Condensed from
 * `buildSessionNamingSection` in runtime's prompt.ts.
 */
const CLAUDE_CLI_SESSION_NAMING_NUDGE = [
  'Early in your first turn — as soon as you understand what the user wants —',
  'call the mcp__nimbalyst__update_session_meta tool to name this',
  'session. Pass `name` (2-5 words, the descriptive part first, based on what the',
  'user asked for — e.g. "Dark mode implementation"), `add` (2-4 lowercase',
  'hyphenated tags for the type of work and area, e.g. ["bug-fix", "ui"]), and',
  '`phase` (one of backlog, planning, implementing, validating). Call it again',
  'later only when the phase changes.',
].join(' ');

const CLAUDE_CLI_SYSTEM_PROMPT_APPEND = [
  CLAUDE_CLI_INTERACTIVE_TOOLS_NUDGE,
  CLAUDE_CLI_SESSION_NAMING_NUDGE,
].join('\n\n');

export function buildClaudeCliSpawnConfig(input: ClaudeCliSpawnInput): ClaudeCliSpawnConfig {
  const executable = input.claudeExecutable || 'claude';

  const args: string[] = [];
  // Never pass the combined `provider:variant` id (or the `-1m` suffix) to
  // `claude --model` — resolve it to the bare CLI alias first.
  const modelArg = resolveClaudeCliModelArg(input.model);
  if (modelArg) {
    args.push('--model', modelArg);
  }
  if (input.mcpConfigPath) {
    args.push('--mcp-config', input.mcpConfigPath);
    // NIM-843: pair with --strict-mcp-config so the genuine `claude` binary uses
    // ONLY this snapshot and does NOT merge its own discovery (~/.claude.json,
    // project .mcp.json, .claude/settings.json, claude.ai connectors). Without it
    // the binary loads every server it finds in ~/.claude.json — ignoring the
    // `disabled` flag Nimbalyst writes — so user-disabled third-party servers leak
    // into CLI sessions and eat context. The snapshot already carries the enabled
    // set (filtered by isMCPServerEnabledForProvider), so strict mode gives the
    // Nimbalyst toggle the same authority over CLI sessions as the SDK path.
    args.push('--strict-mcp-config');
  }
  if (input.resumeSessionId) {
    args.push('--resume', input.resumeSessionId);
  } else if (input.continueSession) {
    args.push('--continue');
  } else if (input.sessionId && UUID_RE.test(input.sessionId)) {
    // Pin the CLI's session id to ours so observation (proxy/jsonl) is
    // deterministically attributable. Only when fresh — `--session-id` and
    // `--resume` are mutually exclusive.
    args.push('--session-id', input.sessionId);
  }
  // Trusted "allow-all"/"bypass-all" workspaces skip the gate entirely via the
  // genuine CLI's own flag (NIM-806 Phase 4). Value-less boolean, safe before the
  // variadics. The launcher never sets this together with `settingsJson` (the hook
  // would prompt on top of the skip), but they're independent here for safety.
  if (input.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  // Register the PreToolUse permission hook via --settings so built-in tool
  // prompts route to a Nimbalyst widget (NIM-806 Phase 4). Value-bearing flag —
  // MUST precede the `--allowedTools`/`--disallowedTools` variadics below so its
  // single JSON value isn't swallowed by a variadic.
  if (input.settingsJson) {
    args.push('--settings', input.settingsJson);
  }
  // Pre-authorize reads of files OUTSIDE the workspace cwd (NIM-806). Pasted chat
  // attachments live under `<userData>/chat-attachments/...`; without `--add-dir`
  // the CLI's Read tool shows its native "read outside working directory" prompt
  // on every pasted image. `--add-dir` is variadic in commander, but the
  // always-present `--disallowedTools` flag below terminates it, so it consumes
  // only these directory values. Placed after the value-bearing `--settings` so
  // neither swallows the other.
  const additionalDirs = (input.additionalDirectories ?? [])
    .map((d) => (typeof d === 'string' ? d.trim() : ''))
    .filter((d) => d.length > 0);
  if (additionalDirs.length > 0) {
    args.push('--add-dir', ...additionalDirs);
  }
  // Load extension Claude-plugins so namespaced slash commands resolve (NIM-845).
  // `--plugin-dir` is value-bearing (ONE path per flag) and repeatable — emit it
  // once per directory. It must precede the trailing --allowedTools/--disallowedTools
  // variadics so its single value isn't swallowed; placed after --add-dir, both
  // before the variadics. The launcher only passes pluginDirs when the resolved CLI
  // supports the flag (≥ 2.1.142); older CLIs would reject it as an unknown option.
  const pluginDirs = (input.pluginDirs ?? [])
    .map((d) => (typeof d === 'string' ? d.trim() : ''))
    .filter((d) => d.length > 0);
  for (const dir of pluginDirs) {
    args.push('--plugin-dir', dir);
  }
  // Pre-allow our trusted Nimbalyst MCP servers at the server level so the genuine
  // CLI doesn't double-prompt (its built-in TUI permission gate) on top of the
  // durable-prompt widget we render (NIM-806 BUG 2). Server-level `mcp__<server>`
  // allows all of that server's tools; built-in Bash/Edit/Write are NOT listed and
  // still get the normal gate.
  //
  // Commander variadic ordering: BOTH `--allowedTools` and `--disallowedTools` are
  // variadic. The allow variadic is terminated by the `--disallowedTools` flag; the
  // disallow variadic by the value-bearing `--append-system-prompt`. All earlier
  // value-bearing flags (--model/--mcp-config/--session-id) precede the variadics so
  // they can't be swallowed. Keep this trailing block in this exact order.
  const allowedServerEntries = (input.allowedMcpServerNames ?? [])
    .filter((name) => typeof name === 'string' && name.length > 0)
    .map((name) => `mcp__${name}`);
  if (allowedServerEntries.length > 0) {
    args.push('--allowedTools', ...allowedServerEntries);
  }
  // Force the model off the built-in TUI AskUserQuestion and onto our MCP tool.
  args.push('--disallowedTools', ...CLAUDE_CLI_DISALLOWED_TOOLS);
  args.push('--append-system-prompt', CLAUDE_CLI_SYSTEM_PROMPT_APPEND);
  if (input.extraArgs?.length) {
    args.push(...input.extraArgs);
  }

  // Build env: start from base, apply terminal + PATH, then observation overrides.
  const merged: Record<string, string | undefined> = { ...input.baseEnv };
  if (input.enhancedPath) {
    merged.PATH = input.enhancedPath;
  }
  merged.TERM = 'xterm-256color';
  merged.COLORTERM = 'truecolor';
  merged.LANG = merged.LANG || 'en_US.UTF-8';
  // Defer MCP tool descriptions out of the upfront context, matching the Agent
  // SDK path (sdkOptionsBuilder.ts sets the same 'true'). Without this the
  // genuine CLI loads EVERY enabled server's full tool schema into the system
  // prompt on turn 1: with Nimbalyst's core MCP servers in the `--mcp-config`
  // snapshot that is ~30K+ tokens of "MCP tools" baseline (observed via
  // `/context`) — whereas the SDK session shows the same servers as deferred
  // (~800 active). 'true' defers unconditionally (the CORE_ALWAYS_LOAD_TOOLS
  // subset stays eager); the CLI's `auto:N` mode is all-or-nothing against N% of the
  // context window, which on 1M-context models left a 20K-token eager floor.
  // Set as a default the user can still override via their own shell/`baseEnv`.
  if (merged.ENABLE_TOOL_SEARCH == null) {
    merged.ENABLE_TOOL_SEARCH = 'true';
  }
  if (input.extraEnv) {
    Object.assign(merged, input.extraEnv);
  }

  // Hard invariant: never let an API key cross into the subscription env.
  for (const key of FORBIDDEN_ENV_KEYS) {
    delete merged[key];
  }

  // Drop undefined values so node-pty receives a clean string env.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  // On Windows, node-pty runs a `.cmd`/`.bat` through cmd.exe, which is
  // line-oriented: a newline inside an argument truncates the command line at
  // that point, dropping everything after it. Nimbalyst passes a multi-line
  // `--append-system-prompt`, so collapse CR/LF runs to a single space for the
  // `.cmd`/`.bat` launch path. The append is plain instructions, so single-lining
  // is semantically harmless; a real `.exe` or the SDK path is unaffected. (#684)
  const platform = input.platform ?? process.platform;
  const launchArgs =
    platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
      ? args.map((arg) => arg.replace(/[\r\n]+/g, ' '))
      : args;

  return { executable, args: launchArgs, env };
}
