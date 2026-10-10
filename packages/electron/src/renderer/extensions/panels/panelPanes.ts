/**
 * Side panes declared by fullscreen extension panels through `host.setPanes`,
 * so the title-bar toggles, Toggle Sidebar, the right-pane toggle, and a
 * gutter re-click reach them the same way they reach a built-in mode.
 *
 * The panel owns the collapsed state; this only relays toggles to it and
 * mirrors what it last reported. A declaration counts only while the panel has
 * a live toggle handler, and is dropped with the last one, so a panel that
 * unmounted never leaves dead buttons in the title bar.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { PanelPanes, PanelPaneSide } from '@nimbalyst/extension-sdk';

type ToggleHandler = (side: PanelPaneSide) => void;

let declared = new Map<string, PanelPanes>();
const handlers = new Map<string, Set<ToggleHandler>>();
const listeners = new Set<() => void>();

function publish(next: Map<string, PanelPanes>): void {
  declared = next;
  for (const listener of listeners) listener();
}

export function setPanelPanes(panelId: string, panes: PanelPanes | null): void {
  if (panes === null) {
    if (!declared.has(panelId)) return;
    const next = new Map(declared);
    next.delete(panelId);
    publish(next);
    return;
  }
  publish(new Map(declared).set(panelId, panes));
}

export function addPanelPaneToggleHandler(panelId: string, handler: ToggleHandler): () => void {
  const set = handlers.get(panelId) ?? new Set<ToggleHandler>();
  set.add(handler);
  handlers.set(panelId, set);
  // The declaration may have arrived first; it becomes live now.
  for (const listener of listeners) listener();
  return () => {
    set.delete(handler);
    if (set.size > 0) return;
    handlers.delete(panelId);
    setPanelPanes(panelId, null);
  };
}

/** The panel's declared panes, or undefined when nothing would handle a toggle. */
export function getPanelPanes(panelId: string): PanelPanes | undefined {
  return handlers.has(panelId) ? declared.get(panelId) : undefined;
}

/** Returns false when the panel did not declare that pane, so the caller can fall back. */
export function togglePanelPane(panelId: string, side: PanelPaneSide): boolean {
  if (!getPanelPanes(panelId)?.[side]) return false;
  for (const handler of handlers.get(panelId) ?? []) {
    try {
      handler(side);
    } catch (error) {
      console.error('[PanelHost] Error in pane toggle handler:', error);
    }
  }
  return true;
}

function subscribePanelPanes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Title-bar pane controls for the active fullscreen panel, in the WindowTopBar shape. */
export function useFullscreenPanelPaneControls(panelId: string | null) {
  const panes = useSyncExternalStore(subscribePanelPanes, () => (panelId ? getPanelPanes(panelId) : undefined));
  return useMemo(() => {
    if (!panelId || !panes) return undefined;
    const control = (side: PanelPaneSide) => {
      const pane = panes[side];
      return pane && { label: pane.label, collapsed: pane.collapsed, onToggle: () => togglePanelPane(panelId, side) };
    };
    return { left: control('left'), right: control('right') };
  }, [panelId, panes]);
}
