import { useEffect } from 'react';

import {
  ORG_WINDOW_COMMAND_CHANNEL,
  isOrgWindowCommand,
} from '../../../shared/orgWindowCommands';
import { dispatchOrgWindowCommand } from './orgWindowCommandBus';
import { resolveOrgWindowCommand } from './orgWindowKeyboard';

/**
 * The org window's single publisher of messaging commands.
 *
 * Mounted by `TeamManagementApp` — the window root — rather than inside
 * `TeamMode`, so the keys work on every surface the window can show, including
 * the loading and unbound-organization arms. Both sources land on the same bus:
 * the native Messages menu over IPC, and the window's own key handling for the
 * platforms and moments the menu accelerator does not reach.
 */
export function useOrgWindowCommandSource(): void {
  useEffect(() => {
    const off = window.electronAPI?.on?.(
      ORG_WINDOW_COMMAND_CHANNEL,
      (command: unknown) => {
        if (isOrgWindowCommand(command)) dispatchOrgWindowCommand(command);
      },
    );
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = resolveOrgWindowCommand(event);
      if (!command) return;
      // Nothing else in this window claims these combinations, and letting
      // Cmd+F fall through would hand the page Chromium's own find bar.
      event.preventDefault();
      dispatchOrgWindowCommand(command);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
