/**
 * Jotai atom-write profiler (development only).
 *
 * Renders are the symptom; a too-coarse atom written hundreds of times a second
 * is usually the cause. Jotai's `storeHooks.c` ("changed") hook accepts a global
 * listener that fires for every atom whose value changes, which gives a ranked
 * "who is driving the commits" list to sit next to the render profiler.
 *
 * This reaches into `jotai/vanilla/internals`. Those `INTERNAL_*Rev2` names have
 * churned across Jotai versions, so every use is guarded: if the shape changes,
 * atom attribution degrades to empty and the render profiler still works. The
 * unit test in `__tests__/atomWriteProfiler.test.ts` is what turns a Jotai
 * upgrade into a red test rather than a silently empty panel.
 */

import { store } from '@nimbalyst/runtime/store';

/** Index of `storeHooks` in Jotai's BuildingBlocks tuple (jotai 2.17). */
const STORE_HOOKS_INDEX = 6;

/** Cap tracked atoms so a family with thousands of params can't grow unbounded. */
const MAX_TRACKED_ATOMS = 2000;

export interface AtomWriteStat {
  name: string;
  writes: number;
  writesPerSec: number;
}

type AnyAtom = { debugLabel?: string; toString(): string };

const writes = new Map<string, number>();
const nameCache = new WeakMap<object, string>();

let detach: (() => void) | null = null;
let startedAt = 0;
let stoppedAt = 0;
let overflowed = false;
let unavailableReason: string | null = null;

function nameOf(atom: AnyAtom): string {
  const cached = nameCache.get(atom as object);
  if (cached !== undefined) return cached;
  // `debugLabel` is set by jotai's babel plugin (wired in dev) and by the
  // atomFamily registry wrapper for per-param atoms. Without it all we have is
  // jotai's own `atom<n>` identifier, which is still enough to spot a hot one.
  const name = atom.debugLabel || String(atom);
  nameCache.set(atom as object, name);
  return name;
}

function record(atom: AnyAtom): void {
  const name = nameOf(atom);
  const current = writes.get(name);
  if (current === undefined && writes.size >= MAX_TRACKED_ATOMS) {
    overflowed = true;
    return;
  }
  writes.set(name, (current ?? 0) + 1);
}

/**
 * Subscribe to every atom change on the shared store.
 * Returns an unsubscribe, or null if Jotai's internals are not the shape we expect.
 */
async function attach(): Promise<(() => void) | null> {
  try {
    const internals: any = await import('jotai/vanilla/internals');
    const getBuildingBlocks = internals.INTERNAL_getBuildingBlocksRev2;
    const initializeStoreHooks = internals.INTERNAL_initializeStoreHooksRev2;
    if (typeof getBuildingBlocks !== 'function' || typeof initializeStoreHooks !== 'function') {
      unavailableReason = 'jotai internals (INTERNAL_*Rev2) not found — Jotai upgrade?';
      return null;
    }

    const blocks = getBuildingBlocks(store);
    const storeHooks = initializeStoreHooks(blocks[STORE_HOOKS_INDEX]);
    const changed = storeHooks?.c;
    if (typeof changed?.add !== 'function') {
      unavailableReason = 'jotai storeHooks.c missing — BuildingBlocks layout changed?';
      return null;
    }

    unavailableReason = null;
    // `add(undefined, cb)` is the global form: fires for every atom.
    return changed.add(undefined, (atom: AnyAtom) => record(atom));
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    return null;
  }
}

export async function start(reset = true): Promise<void> {
  if (reset) {
    writes.clear();
    overflowed = false;
  }
  startedAt = performance.now();
  stoppedAt = 0;
  if (!detach) detach = await attach();
}

export function stop(): void {
  detach?.();
  detach = null;
  stoppedAt = performance.now();
}

export function snapshot(): { atoms: AtomWriteStat[]; totalWrites: number; unavailableReason: string | null; overflowed: boolean } {
  const now = stoppedAt || performance.now();
  const durationMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const perSec = (n: number) => (durationMs > 0 ? Number(((n * 1000) / durationMs).toFixed(2)) : 0);

  let totalWrites = 0;
  const atoms: AtomWriteStat[] = [...writes.entries()]
    .map(([name, count]) => {
      totalWrites += count;
      return { name, writes: count, writesPerSec: perSec(count) };
    })
    .sort((a, b) => b.writes - a.writes);

  return { atoms, totalWrites, unavailableReason, overflowed };
}

export const atomWriteProfiler = { start, stop, snapshot };
