import type { WritableAtom } from 'jotai';
import type { Store } from 'jotai/vanilla/store';

/**
 * Stale-while-revalidate plumbing for atoms a window re-reads on its own.
 *
 * The organization window has no team-sync socket, so it re-fetches the
 * directory and settings whenever it comes forward. Writing the answer straight
 * into the atom repainted the whole sidebar on every focus even when the server
 * said exactly what it said last time: the array, its rows, and the
 * `{ status: 'ready' }` load state were all new objects, so every memo
 * downstream was invalidated. These helpers write only what actually changed.
 */

/**
 * Structural equality over the JSON-shaped values that cross IPC: primitives,
 * arrays, and plain objects. `undefined` properties compare as absent, matching
 * what a round trip through IPC does to them.
 */
export function isStructurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== 'object'
    || typeof right !== 'object'
    || left === null
    || right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length
      && left.every((item, index) => isStructurallyEqual(item, right[index]));
  }
  const leftKeys = definedKeys(left as Record<string, unknown>);
  const rightKeys = definedKeys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(right, key)
    && isStructurallyEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    )
  ));
}

function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/**
 * Write `next` only if it differs from what the atom already holds. An
 * unchanged value keeps its identity, so nothing subscribed to the atom
 * re-renders.
 */
export function setIfChanged<Value>(
  targetStore: Store,
  valueAtom: WritableAtom<Value, [Value], unknown>,
  next: Value,
): void {
  const current = targetStore.get(valueAtom);
  if (isStructurallyEqual(current, next)) return;
  targetStore.set(valueAtom, next);
}

/**
 * Replace each row of `next` with the structurally identical row `current`
 * already holds, and return `current` itself when nothing moved. One renamed
 * room then costs one row's identity instead of the whole list's.
 */
export function reconcileList<Value>(
  current: readonly Value[],
  next: readonly Value[],
): readonly Value[] {
  const reconciled = next.map((item, index) => {
    const sameSlot = current[index];
    if (sameSlot !== undefined && isStructurallyEqual(sameSlot, item)) {
      return sameSlot;
    }
    // Reordered or shifted by an insertion: the row is unchanged, only its
    // position moved, so it keeps its identity.
    const moved = current.find((existing) => isStructurallyEqual(existing, item));
    return moved ?? item;
  });
  const unchanged = reconciled.length === current.length
    && reconciled.every((item, index) => item === current[index]);
  return unchanged ? current : reconciled;
}

/**
 * `setIfChanged` for a list atom, preserving the identity of every row the
 * refresh left alone.
 */
export function setListIfChanged<Value>(
  targetStore: Store,
  listAtom: WritableAtom<Value[], [Value[]], unknown>,
  next: readonly Value[],
): void {
  const current = targetStore.get(listAtom);
  const reconciled = reconcileList(current, next);
  if (reconciled === current) return;
  targetStore.set(listAtom, reconciled as Value[]);
}
