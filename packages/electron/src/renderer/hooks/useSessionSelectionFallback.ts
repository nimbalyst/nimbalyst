import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { pendingAgentModeRestoresAtom } from '../store/atoms/agentMode';
import { selectedWorkstreamAtom } from '../store/atoms/sessions';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';

/** Keep the session list usable after saved selection restoration finishes. */
export function useSessionSelectionFallback(
  workspacePath: string,
  activeSessionId: string | null,
  firstSessionId: string | undefined,
  onSessionSelect: ((sessionId: string) => void) | undefined,
): void {
  const pending = useAtomValue(pendingAgentModeRestoresAtom(workspacePath), { store });
  const selection = useAtomValue(selectedWorkstreamAtom(workspacePath), { store });
  useEffect(() => {
    if (pending || selection || activeSessionId || !firstSessionId || !onSessionSelect) return;
    const timer = setTimeout(() => {
      // Recheck live state: a restore or explicit click can precede React's effect cleanup.
      if (store.get(activeWorkspacePathAtom) !== workspacePath ||
          store.get(pendingAgentModeRestoresAtom(workspacePath)) ||
          store.get(selectedWorkstreamAtom(workspacePath))) return;
      onSessionSelect(firstSessionId);
    }, 100);
    return () => clearTimeout(timer);
  }, [workspacePath, pending, selection, activeSessionId, firstSessionId, onSessionSelect]);
}
