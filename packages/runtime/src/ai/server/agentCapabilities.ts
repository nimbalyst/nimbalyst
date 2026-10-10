/**
 * Declared agent-capability contract.
 *
 * Before this existed, host-surface capabilities were optional duck-typed
 * methods on `AIProvider` (`getSlashCommands?()`, `getSkills?()`) and callers
 * asked `typeof provider.getSkills === 'function'`. That made "this provider
 * never implemented it" indistinguishable from "this provider has none right
 * now": both produced an empty list, no error, and no compile failure. A
 * transport migration could silently drop a capability and nothing in the
 * system would ever say so — which is how #1251-#1254 shipped.
 *
 * Two properties make that class of bug loud instead of silent:
 *
 * 1. `AgentCapabilities` has no optional members, and
 *    `BUILTIN_AGENT_CAPABILITIES` is an exhaustive `Record<AIProviderType, …>`.
 *    Adding a capability breaks every provider entry until it says yes or no;
 *    adding a provider to `AI_PROVIDER_TYPES` breaks the record until it
 *    declares. There is no partial-with-defaults helper on purpose — a
 *    permissive default is exactly the hole this closes.
 * 2. Support is declared separately from the data. `slashCommands: false` with
 *    an empty list means "there is no mechanism, hide the affordance";
 *    `slashCommands: true` with an empty list means "supported, nothing to
 *    show yet" (e.g. the catalog arrives with the SDK init payload).
 *
 * Context reporting follows the same rule. Its three states were added only
 * after every built-in provider path was measured: cumulative token counts are
 * not a current-context snapshot, and no usage signal must hide the indicator
 * rather than render a lying 0% (#914).
 */

import type { AIProviderType } from './types';

/**
 * How the host compacts a session's context.
 *
 * - `'rpc'`: the provider implements `compactSession(sessionId)` against a real
 *   protocol call.
 * - `'slash-command'`: the agent itself interprets a `/compact` user turn.
 * - `'unsupported'`: neither. Sending `/compact` as prompt text reaches the
 *   model as literal words and silently does nothing (#1252), so the caller
 *   must hide the action rather than offer a no-op.
 */
export type CompactionSupport = 'rpc' | 'slash-command' | 'unsupported';

/**
 * How much context-usage information the provider can report honestly.
 *
 * - `'none'`: no measured usage signal; hide the indicator.
 * - `'token-counts'`: cumulative input/output counts only. These are useful in
 *   the tooltip, but cannot produce a current-context percentage.
 * - `'context-window'`: both the current context fill and its model-specific
 *   denominator are available, so a percentage is meaningful.
 */
export type ContextReportingSupport = 'none' | 'token-counts' | 'context-window';

export interface AgentCapabilities {
  /**
   * The provider can enumerate slash commands it will genuinely service, via
   * `getSlashCommands()`. This is about provider-*native* commands only —
   * workspace `.claude/commands` files are the AgentWorkflowService's business
   * and are surfaced regardless.
   */
  slashCommands: boolean;

  /** The provider can enumerate skills it can resolve, via `getSkills()`. */
  skills: boolean;

  compaction: CompactionSupport;

  contextReporting: ContextReportingSupport;
}

/**
 * Fail-closed declaration for any provider whose support is unknown (for
 * example, an extension contribution whose manifest says nothing).
 */
export const NO_AGENT_CAPABILITIES: AgentCapabilities = Object.freeze({
  slashCommands: false,
  skills: false,
  compaction: 'unsupported',
  contextReporting: 'none',
});

const TOKEN_COUNT_ONLY_CAPABILITIES: AgentCapabilities = Object.freeze({
  slashCommands: false,
  skills: false,
  compaction: 'unsupported',
  contextReporting: 'token-counts',
});

/**
 * Per-provider-type declarations for everything built in to Nimbalyst.
 *
 * Instances may narrow this further — `OpenAICodexProvider` reports
 * `compaction: 'unsupported'` when it is running the legacy SDK transport,
 * which has no compaction RPC.
 */
export const BUILTIN_AGENT_CAPABILITIES: Readonly<Record<AIProviderType, AgentCapabilities>> = Object.freeze({
  // Chat providers report cumulative request token counts, but none reports a
  // distinct current-context snapshot. A model catalog window cannot turn
  // cumulative spend into an honest fill percentage.
  claude: TOKEN_COUNT_ONLY_CAPABILITIES,
  openai: TOKEN_COUNT_ONLY_CAPABILITIES,
  lmstudio: TOKEN_COUNT_ONLY_CAPABILITIES,

  // The Claude Agent SDK reports its own commands and skills in the init
  // payload and interprets `/compact` as a real command.
  'claude-code': {
    slashCommands: true,
    skills: true,
    compaction: 'slash-command',
    contextReporting: 'context-window',
  },

  // The genuine CLI is driven by its PTY, not by this provider class:
  // `sendMessage` throws, so there is nothing here to enumerate or compact.
  // Its own TUI still handles `/`-commands the user types into the terminal;
  // the host observation proxy independently supplies currentContext.
  'claude-code-cli': {
    slashCommands: false,
    skills: false,
    compaction: 'unsupported',
    contextReporting: 'context-window',
  },

  // Codex: skills are real (skills/list over the app-server), slash commands
  // are not — the app-server interprets none, so the catalog is deliberately
  // empty rather than advertising TUI names that no-op (#1252). Compaction is
  // `thread/compact/start`.
  'openai-codex': {
    slashCommands: false,
    skills: true,
    compaction: 'rpc',
    contextReporting: 'context-window',
  },

  // Codex ACP sends usage_update with both used and size. Copilot's ACP parser
  // handles no usage event at all. OpenCode's assistant message updates carry
  // the fill, and its discovered model catalog supplies the window.
  'openai-codex-acp': {
    slashCommands: false,
    skills: false,
    compaction: 'unsupported',
    contextReporting: 'context-window',
  },
  opencode: {
    slashCommands: true,
    skills: false,
    compaction: 'rpc',
    contextReporting: 'context-window',
  },
  'copilot-cli': {
    slashCommands: false,
    skills: false,
    compaction: 'unsupported',
    contextReporting: 'none',
  },

  // Grok headless emits `usage` events and a final `end` with cumulative
  // input/output/cache token counts and cost — but no context-window size, so
  // there is no honest percentage to draw. Its `/`-commands live in the TUI;
  // the `available_commands` event names built-in *tools*, not commands a
  // headless prompt can invoke, so offering them would be a no-op (#1252).
  'grok-build': {
    slashCommands: false,
    skills: false,
    compaction: 'unsupported',
    contextReporting: 'token-counts',
  },

  // Cursor's stream-json `result` carries inputTokens/outputTokens/
  // cacheReadTokens, again with no denominator. Headless `--print` exposes no
  // command catalog and no compaction call.
  'cursor-agent': {
    slashCommands: false,
    skills: false,
    compaction: 'unsupported',
    contextReporting: 'token-counts',
  },

  // Antigravity's `GetModelResponse` returns `{ response }` and nothing else --
  // no input/output counts, no context fill, no denominator. Measured against
  // the live server, not inferred from a manifest. The account-level quota RPC
  // reports a remaining *fraction* per model, which is a rate-limit signal
  // rather than a context measurement, so it belongs in the usage chip and not
  // here. There is likewise no command catalog and no compaction call.
  'antigravity-gemini-agent': {
    slashCommands: false,
    skills: false,
    compaction: 'unsupported',
    contextReporting: 'none',
  },
});

/**
 * Declaration for a provider id when no live instance is available (the `/`
 * typeahead runs before a session has started, and the compact affordance is
 * decided in the renderer). Unknown ids — extension-contributed agents, which
 * declare from their manifest via the extension bridge — fail closed.
 */
export function agentCapabilitiesForProviderType(providerType?: string | null): AgentCapabilities {
  if (!providerType) {
    return NO_AGENT_CAPABILITIES;
  }
  return (BUILTIN_AGENT_CAPABILITIES as Record<string, AgentCapabilities>)[providerType]
    ?? NO_AGENT_CAPABILITIES;
}

/**
 * Whether the provider's turns read `metadata.sessionDirective` (the frozen
 * system-prompt addition an extension sets when it creates a session, see
 * `providers/sessionDirective.ts`). Exhaustive for the same reason as
 * `BUILTIN_AGENT_CAPABILITIES`: a new provider must say yes or no, because a
 * directive stored on a session whose provider ignores it is silently lost.
 *
 * Chat providers never read it. `claude-code-cli` drives the genuine CLI
 * through its PTY, so no provider-built system prompt reaches it.
 */
const BUILTIN_SESSION_DIRECTIVE_SUPPORT: Readonly<Record<AIProviderType, boolean>> = Object.freeze({
  claude: false,
  openai: false,
  lmstudio: false,
  'claude-code-cli': false,
  'claude-code': true,
  'openai-codex': true,
  'openai-codex-acp': true,
  opencode: true,
  'copilot-cli': true,
  'grok-build': true,
  'cursor-agent': true,
  'antigravity-gemini-agent': true,
});

/** Unknown ids (extension-contributed agents) fail closed, like `agentCapabilitiesForProviderType`. */
export function providerAppliesSessionDirective(providerType?: string | null): boolean {
  if (!providerType) return false;
  return (BUILTIN_SESSION_DIRECTIVE_SUPPORT as Record<string, boolean>)[providerType] ?? false;
}
