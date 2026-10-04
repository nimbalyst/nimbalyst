import { store } from '@nimbalyst/runtime/store';
import type { ProjectAppearanceSnapshot } from '../../../shared/projectAppearance';
import { projectAppearanceAtom } from '../atoms/projectAppearance';

/** One subscription per renderer; only update projects this window is observing. */
export function initProjectAppearanceListener(targetStore = store): () => void {
  return window.electronAPI.on('project-appearance:changed', (event: ProjectAppearanceSnapshot & { workspacePath: string }) => {
    if (!Array.from(projectAppearanceAtom.getParams()).includes(event.workspacePath)) return;
    targetStore.set(projectAppearanceAtom(event.workspacePath), current =>
      !current.snapshot || event.revision >= current.snapshot.revision ? { snapshot: event } : current);
  });
}
