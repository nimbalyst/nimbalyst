import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { RecoveringFileWatcher } from './RecoveringFileWatcher';
import { createWorkspaceNativeWatcher, supportsRecursiveWatch, type NativeWatchHandle } from './WorkspaceNativeWatcher';
import { pathExistsAfterRename } from './pathExistsAfterRename';
import type { FileWatchHealth } from '../../shared/fileWatchHealth';
import ignore, { Ignore } from 'ignore';
import { ATOMIC_WRITE_TEMP_SUFFIX, RECOVERY_SNAPSHOT_INFIX } from './safeFileWrite';
import { logger } from '../utils/logger';
import { shouldExcludeDir } from '../utils/fileFilters';
import { isPathInWorkspace } from '../utils/workspaceDetection';

/**
 * .git is always ignored — it's an internal data structure, never user content.
 * Everything else is determined by .gitignore (or fallback patterns).
 */
const ALWAYS_IGNORED_DIRS = new Set(['.git']);

/**
 * Top-level directory names (relative to workspace root) that are
 * macOS system/protected dirs and should be ignored entirely.
 * These only apply when the workspace root IS one of these (e.g. opening /).
 */
const IGNORED_TOP_DIRS = new Set([
  '.Trash', 'Library', 'Applications', 'Documents',
  'Downloads', 'Music', 'Pictures', 'Movies', 'Public',
  '.Spotlight-V100', '.TemporaryItems', '.fseventsd',
]);

/** OS junk files that should be silently ignored. */
const IGNORED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Fallback ignore patterns used when no .gitignore exists (non-git projects).
 *
 * When a .gitignore IS present, we trust it completely and don't add these.
 * When it ISN'T present, the project isn't under version control and there's
 * no authoritative source of what to ignore, so we use common conventions
 * for directories that are almost always generated/cached output.
 */
const FALLBACK_IGNORE_PATTERNS = [
  // Package managers
  'node_modules/',
  '.pnp/',
  '.yarn/',
  'bower_components/',

  // Build output
  'dist/',
  'build/',
  'out/',
  'target/',
  '.output/',

  // Framework caches
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.cache/',
  '.turbo/',
  '.parcel-cache/',
  '.webpack/',

  // Test/coverage
  'coverage/',

  // IDE
  '.vscode/',
  '.idea/',

  // Misc
  '.wrangler/',
  '__pycache__/',
  '*.pyc',
  '.DS_Store',
  'Thumbs.db',
];

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/** Normalize a path to forward slashes for consistent Set comparisons across platforms. */
function normalizeToForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

function pathContainsExcludedDir(relativePath: string): boolean {
  const normalized = normalizeToForwardSlash(relativePath);
  if (/(?:^|\/)nimbalyst-local\/attachments(?:\/|$)/.test(normalized)) return true;
  const segments = normalized.split('/').filter(Boolean);
  return segments.some((segment) => shouldExcludeDir(segment));
}

// ---------------------------------------------------------------------------
// Workspace path safety
// ---------------------------------------------------------------------------

/**
 * Minimum depth from filesystem root for a workspace path to be watchable.
 * Paths like `/`, `/Users`, `/home` are too broad and would flood FSEvents.
 */
const MIN_WORKSPACE_DEPTH = 3;

/**
 * Returns the depth of a path from the filesystem root.
 * `/` = 0, `/Users` = 1, `/Users/ghinkle` = 2, `/Users/ghinkle/project` = 3
 */
function pathDepth(p: string): number {
  const resolved = path.resolve(p);
  const segments = resolved.split(path.sep).filter(Boolean);
  return segments.length;
}

/**
 * Validate that a workspace path is safe to watch recursively.
 * Returns an error message if unsafe, or null if safe.
 */
function validateWorkspacePath(workspacePath: string): string | null {
  const depth = pathDepth(workspacePath);
  if (depth < MIN_WORKSPACE_DEPTH) {
    return `Workspace path "${workspacePath}" is too shallow (depth ${depth}, minimum ${MIN_WORKSPACE_DEPTH}). ` +
      `Watching this path would monitor the entire filesystem and freeze the process.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceEventType = 'change' | 'add' | 'unlink';

type GitignoreChangeHandler = (workspacePath: string) => void;

export interface WorkspaceEventListener {
  onHealthChanged?: (health: FileWatchHealth) => void;
  onChange: (filePath: string, gitignoreBypassed?: boolean) => void;
  onAdd: (filePath: string, gitignoreBypassed?: boolean) => void;
  onUnlink: (filePath: string, gitignoreBypassed?: boolean) => void;
  /**
   * Opt in to receive `add` and `unlink` events for gitignored paths
   * (dispatched with `gitignoreBypassed=true`). `change` events for
   * gitignored paths are still dropped — only structural events come through.
   *
   * Used by the file-tree watcher: the tree builder filters by a hardcoded
   * EXCLUDED_DIRS set, not by .gitignore, so gitignored folders like `temp/`
   * or `test-results/` DO show up in the sidebar and need refresh events
   * when they appear or disappear. Listeners that perform AI change tracking
   * or editor notifications should leave this off so they don't pick up
   * unrelated gitignored writes.
   */
  receiveGitignoredStructureEvents?: boolean;
}

/** Dropped gitignored event stored in replay buffer. */
interface DroppedGitignoreEvent {
  absolutePath: string;
  eventType: 'change' | 'add' | 'unlink' | 'rename';
  timestamp: number;
}

/** Max entries in the replay buffer per workspace. */
const REPLAY_BUFFER_MAX = 50;
/** TTL for replay buffer entries (ms). */
const REPLAY_BUFFER_TTL_MS = 5000;

let gitignoreChangeHandler: GitignoreChangeHandler | null = null;

interface BusEntry {
  lifecycle: RecoveringFileWatcher<NativeWatchHandle>;
  expandedPaths: Set<string>;
  /** Callbacks to invoke for each fs event, keyed by subscriber ID */
  listeners: Map<string, WorkspaceEventListener>;
  /** Absolute (resolved) workspace path. Cached so isGitignoredScoped doesn't re-resolve per event. */
  workspaceAbs: string;
  /** Workspace-root .gitignore filter (or fallback patterns when none exists). */
  workspaceGitignoreFilter: Ignore;
  /** Lazily loaded nested-repo .gitignore filters, keyed by absolute git-root path. */
  nestedGitignoreCache: Map<string, Ignore>;
  /** Memoized git-root lookup keyed by directory, so the chokidar walk visits each ancestor at most once. */
  gitRootDirCache: Map<string, string | null>;
  /** Absolute paths that bypass gitignore filtering. */
  gitignoreBypassPaths: Set<string>;
  bypassOwners: Map<string, Set<string>>;
  /** Ring buffer of recently dropped gitignored events for replay on bypass registration. */
  replayBuffer: DroppedGitignoreEvent[];
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Fast pre-filter for paths that should ALWAYS be ignored regardless of
 * .gitignore. Only .git internals, macOS system dirs, and OS junk files.
 *
 * Everything else (node_modules, dist, build, etc.) is determined by .gitignore
 * or the fallback patterns. This keeps the hardcoded list minimal and correct.
 */
function shouldIgnoreHardcoded(relativePath: string): boolean {
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  // Ignore macOS system/protected top-level directories
  if (IGNORED_TOP_DIRS.has(segments[0])) {
    return true;
  }

  // Ignore .git internals (always correct to ignore)
  for (const seg of segments) {
    if (ALWAYS_IGNORED_DIRS.has(seg)) {
      return true;
    }
  }

  if (pathContainsExcludedDir(relativePath)) {
    return true;
  }

  const basename = segments[segments.length - 1];

  // Scratch files from an atomic save. They exist for microseconds inside the
  // workspace, and surfacing them would emit an add/unlink pair per autosave.
  if (basename.endsWith(ATOMIC_WRITE_TEMP_SUFFIX)) {
    return true;
  }

  // Snapshots of content an unconditional overwrite was about to destroy
  // (#3684). They sit beside the file so the user can find them, but they are
  // recovery artifacts, not documents -- keep them out of the tree.
  if (basename.includes(RECOVERY_SNAPSHOT_INFIX)) {
    return true;
  }

  // Ignore OS junk files
  if (IGNORED_BASENAMES.has(basename)) {
    return true;
  }

  // Ignore Unix socket files (e.g. .gnupg/S.gpg-agent)
  if (basename.startsWith('S.')) {
    return true;
  }

  return false;
}

async function loadGitignoreFilter(workspacePath: string): Promise<Ignore> {
  const gitignorePath = path.join(workspacePath, '.gitignore');
  try {
    const content = await fsPromises.readFile(gitignorePath, 'utf-8');
    return ignore().add(content);
  } catch {
    return ignore().add(FALLBACK_IGNORE_PATTERNS);
  }
}

function loadWorkspaceGitignoreFilterSync(workspacePath: string): Ignore {
  const gitignorePath = path.join(workspacePath, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    return ignore().add(content);
  } catch {
    return ignore().add(FALLBACK_IGNORE_PATTERNS);
  }
}

/**
 * Synchronous loader for nested-repo `.gitignore`s. Used from the chokidar
 * `ignored` callback, which must return synchronously, so the `Ignore` instance
 * has to materialize on first miss without `await`. Returns an empty filter
 * when the nested repo has no `.gitignore` — we don't fall back to the workspace
 * patterns at the nested level because a nested repo's silence is its own choice.
 */
function loadGitignoreFilterSync(rootPath: string): Ignore {
  const gitignorePath = path.join(rootPath, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    return ignore().add(content);
  } catch {
    return ignore();
  }
}

/**
 * Walk up from `dirname(absolutePath)` to find the deepest enclosing directory
 * that contains a `.git` entry, bounded at `workspaceAbs`. Memoizes per-directory
 * results so a chokidar walk over 100k entries does at most one `existsSync`
 * per unique ancestor. Mirrors the boundary semantics of
 * `GitStatusService.findGitRootForFile` — out-of-boundary inputs return null
 * so we never resolve to an unrelated repo higher up the filesystem.
 */
function findGitRootForPathCached(
  absolutePath: string,
  workspaceAbs: string,
  cache: Map<string, string | null>,
): string | null {
  const sep = process.platform === 'win32' ? '\\' : '/';
  const boundaryWithSep = workspaceAbs.endsWith(sep) ? workspaceAbs : workspaceAbs + sep;
  if (absolutePath !== workspaceAbs && !absolutePath.startsWith(boundaryWithSep)) {
    return null;
  }

  const ancestorsVisited: string[] = [];
  let dir = path.dirname(absolutePath);
  let result: string | null = null;

  while (true) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    ancestorsVisited.push(dir);

    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        result = dir;
        break;
      }
    } catch {
      // ignore - keep walking
    }

    if (dir === workspaceAbs) {
      result = null;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      result = null;
      break;
    }
    if (!parent.startsWith(boundaryWithSep) && parent !== workspaceAbs) {
      result = null;
      break;
    }
    dir = parent;
  }

  // Every ancestor we crossed shares the same owning root.
  for (const visited of ancestorsVisited) {
    cache.set(visited, result);
  }
  return result;
}

/**
 * Returns true if `absolutePath` is gitignored under either the workspace-root
 * `.gitignore` (existing behavior) or the nearest enclosing nested repo's
 * `.gitignore`. Honors the layout from issue #207, where a non-git workspace
 * root contains nested git repos with their own ignore rules.
 */
function isGitignoredScoped(
  absolutePath: string,
  workspaceAbs: string,
  entry: BusEntry,
): boolean {
  const wsRel = path.relative(workspaceAbs, absolutePath).split(path.sep).join('/');
  if (wsRel === '' || wsRel.startsWith('..')) return false;

  if (entry.workspaceGitignoreFilter.ignores(wsRel) ||
      entry.workspaceGitignoreFilter.ignores(wsRel + '/')) {
    return true;
  }

  const owningRoot = findGitRootForPathCached(absolutePath, workspaceAbs, entry.gitRootDirCache);
  if (!owningRoot || owningRoot === workspaceAbs) return false;

  let nestedFilter = entry.nestedGitignoreCache.get(owningRoot);
  if (!nestedFilter) {
    nestedFilter = loadGitignoreFilterSync(owningRoot);
    entry.nestedGitignoreCache.set(owningRoot, nestedFilter);
  }
  const rootRel = path.relative(owningRoot, absolutePath).split(path.sep).join('/');
  if (rootRel === '' || rootRel.startsWith('..')) return false;
  return nestedFilter.ignores(rootRel) || nestedFilter.ignores(rootRel + '/');
}

function isGitignoreFile(absolutePath: string): boolean {
  return path.basename(absolutePath) === '.gitignore';
}

function reloadGitignoreFiltersForPath(absolutePath: string, entry: BusEntry): boolean {
  if (!isGitignoreFile(absolutePath)) return false;

  const normalizedPath = path.resolve(absolutePath);
  const workspaceGitignorePath = path.join(entry.workspaceAbs, '.gitignore');
  let reloaded = false;

  if (normalizedPath === workspaceGitignorePath) {
    entry.workspaceGitignoreFilter = loadWorkspaceGitignoreFilterSync(entry.workspaceAbs);
    reloaded = true;
  } else {
    const candidateRoot = path.dirname(normalizedPath);
    if (entry.nestedGitignoreCache.has(candidateRoot) || fs.existsSync(path.join(candidateRoot, '.git'))) {
      entry.nestedGitignoreCache.set(candidateRoot, loadGitignoreFilterSync(candidateRoot));
      reloaded = true;
    }
  }

  if (!reloaded) return false;

  // Ignore semantics changed; dropped-event replay is no longer valid.
  entry.replayBuffer = [];
  gitignoreChangeHandler?.(entry.workspaceAbs);
  return true;
}

function refreshGitignoreFiltersForEvent(
  absolutePath: string,
  eventType: 'change' | 'add' | 'unlink' | 'rename',
  entry: BusEntry,
): void {
  if (!isGitignoreFile(absolutePath)) return;

  if (eventType === 'rename') {
    const generation = entry.lifecycle.health.generation;
    void pathExistsAfterRename(absolutePath).then(() => {
      if (busEntries.get(entry.workspaceAbs) === entry && entry.lifecycle.health.generation === generation) reloadGitignoreFiltersForPath(absolutePath, entry);
    }).catch(error => logger.main.error('[WorkspaceEventBus] Gitignore check failed:', error));
    return;
  }

  reloadGitignoreFiltersForPath(absolutePath, entry);
}

// ---------------------------------------------------------------------------
// WorkspaceEventBus
// ---------------------------------------------------------------------------

/** Global registry of shared watchers, keyed by normalized workspace path. */
const busEntries = new Map<string, BusEntry>();

export function setGitignoreChangeHandler(handler: GitignoreChangeHandler | null): void {
  gitignoreChangeHandler = handler;
}

/**
 * WorkspaceEventBus owns a single fs.watch/chokidar watcher per workspace,
 * loads .gitignore, and emits filtered events to all subscribers.
 *
 * Both OptimizedWorkspaceWatcher and SessionFileWatcher subscribe to this bus
 * rather than creating their own watchers.
 */

export async function subscribe(
  workspacePath: string,
  subscriberId: string,
  listener: WorkspaceEventListener,
): Promise<void> {
  const key = path.resolve(workspacePath);
  const existing = busEntries.get(key);
  if (existing) {
    existing.listeners.set(subscriberId, listener);
    listener.onHealthChanged?.(existing.lifecycle.health);
    await existing.lifecycle.start();
    return;
  }
  const validationError = validateWorkspacePath(key);
  if (validationError) throw new Error(validationError);

  const entry: BusEntry = {
    lifecycle: null!, expandedPaths: new Set(), listeners: new Map([[subscriberId, listener]]),
    workspaceAbs: key, workspaceGitignoreFilter: ignore(), nestedGitignoreCache: new Map(),
    gitRootDirCache: new Map(), gitignoreBypassPaths: new Set(), bypassOwners: new Map(), replayBuffer: [],
  };
  entry.lifecycle = new RecoveringFileWatcher(async (current, fail) => {
    const filter = await loadGitignoreFilter(key);
    if (!current()) return { close() {} } as NativeWatchHandle;
    entry.workspaceGitignoreFilter = filter;
    entry.nestedGitignoreCache.clear();
    entry.gitRootDirCache.clear();
    entry.replayBuffer = [];
    const watcher = createWorkspaceNativeWatcher(key, current, fail,
      filePath => {
        const relative = path.relative(key, filePath);
        return !!relative && (shouldIgnoreHardcoded(relative) ||
          (isGitignoredScoped(filePath, key, entry) && getGitignoreAction(filePath, entry) === 'drop'));
      },
      (type, filePath) => deliverNativeEvent(entry, type, filePath, current),
    );
    if (watcher && 'add' in watcher) {
      for (const file of new Set([...entry.expandedPaths, ...entry.gitignoreBypassPaths])) watcher.add(file);
    }
    return watcher;
  }, health => {
    logger.main.info('[WorkspaceEventBus] Watcher health:', { workspacePath: key, ...health, subscriberCount: entry.listeners.size });
    for (const subscriber of entry.listeners.values()) {
      try { subscriber.onHealthChanged?.(health); }
      catch (error) { logger.main.error('[WorkspaceEventBus] Health listener failed:', error); }
    }
  }, error => logger.main.error('[WorkspaceEventBus] Watcher close failed:', error));
  // Register before the first await: concurrent subscriptions must share setup.
  busEntries.set(key, entry);
  await entry.lifecycle.start();
}

export function unsubscribe(workspacePath: string, subscriberId: string): void {
  const key = path.resolve(workspacePath);
  const entry = busEntries.get(key);
  const listener = entry?.listeners.get(subscriberId);
  if (!entry || !listener) return;
  entry.listeners.delete(subscriberId);
  try { listener.onHealthChanged?.({ state: 'stopped', generation: entry.lifecycle.health.generation }); }
  catch (error) { logger.main.error('[WorkspaceEventBus] Health subscriber failed:', error); }
  if (entry.listeners.size === 0) {
    busEntries.delete(key);
    void entry.lifecycle.stop();
    entry.gitignoreBypassPaths.clear();
    entry.replayBuffer = [];
  }
}

/** Active subscriber IDs for a workspace. Used by WorkspaceFileEditAttributionService. */
export function getSubscriberIds(workspacePath: string): string[] {
  const entry = busEntries.get(path.resolve(workspacePath));
  if (!entry) return [];
  return [...entry.listeners.keys()];
}

/**
 * Whether a session is subscribed to any workspace, i.e. an AI turn could still
 * be in flight for it.
 *
 * Used as a liveness guard before retiring that session's pending-review
 * baselines (#1403): `AgentToolHooks.tagFileBeforeEdit` records a baseline
 * equal to current disk content BEFORE the tool writes, so a tag belonging to a
 * live session can look already-landed for as long as a permission prompt sits
 * unanswered.
 */
export function isSessionSubscribedAnywhere(sessionId: string): boolean {
  for (const entry of busEntries.values()) {
    if (entry.listeners.has(sessionId)) return true;
  }
  return false;
}

/** Number of active bus entries. Visible for testing/diagnostics. */
export function getBusEntryCount(): number {
  return busEntries.size;
}

/** Ref count for a workspace. Visible for testing. */
export function getRefCount(workspacePath: string): number {
  return busEntries.get(path.resolve(workspacePath))?.listeners.size ?? 0;
}

/** Reset all bus state. Only for tests. */
export function resetBus(): void {
  for (const entry of busEntries.values()) void entry.lifecycle.stop();
  busEntries.clear();
}

/**
 * On Linux, forward folder expansion to chokidar.
 * No-op on macOS/Windows (recursive fs.watch covers the entire tree).
 */
export function addWatchedPath(workspacePath: string, folderPath: string): void {
  if (supportsRecursiveWatch) return;

  const key = path.resolve(workspacePath);
  const entry = busEntries.get(key);
  if (!entry) return;

  entry.expandedPaths.add(folderPath);
  const watcher = entry.lifecycle.handle;
  if (watcher && 'add' in watcher) {
    watcher.add(folderPath);
  }
}

/**
 * Register a file path to bypass gitignore filtering.
 * Events for this path will be dispatched with `gitignoreBypassed=true`.
 * On Linux (chokidar), also adds the path to the watcher so events fire
 * for files inside already-ignored directories.
 */
export function addGitignoreBypass(workspacePath: string, absolutePath: string, owner = 'legacy'): void {
  const key = path.resolve(workspacePath);
  const entry = busEntries.get(key);
  if (!entry) return;

  // Validate that the path is inside the workspace
  if (!isPathInWorkspace(absolutePath, key)) {
    logger.main.debug('[WorkspaceEventBus] Rejected gitignore bypass for path outside workspace:', {
      workspacePath: key,
      absolutePath,
    });
    return;
  }

  const relativePath = path.relative(key, absolutePath);
  if (relativePath && !relativePath.startsWith('..') && pathContainsExcludedDir(relativePath)) {
    logger.main.debug('[WorkspaceEventBus] Rejected gitignore bypass for excluded path:', {
      workspacePath: key,
      absolutePath,
    });
    return;
  }

  const normalizedPath = normalizeToForwardSlash(absolutePath);
  const owners = entry.bypassOwners.get(normalizedPath) ?? new Set<string>();
  owners.add(owner);
  entry.bypassOwners.set(normalizedPath, owners);
  entry.gitignoreBypassPaths.add(normalizedPath);

  // On Linux, ensure chokidar watches this specific path
  const watcher = entry.lifecycle.handle;
  if (!supportsRecursiveWatch && watcher && 'add' in watcher) {
    watcher.add(absolutePath);
  }

  // Replay any recently dropped events for this path
  replayDroppedEvents(entry, normalizedPath);

  logger.main.debug('[WorkspaceEventBus] Added gitignore bypass:', {
    workspacePath: key,
    absolutePath: normalizedPath,
    bypassCount: entry.gitignoreBypassPaths.size,
  });
}

/**
 * Remove a file path from the gitignore bypass set.
 */
export function removeGitignoreBypass(workspacePath: string, absolutePath: string, owner = 'legacy'): void {
  const key = path.resolve(workspacePath);
  const entry = busEntries.get(key);
  if (!entry) return;

  const normalized = normalizeToForwardSlash(absolutePath);
  const owners = entry.bypassOwners.get(normalized);
  owners?.delete(owner);
  if (!owners?.size) {
    entry.bypassOwners.delete(normalized);
    entry.gitignoreBypassPaths.delete(normalized);
  }
}

/** Check if absolute path is in the bypass set for a workspace. Visible for testing. */
export function hasGitignoreBypass(workspacePath: string, absolutePath: string): boolean {
  const entry = busEntries.get(path.resolve(workspacePath));
  return entry?.gitignoreBypassPaths.has(normalizeToForwardSlash(absolutePath)) ?? false;
}

/**
 * Clear all gitignore bypass paths for a workspace.
 * Called during session cleanup or when bypass state should be reset.
 */
export function clearGitignoreBypasses(workspacePath: string): void {
  const key = path.resolve(workspacePath);
  const entry = busEntries.get(key);
  if (!entry) return;

  const count = entry.gitignoreBypassPaths.size;
  // Session cleanup must not remove a bypass owned by an open editor.
  for (const file of [...entry.gitignoreBypassPaths]) removeGitignoreBypass(key, file);
  entry.replayBuffer = [];

  if (count > 0) {
    logger.main.debug('[WorkspaceEventBus] Cleared all gitignore bypasses:', {
      workspacePath: key,
      clearedCount: count,
    });
  }
}

/**
 * On Linux, forward folder collapse to chokidar.
 * No-op on macOS/Windows.
 */
export function removeWatchedPath(workspacePath: string, folderPath: string): void {
  if (supportsRecursiveWatch) return;

  const key = path.resolve(workspacePath);
  const entry = busEntries.get(key);
  if (!entry) return;

  entry.expandedPaths.delete(folderPath);
  const watcher = entry.lifecycle.handle;
  if (watcher && 'unwatch' in watcher) {
    watcher.unwatch(folderPath);
  }
}

export async function stopAll(): Promise<void> {
  const entries = [...busEntries.values()];
  busEntries.clear();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(entries.map(entry => entry.lifecycle.stop())),
    new Promise<void>(resolve => { timeout = setTimeout(resolve, 1000); }),
  ]);
  if (timeout) clearTimeout(timeout);
}

export function getStats() {
  return {
    type: supportsRecursiveWatch ? 'WorkspaceEventBus (fs.watch recursive)' : 'WorkspaceEventBus (chokidar)',
    activeWorkspaces: [...busEntries.values()].filter(entry => entry.lifecycle.health.state === 'watching').length,
    registeredWorkspaces: busEntries.size,
    workspaces: [...busEntries].map(([workspacePath, entry]) => ({
      workspacePath, subscriberCount: entry.listeners.size, subscriberIds: [...entry.listeners.keys()],
      ...entry.lifecycle.health,
    })),
  };
}

/** Returns true if the relative path should be filtered out. */
/** Returns true if a file has a .md extension. */
function isMarkdownFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.md';
}

/**
 * Determine how a gitignored file should be handled:
 * - 'bypass': dispatch with gitignoreBypassed=true (.md file or in bypass set)
 * - 'drop': filter out (store in replay buffer)
 */
function getGitignoreAction(
  absolutePath: string,
  entry: BusEntry,
): 'bypass' | 'drop' {
  if (entry.gitignoreBypassPaths.has(normalizeToForwardSlash(absolutePath))) return 'bypass';
  if (isMarkdownFile(absolutePath)) return 'bypass';
  return 'drop';
}

/** Add a dropped gitignored event to the replay buffer. */
function addToReplayBuffer(
  entry: BusEntry,
  absolutePath: string,
  eventType: 'change' | 'add' | 'unlink' | 'rename',
): void {
  const now = Date.now();

  // Prune expired entries
  entry.replayBuffer = entry.replayBuffer.filter(
    (e) => now - e.timestamp < REPLAY_BUFFER_TTL_MS,
  );

  // Cap at max size
  if (entry.replayBuffer.length >= REPLAY_BUFFER_MAX) {
    entry.replayBuffer.shift();
  }

  entry.replayBuffer.push({ absolutePath: normalizeToForwardSlash(absolutePath), eventType, timestamp: now });
}

/** Re-dispatch matching events from the replay buffer when a bypass is added. */
function replayDroppedEvents(entry: BusEntry, absolutePath: string): void {
  const now = Date.now();
  const matching: DroppedGitignoreEvent[] = [];
  const remaining: DroppedGitignoreEvent[] = [];

  for (const event of entry.replayBuffer) {
    if (now - event.timestamp >= REPLAY_BUFFER_TTL_MS) continue; // expired
    if (event.absolutePath === absolutePath) {
      matching.push(event);
    } else {
      remaining.push(event);
    }
  }

  entry.replayBuffer = remaining;

  if (matching.length === 0) return;

  const generation = entry.lifecycle.health.generation;
  const current = () => busEntries.get(entry.workspaceAbs) === entry && entry.lifecycle.health.generation === generation;
  // Re-dispatch matching events to all listeners.
  // 'rename' events need an async fs.access check to determine add vs unlink,
  // matching the same logic used in the live startRecursiveWatch path.
  for (const event of matching) {
    switch (event.eventType) {
      case 'change':
        for (const l of entry.listeners.values()) l.onChange(event.absolutePath, true);
        break;
      case 'add':
        for (const l of entry.listeners.values()) l.onAdd(event.absolutePath, true);
        break;
      case 'unlink':
        for (const l of entry.listeners.values()) l.onUnlink(event.absolutePath, true);
        break;
      case 'rename':
        // Determine add vs unlink by checking file existence, same as live path
        pathExistsAfterRename(event.absolutePath).then(exists => {
          if (current()) for (const l of entry.listeners.values()) {
            if (exists) l.onAdd(event.absolutePath, true);
            else l.onUnlink(event.absolutePath, true);
          }
        }).catch(error => logger.main.error('[WorkspaceEventBus] Replay existence check failed:', error));
        break;
    }
  }

  logger.main.debug('[WorkspaceEventBus] Replayed dropped events:', {
    absolutePath,
    count: matching.length,
  });
}

/** Translate native events without allowing callbacks from a retired handle to publish. */
function deliverNativeEvent(
  entry: BusEntry,
  type: 'change' | 'rename' | 'add' | 'unlink',
  filePath: string,
  current: () => boolean,
): void {
  if (!current() || shouldIgnoreHardcoded(path.relative(entry.workspaceAbs, filePath))) return;
  refreshGitignoreFiltersForEvent(filePath, type, entry);
  const bypassed = isGitignoredScoped(filePath, entry.workspaceAbs, entry);
  const dropped = bypassed && getGitignoreAction(filePath, entry) === 'drop';
  if (dropped) {
    addToReplayBuffer(entry, filePath, type);
    if (type === 'change') return;
  }
  const publish = (event: 'change' | 'add' | 'unlink') => {
    if (!current()) return;
    for (const listener of entry.listeners.values()) {
      if (dropped && !listener.receiveGitignoredStructureEvents) continue;
      try {
        if (event === 'change') listener.onChange(filePath, bypassed || undefined);
        else if (event === 'add') listener.onAdd(filePath, bypassed || undefined);
        else listener.onUnlink(filePath, bypassed || undefined);
      } catch (error) { logger.main.error('[WorkspaceEventBus] File listener failed:', error); }
    }
  };
  if (type === 'rename') {
    void pathExistsAfterRename(filePath).then(exists => publish(exists ? 'add' : 'unlink'))
      .catch(error => logger.main.error('[WorkspaceEventBus] Rename check failed:', error));
  } else publish(type);
}
