/**
 * Declared file-tracking contract per provider.
 *
 * Two decisions used to be hardcoded string comparisons against a single
 * provider id, in the middle of the streaming handler:
 *
 * ```ts
 * if (providerName !== 'openai-codex') return 'fuzzy';
 * const isOpenCodeEdit = OPENCODE_EDIT_TOOLS.includes(name) && session.provider === 'opencode';
 * const isCodexAcpEdit = CODEX_ACP_EDIT_TOOLS.includes(name) && session.provider === 'openai-codex-acp';
 * ```
 *
 * Both shapes grow one branch per provider, and both were already wrong in the
 * same way: `'disabled'` attribution reads as a Codex privilege when it is
 * simply what any provider earns by reporting authoritative structured file
 * changes. Adding a provider to `AI_PROVIDER_TYPES` now breaks these exhaustive
 * records until the provider says, in one place, what it can actually report.
 */

import type { AIProviderType } from './types';

/**
 * How well a provider reports the files it changed.
 *
 * - `'structured'`: the transport emits an authoritative change item carrying
 *   the path plus a diff (or old/new text), with moves and deletes
 *   distinguishable from writes. Filesystem-watcher attribution is redundant
 *   and must be switched off so it cannot contradict the real data.
 * - `'tool-args'`: no change item, but edits arrive as tool calls whose
 *   arguments name the path before the write lands. Good enough for a pre-edit
 *   baseline; the watcher still runs to catch edits made any other way
 *   (shell commands, sub-agents).
 * - `'none'`: nothing usable. The watcher is the only source, and every
 *   attribution is inferred.
 */
export type FileChangeFidelity = 'structured' | 'tool-args' | 'none';

/**
 * Whether filesystem-watcher events may be attributed to a session.
 *
 * `'disabled'` is not a statement about the watcher's quality — it means the
 * provider already reports the truth, so guessing on top of it can only add
 * disagreement.
 */
export type WorkspaceFileAttributionMode = 'fuzzy' | 'disabled' | 'shell-window';

export function attributionModeForFileChangeFidelity(
  fidelity: FileChangeFidelity,
): WorkspaceFileAttributionMode {
  return fidelity === 'structured' ? 'disabled' : 'fuzzy';
}

/**
 * Providers whose shell commands are bracketed by in-process pre/post hooks.
 * They use `'shell-window'`: path tools keep their exact rows, Bash edits are
 * linked only from the hook window (`claudeShellTracking.ts`), and neither the
 * fuzzy watcher matcher nor the command-text scraper writes rows for them.
 * Overlapping windows abstain instead of guessing (decided 2026-11-20).
 */
const SHELL_WINDOW_PROVIDERS: ReadonlySet<string> = new Set(['claude-code']);

/**
 * Attribution mode for a provider, given its fidelity. `shellWindowAvailable`
 * is false when the host has no shell tracker; the provider then keeps the
 * fuzzy watcher rather than losing Bash attribution altogether.
 */
export function attributionModeForProvider(
  providerType: string | null | undefined,
  fidelity: FileChangeFidelity,
  shellWindowAvailable: boolean,
): WorkspaceFileAttributionMode {
  const mode = attributionModeForFileChangeFidelity(fidelity);
  if (mode === 'fuzzy' && shellWindowAvailable && providerType && SHELL_WINDOW_PROVIDERS.has(providerType)) {
    return 'shell-window';
  }
  return mode;
}

/**
 * The best fidelity each provider type can reach.
 *
 * A provider whose fidelity depends on which transport is active declares its
 * *best* case here and narrows at runtime via `getFileChangeFidelity()` —
 * `OpenAICodexProvider` reports `'tool-args'` when it is running the legacy SDK
 * transport, which has no `fileChange` item.
 *
 * Chat providers have no file-editing tools of their own, so they report
 * `'none'` rather than pretending otherwise.
 */
export const BUILTIN_FILE_CHANGE_FIDELITY: Readonly<Record<AIProviderType, FileChangeFidelity>> =
  Object.freeze({
    claude: 'none',
    openai: 'none',
    lmstudio: 'none',

    // The Agent SDK surfaces Edit/Write/MultiEdit tool calls with the path in
    // their arguments, but no post-hoc authoritative change list.
    'claude-code': 'tool-args',

    // Driven by its PTY: the host observes no tool calls at all, so the
    // watcher is all there is.
    'claude-code-cli': 'none',

    // App-server `fileChange` items carry `changes: [{ path, kind, diff }]`,
    // with `move_path` distinguishing a rename from a write.
    'openai-codex': 'structured',

    // ACP drops the change item. `apply_patch` rawInput carries no path at all;
    // `CodexACPRawParser` scrapes `locations[0].path` to keep tracking alive.
    'openai-codex-acp': 'tool-args',

    // `tool_call` with status='running' arrives before the write, carrying
    // filePath in the arguments.
    opencode: 'tool-args',

    // The ACP parser handles neither `locations` nor `diff`.
    'copilot-cli': 'none',

    // Grok's `tool_call_update` carries a real `{type:'diff', path, oldText,
    // newText}` block with an absolute path, emitted before the write lands —
    // richer than most `'tool-args'` providers. It stops short of
    // `'structured'` for one reason: Grok has no delete and no move tool, so
    // every removal is an opaque `rm` inside `run_terminal_command`. Switching
    // the watcher off would make deleted files disappear from the sidebar.
    'grok-build': 'tool-args',

    // `editToolCall.result.success` carries `path`, a unified `diffString`,
    // and `beforeFullFileContent`/`afterFullFileContent` — an authoritative
    // pre-edit baseline, which is more than the snapshot cache can infer. A
    // typed `deleteToolCall` reports removals with the file's `prevContent`.
    'cursor-agent': 'structured',

    // Nimbalyst performs Gemini's writes itself, so `GeminiAntigravityProvider`
    // emits a pre-edit baseline read microseconds before the write — a better
    // baseline than any `'structured'` provider's. It still declares
    // `'tool-args'`, and the distinction matters: Gemini's toolset is
    // `read_file`, `list_files`, `search_files`, `write_file`, `run_command`.
    // There is no delete and no move, so every removal is an opaque `rm` inside
    // `run_command`. `'structured'` would switch the watcher off and make those
    // removals — and anything a build step touches — silently disappear from
    // the sidebar. Identical reasoning to `grok-build` above; the snapshots are
    // additive on top, not a substitute for the watcher.
    'antigravity-gemini-agent': 'tool-args',
  });

/**
 * Tool names that mean "this provider is about to write a file", keyed by
 * provider.
 *
 * These drive the pre-edit snapshot that gives a diff its baseline, so the
 * list must name the tool as the *provider* spells it — vocabularies differ
 * per agent and cross-talk between them would tag the wrong file. A provider
 * with `'none'` fidelity has no such tool to name.
 */
export const PROVIDER_EDIT_TOOL_NAMES: Readonly<Record<AIProviderType, readonly string[]>> =
  Object.freeze({
    claude: Object.freeze([]),
    openai: Object.freeze([]),
    lmstudio: Object.freeze([]),

    // Claude Code's pre-edit baseline comes from the SDK's own hooks, not from
    // this table.
    'claude-code': Object.freeze([]),
    'claude-code-cli': Object.freeze([]),

    // Codex app-server drives attribution from its structured change items.
    'openai-codex': Object.freeze([]),

    'openai-codex-acp': Object.freeze([
      'Edit', 'Write', 'ApplyPatch', 'edit', 'write', 'apply_patch',
    ]),
    opencode: Object.freeze(['edit', 'write', 'create']),
    'copilot-cli': Object.freeze([]),

    // Grok's only file-writing tools. Deletes and moves go through
    // `run_terminal_command` and are the watcher's problem.
    'grok-build': Object.freeze(['search_replace', 'write']),

    // Cursor drives its baseline from `beforeFullFileContent` in the tool
    // result, so it needs no disk-snapshot tag.
    'cursor-agent': Object.freeze([]),

    // Empty on purpose despite `write_file` being a real edit tool. This table
    // drives a disk-read snapshot taken when the tool call is *announced*;
    // Gemini instead emits `pre_edit_snapshot` with `authoritative: true` from
    // inside its write path, which is strictly better and would collide with a
    // tag written from here for the same toolUseId.
    'antigravity-gemini-agent': Object.freeze([]),
  });

/**
 * Whether `toolName` is a file-writing tool for `providerType`.
 *
 * Unknown provider ids (extension-contributed agents) answer `false`: they get
 * no `HooklessAgentFileWatcher` either, so there is no baseline to snapshot.
 */
export function isProviderEditTool(
  providerType: string | null | undefined,
  toolName: string | null | undefined,
): boolean {
  if (!providerType || !toolName) return false;
  const names = (PROVIDER_EDIT_TOOL_NAMES as Record<string, readonly string[]>)[providerType];
  return names?.includes(toolName) ?? false;
}

/**
 * Declared fidelity for a provider id when no live instance is available — the
 * attribution policy is set before the provider is constructed.
 */
export function fileChangeFidelityForProviderType(
  providerType: string | null | undefined,
): FileChangeFidelity {
  if (!providerType) return 'none';
  return (BUILTIN_FILE_CHANGE_FIDELITY as Record<string, FileChangeFidelity>)[providerType]
    ?? 'none';
}
