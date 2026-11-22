import { useEffect, useCallback, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { dialogRef, dialogReadyAtom } from '../contexts/DialogContext';
import { DIALOG_IDS } from '../dialogs';
import type { OnboardingData, UnifiedOnboardingData, WindowsClaudeCodeWarningData, RosettaWarningData, MigrationConsentData } from '../dialogs';
import type { OnboardingIntent } from '../components/UnifiedOnboarding/UnifiedOnboarding';
import OnboardingService from '../services/OnboardingService';
import type { ContentMode } from '../types/WindowModeTypes';
import { setDeveloperFeatureSettingsAtom } from '../store/atoms/appSettings';
import {
  unifiedOnboardingRequestAtom,
  windowsClaudeCodeWarningRequestAtom,
} from '../store/atoms/appCommands';
import { persistOnboardingCompletion } from '../utils/onboardingCompletion';

interface UseOnboardingOptions {
  workspacePath: string | null;
  workspaceMode: boolean;
  isInitializing: boolean;
  setActiveMode: (mode: ContentMode) => void;
}

interface UseOnboardingReturn {
  /** Check if commands toast should be shown and show it if needed */
  checkAndShowCommandsToast: () => Promise<boolean>;
}

/**
 * Hook that manages all onboarding-related dialogs and logic.
 *
 * This includes:
 * - Unified onboarding dialog (first-time user flow)
 * - Windows Claude Code warning (Windows-specific)
 * - Claude commands install toast checking
 * - IPC listeners for developer menu triggers
 */
export function useOnboarding({
  workspacePath,
  workspaceMode,
  isInitializing,
  setActiveMode,
}: UseOnboardingOptions): UseOnboardingReturn {
  const posthog = usePostHog();
  const dialogReady = useAtomValue(dialogReadyAtom);
  const updateDeveloperSettings = useSetAtom(setDeveloperFeatureSettingsAtom);

  // Track state for onboarding flow
  const onboardingOpenRef = useRef(false);
  const windowsWarningOpenRef = useRef(false);
  const forcedModeRef = useRef<'new' | 'existing' | null>(null);

  // Handle unified onboarding completion
  const handleOnboardingComplete = useCallback(async (
    data: OnboardingData,
    intent: OnboardingIntent,
  ) => {
    await persistOnboardingCompletion(data);

    // Update the atom so UI reflects the change immediately (without requiring refresh)
    updateDeveloperSettings({ developerMode: data.developerMode });

    // If user selected developer mode, switch to agent mode
    if (data.developerMode) {
      setActiveMode('agent');
    }

    // Person properties and the completion events are reported by
    // `persistOnboardingCompletion` so every onboarding window reports the same
    // thing.

    if (intent === 'tutorial') {
      await window.electronAPI.tutorial.start('onboarding');
    }

    onboardingOpenRef.current = false;

    // After onboarding closes, check if we need to show Windows warning
    checkWindowsWarning();
  }, [workspacePath, updateDeveloperSettings, setActiveMode]);

  // Handle unified onboarding skip
  const handleOnboardingSkip = useCallback(async () => {
    // Mark as completed to prevent re-showing
    await window.electronAPI.invoke('onboarding:update', {
      unifiedOnboardingCompleted: true,
      onboardingCompleted: true, // Keep for backward compatibility
    });

    // Track skip event
    if (posthog) {
      posthog.capture('unified_onboarding_skipped');
    }

    onboardingOpenRef.current = false;

    // After onboarding closes, check if we need to show platform warnings
    checkWindowsWarning();
    checkRosettaWarning();
    checkMigrationConsent();
  }, [posthog]);

  // Check if we should show the Windows Claude Code warning
  const checkWindowsWarning = useCallback(async () => {
    // Only run on Windows
    if (navigator.platform !== 'Win32') return;

    // Skip in Playwright tests
    if ((window as any).PLAYWRIGHT) return;

    // Only show in workspace mode windows
    if (!workspaceMode) return;

    try {
      // Check if we should show the warning (Windows only, not dismissed)
      const shouldShow = await window.electronAPI.invoke('claude-code:should-show-windows-warning');
      if (!shouldShow) return;

      // Check if Claude Code is installed
      const installation = await window.electronAPI.cliCheckClaudeCodeWindowsInstallation();
      if (installation.claudeCodeVersion) {
        // Claude Code is installed, no warning needed
        return;
      }

      // Show the warning via DialogProvider
      if (dialogRef.current) {
        windowsWarningOpenRef.current = true;
        dialogRef.current.open<WindowsClaudeCodeWarningData>(DIALOG_IDS.WINDOWS_CLAUDE_CODE_WARNING, {
          onClose: () => {
            posthog?.capture('windows_claude_code_warning_closed');
            windowsWarningOpenRef.current = false;
          },
          onDismiss: () => {
            posthog?.capture('windows_claude_code_warning_dismissed_forever');
            windowsWarningOpenRef.current = false;
          },
          onOpenSettings: () => {
            posthog?.capture('windows_claude_code_warning_shown');
            windowsWarningOpenRef.current = false;
            setActiveMode('settings');
          },
        });
      }
    } catch (error) {
      console.error('[useOnboarding] Error checking Windows Claude Code warning:', error);
    }
  }, [workspaceMode, posthog, setActiveMode]);

  // Check if we should show the Rosetta warning (x64 build on Apple Silicon)
  const checkRosettaWarning = useCallback(async () => {
    // Only run on macOS
    if (!navigator.platform.startsWith('Mac')) return;

    // Skip in Playwright tests
    if ((window as any).PLAYWRIGHT) return;

    // Only show in workspace mode windows
    if (!workspaceMode) return;

    try {
      const shouldShow = await window.electronAPI.invoke('platform:should-show-rosetta-warning');
      if (!shouldShow) return;

      if (dialogRef.current) {
        dialogRef.current.open<RosettaWarningData>(DIALOG_IDS.ROSETTA_WARNING, {
          onClose: () => {
            posthog?.capture('rosetta_warning_closed');
          },
          onDismiss: () => {
            posthog?.capture('rosetta_warning_dismissed_forever');
          },
          onDownload: () => {
            posthog?.capture('rosetta_warning_download_clicked');
            window.electronAPI.openExternal('https://nimbalyst.com');
          },
        });
      }
    } catch (error) {
      console.error('[useOnboarding] Error checking Rosetta warning:', error);
    }
  }, [workspaceMode, posthog]);

  // Offer to migrate a database above the automatic SQLite ceiling. Main
  // answers `show: true` to one window per launch, and only when boot decided
  // `offer_consent`; see main/database/sqlite/migrationConsentOffer.ts.
  const checkMigrationConsent = useCallback(async () => {
    if ((window as any).PLAYWRIGHT) return;
    if (!workspaceMode) return;
    try {
      const claim = (await window.electronAPI.invoke('db:migration:claim-consent-prompt')) as
        | { show: true; sourceBytesBucket: string }
        | { show: false };
      if (!claim.show || !dialogRef.current) return;
      posthog?.capture('migration_consent_prompt_shown', { source_bytes_bucket: claim.sourceBytesBucket });
      dialogRef.current.open<MigrationConsentData>(DIALOG_IDS.MIGRATION_CONSENT, {
        onAnswer: (accepted) => {
          posthog?.capture('migration_consent_prompt_answered', {
            answer: accepted ? 'accepted' : 'dismissed',
            source_bytes_bucket: claim.sourceBytesBucket,
          });
        },
      });
    } catch (error) {
      console.error('[useOnboarding] Error checking migration consent prompt:', error);
    }
  }, [workspaceMode, posthog]);

  // Check for unified onboarding on first launch
  // Wait for: initialization complete, dialog system ready, workspace mode
  useEffect(() => {
    if (isInitializing || !dialogReady || !workspaceMode) return;

    const checkUnifiedOnboarding = async () => {
      // Skip in Playwright tests
      if ((window as any).PLAYWRIGHT) {
        return;
      }

      // Small delay to let other windows start up first
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if unified onboarding has been completed. The onboarding:get
      // handler reads electron-store synchronously (~0ms); when this call is
      // slow it's because the main-process event loop is saturated at cold
      // start (multiple windows + live sync produce multi-second IPC delays),
      // not because the read itself is slow. A *slow* read is not a *negative*
      // read: treating a timeout as "not completed" makes the dialog re-open
      // for returning users every congested startup (NIM-896).
      //
      // So we retry the read across several short windows rather than giving
      // up after one. The true value comes back as soon as the event loop
      // drains. Only if every attempt times out (a genuine cold-start hang,
      // the issue #260 case) do we fall back to showing the dialog so a true
      // first-run user is never permanently blocked from onboarding.
      const ATTEMPT_TIMEOUT_MS = 3000;
      const MAX_ATTEMPTS = 5;
      const t0 = performance.now();
      let state: { unifiedOnboardingCompleted?: boolean } | null = null;
      let resolved = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const result = await Promise.race([
          window.electronAPI.invoke('onboarding:get').then((s) => ({ kind: 'ok' as const, state: s })),
          new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), ATTEMPT_TIMEOUT_MS)),
        ]);
        if (result.kind === 'ok') {
          state = result.state;
          resolved = true;
          const elapsed = Math.round(performance.now() - t0);
          console.log(`[useOnboarding] onboarding:get resolved in ${elapsed}ms after ${attempt} attempt(s) (completed=${!!result.state?.unifiedOnboardingCompleted})`);
          break;
        }
        console.warn(`[useOnboarding] onboarding:get attempt ${attempt}/${MAX_ATTEMPTS} timed out (${ATTEMPT_TIMEOUT_MS}ms); retrying`);
      }
      if (!resolved) {
        const elapsed = Math.round(performance.now() - t0);
        console.warn(`[useOnboarding] onboarding:get never resolved after ${elapsed}ms; proceeding to show dialog`);
        state = null;
      }

      // Only check the new unified onboarding flag
      if (state?.unifiedOnboardingCompleted) {
        // Onboarding already done, check platform warnings
        checkWindowsWarning();
        checkRosettaWarning();
        checkMigrationConsent();
        return;
      }

      // Show unified onboarding via DialogProvider
      if (dialogRef.current) {
        onboardingOpenRef.current = true;
        dialogRef.current.open<UnifiedOnboardingData>(DIALOG_IDS.ONBOARDING, {
          onComplete: handleOnboardingComplete,
          onSkip: handleOnboardingSkip,
          forcedMode: forcedModeRef.current,
        });
      }
    };

    checkUnifiedOnboarding();
  }, [isInitializing, dialogReady, workspaceMode, handleOnboardingComplete, handleOnboardingSkip, checkWindowsWarning]);

  // React to "show unified onboarding" command from the Developer menu. The
  // IPC subscription lives in store/listeners/appCommandListeners.ts.
  const unifiedOnboardingRequest = useAtomValue(unifiedOnboardingRequestAtom);
  useEffect(() => {
    if (!unifiedOnboardingRequest) return;
    const { options } = unifiedOnboardingRequest;
    let forcedMode: 'new' | 'existing' | null = null;
    if (options?.forceNewUser) {
      forcedMode = 'new';
    } else if (options?.forceExistingUser) {
      forcedMode = 'existing';
    }
    forcedModeRef.current = forcedMode;

    if (dialogRef.current) {
      onboardingOpenRef.current = true;
      dialogRef.current.open<UnifiedOnboardingData>(DIALOG_IDS.ONBOARDING, {
        onComplete: handleOnboardingComplete,
        onSkip: handleOnboardingSkip,
        forcedMode,
      });
    }
  }, [unifiedOnboardingRequest, handleOnboardingComplete, handleOnboardingSkip]);

  // React to "show Windows Claude Code warning" from the Developer menu. The
  // IPC subscription lives in store/listeners/appCommandListeners.ts.
  const windowsWarningVersion = useAtomValue(windowsClaudeCodeWarningRequestAtom);
  const windowsWarningInitialVersionRef = useRef(windowsWarningVersion);
  useEffect(() => {
    if (windowsWarningVersion === windowsWarningInitialVersionRef.current) return;
    if (!dialogRef.current) return;
    windowsWarningOpenRef.current = true;
    dialogRef.current.open<WindowsClaudeCodeWarningData>(DIALOG_IDS.WINDOWS_CLAUDE_CODE_WARNING, {
      onClose: () => {
        posthog?.capture('windows_claude_code_warning_closed');
        windowsWarningOpenRef.current = false;
      },
      onDismiss: () => {
        posthog?.capture('windows_claude_code_warning_dismissed_forever');
        windowsWarningOpenRef.current = false;
      },
      onOpenSettings: () => {
        posthog?.capture('windows_claude_code_warning_shown');
        windowsWarningOpenRef.current = false;
        setActiveMode('settings');
      },
    });
  }, [windowsWarningVersion, posthog, setActiveMode]);

  // Check and show commands toast
  const checkAndShowCommandsToast = useCallback(async (): Promise<boolean> => {
    if (!workspacePath || !workspaceMode) return false;

    // Skip in Playwright tests
    if ((window as any).PLAYWRIGHT) return false;

    // Don't show if onboarding or Windows warning is open
    if (onboardingOpenRef.current || windowsWarningOpenRef.current) return false;

    try {
      const needsInstall = await OnboardingService.needsCommandInstallation(workspacePath);
      return needsInstall;
    } catch (error) {
      console.error('[useOnboarding] Error checking command installation:', error);
      return false;
    }
  }, [workspacePath, workspaceMode]);

  return {
    checkAndShowCommandsToast,
  };
}
