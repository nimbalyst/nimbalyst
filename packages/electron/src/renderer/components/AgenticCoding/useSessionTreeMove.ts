import { useCallback, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { atom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import { reparentSessionAtom } from '../../store';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { sessionMoveError } from './sessionTreeModel';

const MIME = 'application/x-nimbalyst-session';
// Drag payloads are protected during dragover; keep the local identity for validation.
let dragging: { sessionId: string; workspacePath: string } | null = null;
let undoGeneration = 0;

/** Moves made outside this hook (bulk, new workstream) make any open Undo toast stale. */
export function invalidateSessionMoveUndo() {
  ++undoGeneration;
}

export function useSessionTreeMove(id: string, workspacePath?: string) {
  const store = useStore();
  const sessionType = useAtomValue(
    useMemo(() => atom((get) => get(sessionRegistryAtom).get(id)?.sessionType), [id])
  );
  const inWorktree = useAtomValue(
    useMemo(() => atom((get) => !!get(sessionRegistryAtom).get(id)?.worktreeId), [id])
  );
  const reparent = useSetAtom(reparentSessionAtom);
  const [isDragging, setDragging] = useState(false);
  const [hint, setHint] = useState<{ valid: boolean; label: string; between: boolean } | null>(null);
  const isDraggable = !!workspacePath && sessionType !== 'workstream' && sessionType !== 'blitz';
  // Workstreams never live in a worktree, so a worktree session cannot join one.
  const canJoinWorkstream = isDraggable && !inWorktree;

  const move = useCallback(
    async (sourceId: string, newParentId: string | null, undo = false, restoreManagerId?: string | null) => {
      if (!workspacePath) return false;
      const currentRegistry = store.get(sessionRegistryAtom);
      const source = currentRegistry.get(sourceId);
      const error = sessionMoveError(currentRegistry, sourceId, newParentId);
      if (error) {
        errorNotificationService.showError('Cannot move session', error);
        return false;
      }
      const oldParentId = source?.parentSessionId ?? null;
      if (oldParentId === newParentId) return false;
      let previous = { parentId: oldParentId, managerId: source?.createdBySessionId ?? null };
      const success = await reparent({
        sessionId: sourceId,
        oldParentId,
        newParentId,
        workspacePath,
        restoreManagerId,
        onMoved: (result) => {
          previous = result;
        },
      });
      if (!success) {
        errorNotificationService.showError(
          'Cannot move session',
          'The move was rejected. Refresh the list and try again.'
        );
        return false;
      }
      const generation = ++undoGeneration;
      if (!undo)
        errorNotificationService.showInfo(
          'Session moved',
          newParentId
            ? `Moved ${currentRegistry.get(newParentId)?.sessionType === 'workstream' ? 'into' : 'under'} ${currentRegistry.get(newParentId)?.title || 'session'}`
            : 'Moved to top level',
          {
            duration: 8000,
            action: {
              label: 'Undo',
              onClick: () => {
                if (generation === undoGeneration)
                  void move(sourceId, previous.parentId, true, previous.managerId);
              },
            },
          }
        );
      return true;
    },
    [store, workspacePath, reparent]
  );

  /**
   * Move several sessions under one parent with a single summary toast. Rows the
   * guard rejects (a container, a descendant of the target) are skipped and counted.
   */
  const moveMany = useCallback(
    async (sourceIds: readonly string[], newParentId: string | null) => {
      if (sourceIds.length === 1) return move(sourceIds[0], newParentId);
      if (!workspacePath) return false;
      // No bulk undo; any older single-move Undo would now restore a stale placement.
      invalidateSessionMoveUndo();
      let moved = 0;
      let skipped = 0;
      for (const sourceId of sourceIds) {
        const registry = store.get(sessionRegistryAtom);
        const oldParentId = registry.get(sourceId)?.parentSessionId ?? null;
        if (oldParentId === newParentId) continue;
        if (sessionMoveError(registry, sourceId, newParentId)) {
          skipped++;
          continue;
        }
        if (await reparent({ sessionId: sourceId, oldParentId, newParentId, workspacePath })) moved++;
        else skipped++;
      }
      const title = newParentId ? store.get(sessionRegistryAtom).get(newParentId)?.title || 'workstream' : 'top level';
      if (moved)
        errorNotificationService.showInfo(
          'Sessions moved',
          `Moved ${moved} session${moved === 1 ? '' : 's'} to ${title}${skipped ? `; ${skipped} could not move` : ''}`,
          { duration: 8000 }
        );
      else if (skipped) errorNotificationService.showError('Cannot move sessions', 'None of the selected sessions can move there.');
      return moved > 0;
    },
    [move, store, workspacePath, reparent]
  );

  const target = (e: DragEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const between = e.clientY < rect.top + 5 || e.clientY > rect.bottom - 5;
    return {
      between,
      parentId: between ? store.get(sessionRegistryAtom).get(id)?.parentSessionId ?? null : id,
    };
  };
  return {
    move,
    moveMany,
    isDragging,
    isDraggable,
    canJoinWorkstream,
    hint,
    onDragStart(e: DragEvent) {
      if (!isDraggable || !workspacePath) {
        e.preventDefault();
        return;
      }
      e.stopPropagation();
      dragging = { sessionId: id, workspacePath };
      e.dataTransfer.setData(MIME, JSON.stringify(dragging));
      e.dataTransfer.effectAllowed = 'move';
      setDragging(true);
    },
    onDragEnd() {
      dragging = null;
      setDragging(false);
      setHint(null);
    },
    onDragOver(e: DragEvent) {
      if (!e.dataTransfer.types.includes(MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      const { between, parentId } = target(e);
      const registry = store.get(sessionRegistryAtom);
      const error =
        !dragging || dragging.workspacePath !== workspacePath
          ? 'Sessions must stay in the same workspace'
          : sessionMoveError(registry, dragging.sessionId, parentId);
      e.dataTransfer.dropEffect = error ? 'none' : 'move';
      setHint({
        valid: !error,
        between,
        label: error || (parentId ? `${registry.get(parentId)?.sessionType === 'workstream' ? 'into' : 'under'} ${registry.get(parentId)?.title || 'session'}` : 'at top level'),
      });
    },
    onDragLeave(e: DragEvent) {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setHint(null);
    },
    async onDrop(e: DragEvent) {
      if (!e.dataTransfer.types.includes(MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      setHint(null);
      try {
        const data = JSON.parse(e.dataTransfer.getData(MIME));
        if (data.workspacePath === workspacePath && typeof data.sessionId === 'string')
          await move(data.sessionId, target(e).parentId);
      } catch (error) {
        errorNotificationService.showError('Cannot move session', String(error));
      }
      dragging = null;
    },
  };
}
