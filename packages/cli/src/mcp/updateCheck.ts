/**
 * Tells a user that a newer Nimbalyst Wiki or `nim` is published. Neither agent
 * updates third-party plugins on its own (Claude Code leaves auto-update off
 * for our marketplaces; Codex has none), Codex runs no plugin hooks, and npm
 * never updates a global install, so the check lives in the processes people
 * already start: the plugin's local server, `nim mcp`, and `nim` in a terminal.
 * It only notifies: nothing here rewrites an install. `nim update`
 * (commands/update.ts) does that, and only when a person runs it.
 *
 * At most once a day each source fetches the published version and caches
 * what it saw, keyed by the URL it read, so a plugin install and an npm install
 * on one machine keep separate answers. A failed fetch is retried after an
 * hour rather than on every start. The first successful tool result that finds
 * a newer version known carries the notice; a tool call never waits on the fetch.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PluginAgent = 'claude' | 'codex';

export const UPDATE_CHECK_OPT_OUT = 'NIMBALYST_WIKI_NO_UPDATE_CHECK';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
export const PLUGIN_NAME = 'nimbalyst-wiki';
export const CLI_PACKAGE = '@nimbalyst/cli';
export const NPM_LATEST_URL = `https://registry.npmjs.org/${CLI_PACKAGE}/latest`;

/**
 * Where each marketplace publishes the manifest its installs update from. Both
 * marketplaces install from the generated nimbalyst/nimbalyst-wiki repository,
 * so both read its manifests: the monorepo's copy can be bumped before the
 * mirror is staged, which would announce a version no one can install yet.
 */
const MIRROR_MANIFESTS: Record<PluginAgent, string> = {
  claude: 'https://raw.githubusercontent.com/nimbalyst/nimbalyst-wiki/main/.claude-plugin/plugin.json',
  codex: 'https://raw.githubusercontent.com/nimbalyst/nimbalyst-wiki/main/.codex-plugin/plugin.json',
};
export const MANIFEST_URLS: Record<string, Record<PluginAgent, string>> = {
  nimbalyst: MIRROR_MANIFESTS,
  'nimbalyst-wiki': MIRROR_MANIFESTS,
};

export interface PluginInstall {
  kind: 'plugin';
  agent: PluginAgent;
  marketplace: string;
  version: string;
  url: string;
  /** The installed plugin directory, `.../plugins/cache/<marketplace>/nimbalyst-wiki/<version>`. */
  root?: string;
}

export type PackageManager = 'npm' | 'pnpm';

export interface NpmInstall {
  kind: 'npm';
  manager: PackageManager;
  /** False for `nim` installed as a project dependency rather than with `-g`. */
  global: boolean;
  /** The installed `@nimbalyst/cli` directory. */
  packageDir: string;
  version: string;
  url: string;
}

export type UpdateSource = PluginInstall | NpmInstall;

/**
 * The install this server runs from, or null when it is not one we can update:
 * a monorepo checkout, `--plugin-dir`, or a marketplace we don't publish to.
 * Both agents install to `.../plugins/cache/<marketplace>/<plugin>/<version>`.
 * `agent` says which agent installed it; without one, a server started in the
 * plugin directory with no `CLAUDE_PROJECT_DIR` is Codex (see
 * pluginWorkspace.ts) and anything else is Claude Code.
 */
export function detectPluginInstall(env: NodeJS.ProcessEnv, cwd: string, pluginRoot: string, agentFlag?: PluginAgent): PluginInstall | null {
  const parts = path.resolve(pluginRoot).split(path.sep);
  const n = parts.length;
  if (n < 5 || parts[n - 5] !== 'plugins' || parts[n - 4] !== 'cache' || parts[n - 2] !== PLUGIN_NAME) return null;
  const marketplace = parts[n - 3];
  const urls = MANIFEST_URLS[marketplace];
  if (!urls) return null;
  const agent: PluginAgent = agentFlag ?? (!env.CLAUDE_PROJECT_DIR && path.resolve(cwd) === path.resolve(pluginRoot) ? 'codex' : 'claude');
  const manifest = path.join(pluginRoot, agent === 'codex' ? '.codex-plugin' : '.claude-plugin', 'plugin.json');
  let version: unknown;
  try {
    version = JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return null;
  }
  if (typeof version !== 'string' || !parseVersion(version)) return null;
  return { kind: 'plugin', agent, marketplace, version, url: urls[agent], root: path.resolve(pluginRoot) };
}

/** Why a running `nim` has nothing for npm to update, for `nim update` and `nim doctor`. */
export type UnmanagedReason = 'npx' | 'checkout' | 'app' | 'unknown';

/**
 * The npm or pnpm install `entryFile` (the running bundle) belongs to, or why
 * there is none. Global npm puts packages in `<prefix>/lib/node_modules` (or
 * `%APPDATA%\npm\node_modules` on Windows); global pnpm in a `global` directory
 * whose store is `node_modules/.pnpm`. npx runs are skipped because npx fetches
 * the latest version itself, and the copy inside the Nimbalyst app is updated
 * with the app.
 */
export function detectNpmInstall(entryFile: string, version: string): NpmInstall | { kind: 'unmanaged'; reason: UnmanagedReason } {
  const parts = path.resolve(entryFile).split(path.sep);
  let at = -1;
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] === 'node_modules' && parts[i + 1] === '@nimbalyst' && parts[i + 2] === 'cli') {
      at = i;
      break;
    }
  }
  if (at < 0) {
    const tail = parts.slice(-4).join('/');
    if (tail === 'nim/dist/bin/cli-bundled.js') return { kind: 'unmanaged', reason: 'app' };
    if (parts.includes('packages') && parts.includes('cli')) return { kind: 'unmanaged', reason: 'checkout' };
    return { kind: 'unmanaged', reason: 'unknown' };
  }
  if (parts.includes('_npx')) return { kind: 'unmanaged', reason: 'npx' };
  if (!parseVersion(version) || version.startsWith('0.0.0')) return { kind: 'unmanaged', reason: 'checkout' };
  const packageDir = parts.slice(0, at + 3).join(path.sep) || path.sep;
  const pnpmAt = parts.indexOf('.pnpm');
  if (pnpmAt >= 0 || parts.some((p) => p === 'pnpm' || p === '.pnpm-global')) {
    return { kind: 'npm', manager: 'pnpm', global: parts.includes('global') || parts.includes('.pnpm-global'), packageDir, version, url: NPM_LATEST_URL };
  }
  const parent = parts[at - 1] ?? '';
  const global = parent === 'lib' || parent.toLowerCase() === 'npm';
  return { kind: 'npm', manager: 'npm', global, packageDir, version, url: NPM_LATEST_URL };
}

function parseVersion(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? match.slice(1).map(Number) : null;
}

/** True when `latest` is a higher major.minor.patch than `installed`. Prerelease tags are ignored. */
export function isNewerVersion(latest: string, installed: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

const AGENT_NOTE = `Tell the user this once, briefly, and do not repeat it. Set ${UPDATE_CHECK_OPT_OUT}=1 to stop these notices.`;

/** The text an agent reads on its first tool result once a newer version is known. */
export function updateNotice(install: UpdateSource, latest: string): string {
  if (install.kind === 'npm') {
    return `nim ${latest} is available (running: ${install.version}). To update, run \`nim update\` in a terminal, then start a new session so this server restarts. ${AGENT_NOTE}`;
  }
  const steps =
    install.agent === 'codex'
      ? `run \`codex plugin marketplace upgrade ${install.marketplace}\``
      : `run \`claude plugin marketplace update ${install.marketplace}\` and then \`claude plugin update ${PLUGIN_NAME}@${install.marketplace}\``;
  return `Nimbalyst Wiki ${latest} is available (installed: ${install.version}). To update, ${steps}, then start a new session. ${AGENT_NOTE}`;
}

export const defaultUpdateCacheFile = () => path.join(os.homedir(), '.nimbalyst-wiki', 'update-check.json');

export interface CacheEntry {
  checkedAt: number;
  latestVersion: string | null;
  /** False when the last fetch failed; such an entry is retried sooner. */
  ok: boolean;
}

function readCacheFile(file: string): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries: Record<string, CacheEntry> = {};
    for (const [url, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<CacheEntry> | null;
      // Anything else, including the single-entry shape before 0.10, counts as never checked.
      if (entry && typeof entry === 'object' && typeof entry.checkedAt === 'number' && (typeof entry.latestVersion === 'string' || entry.latestVersion === null)) {
        entries[url] = { checkedAt: entry.checkedAt, latestVersion: entry.latestVersion, ok: entry.ok !== false };
      }
    }
    return entries;
  } catch {
    // Missing or unreadable: treat as never checked.
    return {};
  }
}

/** What the cache last saw for `url`, for `nim doctor --versions`. */
export function readCachedLatest(url: string, cacheFile = defaultUpdateCacheFile()): CacheEntry | null {
  return readCacheFile(cacheFile)[url] ?? null;
}

export function writeCacheEntry(file: string, url: string, entry: CacheEntry): void {
  const entries = { ...readCacheFile(file), [url]: entry };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

/** True when `entry` is old enough to fetch again: a day after a success, an hour after a failure. */
export function isCheckDue(entry: CacheEntry | null, now: number): boolean {
  return !entry || now - entry.checkedAt >= (entry.ok ? CHECK_INTERVAL_MS : RETRY_AFTER_FAILURE_MS);
}

/**
 * Fetches the published version at `url` and records it, or records the
 * failure (keeping the last version seen). Returns the version now known.
 */
export async function refreshCachedLatest(
  url: string,
  options: { cacheFile?: string; now?: () => number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ latest: string | null; error?: string }> {
  const cacheFile = options.cacheFile ?? defaultUpdateCacheFile();
  const now = options.now ?? Date.now;
  try {
    const version = await fetchLatestVersion(url, options.fetchImpl, options.signal);
    writeCacheEntry(cacheFile, url, { checkedAt: now(), latestVersion: version, ok: true });
    return { latest: version };
  } catch (err) {
    const previous = readCacheFile(cacheFile)[url]?.latestVersion ?? null;
    if (options.signal?.aborted) return { latest: previous };
    try {
      writeCacheEntry(cacheFile, url, { checkedAt: now(), latestVersion: previous, ok: false });
    } catch {
      // An unwritable home directory only means the next start tries again.
    }
    return { latest: previous, error: err instanceof Error ? err.message : String(err) };
  }
}

/** True when update checks are off: the opt-out variable, or a CI run. */
export function updateChecksDisabled(env: NodeJS.ProcessEnv): boolean {
  const on = (value: string | undefined) => Boolean(value) && value !== '0' && value !== 'false';
  return on(env[UPDATE_CHECK_OPT_OUT]) || on(env.CI);
}

/** The published version at `url`: an npm `latest` document or a plugin manifest, both `{ version }`. */
export async function fetchLatestVersion(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const version = ((await response.json()) as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || !parseVersion(version)) throw new Error('response has no version');
  return version;
}

export interface UpdateCheckOptions {
  install: UpdateSource;
  env?: NodeJS.ProcessEnv;
  cacheFile?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface UpdateCheck {
  /** The agent notice the first time a newer version is known, then null for the rest of the process. */
  takeNotice(): string | null;
  /** Settles when the background fetch (if one started) is done. For tests. */
  settled: Promise<void>;
}

/** The check a long-lived server runs: cached answer now, a fetch in the background when one is due. */
export function startUpdateCheck(options: UpdateCheckOptions): UpdateCheck {
  const env = options.env ?? process.env;
  if (updateChecksDisabled(env)) return { takeNotice: () => null, settled: Promise.resolve() };
  const { install } = options;
  const cacheFile = options.cacheFile ?? defaultUpdateCacheFile();
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const cached = readCacheFile(cacheFile)[install.url] ?? null;
  let latest = cached?.latestVersion ?? null;
  let delivered = false;

  let settled = Promise.resolve();
  if (isCheckDue(cached, now())) {
    settled = refreshCachedLatest(install.url, { cacheFile, now, fetchImpl: options.fetchImpl }).then((result) => {
      latest = result.latest;
      if (result.error) log(`nimbalyst-local: update check against ${install.url} failed: ${result.error}`);
    });
  }

  return {
    takeNotice() {
      if (delivered || !latest || !isNewerVersion(latest, install.version)) return null;
      delivered = true;
      return updateNotice(install, latest);
    },
    settled,
  };
}
