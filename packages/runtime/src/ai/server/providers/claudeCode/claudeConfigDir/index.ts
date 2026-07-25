/**
 * Resolve where the Claude Code CLI keeps its user-level config (GitHub #975).
 *
 * `CLAUDE_CONFIG_DIR` relocates the CLI's entire user-level config root —
 * credentials, settings.json, projects/ transcripts, plugins/, commands/,
 * skills/, history.jsonl, the user CLAUDE.md, all of it. Anything Nimbalyst
 * reads out of that root has to go through here, or it silently reads a
 * different (usually abandoned) directory than the CLI writes.
 *
 * This is a config *location* pointer for the user's own `claude login` — NOT a
 * credential value. Nothing here reads a token, key, or secret out of the
 * environment; it only computes a directory path. The repo rule "Never Use
 * Environment Variables as Implicit API Key Sources" is about key *values*
 * (`ANTHROPIC_API_KEY` and friends) and still holds: do not add an env fallback
 * here that yields a credential rather than a location.
 *
 * Mirrored from the bundled CLI (`@anthropic-ai/claude-agent-sdk/sdk.mjs`):
 *
 *   config dir  = (CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC')
 *   credentials = join(configDir, '.credentials.json')     // win32 / linux
 *
 * On macOS the credentials live in the Keychain instead, under a service name
 * that is *also* derived from this dir — see the sibling `claudeKeychain`
 * module. That module is deliberately separate because it needs `node:crypto`,
 * which Vite replaces with `crypto-browserify` (and which then throws
 * "global is not defined") if it ever reaches the renderer graph. Keep this
 * module dependency-free enough to import from anywhere.
 *
 * Scope note: only the *user-level* root moves. Project-level `.claude/`
 * directories stay next to the workspace and must not be routed through here.
 *
 * One deliberate divergence: the CLI uses `??`, so `CLAUDE_CONFIG_DIR=""` would
 * make it resolve the empty string as a path. We treat blank as unset.
 */

import * as os from 'os';
import * as path from 'path';

/** Just the env shape these resolvers read; `process.env` satisfies it. */
export type ClaudeConfigEnv = Record<string, string | undefined>;

const DEFAULT_CONFIG_DIR_NAME = '.claude';
const CREDENTIALS_FILE_NAME = '.credentials.json';

/** Trimmed env value, or undefined when unset or blank. */
export function readClaudeDirVar(env: ClaudeConfigEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The Claude Code CLI's user-level config directory, NFC-normalized the way the
 * CLI normalizes it (the macOS Keychain scope hashes this string, so the
 * normalization has to match byte-for-byte).
 */
export function resolveClaudeConfigDir(env: ClaudeConfigEnv = process.env): string {
  const configured = readClaudeDirVar(env, 'CLAUDE_CONFIG_DIR');
  const dir = configured ?? path.join(os.homedir(), DEFAULT_CONFIG_DIR_NAME);
  return dir.normalize('NFC');
}

/**
 * The credentials file the CLI writes on Windows and Linux (and on macOS when
 * secure storage is unavailable, e.g. headless/SSH logins).
 */
export function resolveClaudeCredentialsPath(env: ClaudeConfigEnv = process.env): string {
  return path.join(resolveClaudeConfigDir(env), CREDENTIALS_FILE_NAME);
}
