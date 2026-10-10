/**
 * Who "me" is for a tracker surface that stays mounted for the life of the window.
 *
 * Re-read from the renderer's centralized signals rather than once on mount,
 * and never through an IPC subscription of its own: identity follows the auth
 * snapshot (sign-in, sign-out, a different account), the project's org
 * binding, and the window coming back to the front (main falls back to git
 * config, which can change while away).
 *
 * An unchanged answer keeps its object, so a re-read does not re-render.
 */

import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { TrackerIdentity } from '@nimbalyst/runtime/core/DocumentService';
import { stytchAuthAtom } from '../../store/atoms/stytchAuth';
import { projectOrgRevisionAtom } from '../../store/atoms/orgScope';
import { windowFocusedAtom } from '../../store/atoms/windowFocus';

/** Counts the times this window has come back to the front since mount. */
function useFrontWindowReturns(): number {
  const focused = useAtomValue(windowFocusedAtom);
  const [state, setState] = useState({ focused, returns: 0 });
  if (state.focused !== focused) setState({ focused, returns: state.returns + (focused ? 1 : 0) });
  return state.returns;
}

const sameIdentity = (a: TrackerIdentity | null, b: TrackerIdentity | null) =>
  a === b || (!!a && !!b && a.email === b.email && a.displayName === b.displayName);

export function useDesktopTrackerIdentity(workspacePath: string): TrackerIdentity | null {
  const [identity, setIdentity] = useState<TrackerIdentity | null>(null);
  const auth = useAtomValue(stytchAuthAtom);
  const authKey = auth ? `${auth.isAuthenticated}:${auth.user?.user_id ?? ''}` : 'unknown';
  const orgRevision = useAtomValue(projectOrgRevisionAtom);
  const returns = useFrontWindowReturns();

  const workspaceRef = useRef(workspacePath);
  useEffect(() => {
    // Another workspace's "me" must not linger while this one's is read.
    if (workspaceRef.current !== workspacePath) {
      workspaceRef.current = workspacePath;
      setIdentity(null);
    }
    let cancelled = false;
    window.electronAPI.invoke('document-service:get-current-identity').then((result: { success?: boolean; identity?: TrackerIdentity }) => {
      if (cancelled) return;
      const next = result?.success && result.identity ? result.identity : null;
      setIdentity((current) => (sameIdentity(current, next) ? current : next));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [workspacePath, authKey, orgRevision, returns]);
  return identity;
}
