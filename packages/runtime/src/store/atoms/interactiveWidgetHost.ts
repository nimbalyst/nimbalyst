/**
 * Interactive Widget Host Atoms
 *
 * Per-session host for interactive tool widgets (AskUserQuestion, ExitPlanMode,
 * GitCommit, ToolPermission, etc.). Widgets read the host from the atom via
 * `useAtomValue(interactiveWidgetHostAtom(sessionId))` and call its methods.
 *
 * Registration is multi-owner: the same session can be displayed by more than
 * one `SessionTranscript` at a time (e.g. once in Files-mode ChatSidebar and
 * once in Agent mode). If two transcripts compete for the same atom slot with
 * single-owner semantics, the second mount's StrictMode cleanup, or the first
 * cleanup-without-immediate-resetup, leaves the atom at `null` and the
 * surviving transcript has no way to notice it should re-register. That's the
 * regression where AskUserQuestion's options stop rendering after switching
 * Files <-> Agent.
 *
 * Instead we keep a module-local `Set` of live proxies per session. The atom
 * value tracks "any live proxy" -- swapping to a surviving one when the
 * currently-published one unregisters. Atom is only set to null when the last
 * owner disappears.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { store } from '../store';
import type { InteractiveWidgetHost } from '../../ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';

/**
 * Per-session interactive widget host atom. Read by widgets.
 */
export const interactiveWidgetHostAtom = atomFamily((_sessionId: string) =>
  atom<InteractiveWidgetHost | null>(null)
);

const liveHostsBySession = new Map<string, Set<InteractiveWidgetHost>>();

function publishFromSet(sessionId: string): void {
  const set = liveHostsBySession.get(sessionId);
  const next = set && set.size > 0 ? set.values().next().value as InteractiveWidgetHost : null;
  if (store.get(interactiveWidgetHostAtom(sessionId)) !== next) {
    store.set(interactiveWidgetHostAtom(sessionId), next);
  }
}

/**
 * Register a host for a session. Idempotent (safe to call with the same proxy
 * twice in a StrictMode double-invoke). The atom is updated so the newest
 * registrant is published, but earlier registrants are kept as fallback so a
 * later unregister can hand off to a surviving owner instead of nulling out.
 */
export function registerInteractiveWidgetHost(
  sessionId: string,
  host: InteractiveWidgetHost,
): void {
  let set = liveHostsBySession.get(sessionId);
  if (!set) {
    set = new Set();
    liveHostsBySession.set(sessionId, set);
  }
  set.add(host);
  // Publish the newest registrant so widgets see fresh closures.
  store.set(interactiveWidgetHostAtom(sessionId), host);
}

/**
 * Unregister a host. If it was the currently-published owner, fall back to any
 * other live owner; only set the atom to null when the last owner is gone.
 */
export function unregisterInteractiveWidgetHost(
  sessionId: string,
  host: InteractiveWidgetHost,
): void {
  const set = liveHostsBySession.get(sessionId);
  if (!set) return;
  set.delete(host);
  if (set.size === 0) liveHostsBySession.delete(sessionId);
  publishFromSet(sessionId);
}

/**
 * @deprecated Prefer `registerInteractiveWidgetHost` / `unregisterInteractiveWidgetHost`.
 * Kept for tests and any external callers that directly toggle the atom.
 * Bypasses the multi-owner registry, so a null write here clobbers any live
 * owners.
 */
export function setInteractiveWidgetHost(sessionId: string, host: InteractiveWidgetHost | null): void {
  store.set(interactiveWidgetHostAtom(sessionId), host);
}

/**
 * Get the currently-published host for a session.
 */
export function getInteractiveWidgetHost(sessionId: string): InteractiveWidgetHost | null {
  return store.get(interactiveWidgetHostAtom(sessionId));
}

/**
 * Cleanup atom for a session (call when session is deleted).
 */
export function cleanupInteractiveWidgetHost(sessionId: string): void {
  liveHostsBySession.delete(sessionId);
  interactiveWidgetHostAtom.remove(sessionId);
}
