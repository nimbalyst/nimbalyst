import { useEffect, useRef } from 'react';

/**
 * Fires `onTrigger` exactly once per increment of a counter/version atom value,
 * optionally deferred until `ready` is true.
 *
 * Counter atoms (incremented on an IPC event) are the pattern used for
 * command-driven dialogs in App.tsx. The naive inline version compares the live
 * counter against a `useRef` snapshot but never updates the ref after firing, so
 * once the counter increments the guard is permanently false. If the effect also
 * depends on another value (e.g. `workspacePath`), every change to that value
 * re-runs the effect and re-fires the dialog. That is the bug in #480: the
 * session-import dialog re-opened on every workspace switch after first use.
 *
 * This hook consumes the version when it actually fires, so:
 * - each increment fires once,
 * - a re-render at the same version (a workspace switch, a new callback
 *   identity) is a no-op,
 * - an increment that arrives while `ready` is false is deferred and fires once
 *   `ready` becomes true.
 *
 * The version guard also makes the hook robust to an unstable `onTrigger`
 * identity: even if `onTrigger` changes every render, the effect bails when the
 * version has not advanced.
 */
export function useDialogRequestTrigger(
  version: number,
  ready: boolean,
  onTrigger: () => void,
): void {
  const lastFiredVersionRef = useRef(version);

  useEffect(() => {
    if (version === lastFiredVersionRef.current) return;
    if (!ready) return;
    lastFiredVersionRef.current = version;
    onTrigger();
  }, [version, ready, onTrigger]);
}
