/**
 * Whether the Page info panel is open, and how wide. One choice per window,
 * kept in the project's workspace state so it survives a restart; every
 * markdown tab in the window follows it.
 */

import { atom, useAtomValue } from 'jotai';
import { useCallback, useEffect } from 'react';
import { store } from '../../store';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';

export const pageInfoPanelOpenAtom = atom(false);

export const PAGE_INFO_PANEL_MIN_WIDTH = 240;
export const PAGE_INFO_PANEL_MAX_WIDTH = 640;
const PAGE_INFO_PANEL_DEFAULT_WIDTH = 320;
export const pageInfoPanelWidthAtom = atom(PAGE_INFO_PANEL_DEFAULT_WIDTH);

export function clampPageInfoPanelWidth(width: number): number {
  return Math.round(Math.min(PAGE_INFO_PANEL_MAX_WIDTH, Math.max(PAGE_INFO_PANEL_MIN_WIDTH, width)));
}

let loadedWorkspace: string | null = null;
let changedBeforeLoad = false;

async function loadPageInfoPanelOpen(workspacePath: string): Promise<void> {
  try {
    const state = await window.electronAPI.invoke('workspace:get-state', workspacePath);
    // A toggle made while the state was being read wins over the saved value.
    if (!changedBeforeLoad) store.set(pageInfoPanelOpenAtom, state?.pageInfoPanelOpen === true);
    if (typeof state?.pageInfoPanelWidth === 'number') {
      store.set(pageInfoPanelWidthAtom, clampPageInfoPanelWidth(state.pageInfoPanelWidth));
    }
  } catch (error) {
    console.error('[PageInfo] Failed to read whether the panel was open:', error);
  }
}

function savePageInfoPanelState(update: { pageInfoPanelOpen?: boolean; pageInfoPanelWidth?: number }): void {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (!workspacePath) return;
  window.electronAPI.invoke('workspace:update-state', workspacePath, update).catch((error: unknown) => {
    console.error('[PageInfo] Failed to save the panel state:', error);
  });
}

export function setPageInfoPanelOpen(open: boolean): void {
  changedBeforeLoad = true;
  store.set(pageInfoPanelOpenAtom, open);
  savePageInfoPanelState({ pageInfoPanelOpen: open });
}

/** Sets and saves the width; call once when a resize drag ends. */
export function setPageInfoPanelWidth(width: number): void {
  const clamped = clampPageInfoPanelWidth(width);
  store.set(pageInfoPanelWidthAtom, clamped);
  savePageInfoPanelState({ pageInfoPanelWidth: clamped });
}

export function usePageInfoPanelOpen(): [boolean, (open: boolean) => void] {
  const open = useAtomValue(pageInfoPanelOpenAtom);
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  useEffect(() => {
    if (!workspacePath || loadedWorkspace === workspacePath) return;
    loadedWorkspace = workspacePath;
    changedBeforeLoad = false;
    void loadPageInfoPanelOpen(workspacePath);
  }, [workspacePath]);
  return [open, useCallback((next: boolean) => setPageInfoPanelOpen(next), [])];
}
