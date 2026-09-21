import type { WorkspaceEventListener } from './WorkspaceEventBus';
import type { NativeFileEvent } from './NativeFileEventQueue';
import { pathExistsAfterRename } from './pathExistsAfterRename';
import { logger } from '../utils/logger';

const renameWork = new Map<string, Set<Promise<unknown>>>();
export async function drainRenameEvents(workspace: string): Promise<void> {
  await Promise.all(renameWork.get(workspace) ?? []);
}

/** Keep native observation time while resolving rename events asynchronously. */
export function deliverObservedFileEvent(
  workspace: string,
  listeners: Map<string, WorkspaceEventListener>,
  type: NativeFileEvent,
  filePath: string,
  current: () => boolean,
  observedAt: number,
  bypassed: boolean,
  dropped: boolean,
): void {
  const publish = (event: 'change' | 'add' | 'unlink') => {
    if (!current()) return;
    for (const listener of listeners.values()) {
      if (dropped && !listener.receiveGitignoredStructureEvents) continue;
      try {
        listener.onObserved?.(event, filePath, observedAt);
        if (event === 'change') listener.onChange(filePath, bypassed || undefined);
        else if (event === 'add') listener.onAdd(filePath, bypassed || undefined);
        else listener.onUnlink(filePath, bypassed || undefined);
      } catch (error) { logger.main.error('[WorkspaceEventBus] File listener failed:', error); }
    }
  };
  if (type !== 'rename') { publish(type); return; }
  const work = pathExistsAfterRename(filePath).then(exists => publish(exists ? 'add' : 'unlink'))
    .catch(error => logger.main.error('[WorkspaceEventBus] Rename check failed:', error));
  const pending = renameWork.get(workspace) ?? new Set<Promise<unknown>>();
  renameWork.set(workspace, pending);
  pending.add(work);
  void work.finally(() => {
    pending.delete(work);
    if (!pending.size && renameWork.get(workspace) === pending) renameWork.delete(workspace);
  });
}
