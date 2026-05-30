/**
 * TipProvider Component
 *
 * Evaluates tip trigger conditions on a timer and selects the highest-priority
 * eligible tip. Enforces session-based cooldown (one tip per app launch).
 *
 * Rendering policy (current):
 *   Tips are rendered inline in the empty panel of new AI sessions via
 *   `InlineTipDisplay` -- the floating bottom-left card from `TipCard` is
 *   intentionally not rendered here. The floating implementation is kept
 *   intact for a future surface. To avoid "burning" tips while no inline
 *   surface is mounted, activation is gated on
 *   `emptyTranscriptVisibleCountAtom > 0`.
 *
 * Shares persistence with the walkthrough system -- tip dismissed/completed
 * state is stored alongside walkthrough state via the same IPC channels.
 */

import React, { useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import type { ContentMode, TipDefinition, TipTriggerContext } from './types';
import { activeTipIdAtom, tipShownThisSessionAtom } from './atoms';
import { walkthroughStateAtom, isWalkthroughActiveAtom } from '../walkthroughs/atoms';
import { hasActiveDialogsAtom } from '../contexts/DialogContext';
import { hasVisibleOverlay, getWalkthroughState } from '../walkthroughs/WalkthroughService';
import { store } from '@nimbalyst/runtime/store';
import { shouldShowTip, markTipDismissed, markTipCompleted, recordTipShown, registerTipMenuEntries } from './TipService';
import { tips } from './definitions';
import {
  tipTriggerCommandAtom,
  tipResetCommandAtom,
} from '../store/atoms/walkthroughCommands';
import { errorNotificationService } from '../services/ErrorNotificationService';
import { worktreesFeatureAvailableAtom } from '../store/atoms/appSettings';
import { emptyTranscriptVisibleCountAtom } from './atoms';
import type { FeatureUsageRecord } from '../../shared/featureUsage';

/** Delay before first tip evaluation after app start */
const STARTUP_DELAY_MS = 15_000;

/** Interval between tip evaluations */
const EVALUATION_INTERVAL_MS = 5_000;

interface TipProviderProps {
  children: ReactNode;
  currentMode: ContentMode;
  workspacePath?: string;
}

export function TipProvider({ children, currentMode, workspacePath }: TipProviderProps) {
  const posthog = usePostHog();

  const walkthroughState = useAtomValue(walkthroughStateAtom);
  const isWalkthroughActive = useAtomValue(isWalkthroughActiveAtom);
  const hasActiveDialogs = useAtomValue(hasActiveDialogsAtom);
  const isWorktreesAvailable = useAtomValue(worktreesFeatureAvailableAtom);

  const [activeTipId, setActiveTipId] = useAtom(activeTipIdAtom);
  const [tipShownThisSession, setTipShownThisSession] = useAtom(tipShownThisSessionAtom);

  const pendingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for values the interval callback needs to read.
  // The evaluation effect runs ONCE (empty deps) and reads these refs
  // so that dependency changes don't restart the 15s startup delay.
  const walkthroughStateRef = useRef(walkthroughState);
  const isWalkthroughActiveRef = useRef(isWalkthroughActive);
  const hasActiveDialogsRef = useRef(hasActiveDialogs);
  const activeTipIdRef = useRef(activeTipId);
  const tipShownThisSessionRef = useRef(tipShownThisSession);
  const currentModeRef = useRef(currentMode);
  const featureUsageRef = useRef<Record<string, FeatureUsageRecord>>({});
  const isGitRepoRef = useRef(false);
  const isWorktreesAvailableRef = useRef(isWorktreesAvailable);
  const workspacePathRef = useRef(workspacePath);

  // Keep refs in sync on every render
  walkthroughStateRef.current = walkthroughState;
  isWalkthroughActiveRef.current = isWalkthroughActive;
  hasActiveDialogsRef.current = hasActiveDialogs;
  activeTipIdRef.current = activeTipId;
  tipShownThisSessionRef.current = tipShownThisSession;
  currentModeRef.current = currentMode;
  isWorktreesAvailableRef.current = isWorktreesAvailable;
  workspacePathRef.current = workspacePath;

  useEffect(() => {
    let cancelled = false;

    const loadFeatureUsage = async () => {
      try {
        const usage = await window.electronAPI.featureUsage.getAll();
        if (!cancelled) {
          featureUsageRef.current = usage ?? {};
        }
      } catch {
        if (!cancelled) {
          featureUsageRef.current = {};
        }
      }
    };

    loadFeatureUsage();
    const intervalId = setInterval(loadFeatureUsage, EVALUATION_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadGitRepoStatus = async () => {
      if (!workspacePath || !window.electronAPI?.invoke) {
        isGitRepoRef.current = false;
        return;
      }

      try {
        const result = await window.electronAPI.invoke('git:is-repo', workspacePath);
        if (!cancelled) {
          isGitRepoRef.current = Boolean(result?.success && result.isRepo);
        }
      } catch {
        if (!cancelled) {
          isGitRepoRef.current = false;
        }
      }
    };

    loadGitRepoStatus();
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const buildTriggerContext = useCallback((): TipTriggerContext => {
    const featureUsage = featureUsageRef.current;

    return {
      currentMode: currentModeRef.current,
      workspacePath: workspacePathRef.current,
      isGitRepo: isGitRepoRef.current,
      isWorktreesAvailable: isWorktreesAvailableRef.current,
      featureUsage,
      hasBeenUsed: (feature: string) => (featureUsage[feature]?.count ?? 0) > 0,
      hasReachedCount: (feature: string, threshold: number) =>
        (featureUsage[feature]?.count ?? 0) >= threshold,
    };
  }, []);

  // Get active tip definition
  const activeTip = useMemo(() => {
    if (!activeTipId) return null;
    return tips.find((t) => t.id === activeTipId) ?? null;
  }, [activeTipId]);

  // Show a tip
  const showTip = useCallback(
    (tip: TipDefinition) => {
      // console.log(`[Tips] Showing: ${tip.id}`);
      setActiveTipId(tip.id);
      setTipShownThisSession(true);

      recordTipShown(tip.id, tip.version);

      posthog?.capture('tip_shown', {
        tip_id: tip.id,
        tip_name: tip.name,
      });
    },
    [posthog, setActiveTipId, setTipShownThisSession]
  );

  // Stable ref for showTip so the interval can call it
  const showTipRef = useRef(showTip);
  showTipRef.current = showTip;

  // Dismiss current tip (X button or Escape)
  const dismissTip = useCallback(() => {
    if (!activeTip) return;

    posthog?.capture('tip_dismissed', {
      tip_id: activeTip.id,
      tip_name: activeTip.name,
    });

    markTipDismissed(activeTip.id, activeTip.version);
    setActiveTipId(null);
  }, [activeTip, posthog, setActiveTipId]);

  // Handle primary action click
  const handleAction = useCallback(() => {
    if (!activeTip?.content.action) return;

    posthog?.capture('tip_action_clicked', {
      tip_id: activeTip.id,
      tip_name: activeTip.name,
      action_label: activeTip.content.action.label,
    });

    activeTip.content.action.onClick();
    markTipCompleted(activeTip.id, activeTip.version);
    setActiveTipId(null);
  }, [activeTip, posthog, setActiveTipId]);

  // Handle secondary action click
  const handleSecondaryAction = useCallback(() => {
    if (!activeTip?.content.secondaryAction) return;

    posthog?.capture('tip_action_clicked', {
      tip_id: activeTip.id,
      tip_name: activeTip.name,
      action_label: activeTip.content.secondaryAction.label,
      action_type: 'secondary',
    });

    activeTip.content.secondaryAction.onClick();
    // Secondary action doesn't dismiss the tip
  }, [activeTip, posthog]);

  // Tip evaluation loop -- runs ONCE on mount, reads state via refs
  useEffect(() => {
    const isPlaywright = (window as any).PLAYWRIGHT;
    if (isPlaywright) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startupTimer = setTimeout(() => {
      intervalId = setInterval(() => {
        if (tipShownThisSessionRef.current) return;
        if (!walkthroughStateRef.current) return;
        if (isWalkthroughActiveRef.current) return;
        if (hasActiveDialogsRef.current || hasVisibleOverlay()) return;
        if (activeTipIdRef.current) return;
        // Don't activate a tip if there's nowhere to render it. The floating
        // card is disabled; tips currently render inline in empty AI
        // transcripts, so wait until at least one such surface is mounted.
        if (store.get(emptyTranscriptVisibleCountAtom) <= 0) return;

        const state = walkthroughStateRef.current;
        const mode = currentModeRef.current;
        const triggerContext = buildTriggerContext();

        const eligible = tips
          .filter((tip) => {
            if (!shouldShowTip(state, tip)) return false;
            const screenMatch = tip.trigger.screen === '*' || tip.trigger.screen === mode;
            if (!screenMatch) return false;
            if (!tip.trigger.condition(triggerContext)) return false;
            return true;
          })
          .sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));

        if (eligible.length > 0) {
          const tip = eligible[0];
          const delay = tip.trigger.delay ?? 2000;

          if (pendingDelayRef.current) {
            clearTimeout(pendingDelayRef.current);
          }

          pendingDelayRef.current = setTimeout(() => {
            if (hasVisibleOverlay()) return;
            if (store.get(emptyTranscriptVisibleCountAtom) <= 0) return;
            if (!tip.trigger.condition(buildTriggerContext())) return;
            showTipRef.current(tip);
          }, delay);
        }
      }, EVALUATION_INTERVAL_MS);
    }, STARTUP_DELAY_MS);

    return () => {
      clearTimeout(startupTimer);
      if (intervalId) clearInterval(intervalId);
      if (pendingDelayRef.current) {
        clearTimeout(pendingDelayRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildTriggerContext]); // All mutable state is read from refs; only helper identity matters

  // Register tip metadata with main process for Developer menu
  useEffect(() => {
    registerTipMenuEntries(
      tips.map((t) => ({ id: t.id, name: t.name }))
    );
  }, []);

  // React to tip trigger commands from Developer menu
  const triggerCommand = useAtomValue(tipTriggerCommandAtom);
  const triggerCommandProcessedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!triggerCommand || triggerCommand.timestamp === triggerCommandProcessedRef.current) return;
    triggerCommandProcessedRef.current = triggerCommand.timestamp;

    const { tipId } = triggerCommand;
    const tip = tips.find((t) => t.id === tipId);
    if (!tip) {
      errorNotificationService.showInfo(
        'Unknown Tip',
        `Tip "${tipId}" not found.`,
        { duration: 3000 }
      );
      return;
    }

    // Force-show the tip, bypassing cooldown and condition checks
    setActiveTipId(tip.id);
    recordTipShown(tip.id, tip.version);
    posthog?.capture('tip_shown', {
      tip_id: tip.id,
      tip_name: tip.name,
      source: 'developer_menu',
    });
  }, [triggerCommand, setActiveTipId, posthog]);

  // React to tip reset commands from Developer menu
  const resetCommand = useAtomValue(tipResetCommandAtom);
  const resetCommandProcessedRef = useRef<number>(0);

  useEffect(() => {
    if (resetCommand === 0 || resetCommand === resetCommandProcessedRef.current) return;
    resetCommandProcessedRef.current = resetCommand;

    (async () => {
      // Reset only tip state (tip- prefixed entries), not walkthroughs
      await window.electronAPI.invoke('tips:reset');
      // Reload state so tips can show again
      const newState = await getWalkthroughState();
      store.set(walkthroughStateAtom, newState);
      setTipShownThisSession(false);
      setActiveTipId(null);
      errorNotificationService.showInfo(
        'Tips Reset',
        'All tips will show again.',
        { duration: 3000 }
      );
    })();
  }, [resetCommand, setActiveTipId, setTipShownThisSession]);

  // Dev helpers
  useEffect(() => {
    if (import.meta.env.DEV) {
      const helpers = {
        listTips: () => {
          const triggerContext = buildTriggerContext();
          console.table(
            tips.map((t) => ({
              id: t.id,
              name: t.name,
              screen: t.trigger.screen,
              priority: t.trigger.priority,
              conditionMet: t.trigger.condition(triggerContext),
            }))
          );
          return tips.map((t) => t.id);
        },
        showTip: (id: string) => {
          const tip = tips.find((t) => t.id === id);
          if (tip) showTip(tip);
          else console.warn(`[Tips] Unknown tip ID: ${id}`);
        },
        dismissTip: () => dismissTip(),
        getState: () => ({
          activeTipId,
          tipShownThisSession,
          walkthroughState,
        }),
      };

      (window as any).__tipHelpers = helpers;

      return () => {
        delete (window as any).__tipHelpers;
      };
    }
    return undefined;
  }, [activeTipId, tipShownThisSession, walkthroughState, showTip, dismissTip]);

  // Rendering policy: the floating TipCard is intentionally not rendered
  // here. Tips show inline in the empty panel of new AI sessions via
  // `InlineTipDisplay` (see SessionTranscript's `renderEmptyExtra`). The
  // floating implementation is preserved in TipCard for future use.
  return <>{children}</>;
}
