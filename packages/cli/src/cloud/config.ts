/**
 * Where the sync server lives and where `nim login` keeps its tokens.
 *
 * This is the Nimbalyst Teams path to the collab server, separate from the
 * desktop-loopback gateway the tracker commands use. Nothing here reads the
 * Nimbalyst app's userData.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { usageError } from '../cli/exitCodes.js';

export const DEFAULT_SERVER = 'https://sync.nimbalyst.com';

/**
 * The earlier GitHub sign-in for `nim login` (GitHub device flow). Off unless
 * `NIM_GITHUB_NATIVE=on`; the server keeps the same paths behind its own switch.
 */
export function githubNativeEnabled(): boolean {
  return process.env.NIM_GITHUB_NATIVE === 'on';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Same rule as a server URL: https, or http only on this machine. */
function checkedOrigin(envName: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`${envName} is not a URL: "${raw}"`);
  }
  if (url.protocol === 'https:') return raw;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return raw;
  throw usageError(`${envName} must be an https:// URL (http:// is allowed only for localhost), got "${raw}"`);
}

/** Our OAuth client id at the collab server's authorization server. */
export const NIM_CLI_CLIENT_ID = 'nim-cli';

/**
 * GitHub OAuth App client id used for the device flow. Empty until the app is
 * registered; `NIM_GITHUB_CLIENT_ID` overrides it. A client id is public, so
 * shipping it in the bundle is fine.
 */
export const GITHUB_CLIENT_ID = '';

/** Bearer tokens only ever travel over https, except to a local dev server. */
export function resolveServer(): string {
  return checkedOrigin('NIM_SERVER', (process.env.NIM_SERVER || DEFAULT_SERVER).replace(/\/+$/, ''));
}

export function resolveGithubClientId(): string {
  const id = process.env.NIM_GITHUB_CLIENT_ID ?? GITHUB_CLIENT_ID;
  if (!id) {
    throw usageError(
      'GitHub sign-in is not configured in this build of nim. Set NIM_GITHUB_CLIENT_ID to the GitHub OAuth app client id.',
    );
  }
  return id;
}

/** Config dir for nim's own state. `NIM_CONFIG_DIR` overrides it. */
export function resolveConfigDir(): string {
  if (process.env.NIM_CONFIG_DIR) return process.env.NIM_CONFIG_DIR;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'nimbalyst-cli');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'nimbalyst-cli');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'nimbalyst-cli');
}
