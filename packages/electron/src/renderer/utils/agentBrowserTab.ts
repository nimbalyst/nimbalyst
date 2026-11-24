/**
 * Renderer-side helpers for agent-opened browser tabs (`virtual://com.nimbalyst.browser/<tabId>?...&agent=1`).
 *
 * Mirrors the two-path imperative open pattern used by tracker and feedback
 * request tabs:
 *  - Mounted workstream: dispatch a cancelable event so WorkstreamEditorTabs
 *    adds/focuses the tab directly inside its authoritative TabsContext.
 *  - Unmounted workstream (e.g. user is looking at another session or in Files
 *    mode): seed the tab into `workstreamStateAtom(workstreamId).openResources`
 *    (and reveal the editor pane only when `foreground` is true), without
 *    switching the user's current window mode or selected session.
 */

import { store } from '@nimbalyst/runtime/store';
import { revealWorkstreamEditorAtom } from '../store/atoms/agentFileViewer';
import { fileResource, workstreamStateAtom } from '../store/atoms/workstreamState';

export const VIRTUAL_BROWSER_PREFIX = 'virtual://com.nimbalyst.browser/';

/** Dispatched at an already-mounted WorkstreamEditorTabs strip. */
export const AGENT_BROWSER_OPEN_EVENT = 'nimbalyst:workstream-open-browser';

export interface AgentBrowserTabInfo {
  tabId: string;
  baseUri: string;
  agentSessionId: string | null;
  foreground: boolean;
}

export interface AgentBrowserOpenEventDetail {
  workstreamId: string;
  filePath: string;
  foreground: boolean;
}

/** Extract the query-free `virtual://com.nimbalyst.browser/<tabId>` identity, or null. */
export function virtualBrowserTabBaseUri(filePath: string): string | null {
  if (!filePath.startsWith(VIRTUAL_BROWSER_PREFIX)) return null;
  const q = filePath.indexOf('?');
  const base = q >= 0 ? filePath.slice(0, q) : filePath;
  return base.length > VIRTUAL_BROWSER_PREFIX.length ? base : null;
}

/** True when two paths point to the same virtual browser tab (ignoring query params like foreground=1). */
export function isSameVirtualBrowserTab(a: string, b: string): boolean {
  const baseA = virtualBrowserTabBaseUri(a);
  if (!baseA) return false;
  return baseA === virtualBrowserTabBaseUri(b);
}

/** Parse an agent-opened virtual browser tab URI, or return null for non-agent/non-browser paths. */
export function parseAgentBrowserTabPath(filePath: string): AgentBrowserTabInfo | null {
  const baseUri = virtualBrowserTabBaseUri(filePath);
  if (!baseUri) return null;
  const q = filePath.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(filePath.slice(q + 1));
  if (params.get('agent') !== '1') return null;
  const tabId = baseUri.slice(VIRTUAL_BROWSER_PREFIX.length);
  const agentSessionId = params.get('session')?.trim() || null;
  const foreground = params.get('foreground') === '1';
  return { tabId, baseUri, agentSessionId, foreground };
}

/**
 * Route an agent-opened browser tab to its owning workstream without changing
 * the user's active mode or selected session.
 */
export function openAgentBrowserTabInWorkstream(
  detail: AgentBrowserOpenEventDetail,
): void {
  const { workstreamId, filePath, foreground } = detail;
  const event = new CustomEvent<AgentBrowserOpenEventDetail>(AGENT_BROWSER_OPEN_EVENT, {
    detail,
    cancelable: true,
  });
  window.dispatchEvent(event);
  if (event.defaultPrevented) {
    if (foreground) {
      store.set(revealWorkstreamEditorAtom, workstreamId);
    }
    return;
  }

  // Workstream editor strip is not currently mounted (user is in another
  // session or another mode). Seed the tab into persisted workstream state so
  // it appears when the user opens that session.
  const state = store.get(workstreamStateAtom(workstreamId));
  const existing = state.openResources.find((t) =>
    isSameVirtualBrowserTab(t.resource.resourceId, filePath),
  );
  if (existing) {
    if (foreground) {
      store.set(workstreamStateAtom(workstreamId), {
        activeResourceId: existing.resource.resourceId,
      });
      store.set(revealWorkstreamEditorAtom, workstreamId);
    }
    return;
  }

  const nextResources = [...state.openResources, { resource: fileResource(filePath) }];
  store.set(workstreamStateAtom(workstreamId), {
    openResources: nextResources,
    ...(foreground ? { activeResourceId: filePath } : {}),
  });
  if (foreground) {
    store.set(revealWorkstreamEditorAtom, workstreamId);
  }
}
