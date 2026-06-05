/**
 * Dialog Registry Index
 *
 * This file exports the dialog registration system and initializes all dialogs.
 * Import this early in app initialization to register all dialogs.
 */

import { registerNavigationDialogs as _registerNavigationDialogs } from './navigation';
import { registerSimpleDialogs as _registerSimpleDialogs } from './simpleDialogs';
import { registerDataDialogs as _registerDataDialogs } from './dataDialogs';
import { registerOnboardingDialogs as _registerOnboardingDialogs } from './onboardingDialogs';
import { registerTeamDialogs as _registerTeamDialogs } from './teamDialogs';

export { DIALOG_IDS, type DialogId } from './registry';
export {
  registerNavigationDialogs,
  type UnifiedQuickOpenData,
} from './navigation';
export {
  registerSimpleDialogs,
  type KeyboardShortcutsData,
  type DiscordInvitationData,
  type FeedbackIntakeData,
  type ApiKeyDialogData,
  type ShareDialogData,
} from './simpleDialogs';
export {
  registerDataDialogs,
  type ProjectSelectionData,
  type ErrorDialogData,
  type ConfirmDialogData,
  type SessionImportData,
} from './dataDialogs';
export {
  registerOnboardingDialogs,
  type WindowsClaudeCodeWarningData,
  type RosettaWarningData,
  type UnifiedOnboardingData,
  type ExtensionProjectIntroData,
  type OnboardingData,
} from './onboardingDialogs';
export {
  registerTeamDialogs,
  type CreateTeamData,
  type ShareToTeamData,
} from './teamDialogs';
export { useNavigationDialogs, type UseNavigationDialogsReturn } from './useNavigationDialogs';
export { dialogRef, dialogReadyAtom, hasActiveDialogsAtom } from '../contexts/DialogContext';

// Re-export types from context
export type {
  DialogConfig,
  DialogComponentProps,
  DialogGroup,
  ConfirmDialogOptions,
} from '../contexts/DialogContext.types';

/**
 * Initialize all dialog registrations.
 * Call this once at app startup, before any dialogs might be opened.
 */
export function initializeDialogs() {
  // Register navigation dialogs
  _registerNavigationDialogs();

  // Register simple dialogs (help, settings, promotion, feedback)
  _registerSimpleDialogs();

  // Register data-carrying dialogs (system, alert)
  _registerDataDialogs();

  // Register onboarding dialogs (Windows warning, unified onboarding)
  _registerOnboardingDialogs();

  // Register team/collaboration dialogs
  _registerTeamDialogs();
}
