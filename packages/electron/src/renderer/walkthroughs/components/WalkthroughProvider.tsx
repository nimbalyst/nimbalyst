/**
 * WalkthroughProvider Component
 *
 * Context provider that manages walkthrough state and trigger evaluation.
 * Uses Jotai atoms for state management within the window.
 * State is synced with main process store for persistence across sessions.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import type {
  WalkthroughState,
  WalkthroughContextValue,
  ContentMode,
} from '../types';
import {
  getWalkthroughState,
  setWalkthroughsEnabled,
  markWalkthroughCompleted,
  markWalkthroughDismissed,
  recordWalkthroughShown,
  shouldShowWalkthrough,
  resetWalkthroughState as resetWalkthroughStateIPC,
  resolveTarget,
  registerWalkthroughMenuEntries,
  hasVisibleOverlay,
} from '../WalkthroughService';
import { WalkthroughCallout } from './WalkthroughCallout';
import { walkthroughs } from '../definitions';
import {
  walkthroughStateAtom,
  activeWalkthroughIdAtom,
  currentStepIndexAtom,
} from '../atoms';
import { hasActiveDialogsAtom } from '../../contexts/DialogContext';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import {
  walkthroughTriggerCommandAtom,
  walkthroughResetCommandAtom,
} from '../../store/atoms/walkthroughCommands';

const WalkthroughContext = createContext<WalkthroughContextValue | null>(null);

interface WalkthroughProviderProps {
  children: ReactNode;
  /** Current content mode (files/agent/settings) - from App.tsx */
  currentMode: ContentMode;
  /** Whether to enable automatic walkthrough triggering */
  autoTrigger?: boolean;
}

export function WalkthroughProvider({
  children,
  currentMode,
  autoTrigger = true,
}: WalkthroughProviderProps) {
  const posthog = usePostHog();

  // Jotai atoms for state
  const [state, setState] = useAtom(walkthroughStateAtom);
  const [activeWalkthroughId, setActiveWalkthroughId] = useAtom(activeWalkthroughIdAtom);
  const [currentStepIndex, setCurrentStepIndex] = useAtom(currentStepIndexAtom);

  // Check if any dialogs are open (don't show walkthroughs while dialogs are visible)
  const hasActiveDialogs = useAtomValue(hasActiveDialogsAtom);

  // Track whether we've already triggered for this mode to avoid re-triggering
  const lastTriggeredModeRef = useRef<string | null>(null);
  const triggerDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // No walkthroughs for first 10 seconds after app start
  const APP_STARTUP_DELAY_MS = 10_000;
  const [startupDelayPassed, setStartupDelayPassed] = React.useState(false);

  // Load state from main process on mount and register walkthroughs for menu
  useEffect(() => {
    getWalkthroughState().then(setState);

    // Register walkthrough metadata with main process for dynamic Developer menu
    registerWalkthroughMenuEntries(
      walkthroughs.map((w) => ({ id: w.id, name: w.name }))
    );
  }, [setState]);

  // Set up startup delay timer - enables walkthrough triggers after 10 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setStartupDelayPassed(true);
    }, APP_STARTUP_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  // Get current walkthrough definition
  const activeWalkthrough = useMemo(() => {
    if (!activeWalkthroughId) return null;
    return walkthroughs.find((w) => w.id === activeWalkthroughId) ?? null;
  }, [activeWalkthroughId]);

  // Start a walkthrough (can be called manually for testing)
  const startWalkthrough = useCallback(
    (walkthroughId: string, mode?: 'files' | 'agent') => {
      const walkthrough = walkthroughs.find((w) => w.id === walkthroughId);
      if (!walkthrough) {
        console.warn(`[Walkthrough] Unknown walkthrough ID: ${walkthroughId}`);
        return;
      }

      console.log(`[Walkthrough] Starting: ${walkthroughId}`);
      setActiveWalkthroughId(walkthroughId);
      setCurrentStepIndex(0);

      // Record that it was shown (with mode for cooldown tracking)
      recordWalkthroughShown(walkthroughId, walkthrough.version, mode);

      // Track in PostHog
      posthog?.capture('walkthrough_started', {
        walkthrough_id: walkthroughId,
        walkthrough_name: walkthrough.name,
        total_steps: walkthrough.steps.length,
        mode,
      });
    },
    [posthog, setActiveWalkthroughId, setCurrentStepIndex]
  );

  // Dismiss current walkthrough
  const dismissWalkthrough = useCallback(() => {
    if (!activeWalkthrough) return;

    // Track in PostHog
    posthog?.capture('walkthrough_dismissed', {
      walkthrough_id: activeWalkthrough.id,
      walkthrough_name: activeWalkthrough.name,
      step_dismissed_at: currentStepIndex,
      total_steps: activeWalkthrough.steps.length,
    });

    // Mark as dismissed in store
    markWalkthroughDismissed(activeWalkthrough.id, activeWalkthrough.version);

    // Update local state
    setState((prev) =>
      prev
        ? {
            ...prev,
            dismissed: [...prev.dismissed, activeWalkthrough.id],
          }
        : prev
    );

    setActiveWalkthroughId(null);
    setCurrentStepIndex(0);
  }, [activeWalkthrough, currentStepIndex, posthog, setState, setActiveWalkthroughId, setCurrentStepIndex]);

  // Complete current walkthrough
  const completeWalkthrough = useCallback(() => {
    if (!activeWalkthrough) return;

    // Track in PostHog
    posthog?.capture('walkthrough_completed', {
      walkthrough_id: activeWalkthrough.id,
      walkthrough_name: activeWalkthrough.name,
      steps_viewed: currentStepIndex + 1,
    });

    // Mark as completed in store
    markWalkthroughCompleted(activeWalkthrough.id, activeWalkthrough.version);

    // Update local state
    setState((prev) =>
      prev
        ? {
            ...prev,
            completed: [...prev.completed, activeWalkthrough.id],
          }
        : prev
    );

    setActiveWalkthroughId(null);
    setCurrentStepIndex(0);
  }, [activeWalkthrough, currentStepIndex, posthog, setState, setActiveWalkthroughId, setCurrentStepIndex]);

  // Go to next step
  const nextStep = useCallback(() => {
    if (!activeWalkthrough) return;

    const nextIndex = currentStepIndex + 1;
    if (nextIndex >= activeWalkthrough.steps.length) {
      completeWalkthrough();
    } else {
      setCurrentStepIndex(nextIndex);

      // Track step view in PostHog
      posthog?.capture('walkthrough_step_viewed', {
        walkthrough_id: activeWalkthrough.id,
        step_id: activeWalkthrough.steps[nextIndex].id,
        step_index: nextIndex,
      });
    }
  }, [activeWalkthrough, currentStepIndex, completeWalkthrough, posthog, setCurrentStepIndex]);

  // Go to previous step
  const previousStep = useCallback(() => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  }, [currentStepIndex, setCurrentStepIndex]);

  // Enable/disable walkthroughs globally
  const setEnabled = useCallback((enabled: boolean) => {
    setWalkthroughsEnabled(enabled);
    setState((prev) => (prev ? { ...prev, enabled } : prev));

    // If disabling, also dismiss any active walkthrough
    if (!enabled && activeWalkthroughId) {
      setActiveWalkthroughId(null);
      setCurrentStepIndex(0);
    }
  }, [activeWalkthroughId, setState, setActiveWalkthroughId, setCurrentStepIndex]);

  // Evaluate triggers when mode changes or state loads
  useEffect(() => {
    // Disable walkthroughs entirely in Playwright tests
    const isPlaywright = (window as any).PLAYWRIGHT;
    if (isPlaywright) {
      return;
    }

    // Skip during app startup delay (no walkthroughs for first 10 seconds)
    if (!startupDelayPassed) {
      return;
    }

    // Skip if disabled, no state yet, already showing a walkthrough, or a dialog/overlay is open
    const hasOverlay = hasVisibleOverlay();
    if (!autoTrigger || !state || !state.enabled || activeWalkthroughId || hasActiveDialogs || hasOverlay) {
      // if (import.meta.env.DEV) {
      //   console.log('[Walkthrough] Trigger check skipped:', {
      //     autoTrigger,
      //     hasState: !!state,
      //     enabled: state?.enabled,
      //     activeWalkthroughId,
      //     hasActiveDialogs,
      //     hasOverlay,
      //   });
      // }
      return;
    }

    // Skip if we already triggered for this mode (prevents re-triggering on every render)
    if (lastTriggeredModeRef.current === currentMode) {
      return;
    }

    // Clear any pending trigger
    if (triggerDelayRef.current) {
      clearTimeout(triggerDelayRef.current);
    }

    // Find eligible walkthroughs for current mode
    // Only track cooldown for files/agent modes (not settings)
    const modeForCooldown = currentMode === 'files' || currentMode === 'agent' ? currentMode : undefined;

    const eligible = walkthroughs
      .filter((w) => {
        // Check if should show based on state (including cooldown check)
        if (!shouldShowWalkthrough(state, w, modeForCooldown)) {
          // if (import.meta.env.DEV) {
          //   console.log(`[Walkthrough] ${w.id} filtered out by shouldShowWalkthrough`);
          // }
          return false;
        }

        // Check screen trigger
        const screenMatch =
          w.trigger.screen === '*' || w.trigger.screen === currentMode;
        if (!screenMatch) {
          // if (import.meta.env.DEV) {
          //   console.log(`[Walkthrough] ${w.id} filtered out by screen mismatch (${w.trigger.screen} vs ${currentMode})`);
          // }
          return false;
        }

        // Check custom condition if provided
        if (w.trigger.condition && !w.trigger.condition()) {
          // if (import.meta.env.DEV) {
          //   console.log(`[Walkthrough] ${w.id} filtered out by condition`);
          // }
          return false;
        }

        return true;
      })
      .sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));

    // if (import.meta.env.DEV) {
    //   console.log('[Walkthrough] Eligible walkthroughs:', eligible.map(w => w.id));
    // }

    if (eligible.length > 0) {
      const walkthrough = eligible[0];
      const delay = walkthrough.trigger.delay ?? 500;

      // if (import.meta.env.DEV) {
      //   console.log(`[Walkthrough] Will trigger ${walkthrough.id} in ${delay}ms`);
      // }

      // Delay trigger to let UI settle
      triggerDelayRef.current = setTimeout(() => {
        // Re-check for overlays right before triggering (a dialog may have opened during delay)
        if (hasVisibleOverlay()) {
          // if (import.meta.env.DEV) {
          //   console.log(`[Walkthrough] ${walkthrough.id} skipped - overlay appeared during delay`);
          // }
          return;
        }
        // Re-check condition right before triggering (UI may have changed)
        if (walkthrough.trigger.condition && !walkthrough.trigger.condition()) {
          // if (import.meta.env.DEV) {
          //   console.log(`[Walkthrough] ${walkthrough.id} condition failed at trigger time, skipping`);
          // }
          return;
        }
        lastTriggeredModeRef.current = currentMode;
        startWalkthrough(walkthrough.id, modeForCooldown);
      }, delay);
    }

    return () => {
      if (triggerDelayRef.current) {
        clearTimeout(triggerDelayRef.current);
      }
    };
  }, [currentMode, state, activeWalkthroughId, autoTrigger, startWalkthrough, hasActiveDialogs, startupDelayPassed]);

  // Expose test helpers in development mode
  useEffect(() => {
    if (import.meta.env.DEV) {
      const helpers = {
        // List all available walkthroughs
        listWalkthroughs: () => {
          console.table(walkthroughs.map(w => ({
            id: w.id,
            name: w.name,
            screen: w.trigger.screen,
            priority: w.trigger.priority,
            steps: w.steps.length,
          })));
          return walkthroughs.map(w => w.id);
        },
        // Start a specific walkthrough by ID
        startWalkthrough: (id: string) => {
          startWalkthrough(id);
        },
        // Dismiss current walkthrough
        dismissWalkthrough: () => {
          dismissWalkthrough();
        },
        // Get current state
        getState: () => ({
          state,
          activeWalkthroughId,
          currentStepIndex,
          activeWalkthrough,
        }),
        // Reset all walkthrough state (re-show all guides)
        resetState: async () => {
          await resetWalkthroughStateIPC();
          const newState = await getWalkthroughState();
          setState(newState);
          lastTriggeredModeRef.current = null;
          console.log('[Walkthrough] State reset');
        },
      };

      (window as any).__walkthroughHelpers = helpers;
      // console.log('[Walkthrough] Dev helpers available at window.__walkthroughHelpers');
      // console.log('  - listWalkthroughs(): Show all available walkthroughs');
      // console.log('  - startWalkthrough(id): Start a specific walkthrough');
      // console.log('  - dismissWalkthrough(): Dismiss current walkthrough');
      // console.log('  - getState(): Get current walkthrough state');
      // console.log('  - resetState(): Reset all walkthrough progress');
    }

    return () => {
      if (import.meta.env.DEV) {
        delete (window as any).__walkthroughHelpers;
      }
    };
  }, [state, activeWalkthroughId, currentStepIndex, activeWalkthrough, startWalkthrough, dismissWalkthrough, setState]);

  // React to walkthrough trigger commands from centralized listener
  const triggerCommand = useAtomValue(walkthroughTriggerCommandAtom);
  const triggerCommandProcessedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!triggerCommand || triggerCommand.timestamp === triggerCommandProcessedRef.current) return;
    triggerCommandProcessedRef.current = triggerCommand.timestamp;

    const { walkthroughId } = triggerCommand;
    const walkthrough = walkthroughs.find((w) => w.id === walkthroughId);
    if (!walkthrough) {
      errorNotificationService.showInfo(
        'Walkthrough Not Found',
        `Unknown walkthrough: ${walkthroughId}`,
        { duration: 3000 }
      );
      return;
    }

    // Check if the first step's target element exists on the page
    const firstStep = walkthrough.steps[0];
    const targetElement = resolveTarget(firstStep.target);

    if (!targetElement) {
      errorNotificationService.showInfo(
        'Cannot Show Walkthrough',
        `"${walkthrough.name}" requires UI elements that aren't visible on this screen. Try switching to ${walkthrough.trigger.screen === 'agent' ? 'Agent Mode' : 'Files Mode'} first.`,
        { duration: 5000 }
      );
      return;
    }

    // Check if walkthrough's condition is met
    if (walkthrough.trigger.condition && !walkthrough.trigger.condition()) {
      errorNotificationService.showInfo(
        'Cannot Show Walkthrough',
        `"${walkthrough.name}" conditions aren't met. Try switching to ${walkthrough.trigger.screen === 'agent' ? 'Agent Mode' : 'Files Mode'} first.`,
        { duration: 5000 }
      );
      return;
    }

    startWalkthrough(walkthroughId);
  }, [triggerCommand, startWalkthrough]);

  // React to walkthrough reset commands from centralized listener
  const resetCommand = useAtomValue(walkthroughResetCommandAtom);
  const resetCommandProcessedRef = useRef<number>(0);

  useEffect(() => {
    if (resetCommand === 0 || resetCommand === resetCommandProcessedRef.current) return;
    resetCommandProcessedRef.current = resetCommand;

    (async () => {
      await resetWalkthroughStateIPC();
      const newState = await getWalkthroughState();
      setState(newState);
      lastTriggeredModeRef.current = null;
      errorNotificationService.showInfo(
        'Walkthroughs Reset',
        'All walkthrough guides will show again.',
        { duration: 3000 }
      );
    })();
  }, [resetCommand, setState]);

  // Context value
  const contextValue = useMemo<WalkthroughContextValue>(
    () => ({
      state,
      activeWalkthroughId,
      currentStepIndex,
      startWalkthrough,
      dismissWalkthrough,
      completeWalkthrough,
      nextStep,
      previousStep,
      setEnabled,
    }),
    [
      state,
      activeWalkthroughId,
      currentStepIndex,
      startWalkthrough,
      dismissWalkthrough,
      completeWalkthrough,
      nextStep,
      previousStep,
      setEnabled,
    ]
  );

  return (
    <WalkthroughContext.Provider value={contextValue}>
      {children}
      {activeWalkthrough && (
        <WalkthroughCallout
          definition={activeWalkthrough}
          stepIndex={currentStepIndex}
          onNext={nextStep}
          onBack={previousStep}
          onDismiss={dismissWalkthrough}
          onComplete={completeWalkthrough}
        />
      )}
    </WalkthroughContext.Provider>
  );
}

/**
 * Hook to access walkthrough context
 */
export function useWalkthrough(): WalkthroughContextValue {
  const context = useContext(WalkthroughContext);
  if (!context) {
    throw new Error('useWalkthrough must be used within a WalkthroughProvider');
  }
  return context;
}

/**
 * Hook to access walkthrough context (safe version that returns null if not in provider)
 */
export function useWalkthroughSafe(): WalkthroughContextValue | null {
  return useContext(WalkthroughContext);
}
