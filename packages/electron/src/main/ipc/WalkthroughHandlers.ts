/**
 * IPC handlers for Walkthrough Guide System
 *
 * Provides handlers for:
 * - Getting walkthrough state
 * - Enabling/disabling walkthroughs globally
 * - Marking walkthroughs as completed or dismissed
 * - Resetting walkthrough state (for testing)
 * - Registering walkthrough metadata for dynamic menu generation
 */

import { safeHandle } from '../utils/ipcRegistry';
import {
  getWalkthroughState,
  setWalkthroughsEnabled,
  markWalkthroughCompleted,
  markWalkthroughDismissed,
  recordWalkthroughShown,
  resetWalkthroughState,
  resetTipState,
  type WalkthroughState,
} from '../utils/store';
import { updateApplicationMenu } from '../menu/ApplicationMenu';

/** Walkthrough metadata for menu generation */
export interface WalkthroughMenuEntry {
  id: string;
  name: string;
}

/** Registered walkthroughs from renderer - used for dynamic menu */
let registeredWalkthroughs: WalkthroughMenuEntry[] = [];

/** Registered tips from renderer - used for dynamic menu */
let registeredTips: WalkthroughMenuEntry[] = [];

/** Get the current list of registered walkthroughs */
export function getRegisteredWalkthroughs(): WalkthroughMenuEntry[] {
  return registeredWalkthroughs;
}

/** Get the current list of registered tips */
export function getRegisteredTips(): WalkthroughMenuEntry[] {
  return registeredTips;
}

export function registerWalkthroughHandlers(): void {
  /**
   * Get the current walkthrough state
   */
  safeHandle('walkthroughs:get-state', async (): Promise<WalkthroughState> => {
    return getWalkthroughState();
  });

  /**
   * Enable or disable walkthroughs globally
   */
  safeHandle('walkthroughs:set-enabled', async (_event, enabled: boolean): Promise<void> => {
    setWalkthroughsEnabled(enabled);
  });

  /**
   * Mark a walkthrough as completed (user finished all steps)
   */
  safeHandle(
    'walkthroughs:mark-completed',
    async (_event, walkthroughId: string, version?: number): Promise<void> => {
      markWalkthroughCompleted(walkthroughId, version);
    }
  );

  /**
   * Mark a walkthrough as dismissed (user skipped/closed it)
   */
  safeHandle(
    'walkthroughs:mark-dismissed',
    async (_event, walkthroughId: string, version?: number): Promise<void> => {
      markWalkthroughDismissed(walkthroughId, version);
    }
  );

  /**
   * Record that a walkthrough was shown (for analytics tracking)
   * Also updates per-mode cooldown timestamp
   */
  safeHandle(
    'walkthroughs:record-shown',
    async (_event, walkthroughId: string, version?: number, mode?: 'files' | 'agent'): Promise<void> => {
      recordWalkthroughShown(walkthroughId, version, mode);
    }
  );

  /**
   * Reset all walkthrough state (for testing/debugging)
   */
  safeHandle('walkthroughs:reset', async (): Promise<void> => {
    resetWalkthroughState();
  });

  /**
   * Register walkthrough metadata from renderer for dynamic menu generation.
   * Called once when the renderer initializes with the list of available walkthroughs.
   */
  safeHandle(
    'walkthroughs:register-menu-entries',
    async (_event, entries: WalkthroughMenuEntry[]): Promise<void> => {
      registeredWalkthroughs = entries;
      // Rebuild menu to include the new walkthrough entries
      await updateApplicationMenu();
    }
  );

  /**
   * Register tip metadata from renderer for dynamic menu generation.
   */
  safeHandle(
    'tips:register-menu-entries',
    async (_event, entries: WalkthroughMenuEntry[]): Promise<void> => {
      registeredTips = entries;
      await updateApplicationMenu();
    }
  );

  /**
   * Reset only tip state (not walkthroughs) for testing/debugging
   */
  safeHandle('tips:reset', async (): Promise<void> => {
    resetTipState();
  });
}
