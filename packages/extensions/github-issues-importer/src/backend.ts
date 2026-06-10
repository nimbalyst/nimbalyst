/**
 * GitHub Issues importer — backend module.
 *
 * Runs in an Electron utility-process (outside main and the renderer). It does
 * the privileged work — spawning the user's GitHub CLI (`gh`) — and exposes the
 * `importer.*` RPC methods the host's TrackerImporterRegistry calls. The host
 * owns turning the returned snapshot into a tracker item.
 *
 * Auth is delegated entirely to `gh` (no token is ever read or stored here).
 * The import target (binding) is derived from the workspace's GitHub git
 * remotes, so the importer is zero-config for any repo opened in Nimbalyst.
 *
 * Method keys below MUST match TRACKER_IMPORTER_RPC_METHODS in the extension
 * SDK (`importer.isAuthenticated`, `importer.listBindings`, `importer.list`,
 * `importer.fetch`).
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ImporterBinding,
  ImporterListEntry,
  ImporterListFilter,
  ImporterListPage,
  TrackerSnapshot,
} from '../../../extension-sdk/src/types/trackerImporter';

const PROVIDER_ID = 'github-issues';
const URN_SCHEME = 'github';
const SPAWN_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** Minimal shape of the activate context the host bootstrap passes. */
interface ActivateCtx {
  services: {
    workspacePath: string;
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  };
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Common-install-location PATH for spawning CLIs. Electron's child-process PATH
 * on macOS/Linux GUI launches frequently omits /usr/local/bin and
 * /opt/homebrew/bin. Mirrors the host's GhApiService.
 */
function enhancedPath(): string {
  const current = process.env.PATH || '';
  const extra: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    extra.push(path.join(appData, 'npm'));
    extra.push(path.join(os.homedir(), '.local', 'bin'));
    extra.push('C:\\Program Files\\GitHub CLI');
  } else {
    extra.push(path.join(os.homedir(), '.local', 'bin'));
    extra.push('/usr/local/bin');
    extra.push('/opt/homebrew/bin');
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  return [...extra, current].join(sep);
}

function ghCommand(): string {
  return process.env.NIMBALYST_GH_PATH || 'gh';
}

function runProcess(cmd: string, args: string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      timeout: SPAWN_TIMEOUT_MS,
      shell: false,
      cwd,
      env: { ...process.env, PATH: enhancedPath(), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: err.message }));
  });
}

async function gh(args: string[], cwd?: string): Promise<SpawnResult> {
  return runProcess(ghCommand(), args, cwd);
}

async function ghApiJson<T>(endpoint: string): Promise<T> {
  const res = await gh([
    'api',
    endpoint,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
  ]);
  if (res.code !== 0) {
    throw new Error(`gh api ${endpoint} failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return JSON.parse(res.stdout.trim() || 'null') as T;
}

/** Parse `owner/repo` out of any common GitHub remote URL form. */
export function parseGithubRemote(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/(.+?)(?:\.git)?$/i.exec(url.trim());
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/** Derive importable GitHub repos from the workspace's git remotes. */
async function deriveBindings(workspacePath: string): Promise<ImporterBinding[]> {
  const res = await runProcess('git', ['-C', workspacePath, 'remote', '-v'], workspacePath);
  if (res.code !== 0) return [];
  const seen = new Set<string>();
  const bindings: ImporterBinding[] = [];
  for (const line of res.stdout.split('\n')) {
    // "origin\tgit@github.com:owner/repo.git (fetch)"
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const repo = parseGithubRemote(parts[1]);
    if (repo && !seen.has(repo)) {
      seen.add(repo);
      bindings.push({ id: repo, label: repo });
    }
  }
  return bindings;
}

export function buildUrn(repo: string, number: number): string {
  return `${URN_SCHEME}://${repo}#${number}`;
}

export function buildExternalId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function parseExternalId(externalId: string): { repo: string; number: number } {
  const hash = externalId.lastIndexOf('#');
  if (hash < 0) throw new Error(`Invalid GitHub externalId: ${externalId}`);
  const repo = externalId.slice(0, hash);
  const number = Number(externalId.slice(hash + 1));
  if (!repo.includes('/') || !Number.isFinite(number)) {
    throw new Error(`Invalid GitHub externalId: ${externalId}`);
  }
  return { repo, number };
}

interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  html_url: string;
  updated_at: string;
  created_at: string;
  pull_request?: unknown;
  user?: { login?: string } | null;
  labels?: Array<{ name?: string } | string>;
}

function issueLabels(issue: GhIssue): string[] {
  return (issue.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((n): n is string => Boolean(n));
}

export function activate(ctx: ActivateCtx) {
  const { workspacePath, log } = ctx.services;

  return {
    methods: {
      'importer.isAuthenticated': async (): Promise<boolean> => {
        const res = await gh(['auth', 'status']);
        return res.code === 0;
      },

      'importer.listBindings': async (): Promise<ImporterBinding[]> => {
        const bindings = await deriveBindings(workspacePath);
        log('debug', `github-issues: ${bindings.length} binding(s) from git remotes`);
        return bindings;
      },

      'importer.list': async (params: {
        binding: ImporterBinding;
        filters: ImporterListFilter;
      }): Promise<ImporterListPage> => {
        const repo = params.binding.id;
        const filters = params.filters ?? {};
        const state = filters.state ?? 'open';
        const perPage = Math.min(filters.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const page = filters.cursor ? Number(filters.cursor) || 1 : 1;
        const issues = await ghApiJson<GhIssue[]>(
          `repos/${repo}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`
        );
        let entries: ImporterListEntry[] = (issues ?? [])
          // The issues endpoint returns PRs too; exclude them.
          .filter((i) => !i.pull_request)
          .map((i) => ({
            externalId: buildExternalId(repo, i.number),
            urn: buildUrn(repo, i.number),
            url: i.html_url,
            title: i.title,
            state: i.state,
            updatedAt: i.updated_at,
          }));
        if (filters.search) {
          const needle = filters.search.toLowerCase();
          entries = entries.filter(
            (e) => e.title.toLowerCase().includes(needle) || e.externalId.includes(needle)
          );
        }
        // Advertise another page only when the API returned a full page.
        const nextCursor =
          (issues?.length ?? 0) >= perPage ? String(page + 1) : undefined;
        return { items: entries, nextCursor };
      },

      'importer.fetch': async (params: { externalId: string }): Promise<TrackerSnapshot> => {
        const { repo, number } = parseExternalId(params.externalId);
        const issue = await ghApiJson<GhIssue>(`repos/${repo}/issues/${number}`);
        if (!issue) {
          throw new Error(`GitHub issue ${params.externalId} not found`);
        }
        const urn = buildUrn(repo, number);
        return {
          external: {
            providerId: PROVIDER_ID,
            externalId: buildExternalId(repo, number),
            urn,
            url: issue.html_url,
            titleSnapshot: issue.title,
            stateSnapshot: issue.state,
          },
          primaryType: 'bug',
          title: issue.title,
          body: issue.body ?? '',
          status: issue.state,
          labels: issueLabels(issue),
          authorIdentity: issue.user?.login
            ? { email: null, displayName: issue.user.login, gitName: issue.user.login }
            : null,
          upstreamCreatedAt: issue.created_at,
          upstreamUpdatedAt: issue.updated_at,
        };
      },
    },
  };
}
