export const MAX_OPEN_PROJECT_TABS = 8;

export const OPEN_PROJECT_TAB_CHANNEL = 'workspace:open-project-tab';
export const CLOSE_ACTIVE_PROJECT_TAB_CHANNEL = 'workspace:close-active-project-tab';
export const PROJECT_TAB_MUTATION_CHANNEL = 'workspace:project-tab-mutation';

/** Custom drag type so project tabs cannot be confused with file/text drags. */
export const PROJECT_TAB_DRAG_MIME = 'application/x-nimbalyst-project-tab+json';

export interface ProjectTabDragPayload {
  version: 1;
  dragId: string;
}

/** Sent only over trusted renderer-to-main IPC; never exposed to external drop targets. */
export interface ProjectTabDragRegistration extends ProjectTabDragPayload {
  workspacePath: string;
}

export type ProjectTabMutation =
  | {
      id: string;
      kind: 'add';
      workspacePath: string;
      activate: true;
    }
  | {
      id: string;
      kind: 'remove';
      workspacePath: string;
      replacementWorkspacePath: string | null;
      closeWindowWhenEmpty: boolean;
    };

export interface OpenProjectTabRequest {
  workspacePath: string;
}
