/**
 * macOS Keychain naming for the Claude Code CLI's OAuth credentials (#975).
 *
 * Split out from `claudeConfigDir` because this needs `node:crypto`: Vite
 * substitutes `crypto-browserify` for it in the renderer graph, which throws
 * "global is not defined" on load. Only main-process code should import this.
 *
 * From the bundled CLI (`@anthropic-ai/claude-agent-sdk/sdk.mjs`):
 *
 *   service = `Claude Code${OAUTH_FILE_SUFFIX}-credentials${scope}`
 *   scope   = '' when neither CLAUDE_CONFIG_DIR nor
 *             CLAUDE_SECURESTORAGE_CONFIG_DIR is set, else
 *             `-${sha256(dir).slice(0, 8)}`
 *   read as `security find-generic-password -a <user> -w -s <service>`
 *
 * The scope is the part that is easy to miss: on macOS a relocated config dir
 * does not move a file, it renames the Keychain entry. Reading the unscoped
 * service name then silently returns whatever stale credential a pre-move login
 * left behind — the same "401 forever" failure #975 reported on Windows,
 * reached by a different mechanism.
 *
 * OAUTH_FILE_SUFFIX is '' for the production endpoint (it is only non-empty for
 * staging / custom-OAuth builds, which Nimbalyst does not target), so it is
 * omitted here.
 */

import { createHash } from 'crypto';
import {
  readClaudeDirVar,
  resolveClaudeConfigDir,
  resolveClaudeCredentialsPath,
  type ClaudeConfigEnv,
} from '../claudeConfigDir';

const KEYCHAIN_SERVICE_BASE = 'Claude Code';
const KEYCHAIN_CREDENTIALS_SERVICE = `${KEYCHAIN_SERVICE_BASE}-credentials`;

function hashScope(dir: string): string {
  return `-${createHash('sha256').update(dir).digest('hex').substring(0, 8)}`;
}

function keychainScopeSuffix(env: ClaudeConfigEnv): string {
  const secureRaw = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;

  if (secureRaw !== undefined) {
    // Set-but-blank is the CLI's explicit "use the unscoped entry" signal, and
    // it outranks CLAUDE_CONFIG_DIR.
    const secure = secureRaw.trim();
    return secure === '' ? '' : hashScope(secure.normalize('NFC'));
  }

  if (readClaudeDirVar(env, 'CLAUDE_CONFIG_DIR') === undefined) return '';
  return hashScope(resolveClaudeConfigDir(env));
}

/**
 * macOS Keychain service names to try, most specific first.
 *
 * With no config-dir override this is the historical cascade: the current
 * `Claude Code-credentials` entry, then the pre-rename `Claude Code` entry.
 *
 * With an override there is deliberately NO fallback to the unscoped entries.
 * Those belong to a different config root, so a stale one would make the usage
 * meter report a *different account's* numbers — silently wrong data is worse
 * than a visible "not logged in".
 */
export function resolveClaudeKeychainServiceNames(env: ClaudeConfigEnv = process.env): string[] {
  const scope = keychainScopeSuffix(env);
  if (scope) return [`${KEYCHAIN_CREDENTIALS_SERVICE}${scope}`];
  return [KEYCHAIN_CREDENTIALS_SERVICE, KEYCHAIN_SERVICE_BASE];
}

/**
 * Human-readable description of where credentials were looked for, for log
 * lines and the usage meter's error tooltip. Naming the resolved location is
 * the whole point — "please re-login" is useless advice when the real problem
 * is that we read the wrong directory.
 */
export function describeClaudeCredentialSource(
  env: ClaudeConfigEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const credentialsPath = resolveClaudeCredentialsPath(env);
  if (platform !== 'darwin') return credentialsPath;
  const services = resolveClaudeKeychainServiceNames(env).join(' or ');
  return `macOS Keychain (${services}), or ${credentialsPath}`;
}
