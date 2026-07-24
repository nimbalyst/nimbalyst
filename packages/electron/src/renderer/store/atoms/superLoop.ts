/**
 * Super Loop Atoms
 *
 * Jotai atoms for managing Super Loop state in the renderer.
 * Provides reactive state for UI components to display loop progress and status.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type {
  SuperLoop,
  SuperLoopWithIterations,
  SuperLoopStatus,
  SuperLoopEvent,
  SuperIteration,
  SuperProgressFile,
} from '../../../shared/types/superLoop';

// ========================================
// Registry Atoms
// ========================================

/**
 * Registry of all Super Loops by ID.
 * Populated via IPC when fetching loops for a workspace.
 */
export const superLoopRegistryAtom = atom<Map<string, SuperLoop>>(new Map());

/**
 * Derived: Array of all super loops sorted by creation date (newest first)
 */
export const superLoopListAtom = atom((get) => {
  const registry = get(superLoopRegistryAtom);
  return Array.from(registry.values())
    .sort((a, b) => b.createdAt - a.createdAt);
});

/**
 * Derived: Active (running or paused) super loops
 */
export const activeSuperLoopsAtom = atom((get) => {
  const registry = get(superLoopRegistryAtom);
  return Array.from(registry.values())
    .filter(loop => loop.status === 'running' || loop.status === 'paused');
});

// ========================================
// Per-Loop Atoms (Atom Families)
// ========================================

/**
 * Get a single super loop by ID
 */
export const superLoopAtom = atomFamily((loopId: string) =>
  atom((get) => {
    const registry = get(superLoopRegistryAtom);
    return registry.get(loopId) ?? null;
  })
);

/**
 * Runner state for active loops (from main process)
 */
export interface SuperRunnerState {
  isRunning: boolean;
  isPaused: boolean;
  currentIteration: number;
  maxIterations: number;
  currentSessionId: string | null;
}

export const superRunnerStateAtom = atomFamily((_loopId: string) =>
  atom<SuperRunnerState | null>(null)
);

/**
 * Iterations for a super loop (loaded separately due to potential size)
 */
export const superIterationsAtom = atomFamily((_loopId: string) =>
  atom<SuperLoopWithIterations['iterations']>([])
);

/**
 * Progress file data for a super loop (loaded when loop is completed/failed)
 */
export const superProgressAtom = atomFamily((_loopId: string) =>
  atom<SuperProgressFile | null>(null)
);

// ========================================
// Action Atoms
// ========================================

/**
 * Update the super loop registry with new loops
 */
export const setSuperLoopsAtom = atom(
  null,
  (get, set, loops: SuperLoop[]) => {
    const newRegistry = new Map<string, SuperLoop>();
    for (const loop of loops) {
      newRegistry.set(loop.id, loop);
    }
    set(superLoopRegistryAtom, newRegistry);
  }
);

/**
 * Update or add a single super loop
 */
export const upsertSuperLoopAtom = atom(
  null,
  (get, set, loop: SuperLoop) => {
    const registry = new Map(get(superLoopRegistryAtom));
    registry.set(loop.id, loop);
    set(superLoopRegistryAtom, registry);
  }
);

/**
 * Remove a super loop from the registry
 */
export const removeSuperLoopAtom = atom(
  null,
  (get, set, loopId: string) => {
    const registry = new Map(get(superLoopRegistryAtom));
    registry.delete(loopId);
    set(superLoopRegistryAtom, registry);
  }
);

/**
 * Update runner state for a loop
 */
export const setSuperRunnerStateAtom = atom(
  null,
  (get, set, { loopId, state }: { loopId: string; state: SuperRunnerState | null }) => {
    set(superRunnerStateAtom(loopId), state);
  }
);

/**
 * Update iterations for a loop
 */
export const setSuperIterationsAtom = atom(
  null,
  (get, set, { loopId, iterations }: { loopId: string; iterations: SuperLoopWithIterations['iterations'] }) => {
    set(superIterationsAtom(loopId), iterations);
  }
);

/**
 * Update progress file data for a loop
 */
export const setSuperProgressAtom = atom(
  null,
  (get, set, { loopId, progress }: { loopId: string; progress: SuperProgressFile | null }) => {
    set(superProgressAtom(loopId), progress);
  }
);

// ========================================
// Event Handling
// ========================================

/**
 * Process a super loop event and update state accordingly
 */
export const processSuperEventAtom = atom(
  null,
  (get, set, event: SuperLoopEvent) => {
    // Guard against undefined or malformed events
    if (!event || typeof event !== 'object' || !('type' in event) || !('superLoopId' in event)) {
      console.warn('[processSuperEventAtom] Received invalid event:', event);
      return;
    }

    const registry = new Map(get(superLoopRegistryAtom));

    switch (event.type) {
      case 'iteration-started': {
        const loop = registry.get(event.superLoopId);
        if (loop) {
          registry.set(event.superLoopId, {
            ...loop,
            currentIteration: event.iterationNumber,
            updatedAt: Date.now(),
          });
          set(superLoopRegistryAtom, registry);

          // Update runner state (create default if doesn't exist yet)
          const existingRunnerState = get(superRunnerStateAtom(event.superLoopId));
          const runnerState: SuperRunnerState = existingRunnerState ?? {
            isRunning: true,
            isPaused: false,
            currentIteration: 0,
            maxIterations: loop.maxIterations,
            currentSessionId: null,
          };
          set(superRunnerStateAtom(event.superLoopId), {
            ...runnerState,
            currentIteration: event.iterationNumber,
            currentSessionId: event.sessionId,
          });

          // Add the new iteration to the iterations atom
          const newIteration: SuperIteration = {
            id: event.iterationId,
            superLoopId: event.superLoopId,
            sessionId: event.sessionId,
            iterationNumber: event.iterationNumber,
            status: 'running',
            createdAt: Date.now(),
          };
          const currentIterations = get(superIterationsAtom(event.superLoopId));
          // Only add if not already present (in case of duplicate events)
          if (!currentIterations.some(iter => iter.id === event.iterationId)) {
            set(superIterationsAtom(event.superLoopId), [...currentIterations, newIteration]);
          }
        }
        break;
      }

      case 'iteration-completed': {
        const loop = registry.get(event.superLoopId);
        if (loop) {
          registry.set(event.superLoopId, {
            ...loop,
            updatedAt: Date.now(),
          });
          set(superLoopRegistryAtom, registry);

          // Update the iteration status in the iterations atom
          const currentIterations = get(superIterationsAtom(event.superLoopId));
          const updatedIterations = currentIterations.map(iter =>
            iter.id === event.iterationId
              ? { ...iter, status: 'completed' as const, exitReason: event.exitReason, completedAt: Date.now() }
              : iter
          );
          set(superIterationsAtom(event.superLoopId), updatedIterations);
        }
        break;
      }

      case 'iteration-failed': {
        const loop = registry.get(event.superLoopId);
        if (loop) {
          registry.set(event.superLoopId, {
            ...loop,
            updatedAt: Date.now(),
          });
          set(superLoopRegistryAtom, registry);

          // Update the iteration status in the iterations atom
          const currentIterations = get(superIterationsAtom(event.superLoopId));
          const updatedIterations = currentIterations.map(iter =>
            iter.id === event.iterationId
              ? { ...iter, status: 'failed' as const, exitReason: event.error, completedAt: Date.now() }
              : iter
          );
          set(superIterationsAtom(event.superLoopId), updatedIterations);
        }
        break;
      }

      case 'loop-blocked': {
        const loop = registry.get(event.superLoopId);
        if (loop) {
          registry.set(event.superLoopId, {
            ...loop,
            status: 'blocked',
            completionReason: event.reason,
            updatedAt: Date.now(),
          });
          set(superLoopRegistryAtom, registry);
          set(superRunnerStateAtom(event.superLoopId), null);
        }
        break;
      }

      case 'loop-completed':
      case 'loop-stopped': {
        const loop = registry.get(event.superLoopId);
        if (loop) {
          registry.set(event.superLoopId, {
            ...loop,
            status: 'completed',
            completionReason: event.reason,
            updatedAt: Date.now(),
          });
          set(superLoopRegistryAtom, registry);
          set(superRunnerStateAtom(event.superLoopId), null);
        }
        break;
      }

      case 'loop-failed': {
        const loop = registry.get(event.superLoopId);
        if (loop) {
          registry.set(event.superLoopId, {
            ...loop,
            status: 'failed',
            completionReason: event.error,
            updatedAt: Date.now(),
          });
          set(superLoopRegistryAtom, registry);
          set(superRunnerStateAtom(event.superLoopId), null);
        }
        break;
      }

      case 'loop-paused': {
        const loop = registry.get(event.superLoopId);
        if (loop) {
          registry.set(event.superLoopId, {
            ...loop,
            status: 'paused',
            updatedAt: Date.now(),
          });
          set(superLoopRegistryAtom, registry);

          const runnerState = get(superRunnerStateAtom(event.superLoopId));
          if (runnerState) {
            set(superRunnerStateAtom(event.superLoopId), {
              ...runnerState,
              isPaused: true,
              isRunning: false,
            });
          }
        }
        break;
      }

      case 'loop-resumed': {
        const loop = registry.get(event.superLoopId);
        if (loop) {
          registry.set(event.superLoopId, {
            ...loop,
            status: 'running',
            updatedAt: Date.now(),
          });
          set(superLoopRegistryAtom, registry);

          const runnerState = get(superRunnerStateAtom(event.superLoopId));
          if (runnerState) {
            set(superRunnerStateAtom(event.superLoopId), {
              ...runnerState,
              isPaused: false,
              isRunning: true,
            });
          }
        }
        break;
      }
    }
  }
);

// ========================================
// UI State Atoms
// ========================================

/**
 * Whether the new super loop dialog is open
 */
export const newSuperLoopDialogOpenAtom = atom(false);

/**
 * Currently selected/expanded super loop in UI
 */
export const selectedSuperLoopIdAtom = atom<string | null>(null);

// ========================================
// Helpers
// ========================================

/**
 * Get super loop status display info
 */
export function getSuperStatusInfo(status: SuperLoopStatus): {
  label: string;
  color: 'running' | 'paused' | 'completed' | 'failed' | 'pending' | 'blocked';
} {
  switch (status) {
    case 'running':
      return { label: 'Running', color: 'running' };
    case 'paused':
      return { label: 'Paused', color: 'paused' };
    case 'completed':
      return { label: 'Completed', color: 'completed' };
    case 'failed':
      return { label: 'Failed', color: 'failed' };
    case 'blocked':
      return { label: 'Blocked', color: 'blocked' };
    case 'pending':
    default:
      return { label: 'Pending', color: 'pending' };
  }
}
