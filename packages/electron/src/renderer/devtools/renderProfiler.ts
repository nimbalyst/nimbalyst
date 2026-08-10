/**
 * React render profiler (development only).
 *
 * Answers "what is re-rendering right now, how often, and why" without React
 * DevTools. React's development build calls
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(id, root)` on every commit;
 * we install a minimal shim for that hook and read the committed fiber tree.
 *
 * IMPORTANT — import order. The shim must exist before `react-dom` initializes,
 * because react-dom captures the hook once at module scope. Import this module
 * *first* in every renderer entry point, and first in any test that profiles.
 * `start()` throws if react-dom loaded without seeing the shim, so a bad import
 * order fails loudly instead of silently reporting zero renders.
 *
 * Cost. Counting commits is O(1) and always on in dev. The per-component tree
 * walk only runs while recording, which is off until someone calls `start()`.
 *
 * Consumers:
 *   - live/agent: `window.__renderProfiler` (see `dev:render-profiler` IPC)
 *   - tests: `renderBudget.ts`, which wraps this in a per-test harness
 */

// React work tags for the fiber kinds that correspond to a component the
// programmer wrote. Verified against react-dom 19.2.7's
// `getComponentNameFromFiber`.
const TAG_FUNCTION = 0;
const TAG_CLASS = 1;
const TAG_FORWARD_REF = 11;
const TAG_MEMO = 14;
const TAG_SIMPLE_MEMO = 15;
const COMPONENT_TAGS = new Set([TAG_FUNCTION, TAG_CLASS, TAG_FORWARD_REF, TAG_MEMO, TAG_SIMPLE_MEMO]);

/** `PerformedWork` — React sets this bit on a fiber whose render function actually ran. */
const PERFORMED_WORK = 0b1;

/** Guard against a pathological or cyclic tree wedging the walk. */
const MAX_NODES_PER_COMMIT = 100_000;

/** Per component, stop paying for the "why" analysis after this many renders in a window. */
const REASON_SAMPLE_LIMIT = 250;

/** Hooks are a linked list; bound the walk so a huge component can't dominate. */
const MAX_HOOKS_SCANNED = 64;

/** Depth for the structural comparison that distinguishes "changed" from "same value, new reference". */
const STRUCTURAL_COMPARE_DEPTH = 2;

export interface ComponentRenderStat {
  name: string;
  /** Times this component's render function ran. */
  renders: number;
  /** Distinct commits it appeared in — renders >> commits means many instances. */
  commits: number;
  /** First-time renders (a mount is legitimate work; an update may not be). */
  mounts: number;
  updates: number;
  /** Reason label -> how many times it was the diagnosis. Sampled; see REASON_SAMPLE_LIMIT. */
  reasons: Record<string, number>;
  rendersPerSec: number;
}

export interface RenderProfilerSnapshot {
  recording: boolean;
  durationMs: number;
  commits: number;
  commitsPerSec: number;
  totalRenders: number;
  rendersPerSec: number;
  components: ComponentRenderStat[];
  /** Per-second buckets since `start()`, for charting a storm's shape. */
  timeline: { second: number; commits: number; renders: number }[];
  /** How much wall-clock the profiler itself spent walking trees. */
  overheadMs: number;
  /**
   * A hidden or unfocused window is throttled by Chromium, so a quiet reading
   * here may just mean you profiled the wrong window.
   */
  window: { visibilityState: string; hasFocus: boolean; url: string };
  truncated: boolean;
}

export interface RenderProfilerStartOptions {
  /** Clear previous counters. Default true. */
  reset?: boolean;
}

interface MutableStat {
  name: string;
  renders: number;
  commits: number;
  mounts: number;
  updates: number;
  reasons: Map<string, number>;
  lastCommitId: number;
  reasonSamples: number;
}

type Fiber = any;

const stats = new Map<string, MutableStat>();
const timeline = new Map<number, { commits: number; renders: number }>();
const nameCache = new WeakMap<object, string>();

let hookInstalled = false;
let reactInjected = false;
let recording = false;
let startedAt = 0;
let stoppedAt = 0;
let commitCount = 0;
let commitId = 0;
let renderCount = 0;
let overheadMs = 0;
let truncated = false;

// Commits are counted even when not recording: it is one increment, and it lets
// the dashboard show a commit rate without anyone having armed the profiler.
let lifetimeCommits = 0;

function isDevBuild(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// ---------------------------------------------------------------------------
// Component naming
// ---------------------------------------------------------------------------

function functionName(type: any): string {
  if (!type) return '';
  return type.displayName || type.name || '';
}

function ownName(fiber: Fiber): string {
  const type = fiber.type;
  if (!type) return '';
  switch (fiber.tag) {
    case TAG_FORWARD_REF:
      return type.displayName || (functionName(type.render) ? `ForwardRef(${functionName(type.render)})` : '');
    case TAG_MEMO:
      return type.displayName || (functionName(type.type) ? `Memo(${functionName(type.type)})` : '');
    default:
      return functionName(type);
  }
}

function kindOf(fiber: Fiber): string {
  switch (fiber.tag) {
    case TAG_FORWARD_REF: return 'ForwardRef';
    case TAG_MEMO:
    case TAG_SIMPLE_MEMO: return 'Memo';
    case TAG_CLASS: return 'Class';
    default: return 'Anonymous';
  }
}

/**
 * `memo((props) => …)` and `forwardRef((props, ref) => …)` — both common here —
 * wrap an anonymous arrow, so React has no name for them and a bare "Anonymous"
 * row would be useless. Fall back to kind plus the nearest named ancestor,
 * which is enough to find it in the tree: "Memo <- SessionHistory".
 */
function contextualName(fiber: Fiber): string {
  const kind = kindOf(fiber);
  let ancestor = fiber.return;
  let hops = 0;
  while (ancestor && hops < 12) {
    if (COMPONENT_TAGS.has(ancestor.tag)) {
      const name = ownName(ancestor);
      if (name) return `${kind} <- ${name}`;
    }
    ancestor = ancestor.return;
    hops += 1;
  }
  return kind;
}

function resolveName(fiber: Fiber): string {
  const type = fiber.type;
  if (!type) return '';

  const cacheKey = typeof type === 'object' || typeof type === 'function' ? type : null;
  if (cacheKey) {
    const cached = nameCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const name = ownName(fiber) || contextualName(fiber);

  if (cacheKey) nameCache.set(cacheKey, name);
  return name;
}

// ---------------------------------------------------------------------------
// "Why did this render" analysis
// ---------------------------------------------------------------------------

/**
 * Structural equality, depth-limited. Its only job is to separate "this prop
 * genuinely changed" from "the parent handed down a fresh reference holding the
 * same thing" — the inline `{...}` / `[...]` / `() => {}` that causes most of
 * these storms.
 */
function structurallyEqual(a: unknown, b: unknown, depth = STRUCTURAL_COMPARE_DEPTH): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;

  // Two distinct closures with identical source are an inline lambda recreated
  // per render. Not proof, but the right diagnosis nearly every time.
  if (typeof a === 'function' && typeof b === 'function') {
    return String(a) === String(b);
  }

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (depth <= 0) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => structurallyEqual(item, b[i], depth - 1));
  }

  // React elements compare by type/key only; recursing into them is expensive
  // and a fresh element every render is expected, not a finding.
  if ((a as any).$$typeof) return (a as any).type === (b as any).type && (a as any).key === (b as any).key;

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => structurallyEqual((a as any)[k], (b as any)[k], depth - 1));
}

function hookStateChanged(prev: Fiber, next: Fiber): boolean {
  if (next.tag === TAG_CLASS) return prev.memoizedState !== next.memoizedState;

  let a = prev.memoizedState;
  let b = next.memoizedState;
  let scanned = 0;
  while (a && b && scanned < MAX_HOOKS_SCANNED) {
    if (a.memoizedState !== b.memoizedState) return true;
    a = a.next;
    b = b.next;
    scanned += 1;
  }
  // A differing hook-list length is itself a change.
  return Boolean(a) !== Boolean(b);
}

function diagnose(prev: Fiber, next: Fiber): string {
  const before = prev.memoizedProps;
  const after = next.memoizedProps;

  if (before && after && before !== after && typeof before === 'object' && typeof after === 'object') {
    const unstable: string[] = [];
    const changed: string[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const a = (before as any)[key];
      const b = (after as any)[key];
      if (Object.is(a, b)) continue;
      if (structurallyEqual(a, b)) unstable.push(key);
      else changed.push(key);
    }
    // Report the unstable ones first: they are the actionable finding.
    if (unstable.length) return `unstable prop identity: ${unstable.slice(0, 3).join(', ')}`;
    if (changed.length) return `props changed: ${changed.slice(0, 3).join(', ')}`;
  }

  if (hookStateChanged(prev, next)) return 'hook or state changed';
  if (before === after) return 'parent rendered (props identical)';
  return 'context or parent';
}

// ---------------------------------------------------------------------------
// Commit traversal
// ---------------------------------------------------------------------------

function statFor(name: string): MutableStat {
  let stat = stats.get(name);
  if (!stat) {
    stat = { name, renders: 0, commits: 0, mounts: 0, updates: 0, reasons: new Map(), lastCommitId: -1, reasonSamples: 0 };
    stats.set(name, stat);
  }
  return stat;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function visit(fiber: Fiber): void {
  if (!COMPONENT_TAGS.has(fiber.tag)) return;
  if ((fiber.flags & PERFORMED_WORK) === 0) return;

  const name = resolveName(fiber);
  if (!name) return;

  const stat = statFor(name);
  stat.renders += 1;
  renderCount += 1;
  if (stat.lastCommitId !== commitId) {
    stat.commits += 1;
    stat.lastCommitId = commitId;
  }

  const alternate = fiber.alternate;
  if (!alternate) {
    stat.mounts += 1;
    bump(stat.reasons, 'mount');
    return;
  }

  stat.updates += 1;
  if (stat.reasonSamples < REASON_SAMPLE_LIMIT) {
    stat.reasonSamples += 1;
    bump(stat.reasons, diagnose(alternate, fiber));
  }
}

function walk(rootFiber: Fiber): void {
  let node: Fiber | null = rootFiber;
  let visited = 0;

  while (node) {
    visited += 1;
    if (visited > MAX_NODES_PER_COMMIT) {
      truncated = true;
      return;
    }

    visit(node);

    if (node.child) {
      node = node.child;
      continue;
    }
    while (node && node !== rootFiber && !node.sibling) {
      node = node.return;
    }
    if (!node || node === rootFiber) return;
    node = node.sibling;
  }
}

function onCommit(root: Fiber): void {
  lifetimeCommits += 1;
  if (!recording) return;

  const began = performance.now();
  commitCount += 1;
  commitId += 1;

  const rendersBefore = renderCount;
  try {
    if (root?.current) walk(root.current);
  } catch {
    // A React internals change must not take the app down. The snapshot's
    // zeroed counters plus the profiler's own unit test are how we notice.
  }

  const second = Math.floor((began - startedAt) / 1000);
  const bucket = timeline.get(second) ?? { commits: 0, renders: 0 };
  bucket.commits += 1;
  bucket.renders += renderCount - rendersBefore;
  timeline.set(second, bucket);

  overheadMs += performance.now() - began;
}

// ---------------------------------------------------------------------------
// DevTools hook shim
// ---------------------------------------------------------------------------

function installHook(): void {
  if (hookInstalled || typeof globalThis === 'undefined') return;
  hookInstalled = true;

  const existing = (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;

  if (existing) {
    // Real React DevTools is present. Chain rather than replace so both work.
    const previous = existing.onCommitFiberRoot?.bind(existing);
    existing.onCommitFiberRoot = (id: number, root: Fiber, priority: unknown, didError: unknown) => {
      onCommit(root);
      previous?.(id, root, priority, didError);
    };
    reactInjected = true;
    return;
  }

  let nextRendererId = 1;
  (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map<number, unknown>(),
    inject(renderer: unknown) {
      reactInjected = true;
      const id = nextRendererId++;
      (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(_id: number, root: Fiber) {
      onCommit(root);
    },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onScheduleFiberRoot() {},
    setStrictMode() {},
    registerInternalModuleStart() {},
    registerInternalModuleStop() {},
    // React calls this to verify dead-code elimination ran; it must not throw.
    checkDCE() {},
  };
}

if (isDevBuild()) installHook();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function clear(): void {
  stats.clear();
  timeline.clear();
  commitCount = 0;
  renderCount = 0;
  overheadMs = 0;
  truncated = false;
}

export function start(options: RenderProfilerStartOptions = {}): void {
  if (!isDevBuild()) throw new Error('renderProfiler is development-only');
  if (!reactInjected) {
    throw new Error(
      'renderProfiler: React never saw the DevTools hook. Import renderProfiler before react-dom ' +
        '(first import in the entry point / test file).',
    );
  }
  if (options.reset !== false) clear();
  startedAt = performance.now();
  stoppedAt = 0;
  recording = true;
}

export function stop(): RenderProfilerSnapshot {
  const result = snapshot();
  recording = false;
  stoppedAt = performance.now();
  return result;
}

export function reset(): void {
  clear();
  startedAt = performance.now();
}

export function snapshot(): RenderProfilerSnapshot {
  const now = recording ? performance.now() : stoppedAt || performance.now();
  const durationMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const perSec = (n: number) => (durationMs > 0 ? Number(((n * 1000) / durationMs).toFixed(2)) : 0);

  const components: ComponentRenderStat[] = [...stats.values()]
    .map(stat => ({
      name: stat.name,
      renders: stat.renders,
      commits: stat.commits,
      mounts: stat.mounts,
      updates: stat.updates,
      reasons: Object.fromEntries([...stat.reasons.entries()].sort((a, b) => b[1] - a[1])),
      rendersPerSec: perSec(stat.renders),
    }))
    .sort((a, b) => b.renders - a.renders);

  return {
    recording,
    durationMs: Math.round(durationMs),
    commits: commitCount,
    commitsPerSec: perSec(commitCount),
    totalRenders: renderCount,
    rendersPerSec: perSec(renderCount),
    components,
    timeline: [...timeline.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([second, v]) => ({ second, ...v })),
    overheadMs: Number(overheadMs.toFixed(2)),
    window: {
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
      hasFocus: typeof document !== 'undefined' ? document.hasFocus() : false,
      url: typeof location !== 'undefined' ? location.href : '',
    },
    truncated,
  };
}

/**
 * Renders recorded for one component since `start()`. The primary assertion in
 * budget tests.
 *
 * Tolerates a trailing bundler suffix: esbuild renames the inner function of
 * `const Foo = memo(function Foo() {…})` to `Foo2` to avoid shadowing the
 * const, so the profiler sees `Foo2` while every caller reasonably asks for
 * `Foo`. Matching `Foo\d*` keeps that build detail out of every test.
 */
export function rendersOf(componentName: string): number {
  const exact = stats.get(componentName);
  if (exact) return exact.renders;

  let total = 0;
  const suffixed = new RegExp(`^${componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`);
  for (const [name, stat] of stats) {
    if (suffixed.test(name)) total += stat.renders;
  }
  return total;
}

/** Commits observed since the module loaded, recording or not. Cheap health signal. */
export function lifetimeCommitCount(): number {
  return lifetimeCommits;
}

export function isRecording(): boolean {
  return recording;
}

export const renderProfiler = {
  start,
  stop,
  reset,
  snapshot,
  rendersOf,
  isRecording,
  lifetimeCommitCount,
};
