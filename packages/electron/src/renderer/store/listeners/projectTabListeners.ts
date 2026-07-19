import {
  CLOSE_ACTIVE_PROJECT_TAB_CHANNEL,
  OPEN_PROJECT_TAB_CHANNEL,
  PROJECT_TAB_MUTATION_CHANNEL,
  type OpenProjectTabRequest,
  type ProjectTabMutation,
} from '../../../shared/projectTabs';
import {
  applyProjectTabMutation,
  closeActiveProjectTab,
  openProjectTab,
} from '../../services/projectTabs';

let initialized = false;

export function initProjectTabListeners(
  openProjectsReady: Promise<void> = Promise.resolve(),
): () => void {
  if (initialized) return () => {};
  initialized = true;
  let disposed = false;
  let mutationQueue = Promise.resolve();
  const processedMutationIds = new Set<string>();

  const cleanups: Array<() => void> = [];
  const queueMutation = (mutation: ProjectTabMutation | undefined) => {
    if (!mutation?.id || (mutation.kind !== 'add' && mutation.kind !== 'remove')) return;
    mutationQueue = mutationQueue.then(async () => {
      await openProjectsReady;
      if (disposed) return;
      if (!processedMutationIds.has(mutation.id)) {
        await applyProjectTabMutation(mutation);
        processedMutationIds.add(mutation.id);
      }
      await window.electronAPI?.invoke?.('workspace:ack-project-tab-mutation', {
        mutationId: mutation.id,
      });
    }).catch((error) => {
      console.error('[ProjectTabs] Failed to process project tab mutation:', error);
    });
  };

  const mutationCleanup = window.electronAPI?.on?.(
    PROJECT_TAB_MUTATION_CHANNEL,
    (mutation: ProjectTabMutation) => queueMutation(mutation),
  );
  if (typeof mutationCleanup === 'function') cleanups.push(mutationCleanup);

  const openWhenReady = (workspacePath: string | undefined) => {
    if (!workspacePath) return;
    void openProjectsReady.then(async () => {
      if (disposed) return;
      const result = await openProjectTab(workspacePath);
      if (!result.success) {
        console.error('[ProjectTabs] Failed to open project tab:', result.error);
        return;
      }
      await window.electronAPI?.invoke?.('workspace:ack-project-tab-open', { workspacePath });
    }).catch((error) => {
      console.error('[ProjectTabs] Failed to process project tab request:', error);
    });
  };

  const openCleanup = window.electronAPI?.on?.(
    OPEN_PROJECT_TAB_CHANNEL,
    (request: OpenProjectTabRequest) => {
      openWhenReady(request?.workspacePath);
    },
  );
  if (typeof openCleanup === 'function') cleanups.push(openCleanup);

  const closeCleanup = window.electronAPI?.on?.(CLOSE_ACTIVE_PROJECT_TAB_CHANNEL, () => {
    void openProjectsReady
      .then(() => closeActiveProjectTab())
      .then((result) => {
        if (!result.success && result.error !== 'cancelled') {
          console.error('[ProjectTabs] Failed to close active project tab:', result.error);
        }
      })
      .catch((error) => {
        console.error('[ProjectTabs] Failed to process close request:', error);
      });
  });
  if (typeof closeCleanup === 'function') cleanups.push(closeCleanup);

  // Pull any request queued while this renderer was loading or reloading.
  // The live listener is installed first, so an open racing this call is
  // harmless: openProjectTab is idempotent and merely activates the tab.
  void openProjectsReady.then(async () => {
    if (disposed) return;
    try {
      const pending = await window.electronAPI?.invoke?.('workspace:consume-pending-project-tabs');
      if (!Array.isArray(pending)) return;
      for (const workspacePath of pending) {
        if (typeof workspacePath === 'string') openWhenReady(workspacePath);
      }
    } catch (error) {
      console.error('[ProjectTabs] Failed to consume pending project tabs:', error);
    }
  });

  // Cross-window moves are committed in main before renderer delivery. Pull
  // queued mutations after installing the live listener so reloads and event
  // races converge on the same tab state.
  void openProjectsReady.then(async () => {
    if (disposed) return;
    try {
      const pending = await window.electronAPI?.invoke?.(
        'workspace:consume-pending-project-tab-mutations',
      );
      if (!Array.isArray(pending)) return;
      pending.forEach((mutation) => queueMutation(mutation as ProjectTabMutation));
    } catch (error) {
      console.error('[ProjectTabs] Failed to consume project tab mutations:', error);
    }
  });

  return () => {
    disposed = true;
    cleanups.forEach((cleanup) => cleanup());
    initialized = false;
  };
}
