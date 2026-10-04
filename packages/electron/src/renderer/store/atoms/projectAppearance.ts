import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type { ProjectAppearanceSnapshot, ProjectAppearanceUpdate } from '../../../shared/projectAppearance';

export interface ProjectAppearanceState {
  snapshot?: ProjectAppearanceSnapshot;
  error?: string;
}
export const projectAppearanceAtom = atomFamily((workspacePath: string) => {
  const state = atom<ProjectAppearanceState>({});
  state.onMount = set => {
    let cancelled = false;
    let loaded = false;
    set(current => { loaded = Boolean(current.snapshot); return current; });
    if (workspacePath && !loaded) {
      void (async () => {
        try {
          const snapshot: ProjectAppearanceSnapshot = await window.electronAPI.invoke('project-appearance:get', workspacePath);
          if (!snapshot) throw new Error('Could not load project appearance.');
          if (!cancelled) set(current => !current.snapshot || snapshot.revision >= current.snapshot.revision ? { snapshot } : current);
        } catch (error) {
          if (!cancelled) set(current => current.snapshot ? current : { error: String(error) });
        }
      })();
    }
    return () => { cancelled = true; };
  };
  return state;
});

export const saveProjectAppearanceAtom = atom(null, async (_get, set, workspacePath: string, patch: ProjectAppearanceUpdate) => {
  const snapshot: ProjectAppearanceSnapshot = await window.electronAPI.invoke('project-appearance:update', workspacePath, patch);
  set(projectAppearanceAtom(workspacePath), current =>
    !current.snapshot || snapshot.revision >= current.snapshot.revision ? { snapshot } : current);
});
