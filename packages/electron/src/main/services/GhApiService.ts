/**
 * GhApiService - Single source of truth for every GitHub call from Nimbalyst.
 *
 * All requests are routed through `gh api ...` subprocesses, which means
 * Nimbalyst never sees or stores a GitHub credential — `gh` handles auth,
 * rate-limit headers, host routing (GitHub Enterprise), and ETag caching
 * via its `--cache <seconds>` flag.
 *
 * Methods accept a `workspaceId` so cached rows persist scoped to a project,
 * and a `Remote` (owner/repo string) which is opaque to this service.
 */

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log/main';
import type {
  PullRequestRow,
  PullRequestFileRow,
  PullRequestCommitRow,
  PullRequestCheckRow,
  PullRequestsStore,
  Reviewer,
} from './PullRequestsStore';

const logger = log.scope('GhApiService');

const SPAWN_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_LIST_SECONDS = 60;
const DEFAULT_CACHE_DETAIL_SECONDS = 30;
/** Page size for paginated REST fetches (`per_page=N`) and GraphQL `first:N`. */
const API_PAGE_SIZE = 100;

/**
 * GraphQL query for a PR's inline review threads. Extracted and exported so the
 * `first:` page-size interpolation is covered by a unit test — it must produce
 * a template literal (`first:100`), not the literal text `${API_PAGE_SIZE}`.
 */
export function buildReviewThreadsQuery(pageSize: number = API_PAGE_SIZE): string {
  return (
    `query($owner:String!,$name:String!,$number:Int!){` +
    `repository(owner:$owner,name:$name){pullRequest(number:$number){` +
    `reviewThreads(first:${pageSize}){nodes{id isResolved isOutdated path line ` +
    `comments(first:${pageSize}){nodes{id author{login} body createdAt url}}} ` +
    `pageInfo{hasNextPage}}}}}`
  );
}

/**
 * The `gh` executable to spawn. Honors `NIMBALYST_GH_PATH` so E2E tests can
 * point at a stub and users can pin a non-standard install location; falls
 * back to resolving `gh` on PATH.
 */
function ghCommand(): string {
  return process.env.NIMBALYST_GH_PATH || 'gh';
}

export type Remote = string; // "owner/repo"

export interface ListFilters {
  state?: 'open' | 'closed' | 'all';
  awaitingMyReview?: boolean;
  createdByMe?: boolean;
  withConflicts?: boolean;
  search?: string;
}

export interface TimelineEntry {
  id: string;
  type: 'issue_comment' | 'review' | 'review_comment';
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  body: string;
  state?: string;
  createdAt: number;
  url: string | null;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface RepoPermissions {
  admin: boolean;
  maintain: boolean;
  push: boolean;
  triage: boolean;
  pull: boolean;
}

/**
 * Everything the renderer needs to decide which PR action buttons to show,
 * all derived from `gh` (the authenticated user's repo permissions + the
 * repo's allowed merge methods). No button is shown that the user's access
 * doesn't permit.
 */
export interface RepoCapabilities {
  viewerLogin: string | null;
  permissions: RepoPermissions;
  allowSquashMerge: boolean;
  allowMergeCommit: boolean;
  allowRebaseMerge: boolean;
  deleteBranchOnMerge: boolean;
}

export interface MergeResult {
  sha: string | null;
  merged: boolean;
  message?: string;
}

export interface ReviewThreadComment {
  id: string;
  authorLogin: string | null;
  body: string;
  createdAt: number;
  url: string | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface ReviewThreadsResult {
  threads: ReviewThread[];
  /** True when the PR has more than the fetched page of threads. */
  truncated: boolean;
}

export class GhApiError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GhApiError';
  }
}

/** Find the endpoint in a `gh api` argv list, including mutations with leading flags. */
export function getGhApiEndpoint(args: string[]): string {
  const valueOptions = new Set([
    '-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--cache',
  ]);
  for (let index = args[0] === 'api' ? 1 : 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return '';
}

export const GH_WORKFLOW_SCOPE_REFRESH_COMMAND = 'gh auth refresh -h github.com -s workflow';

/** Return actionable guidance for GitHub's workflow-file OAuth restriction. */
export function getWorkflowScopeRecoveryMessage(stderr: string): string | null {
  const missingScope =
    /refusing to allow an OAuth App to create or update workflow .* without [`'"]?workflow[`'"]? scope/i;
  if (!missingScope.test(stderr)) return null;
  return (
    'GitHub blocked this merge because the PR changes a workflow file and the active GitHub CLI token lacks the `workflow` scope. ' +
    `Run: ${GH_WORKFLOW_SCOPE_REFRESH_COMMAND}`
  );
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Common-install-location PATH for spawning `gh`. Mirrors GhCliDetector —
 * Electron's child-process PATH on macOS/Linux GUI launches frequently
 * omits `/usr/local/bin` and `/opt/homebrew/bin`.
 */
function getEnhancedPath(): string {
  const currentPath = process.env.PATH || '';
  const additionalPaths: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    additionalPaths.push(path.join(appData, 'npm'));
    additionalPaths.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm'));
    additionalPaths.push(path.join(os.homedir(), '.local', 'bin'));
    additionalPaths.push('C:\\Program Files\\GitHub CLI');
  } else {
    additionalPaths.push(path.join(os.homedir(), '.local', 'bin'));
    additionalPaths.push(path.join(os.homedir(), '.npm-global', 'bin'));
    additionalPaths.push('/usr/local/bin');
    additionalPaths.push('/opt/homebrew/bin');
  }
  const separator = process.platform === 'win32' ? ';' : ':';
  return [...additionalPaths, currentPath].join(separator);
}

async function spawnGhApi(args: string[], token?: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: getEnhancedPath(),
      NO_COLOR: '1',
      // By default gh resolves auth itself (active account). When a project
      // pins a specific account, we pass that account's token (fetched from
      // gh's own keyring) for this one spawn only — never persisted by us.
    };
    if (token) {
      env.GH_TOKEN = token;
    }

    const child = spawn(ghCommand(), args, {
      timeout: SPAWN_TIMEOUT_MS,
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on('error', (error) => {
      logger.warn('gh spawn error', { message: error.message });
      resolve({ stdout, stderr: error.message, exitCode: null });
    });
  });
}

function buildApiArgs(
  endpoint: string,
  options: { cacheSeconds?: number; paginate?: boolean } = {},
): string[] {
  const args = [
    'api',
    endpoint,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
  ];
  if (options.paginate) {
    args.push('--paginate');
  }
  if (options.cacheSeconds && options.cacheSeconds > 0) {
    args.push('--cache', `${options.cacheSeconds}s`);
  }
  return args;
}

/**
 * `gh api --paginate` returns multiple JSON arrays concatenated on stdout
 * (one per page). Parse defensively: try single parse first, then fall back
 * to per-line / per-array splitting.
 */
function parsePagedJson<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Single JSON value (most common).
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T];
  } catch {
    // Fall through to concatenated-arrays parse.
  }

  // Concatenated JSON values from `--paginate`. Walk the string tracking
  // bracket/brace depth (skipping string contents) and parse each top-level
  // value, flattening arrays. Robust against spaces/newlines inside the JSON.
  const out: T[] = [];
  let depth = 0;
  let sliceStart = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        const slice = trimmed.slice(sliceStart, i + 1).trim();
        try {
          const parsed = JSON.parse(slice) as T[] | T;
          if (Array.isArray(parsed)) out.push(...parsed);
          else out.push(parsed);
        } catch (error) {
          logger.warn('Failed to parse gh api chunk', { error });
        }
        sliceStart = i + 1;
      }
    }
  }
  return out;
}

interface GhPullPayload {
  id?: number;
  number: number;
  state: 'open' | 'closed';
  title: string;
  body?: string | null;
  draft?: boolean;
  user?: { login?: string; avatar_url?: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
  comments?: number;
  review_comments?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  merged?: boolean;
  // The pulls *list* endpoint omits `merged` but sets `merged_at` on merged
  // PRs; the single-PR endpoint sets `merged`. Treat either as merged.
  merged_at?: string | null;
  requested_reviewers?: Array<{ login: string }>;
  labels?: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url?: string;
}

interface GhFilePayload {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  previous_filename?: string;
}

interface GhCommitPayload {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
  };
  author?: { login?: string } | null;
  // Present only on the single-commit endpoint, not the PR commits list.
  stats?: { additions?: number; deletions?: number };
}

interface GhCheckRunsPayload {
  check_runs?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    details_url?: string;
    started_at?: string | null;
    completed_at?: string | null;
  }>;
}

interface GhCommitStatusPayload {
  state?: 'success' | 'failure' | 'pending' | 'error';
  statuses?: Array<{
    context: string;
    state: 'success' | 'failure' | 'pending' | 'error';
    target_url?: string;
    updated_at?: string;
  }>;
}

interface GhCommentPayload {
  id: number;
  body?: string;
  user?: { login?: string; avatar_url?: string } | null;
  created_at: string;
  html_url?: string;
}

interface GhReviewPayload {
  id: number;
  state?: string;
  body?: string;
  user?: { login?: string; avatar_url?: string } | null;
  submitted_at?: string;
  html_url?: string;
}

interface GhContentsPayload {
  content?: string;
  encoding?: string;
  type?: string;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof GhApiError && /Not Found|HTTP 404/i.test(error.stderr);
}

function mapPullToRow(workspaceId: string, remote: Remote, payload: GhPullPayload): PullRequestRow {
  const isMerged = payload.merged === true || Boolean(payload.merged_at);
  const state: PullRequestRow['state'] = isMerged
    ? 'merged'
    : payload.state === 'closed'
      ? 'closed'
      : 'open';
  const mergeable: PullRequestRow['mergeable'] =
    payload.mergeable_state === 'dirty'
      ? 'conflicting'
      : payload.mergeable === true
        ? 'mergeable'
        : payload.mergeable === false
          ? 'conflicting'
          : 'unknown';
  const reviewers: Reviewer[] = (payload.requested_reviewers ?? []).map((r) => ({
    login: r.login,
    state: 'requested',
  }));
  const labels = (payload.labels ?? []).map((l) => l.name);
  const now = Date.now();
  return {
    id: `pr_${remote.replace('/', '_')}_${payload.number}`,
    workspaceId,
    remote,
    number: payload.number,
    title: payload.title,
    body: payload.body ?? null,
    state,
    isDraft: Boolean(payload.draft),
    authorLogin: payload.user?.login ?? null,
    authorAvatarUrl: payload.user?.avatar_url ?? null,
    headRef: payload.head.ref,
    headSha: payload.head.sha,
    baseRef: payload.base.ref,
    mergeable,
    commentsCount: payload.comments ?? 0,
    reviewCommentsCount: payload.review_comments ?? 0,
    additions: payload.additions ?? 0,
    deletions: payload.deletions ?? 0,
    changedFiles: payload.changed_files ?? 0,
    ciStatus: null, // populated by getPullRequestChecks
    reviewers,
    labels,
    raw: payload,
    etag: null,
    createdAt: new Date(payload.created_at).getTime(),
    updatedAt: new Date(payload.updated_at).getTime(),
    fetchedAt: now,
  };
}

function mapFileToRow(prId: string, payload: GhFilePayload): PullRequestFileRow {
  const status = (() => {
    switch (payload.status) {
      case 'added':
      case 'removed':
      case 'modified':
      case 'renamed':
        return payload.status as PullRequestFileRow['status'];
      default:
        return 'modified';
    }
  })();
  return {
    prId,
    path: payload.filename,
    status,
    additions: payload.additions ?? 0,
    deletions: payload.deletions ?? 0,
    patch: payload.patch ?? null,
    previousPath: payload.previous_filename ?? null,
    fetchedAt: Date.now(),
  };
}

function mapCommitToRow(prId: string, payload: GhCommitPayload): PullRequestCommitRow {
  return {
    prId,
    sha: payload.sha,
    message: payload.commit.message,
    authorLogin: payload.author?.login ?? payload.commit.author?.name ?? null,
    authoredAt: payload.commit.author?.date
      ? new Date(payload.commit.author.date).getTime()
      : Date.now(),
    additions: payload.stats?.additions ?? 0,
    deletions: payload.stats?.deletions ?? 0,
  };
}

function makePrId(remote: Remote, number: number): string {
  return `pr_${remote.replace('/', '_')}_${number}`;
}

// Cap per-commit stat fetches so a giant PR doesn't spawn hundreds of `gh`
// processes. Commits beyond the cap show 0/0.
const COMMIT_STATS_CAP = 100;
const COMMIT_STATS_CONCURRENCY = 5;

/** Run async `task` over `items` with bounded concurrency, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await task(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Per-login token cache. Tokens come from gh's keyring via `gh auth token
// --user <login>`; we hold them in memory only, briefly, to avoid spawning a
// resolver process on every api call. Never persisted to disk.
const TOKEN_CACHE_TTL_MS = 5 * 60_000;
const tokenCache = new Map<string, { token: string; at: number }>();

/**
 * Resolve a specific gh account's token from gh's own keyring. Returns null if
 * gh can't produce one (account not logged in, gh missing). The token never
 * leaves the process — it's passed to a child gh spawn's env only.
 */
async function resolveGhToken(login: string): Promise<string | null> {
  const cached = tokenCache.get(login);
  if (cached && Date.now() - cached.at < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }
  return new Promise((resolve) => {
    try {
      const env = { ...process.env, PATH: getEnhancedPath(), NO_COLOR: '1' };
      const child = spawn(ghCommand(), ['auth', 'token', '--user', login], {
        timeout: SPAWN_TIMEOUT_MS,
        shell: false,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.on('close', (code) => {
        const token = out.trim();
        if (code === 0 && token) {
          tokenCache.set(login, { token, at: Date.now() });
          resolve(token);
        } else {
          resolve(null);
        }
      });
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** Resolves the gh account login Nimbalyst should use for a workspace's calls. */
export type GhAccountResolver = (workspaceId: string) => string | undefined;

export class GhApiService {
  constructor(
    private readonly store: PullRequestsStore,
    private readonly accountResolver?: GhAccountResolver,
  ) {}

  /** Resolve the per-workspace account's token (cached), or undefined to let gh pick the active account. */
  private async tokenFor(workspaceId?: string): Promise<string | undefined> {
    if (!workspaceId || !this.accountResolver) return undefined;
    const login = this.accountResolver(workspaceId);
    if (!login) return undefined;
    return (await resolveGhToken(login)) ?? undefined;
  }

  /**
   * One choke point. 30s spawn timeout. shell: false. When `workspaceId` maps
   * to a pinned account, that account's token is injected for this spawn only.
   * Non-zero exit -> typed GhApiError carrying stderr.
   */
  private async ghApi(args: string[], workspaceId?: string): Promise<string> {
    const t0 = Date.now();
    const token = await this.tokenFor(workspaceId);
    const result = await spawnGhApi(args, token);
    const dur = Date.now() - t0;
    if (result.exitCode !== 0) {
      logger.warn('gh api failed', { args, exitCode: result.exitCode, stderr: result.stderr });
      const endpoint = getGhApiEndpoint(args);
      throw new GhApiError(
        `gh api ${endpoint} failed`,
        result.stderr,
        result.exitCode,
      );
    }
    if (dur > 2000) {
      logger.info('gh api slow', { args: args.slice(0, 2), durationMs: dur });
    }
    return result.stdout;
  }

  async listPullRequests(
    workspaceId: string,
    remote: Remote,
    filters: ListFilters = {},
  ): Promise<PullRequestRow[]> {
    const state = filters.state ?? 'open';

    // awaitingMyReview uses the search endpoint; otherwise list endpoint.
    let payloads: GhPullPayload[];
    if (filters.awaitingMyReview) {
      const query = `is:pr+is:open+review-requested:@me+repo:${remote}`;
      const stdout = await this.ghApi(
        buildApiArgs(`search/issues?q=${query}&per_page=${API_PAGE_SIZE}`, {
          cacheSeconds: DEFAULT_CACHE_LIST_SECONDS,
          paginate: true,
        }),
      workspaceId,);
      const search = JSON.parse(stdout.trim()) as { items?: Array<{ number: number }> };
      const numbers = (search.items ?? []).map((i) => i.number);
      payloads = [];
      for (const num of numbers) {
        const detail = await this.ghApi(
          buildApiArgs(`repos/${remote}/pulls/${num}`, {
            cacheSeconds: DEFAULT_CACHE_LIST_SECONDS,
          }),
        workspaceId,);
        payloads.push(JSON.parse(detail.trim()) as GhPullPayload);
      }
    } else {
      const params = new URLSearchParams({
        state,
        per_page: '50',
        sort: 'updated',
        direction: 'desc',
      });
      const stdout = await this.ghApi(
        buildApiArgs(`repos/${remote}/pulls?${params.toString()}`, {
          cacheSeconds: DEFAULT_CACHE_LIST_SECONDS,
          paginate: true,
        }),
      workspaceId,);
      payloads = parsePagedJson<GhPullPayload>(stdout);
    }

    let rows = payloads.map((p) => mapPullToRow(workspaceId, remote, p));
    if (filters.createdByMe && filters.search === undefined) {
      // createdByMe is a client-side filter against the authed user; the
      // caller passes the user separately via the IPC layer where we have
      // access to `GhCliStatus.user`. Skip here.
    }
    if (filters.withConflicts) {
      rows = rows.filter((r) => r.mergeable === 'conflicting');
    }
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      rows = rows.filter((r) => {
        if (r.title.toLowerCase().includes(needle)) return true;
        if (String(r.number).includes(needle)) return true;
        return false;
      });
    }

    await this.store.upsertList(rows);
    return rows;
  }

  async getPullRequest(
    workspaceId: string,
    remote: Remote,
    number: number,
    options: { noCache?: boolean } = {},
  ): Promise<PullRequestRow> {
    const stdout = await this.ghApi(
      buildApiArgs(`repos/${remote}/pulls/${number}`, {
        // After a mutation (merge/approve) we must bypass gh's response cache
        // or we'd re-read the pre-merge state.
        cacheSeconds: options.noCache ? 0 : DEFAULT_CACHE_DETAIL_SECONDS,
      }),
    workspaceId,);
    const payload = JSON.parse(stdout.trim()) as GhPullPayload;
    const row = mapPullToRow(workspaceId, remote, payload);
    await this.store.upsertOne(row);
    return row;
  }

  async getPullRequestFiles(
    workspaceId: string,
    remote: Remote,
    number: number,
  ): Promise<PullRequestFileRow[]> {
    const stdout = await this.ghApi(
      buildApiArgs(`repos/${remote}/pulls/${number}/files?per_page=${API_PAGE_SIZE}`, {
        cacheSeconds: DEFAULT_CACHE_DETAIL_SECONDS,
        paginate: true,
      }),
    workspaceId,);
    const payloads = parsePagedJson<GhFilePayload>(stdout);
    const prId = makePrId(remote, number);
    const files = payloads.map((p) => mapFileToRow(prId, p));
    await this.store.replaceFiles(prId, files);
    return files;
  }

  async getPullRequestCommits(
    workspaceId: string,
    remote: Remote,
    number: number,
  ): Promise<PullRequestCommitRow[]> {
    const stdout = await this.ghApi(
      buildApiArgs(`repos/${remote}/pulls/${number}/commits?per_page=${API_PAGE_SIZE}`, {
        cacheSeconds: DEFAULT_CACHE_DETAIL_SECONDS,
        paginate: true,
      }),
    workspaceId,);
    const payloads = parsePagedJson<GhCommitPayload>(stdout);
    const prId = makePrId(remote, number);
    const commits = payloads.map((p) => mapCommitToRow(prId, p));

    // The PR commits list omits stats; backfill additions/deletions from the
    // single-commit endpoint (bounded concurrency, capped). Best-effort —
    // a failed stat fetch leaves that commit at 0/0.
    const toEnrich = commits.slice(0, COMMIT_STATS_CAP);
    await mapWithConcurrency(toEnrich, COMMIT_STATS_CONCURRENCY, async (commit) => {
      try {
        const detail = await this.ghApi(
          buildApiArgs(`repos/${remote}/commits/${commit.sha}`, {
            cacheSeconds: DEFAULT_CACHE_DETAIL_SECONDS,
          }),
          workspaceId,
        );
        const payload = JSON.parse(detail.trim()) as GhCommitPayload;
        commit.additions = payload.stats?.additions ?? 0;
        commit.deletions = payload.stats?.deletions ?? 0;
      } catch (error) {
        logger.warn('commit stats fetch failed', { sha: commit.sha, error });
      }
    });

    await this.store.replaceCommits(prId, commits);
    return commits;
  }

  async getPullRequestChecks(
    workspaceId: string,
    remote: Remote,
    number: number,
  ): Promise<PullRequestCheckRow[]> {
    // We need the head sha; cheapest path is to read it from the cached PR.
    const cached = await this.store.getByNumber(workspaceId, remote, number);
    let headSha = cached?.headSha;
    if (!headSha) {
      const pr = await this.getPullRequest(workspaceId, remote, number);
      headSha = pr.headSha;
    }

    const prId = makePrId(remote, number);
    const out: PullRequestCheckRow[] = [];

    // Modern check-runs endpoint.
    try {
      const stdout = await this.ghApi(
        buildApiArgs(`repos/${remote}/commits/${headSha}/check-runs?per_page=${API_PAGE_SIZE}`, {
          cacheSeconds: DEFAULT_CACHE_DETAIL_SECONDS,
        }),
      workspaceId,);
      const payload = JSON.parse(stdout.trim()) as GhCheckRunsPayload;
      for (const run of payload.check_runs ?? []) {
        out.push({
          prId,
          checkName: run.name,
          status: (run.status as PullRequestCheckRow['status']) ?? 'queued',
          conclusion: (run.conclusion as PullRequestCheckRow['conclusion']) ?? null,
          detailsUrl: run.details_url ?? null,
          startedAt: run.started_at ? new Date(run.started_at).getTime() : null,
          completedAt: run.completed_at ? new Date(run.completed_at).getTime() : null,
          fetchedAt: Date.now(),
        });
      }
    } catch (error) {
      logger.warn('check-runs fetch failed', { error });
    }

    // Legacy combined-status endpoint for older CI integrations.
    try {
      const stdout = await this.ghApi(
        buildApiArgs(`repos/${remote}/commits/${headSha}/status`, {
          cacheSeconds: DEFAULT_CACHE_DETAIL_SECONDS,
        }),
      workspaceId,);
      const payload = JSON.parse(stdout.trim()) as GhCommitStatusPayload;
      for (const status of payload.statuses ?? []) {
        out.push({
          prId,
          checkName: status.context,
          status: 'completed',
          conclusion: (status.state === 'error' ? 'failure' : status.state) as PullRequestCheckRow['conclusion'],
          detailsUrl: status.target_url ?? null,
          startedAt: null,
          completedAt: status.updated_at ? new Date(status.updated_at).getTime() : null,
          fetchedAt: Date.now(),
        });
      }
    } catch (error) {
      logger.warn('combined-status fetch failed', { error });
    }

    await this.store.replaceChecks(prId, out);
    return out;
  }

  async getConversation(
    workspaceId: string,
    remote: Remote,
    number: number,
    options: { noCache?: boolean } = {},
  ): Promise<TimelineEntry[]> {
    const entries: TimelineEntry[] = [];
    const cacheSeconds = options.noCache ? 0 : DEFAULT_CACHE_DETAIL_SECONDS;

    try {
      const stdout = await this.ghApi(
        buildApiArgs(`repos/${remote}/issues/${number}/comments?per_page=${API_PAGE_SIZE}`, {
          cacheSeconds,
          paginate: true,
        }),
      workspaceId,);
      for (const comment of parsePagedJson<GhCommentPayload>(stdout)) {
        entries.push({
          id: `c_${comment.id}`,
          type: 'issue_comment',
          authorLogin: comment.user?.login ?? null,
          authorAvatarUrl: comment.user?.avatar_url ?? null,
          body: comment.body ?? '',
          createdAt: new Date(comment.created_at).getTime(),
          url: comment.html_url ?? null,
        });
      }
    } catch (error) {
      logger.warn('issue comments fetch failed', { error });
    }

    try {
      const stdout = await this.ghApi(
        buildApiArgs(`repos/${remote}/pulls/${number}/reviews?per_page=${API_PAGE_SIZE}`, {
          cacheSeconds,
          paginate: true,
        }),
      workspaceId,);
      for (const review of parsePagedJson<GhReviewPayload>(stdout)) {
        entries.push({
          id: `r_${review.id}`,
          type: 'review',
          authorLogin: review.user?.login ?? null,
          authorAvatarUrl: review.user?.avatar_url ?? null,
          body: review.body ?? '',
          state: review.state,
          createdAt: review.submitted_at ? new Date(review.submitted_at).getTime() : Date.now(),
          url: review.html_url ?? null,
        });
      }
    } catch (error) {
      logger.warn('reviews fetch failed', { error });
    }

    entries.sort((a, b) => a.createdAt - b.createdAt);
    return entries;
  }

  async getFileContents(
    workspaceId: string,
    remote: Remote,
    ref: string,
    path: string,
  ): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    let stdout: string;
    try {
      stdout = await this.ghApi(
        buildApiArgs(`repos/${remote}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
          cacheSeconds: DEFAULT_CACHE_DETAIL_SECONDS,
        }),
        workspaceId,
      );
    } catch (error) {
      // For added/removed/renamed files, one side of the comparison may
      // legitimately not exist at the requested ref. Treat 404 as "empty side"
      // instead of surfacing an error in the PR diff UI.
      if (isNotFoundError(error)) {
        return '';
      }
      throw error;
    }
    const payload = JSON.parse(stdout.trim()) as GhContentsPayload;
    if (payload.type && payload.type !== 'file') {
      return '';
    }
    if (!payload.content) {
      return '';
    }
    const encoding = payload.encoding ?? 'base64';
    if (encoding === 'base64') {
      return Buffer.from(payload.content, 'base64').toString('utf8');
    }
    return payload.content;
  }

  // ----- Review / merge actions + access control -------------------------

  /** The login of the gh account Nimbalyst uses for this workspace's calls. */
  async getViewerLogin(workspaceId: string): Promise<string | null> {
    const stdout = await this.ghApi(
      buildApiArgs('user', { cacheSeconds: 300 }),
      workspaceId,
    );
    const payload = JSON.parse(stdout.trim()) as { login?: string };
    return payload.login ?? null;
  }

  /**
   * Repo-level capabilities for the authenticated user: their effective
   * permissions and the merge methods the repo allows. GitHub only returns
   * the `allow_*` flags to users with write access (null otherwise), which is
   * fine — without `push` the merge buttons are hidden regardless.
   */
  async getRepoCapabilities(workspaceId: string, remote: Remote): Promise<RepoCapabilities> {
    const stdout = await this.ghApi(
      buildApiArgs(`repos/${remote}`, { cacheSeconds: DEFAULT_CACHE_LIST_SECONDS }),
      workspaceId,
    );
    const payload = JSON.parse(stdout.trim()) as {
      permissions?: Partial<RepoPermissions>;
      allow_squash_merge?: boolean | null;
      allow_merge_commit?: boolean | null;
      allow_rebase_merge?: boolean | null;
      delete_branch_on_merge?: boolean | null;
    };
    const perms = payload.permissions ?? {};
    let viewerLogin: string | null = null;
    try {
      viewerLogin = await this.getViewerLogin(workspaceId);
    } catch (error) {
      logger.warn('viewer login fetch failed', { error });
    }
    return {
      viewerLogin,
      permissions: {
        admin: Boolean(perms.admin),
        maintain: Boolean(perms.maintain),
        push: Boolean(perms.push),
        triage: Boolean(perms.triage),
        pull: Boolean(perms.pull),
      },
      allowSquashMerge: payload.allow_squash_merge === true,
      allowMergeCommit: payload.allow_merge_commit === true,
      allowRebaseMerge: payload.allow_rebase_merge === true,
      deleteBranchOnMerge: Boolean(payload.delete_branch_on_merge),
    };
  }

  /** Submit an APPROVE review. Fails (422) on your own PR — GitHub disallows self-approval. */
  async approvePullRequest(
    workspaceId: string,
    remote: Remote,
    number: number,
    body?: string,
  ): Promise<void> {
    const args = [
      'api',
      '-X',
      'POST',
      `repos/${remote}/pulls/${number}/reviews`,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      '-f',
      'event=APPROVE',
    ];
    if (body && body.trim()) {
      args.push('-f', `body=${body}`);
    }
    await this.ghApi(args, workspaceId);
  }

  async commentOnPullRequest(
    workspaceId: string,
    remote: Remote,
    number: number,
    body: string,
  ): Promise<void> {
    const args = [
      'api',
      '-X',
      'POST',
      `repos/${remote}/issues/${number}/comments`,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      '-f',
      `body=${body}`,
    ];
    await this.ghApi(args, workspaceId);
  }

  /**
   * Merge the PR with the given method. Optional `commitTitle` / `commitMessage`
   * override the commit subject/body (squash + merge-commit only; GitHub ignores
   * them for rebase). Throws GhApiError on 405/409/422 (carries stderr).
   */
  async mergePullRequest(
    workspaceId: string,
    remote: Remote,
    number: number,
    method: MergeMethod,
    opts: { commitTitle?: string; commitMessage?: string } = {},
  ): Promise<MergeResult> {
    const args = [
      'api',
      '-X',
      'PUT',
      `repos/${remote}/pulls/${number}/merge`,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      '-f',
      `merge_method=${method}`,
    ];
    if (opts.commitTitle && opts.commitTitle.trim()) {
      args.push('-f', `commit_title=${opts.commitTitle}`);
    }
    if (opts.commitMessage && opts.commitMessage.trim()) {
      args.push('-f', `commit_message=${opts.commitMessage}`);
    }
    const stdout = await this.ghApi(args, workspaceId);
    const payload = JSON.parse(stdout.trim() || '{}') as {
      sha?: string;
      merged?: boolean;
      message?: string;
    };
    return { sha: payload.sha ?? null, merged: Boolean(payload.merged), message: payload.message };
  }

  /**
   * Inline review threads (line-level comments) with their resolution state.
   * REST exposes the comments but not `isResolved`, so this is the one call
   * that goes through `gh api graphql`. Capped at the first 100 threads /
   * 100 comments per thread; `truncated` flags when there are more.
   */
  async getReviewThreads(
    workspaceId: string,
    remote: Remote,
    number: number,
  ): Promise<ReviewThreadsResult> {
    const [owner, name] = remote.split('/');
    const query = buildReviewThreadsQuery();
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${number}`,
    ];
    const stdout = await this.ghApi(args, workspaceId);
    const parsed = JSON.parse(stdout.trim() || '{}') as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{
                id: string;
                isResolved?: boolean;
                isOutdated?: boolean;
                path?: string | null;
                line?: number | null;
                comments?: {
                  nodes?: Array<{
                    id: string;
                    author?: { login?: string } | null;
                    body?: string;
                    createdAt?: string;
                    url?: string;
                  }>;
                };
              }>;
              pageInfo?: { hasNextPage?: boolean };
            };
          };
        };
      };
    };
    const node = parsed.data?.repository?.pullRequest?.reviewThreads;
    const threads: ReviewThread[] = (node?.nodes ?? []).map((t) => ({
      id: t.id,
      isResolved: Boolean(t.isResolved),
      isOutdated: Boolean(t.isOutdated),
      path: t.path ?? null,
      line: typeof t.line === 'number' ? t.line : null,
      comments: (t.comments?.nodes ?? []).map((c) => ({
        id: c.id,
        authorLogin: c.author?.login ?? null,
        body: c.body ?? '',
        createdAt: c.createdAt ? new Date(c.createdAt).getTime() : 0,
        url: c.url ?? null,
      })),
    }));
    return { threads, truncated: Boolean(node?.pageInfo?.hasNextPage) };
  }
}
