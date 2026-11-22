/**
 * Central listener for `terminal:reveal`: main asks the windows showing a
 * project to open the terminal panel on one tab. Sent when an extension
 * backend module reveals a command terminal it owns
 * (`ctx.services.terminals`, main/extensions/backendTerminals.ts), for example
 * a run target's "Logs" button or an agent tool's "show logs" link.
 *
 * Bottom panels are mutually exclusive, so the extension bottom panel that
 * asked for the reveal is closed. A window on another project ignores the
 * event; main has already stored the tab as that project's active terminal, so
 * the tab is selected when the project is next shown.
 */
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { activeExtensionBottomPanelAtom } from '../atoms/extensionPanels';
import { loadTerminals, openTerminalPanelAtom, setActiveTerminal, terminalListAtom } from '../atoms/terminals';

const REVEAL_CHANNEL = 'terminal:reveal';

interface TerminalRevealRequest {
  workspacePath: string;
  terminalId: string;
}

export async function revealTerminal(request: TerminalRevealRequest): Promise<void> {
  if (!request?.workspacePath || !request.terminalId) return;
  if (request.workspacePath !== store.get(activeWorkspacePathAtom)) return;
  // The tab may have been created a moment ago; load the list that contains it.
  await loadTerminals(request.workspacePath);
  if (request.workspacePath !== store.get(activeWorkspacePathAtom)) return;
  setActiveTerminal(request.terminalId);
  store.set(activeExtensionBottomPanelAtom, null);
  store.set(openTerminalPanelAtom);
}

/**
 * Reveal the command terminal an extension owns under `key` (a run target's
 * id), whichever terminal id it has now: each start of a command replaces its
 * tab with a new terminal, so an id remembered in a transcript goes stale.
 * Resolves false when the project has no such tab.
 */
export async function revealOwnedTerminal(request: {
  workspacePath: string;
  extensionId: string;
  key: string;
}): Promise<boolean> {
  if (!request?.workspacePath || request.workspacePath !== store.get(activeWorkspacePathAtom)) return false;
  await loadTerminals(request.workspacePath);
  if (request.workspacePath !== store.get(activeWorkspacePathAtom)) return false;
  const terminal = store
    .get(terminalListAtom)
    .find((item) => item.owner?.extensionId === request.extensionId && item.owner.key === request.key);
  if (!terminal) return false;
  await revealTerminal({ workspacePath: request.workspacePath, terminalId: terminal.id });
  return true;
}

export function initTerminalRevealListeners(): () => void {
  const api = window.electronAPI;
  if (!api?.on) return () => {};
  const off = api.on(REVEAL_CHANNEL, (request: TerminalRevealRequest) => {
    revealTerminal(request).catch((error) => {
      console.error('[terminalRevealListeners] Failed to reveal terminal:', error);
    });
  });
  return () => off?.();
}
