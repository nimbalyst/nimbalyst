/**
 * Branch listing, preflight and switching for the Git panel's branch switcher
 * (#1959).
 *
 * Every mutation here is a plain `git switch --no-overwrite-ignore`. Nothing
 * in this module passes `--force`, `--discard-changes` or `--merge`, stashes,
 * resets, or runs `checkout -- .`: a dirty tree either comes along to the new
 * branch or git refuses and the user's files stay exactly as they were.
 *
 * `switchBranch` re-runs every preflight check itself (it runs inside the
 * operation lock), refuses managed worktrees and occupied branches outright,
 * and only switches past a confirmation when the caller presents an unexpired,
 * single-use `confirmToken` that was issued for exactly the state it just
 * re-checked (checkout, request, HEAD, dirty files, sessions, detached commit).
 *
 * Git access is injected (`readGit` for reads, `runSwitch` for the one
 * mutating command) so the IPC layer can route the switch through the
 * operation lock and the Output tab, and tests can drive real temp repos.
 */
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { realpathSync, statSync } from 'fs';
import { resolve, sep } from 'path';
import { getGitSubprocessEnv } from './gitEnv';
import { validateGitOperand } from './gitOperandValidation';
import { parseWorktreeListPorcelain, type WorktreeListEntry } from './gitWorktreeList';

// ---- Types ----

export interface GitReadResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs a read-only git command in `cwd`. Never throws for a non-zero exit. */
export type ReadGit = (cwd: string, args: string[]) => Promise<GitReadResult>;

/** Runs the mutating `git switch` argv in `cwd`, returning git's stderr on failure. */
export type RunSwitch = (cwd: string, args: string[]) => Promise<{ success: boolean; error?: string }>;

export interface ManagedWorktreeInfo {
  id: string;
  name: string;
  displayName?: string;
  path: string;
}

export interface RunningSessionInfo {
  id: string;
  title: string;
  workspacePath?: string;
  worktreeId?: string;
}

export interface BranchSwitchDeps {
  readGit: ReadGit;
  runSwitch?: RunSwitch;
  /** Nimbalyst worktree records for any of these checkout paths, in one batch. Throws when it cannot tell. */
  lookupWorktrees?: (paths: string[]) => Promise<ManagedWorktreeInfo[]>;
  listRunningSessions?: () => Promise<RunningSessionInfo[]>;
  /** Where confirm tokens live; defaults to the process-wide store. */
  confirmTokens?: ConfirmTokenStore;
}

export interface OccupiedBy {
  path: string;
  worktreeId?: string;
  sessionTitle?: string;
}

export interface LocalBranchInfo {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The configured upstream no longer exists on the remote. */
  upstreamGone: boolean;
  lastCommitDate: string | null;
  isCurrent: boolean;
  /** Set when the branch is checked out in a different worktree. */
  occupiedBy: OccupiedBy | null;
}

export interface RemoteBranchInfo {
  /** `origin/fix/y` -- the remote-tracking ref the switch tracks. */
  remoteRef: string;
  /** The configured remote, which may itself contain `/`. */
  remote: string;
  /** `fix/y` -- the local branch a tracking switch would create. */
  name: string;
  lastCommitDate: string | null;
}

export interface BranchListResult {
  current: {
    branch: string | null;
    detached: boolean;
    headSha: string | null;
    /**
     * False when HEAD is detached on a commit no branch, remote ref or tag
     * contains; null when that could not be checked.
     */
    headReachable: boolean | null;
  };
  local: LocalBranchInfo[];
  remoteOnly: RemoteBranchInfo[];
  /** mtime of FETCH_HEAD in ms, or null when this checkout has never fetched. */
  lastFetchedAt: number | null;
  /** Set when the checkout itself is a Nimbalyst-managed worktree. */
  managedWorktree: { worktreeId: string; name: string } | null;
  /** True when the worktree records could not be read, so occupancy and ownership are unknown. */
  worktreeLookupFailed: boolean;
}

export type SwitchRequest =
  | { kind: 'local'; branch: string }
  | { kind: 'remote'; remoteRef: string }
  | { kind: 'create'; name: string; startPoint: string };

export type PreflightBlock =
  | { reason: 'occupied'; occupiedBy: OccupiedBy }
  | { reason: 'managed-worktree'; worktreeId: string; name: string }
  | { reason: 'unverified'; message: string };

export interface SwitchPreflightResult {
  blocked: PreflightBlock | null;
  /** The local branch the switch ends on (the derived name for a remote target). */
  targetBranch: string;
  /** Repository-relative paths with uncommitted changes (capped at MAX_DIRTY_FILES). */
  dirtyFiles: string[];
  dirtyCount: number;
  /** Agent sessions running in this checkout (not in a worktree of it). */
  runningSessions: Array<{ id: string; title: string }>;
  /** Detached HEAD on a commit only the reflog will reach after switching. */
  unreachableHead: { sha: string } | null;
  /** For a remote target: a local branch with the same short name already exists. */
  localExists: boolean;
  needsConfirm: boolean;
  /**
   * Opaque, single-use id for the state the user saw; empty when no confirm
   * is needed. `switchBranch` consumes it and proceeds only if the state it
   * re-checks inside the lock is the one the token was issued for.
   */
  confirmToken: string;
}

export type SwitchResult =
  | { success: true; branch: string }
  | {
      success: false;
      error: string;
      conflict?: 'local-exists';
      branch?: string;
      blocked?: PreflightBlock;
      /** The state changed (or was never confirmed); show this fresh confirm. */
      needsConfirm?: SwitchPreflightResult;
    };

export const MAX_DIRTY_FILES = 500;

// ---- Git access ----

/**
 * A `ReadGit` backed by the git binary. Reads run with GIT_OPTIONAL_LOCKS=0 so
 * a status read never takes the index lock out from under a user command.
 */
export function createReadGit(getEnv: () => NodeJS.ProcessEnv = getGitSubprocessEnv): ReadGit {
  return (cwd, args) => new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...getEnv(), GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolvePromise({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

export const defaultReadGit: ReadGit = createReadGit();

async function readOrThrow(readGit: ReadGit, cwd: string, args: string[]): Promise<string> {
  const result = await readGit(cwd, args);
  if (!result.ok) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout;
}

/** Git ends a single path with one newline; the path itself may contain more. */
export function stripTrailingNewline(output: string): string {
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function canonicalPath(p: string): string {
  const absolute = resolve(p);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isSameOrInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Minimal query surface shared by the PGLite and SQLite database wrappers. */
export interface WorktreeQueryDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** One query for every checkout path, so listing never does a lookup per worktree. */
export async function queryWorktreesByPaths(db: WorktreeQueryDb, paths: string[]): Promise<ManagedWorktreeInfo[]> {
  if (paths.length === 0) return [];
  const placeholders = paths.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query<{ id: string; name: string; display_name: string | null; path: string }>(
    `SELECT id, name, display_name, path FROM worktrees WHERE path IN (${placeholders})`,
    paths,
  );
  return rows.map(row => ({ id: row.id, name: row.name, displayName: row.display_name ?? undefined, path: row.path }));
}

// ---- Listing ----

const REF_FORMAT = [
  '%(refname)',
  '%(upstream)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:iso-strict)',
  '%(symref)',
].join('%00');

interface RawRef {
  refname: string;
  upstream: string;
  upstreamShort: string;
  track: string;
  date: string;
  symref: string;
}

function parseRefs(output: string): RawRef[] {
  const refs: RawRef[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [refname, upstream = '', upstreamShort = '', track = '', date = '', symref = ''] = line.split('\0');
    refs.push({ refname, upstream, upstreamShort, track, date, symref });
  }
  return refs;
}

function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: track.trim() === 'gone',
  };
}

/**
 * Split `<remote>/<branch>` using the configured remotes. Remote names may
 * contain `/`, so the longest configured remote that prefixes the ref wins;
 * the first segment is only a fallback for a remote no longer configured.
 */
export function splitRemoteRef(remoteRef: string, remotes: readonly string[]): { remote: string; name: string } {
  let best = '';
  for (const remote of remotes) {
    if (remote.length > best.length && remoteRef.startsWith(`${remote}/`)) best = remote;
  }
  if (!best) {
    const slash = remoteRef.indexOf('/');
    best = slash > 0 ? remoteRef.slice(0, slash) : remoteRef;
  }
  return { remote: best, name: remoteRef.slice(best.length + 1) };
}

async function readRemotes(readGit: ReadGit, repoPath: string): Promise<string[]> {
  const output = await readOrThrow(readGit, repoPath, ['remote']);
  return output.split('\n').map(r => r.trim()).filter(Boolean);
}

async function readWorktrees(readGit: ReadGit, repoPath: string): Promise<WorktreeListEntry[]> {
  const nul = await readGit(repoPath, ['worktree', 'list', '--porcelain', '-z']);
  if (nul.ok) return parseWorktreeListPorcelain(nul.stdout, { nulTerminated: true });
  // git older than 2.36 has no -z; its quoted paths only affect exotic names.
  return parseWorktreeListPorcelain(await readOrThrow(readGit, repoPath, ['worktree', 'list', '--porcelain']));
}

interface ListContext {
  toplevel: string;
  remotes: string[];
  list: BranchListResult;
}

async function listWithContext(repoPath: string, deps: BranchSwitchDeps): Promise<ListContext> {
  const { readGit } = deps;
  // Separate reads: each prints one path, which may itself contain a newline.
  const [toplevelOutput, fetchHeadOutput, worktrees, refsOutput, remotes] = await Promise.all([
    readOrThrow(readGit, repoPath, ['rev-parse', '--show-toplevel']),
    readOrThrow(readGit, repoPath, ['rev-parse', '--git-path', 'FETCH_HEAD']),
    readWorktrees(readGit, repoPath),
    readOrThrow(readGit, repoPath, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes']),
    readRemotes(readGit, repoPath),
  ]);

  const toplevel = stripTrailingNewline(toplevelOutput) || repoPath;
  const fetchHeadPath = stripTrailingNewline(fetchHeadOutput);
  let lastFetchedAt: number | null = null;
  if (fetchHeadPath) {
    try {
      lastFetchedAt = statSync(resolve(repoPath, fetchHeadPath)).mtimeMs;
    } catch {
      lastFetchedAt = null;
    }
  }

  const ownPath = canonicalPath(toplevel);
  const own = worktrees.find(w => canonicalPath(w.path) === ownPath) ?? null;
  const others = worktrees.filter(w => w !== own && !w.bare);

  // One batched lookup for every worktree, not one per worktree or branch.
  const lookupPaths = [...new Set([own?.path ?? toplevel, ...others.filter(w => w.branch).map(w => w.path)])];
  const recordsByPath = new Map<string, ManagedWorktreeInfo>();
  let worktreeLookupFailed = false;
  if (deps.lookupWorktrees) {
    try {
      for (const record of await deps.lookupWorktrees(lookupPaths)) {
        recordsByPath.set(canonicalPath(record.path), record);
      }
    } catch {
      worktreeLookupFailed = true;
    }
  }
  const recordFor = (p: string) => recordsByPath.get(canonicalPath(p)) ?? null;

  const occupiedByBranch = new Map<string, OccupiedBy>();
  for (const w of others) {
    if (!w.branch) continue;
    const record = recordFor(w.path);
    occupiedByBranch.set(
      w.branch,
      record
        ? { path: w.path, worktreeId: record.id, sessionTitle: record.displayName || record.name }
        : { path: w.path },
    );
  }
  const ownRecord = recordFor(own?.path ?? toplevel);

  const currentBranch = own && !own.detached ? own.branch : null;
  const detached = own?.detached ?? false;
  const headSha = own?.head ?? null;

  let headReachable: boolean | null = true;
  if (detached && headSha) {
    const containing = await readGit(repoPath, [
      'for-each-ref', '--count=1', '--format=%(refname)', '--contains', headSha,
      'refs/heads', 'refs/remotes', 'refs/tags',
    ]);
    headReachable = containing.ok ? containing.stdout.trim().length > 0 : null;
  }

  const refs = parseRefs(refsOutput);
  const localRefs = refs.filter(r => r.refname.startsWith('refs/heads/'));
  const localNames = new Set(localRefs.map(r => r.refname.slice('refs/heads/'.length)));
  const trackedUpstreams = new Set(localRefs.map(r => r.upstream).filter(Boolean));

  const local: LocalBranchInfo[] = localRefs.map((r) => {
    const name = r.refname.slice('refs/heads/'.length);
    const track = parseTrack(r.track);
    return {
      name,
      upstream: r.upstreamShort || null,
      ahead: track.ahead,
      behind: track.behind,
      upstreamGone: track.gone,
      lastCommitDate: r.date || null,
      isCurrent: name === currentBranch,
      occupiedBy: name === currentBranch ? null : occupiedByBranch.get(name) ?? null,
    };
  });

  const remoteOnly: RemoteBranchInfo[] = [];
  for (const r of refs) {
    if (!r.refname.startsWith('refs/remotes/') || r.symref) continue;
    const remoteRef = r.refname.slice('refs/remotes/'.length);
    const { remote, name } = splitRemoteRef(remoteRef, remotes);
    if (!remote || !name || name === 'HEAD') continue;
    if (localNames.has(name) || trackedUpstreams.has(r.refname)) continue;
    remoteOnly.push({ remoteRef, remote, name, lastCommitDate: r.date || null });
  }

  return {
    toplevel,
    remotes,
    list: {
      current: { branch: currentBranch, detached, headSha, headReachable },
      local,
      remoteOnly,
      lastFetchedAt,
      managedWorktree: ownRecord
        ? { worktreeId: ownRecord.id, name: ownRecord.displayName || ownRecord.name }
        : null,
      worktreeLookupFailed,
    },
  };
}

export async function listBranchesDetailed(repoPath: string, deps: BranchSwitchDeps): Promise<BranchListResult> {
  return (await listWithContext(repoPath, deps)).list;
}

// ---- Validation and argv ----

function assertRequestObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request must be an object');
  }
}

/** Throws unless `value` is a well-formed request whose operands cannot be read as options. */
export function validateSwitchRequest(value: unknown): asserts value is SwitchRequest {
  assertRequestObject(value);
  switch (value.kind) {
    case 'local':
      validateGitOperand(value.branch, 'branch');
      return;
    case 'remote':
      validateGitOperand(value.remoteRef, 'remoteRef');
      if (!value.remoteRef.includes('/')) throw new Error('remoteRef must name <remote>/<branch>');
      return;
    case 'create':
      validateGitOperand(value.name, 'name');
      validateGitOperand(value.startPoint, 'startPoint');
      return;
    default:
      throw new Error('request kind must be local, remote or create');
  }
}

/**
 * The exact argv for each request.
 * - `--no-overwrite-ignore`: git switch otherwise silently overwrites ignored
 *   local files that the target branch tracks.
 * - `--end-of-options` keeps every operand a revision.
 * - `--no-guess` stops a local switch from silently creating a tracking branch
 *   when only a remote ref has that name.
 * - A remote switch names the local branch explicitly (`-c <name> --track`)
 *   so a remote whose name contains `/` derives the same name we checked.
 */
export function buildSwitchArgs(request: SwitchRequest, remoteBranchName?: string): string[] {
  switch (request.kind) {
    case 'local':
      return ['switch', '--no-overwrite-ignore', '--no-guess', '--end-of-options', request.branch];
    case 'remote': {
      if (!remoteBranchName) throw new Error('remote switch needs the derived local branch name');
      return ['switch', '--no-overwrite-ignore', '--track', '-c', remoteBranchName, '--end-of-options', request.remoteRef];
    }
    case 'create':
      return ['switch', '--no-overwrite-ignore', '--no-track', '-c', request.name, '--end-of-options', request.startPoint];
  }
}

// ---- Preflight ----

/** Paths from `git status --porcelain=v2 -z`. Renames report the new path. */
export function parseStatusPorcelainV2Z(output: string): string[] {
  const files: string[] = [];
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const kind = token[0];
    if (kind === '1') {
      files.push(token.split(' ').slice(8).join(' '));
    } else if (kind === '2') {
      files.push(token.split(' ').slice(9).join(' '));
      i++; // the original path follows as its own NUL-terminated token
    } else if (kind === 'u') {
      files.push(token.split(' ').slice(10).join(' '));
    } else if (kind === '?') {
      files.push(token.slice(2));
    }
  }
  return files;
}

function targetBranchName(request: SwitchRequest, remotes: readonly string[]): string {
  if (request.kind === 'local') return request.branch;
  if (request.kind === 'remote') return splitRemoteRef(request.remoteRef, remotes).name;
  return request.name;
}

const COULD_NOT_VERIFY = {
  worktrees: 'Could not verify whether this checkout or the target branch belongs to a Nimbalyst worktree.',
  reachability: 'Could not verify whether the current detached commit is on a branch.',
  sessions: 'Could not verify whether an agent session is running in this checkout.',
} as const;

/**
 * Running sessions whose effective checkout is this one. A session in a
 * subfolder counts; one in a nested repository or a worktree does not.
 */
async function runningSessionsInCheckout(
  deps: BranchSwitchDeps,
  ownPath: string,
): Promise<Array<{ id: string; title: string }>> {
  if (!deps.listRunningSessions) return [];
  const running = await deps.listRunningSessions();
  const matches: Array<{ id: string; title: string }> = [];
  for (const session of running) {
    if (session.worktreeId || !session.workspacePath) continue;
    const workspace = canonicalPath(session.workspacePath);
    // A checkout root is always the path itself or an ancestor of it.
    if (!isSameOrInside(workspace, ownPath)) continue;
    if (workspace !== ownPath) {
      const top = await deps.readGit(workspace, ['rev-parse', '--show-toplevel']);
      // Unresolvable: count it rather than report "no sessions".
      if (top.ok && canonicalPath(stripTrailingNewline(top.stdout)) !== ownPath) continue;
    }
    matches.push({ id: session.id, title: session.title });
  }
  return matches;
}

/** The exact state a confirmation was given for. */
interface ConfirmedState {
  checkout: string;
  request: string;
  headSha: string | null;
  headRef: string | null;
  dirty: string;
  sessions: string;
  unreachable: string | null;
}

function confirmedStateKey(state: ConfirmedState): string {
  return JSON.stringify([
    state.checkout, state.request, state.headSha, state.headRef,
    state.dirty, state.sessions, state.unreachable,
  ]);
}

/** Fixed field order, so the caller's key order cannot change the identity. */
function requestKey(request: SwitchRequest): string {
  return JSON.stringify(request.kind === 'local'
    ? ['local', request.branch]
    : request.kind === 'remote'
      ? ['remote', request.remoteRef]
      : ['create', request.name, request.startPoint]);
}

export const CONFIRM_TOKEN_TTL_MS = 2 * 60 * 1000;

/**
 * In-memory confirm tokens: random ids mapped to the state the user confirmed.
 * Tokens expire after CONFIRM_TOKEN_TTL_MS and are removed on first use,
 * whether or not the state still matched, so none can be replayed.
 */
export interface ConfirmTokenEntry {
  key: string;
  expiresAt: number;
}

export class ConfirmTokenStore {
  private readonly tokens = new Map<string, ConfirmTokenEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor({ now = Date.now, ttlMs = CONFIRM_TOKEN_TTL_MS }: { now?: () => number; ttlMs?: number } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  issue(state: ConfirmedState): string {
    this.prune();
    const token = randomUUID();
    this.tokens.set(token, { key: confirmedStateKey(state), expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /**
   * Removes the token synchronously and returns what it confirmed, or null if
   * it was unknown or expired. Callers take it BEFORE awaiting any check, so a
   * check that throws still leaves the token spent.
   */
  take(token: string | undefined): ConfirmTokenEntry | null {
    if (!token) return null;
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return entry;
  }

  /** True when a taken entry was issued for exactly `state`. */
  static matches(entry: ConfirmTokenEntry | null, state: ConfirmedState | null): boolean {
    return !!entry && !!state && entry.key === confirmedStateKey(state);
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
  }
}

const defaultConfirmTokens = new ConfirmTokenStore();

interface SwitchState {
  preflight: SwitchPreflightResult;
  /** Present when no check blocked the switch. */
  confirmed: ConfirmedState | null;
}

async function computeSwitchState(
  repoPath: string,
  target: SwitchRequest,
  deps: BranchSwitchDeps,
): Promise<SwitchState> {
  const { toplevel, remotes, list } = await listWithContext(repoPath, deps);
  const ownPath = canonicalPath(toplevel);
  const branchName = targetBranchName(target, remotes);
  const base: SwitchPreflightResult = {
    blocked: null,
    targetBranch: branchName,
    dirtyFiles: [],
    dirtyCount: 0,
    runningSessions: [],
    unreachableHead: null,
    localExists: false,
    needsConfirm: false,
    confirmToken: '',
  };
  const blocked = (block: PreflightBlock): SwitchState => ({ preflight: { ...base, blocked: block }, confirmed: null });

  if (list.worktreeLookupFailed) return blocked({ reason: 'unverified', message: COULD_NOT_VERIFY.worktrees });
  if (list.managedWorktree) {
    return blocked({ reason: 'managed-worktree', worktreeId: list.managedWorktree.worktreeId, name: list.managedWorktree.name });
  }

  const localEntry = list.local.find(b => b.name === branchName);
  if (target.kind === 'local' && localEntry?.occupiedBy) {
    return blocked({ reason: 'occupied', occupiedBy: localEntry.occupiedBy });
  }
  if (list.current.detached && list.current.headReachable === null) {
    return blocked({ reason: 'unverified', message: COULD_NOT_VERIFY.reachability });
  }

  let runningSessions: Array<{ id: string; title: string }>;
  try {
    runningSessions = await runningSessionsInCheckout(deps, ownPath);
  } catch {
    return blocked({ reason: 'unverified', message: COULD_NOT_VERIFY.sessions });
  }

  const allDirty = parseStatusPorcelainV2Z(await readOrThrow(deps.readGit, repoPath, ['status', '--porcelain=v2', '-z']));
  const unreachableHead = list.current.detached && list.current.headReachable === false && list.current.headSha
    ? { sha: list.current.headSha }
    : null;

  const needsConfirm = allDirty.length > 0 || runningSessions.length > 0 || unreachableHead !== null;
  const confirmed: ConfirmedState = {
    checkout: ownPath,
    request: requestKey(target),
    headSha: list.current.headSha,
    headRef: list.current.detached ? null : list.current.branch,
    dirty: JSON.stringify([...allDirty].sort()),
    sessions: JSON.stringify(runningSessions.map(s => s.id).sort()),
    unreachable: unreachableHead?.sha ?? null,
  };

  return {
    confirmed,
    preflight: {
      ...base,
      dirtyFiles: allDirty.slice(0, MAX_DIRTY_FILES),
      dirtyCount: allDirty.length,
      runningSessions,
      unreachableHead,
      localExists: target.kind === 'remote' && !!localEntry,
      needsConfirm,
      confirmToken: needsConfirm ? (deps.confirmTokens ?? defaultConfirmTokens).issue(confirmed) : '',
    },
  };
}

export async function switchPreflight(
  repoPath: string,
  target: unknown,
  deps: BranchSwitchDeps,
): Promise<SwitchPreflightResult> {
  validateSwitchRequest(target);
  return (await computeSwitchState(repoPath, target, deps)).preflight;
}

function blockMessage(block: PreflightBlock): string {
  if (block.reason === 'managed-worktree') return `This checkout belongs to worktree session ${block.name}.`;
  if (block.reason === 'occupied') return `This branch is checked out in ${block.occupiedBy.sessionTitle ?? block.occupiedBy.path}.`;
  return block.message;
}

// ---- Switch ----

/**
 * Re-checks the full preflight state (callers hold the operation lock), then
 * switches. A confirmation counts only when `confirmToken` is live and was
 * issued for the state re-checked here; the token is consumed either way, and
 * a mismatch returns the fresh preflight (with a new token) as `needsConfirm`.
 */
export async function switchBranch(
  repoPath: string,
  request: unknown,
  deps: BranchSwitchDeps,
  confirmToken?: string,
): Promise<SwitchResult> {
  validateSwitchRequest(request);
  if (!deps.runSwitch) throw new Error('runSwitch is required to switch branches');

  // Spend the token before the first await: if any check below throws, the
  // token is already gone and cannot be replayed once reads recover.
  const taken = (deps.confirmTokens ?? defaultConfirmTokens).take(confirmToken);
  const { preflight: state, confirmed } = await computeSwitchState(repoPath, request, deps);
  const tokenMatches = ConfirmTokenStore.matches(taken, confirmed);
  if (state.blocked) {
    return { success: false, error: blockMessage(state.blocked), blocked: state.blocked };
  }

  if (request.kind === 'remote') {
    validateGitOperand(state.targetBranch, 'derived branch name');
    if (state.localExists) {
      return {
        success: false,
        conflict: 'local-exists',
        branch: state.targetBranch,
        error: `A local branch named "${state.targetBranch}" already exists.`,
      };
    }
  }

  if (request.kind === 'create') {
    const check = await deps.readGit(repoPath, ['check-ref-format', '--branch', request.name]);
    if (!check.ok) {
      return { success: false, error: `"${request.name}" is not a valid branch name.` };
    }
  }

  if (state.needsConfirm && !tokenMatches) {
    return { success: false, error: 'Confirmation required', needsConfirm: state };
  }

  const result = await deps.runSwitch(repoPath, buildSwitchArgs(request, state.targetBranch));
  if (!result.success) {
    return { success: false, error: result.error || 'git switch failed' };
  }
  return { success: true, branch: state.targetBranch };
}
