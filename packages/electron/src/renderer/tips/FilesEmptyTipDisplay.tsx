import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import type { FeatureUsageRecord } from '../../shared/featureUsage';
import { worktreesFeatureAvailableAtom } from '../store/atoms/appSettings';
import { walkthroughStateAtom } from '../walkthroughs/atoms';
import { getWalkthroughState } from '../walkthroughs/WalkthroughService';
import { AllTipsDialog } from './AllTipsDialog';
import { TipCard } from './TipCard';
import { markTipCompleted, recordTipShown } from './TipService';
import { tips } from './definitions';
import {
  getEligibleFilesEmptyTips,
  getNextTip,
} from './filesEmptyTipSelection';
import type { TipDefinition, TipTriggerContext } from './types';

interface FilesEmptyTipDisplayProps {
  workspacePath: string;
  onInsertPrompt?: (text: string) => void;
}

export function FilesEmptyTipDisplay({
  workspacePath,
  onInsertPrompt,
}: FilesEmptyTipDisplayProps) {
  const posthog = usePostHog();
  const walkthroughState = useAtomValue(walkthroughStateAtom);
  const setWalkthroughState = useSetAtom(walkthroughStateAtom);
  const isWorktreesAvailable = useAtomValue(worktreesFeatureAvailableAtom);
  const [featureUsage, setFeatureUsage] = useState<Record<string, FeatureUsageRecord>>({});
  const [toolUsage, setToolUsage] = useState<Record<string, FeatureUsageRecord>>({});
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [activeTipId, setActiveTipId] = useState<string | null>(null);
  const [showAllTipsDialog, setShowAllTipsDialog] = useState(false);
  const recordedTipIdsRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;

    // toolUsage may be absent if the preload bundle predates this API (dev
    // renderer hot-reload without a full restart) -- guard rather than crash.
    void Promise.resolve(window.electronAPI.toolUsage?.getRollup())
      .then((usage) => {
        if (!cancelled) setToolUsage(usage ?? {});
      })
      .catch(() => {
        if (!cancelled) setToolUsage({});
      });

    window.electronAPI.featureUsage.getAll()
      .then((usage) => {
        if (!cancelled) setFeatureUsage(usage ?? {});
      })
      .catch(() => {
        if (!cancelled) setFeatureUsage({});
      });

    window.electronAPI.invoke('git:is-repo', workspacePath)
      .then((result) => {
        if (!cancelled) setIsGitRepo(Boolean(result?.success && result.isRepo));
      })
      .catch(() => {
        if (!cancelled) setIsGitRepo(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const triggerContext = useMemo<TipTriggerContext>(() => ({
    currentMode: 'files',
    workspacePath,
    isGitRepo,
    isWorktreesAvailable,
    featureUsage,
    hasBeenUsed: (feature) => (featureUsage[feature]?.count ?? 0) > 0,
    hasReachedCount: (feature, threshold) =>
      (featureUsage[feature]?.count ?? 0) >= threshold,
    toolUsage,
    hasUsedTool: (toolKey) => (toolUsage[toolKey]?.count ?? 0) > 0,
    toolUseCount: (toolKey) => toolUsage[toolKey]?.count ?? 0,
  }), [featureUsage, toolUsage, isGitRepo, isWorktreesAvailable, workspacePath]);

  const eligibleTips = useMemo(() => {
    if (!walkthroughState) return [];
    return getEligibleFilesEmptyTips(tips, walkthroughState, triggerContext);
  }, [triggerContext, walkthroughState]);

  const recordShown = useCallback((tip: TipDefinition) => {
    if (recordedTipIdsRef.current.has(tip.id)) return;
    recordedTipIdsRef.current.add(tip.id);
    void recordTipShown(tip.id, tip.version);
    posthog?.capture('tip_shown', {
      tip_id: tip.id,
      tip_name: tip.name,
      surface: 'files_empty',
    });
  }, [posthog]);

  useEffect(() => {
    const currentIsEligible = eligibleTips.some((tip) => tip.id === activeTipId);
    if (currentIsEligible) return;

    const firstTip = eligibleTips[0] ?? null;
    setActiveTipId(firstTip?.id ?? null);
    if (firstTip) recordShown(firstTip);
  }, [activeTipId, eligibleTips, recordShown]);

  const activeTip = useMemo(
    () => eligibleTips.find((tip) => tip.id === activeTipId) ?? null,
    [activeTipId, eligibleTips],
  );

  const displayTip = useMemo(() => {
    if (!activeTip) return null;
    if (activeTip.content.action?.insertPrompt && !onInsertPrompt) {
      return {
        ...activeTip,
        content: { ...activeTip.content, action: undefined },
      };
    }
    return activeTip;
  }, [activeTip, onInsertPrompt]);

  const handleNext = useCallback(() => {
    const nextTip = getNextTip(eligibleTips, activeTipId);
    if (!nextTip) return;

    posthog?.capture('tip_navigated', {
      from_tip_id: activeTipId,
      to_tip_id: nextTip.id,
      direction: 'next',
      reason: 'next_button',
      surface: 'files_empty',
    });
    setActiveTipId(nextTip.id);
    recordShown(nextTip);
  }, [activeTipId, eligibleTips, posthog, recordShown]);

  const handleAction = useCallback(async () => {
    const action = activeTip?.content.action;
    if (!activeTip || !action) return;

    posthog?.capture('tip_action_clicked', {
      tip_id: activeTip.id,
      tip_name: activeTip.name,
      action_label: action.label,
      surface: 'files_empty',
    });
    if (action.insertPrompt && onInsertPrompt) {
      onInsertPrompt(action.insertPrompt);
    }
    action.onClick?.();
    await markTipCompleted(activeTip.id, activeTip.version);
    setWalkthroughState(await getWalkthroughState());
    setActiveTipId(null);
  }, [activeTip, onInsertPrompt, posthog, setWalkthroughState]);

  const handleSecondaryAction = useCallback(() => {
    const action = activeTip?.content.secondaryAction;
    if (!activeTip || !action) return;
    posthog?.capture('tip_action_clicked', {
      tip_id: activeTip.id,
      tip_name: activeTip.name,
      action_label: action.label,
      action_type: 'secondary',
      surface: 'files_empty',
    });
    action.onClick?.();
  }, [activeTip, posthog]);

  const handleShowTip = useCallback((tip: TipDefinition) => {
    setActiveTipId(tip.id);
    recordShown(tip);
  }, [recordShown]);

  if (!activeTip || !displayTip) return null;

  const footerExtras = (
    <>
      {eligibleTips.length > 1 && (
        <button
          type="button"
          className="files-empty-tip-next text-[13px] text-nim-faint bg-transparent border-none cursor-pointer font-[inherit] transition-colors duration-150 hover:text-nim-muted hover:underline"
          onClick={handleNext}
        >
          Next tip
        </button>
      )}
      <button
        type="button"
        className="files-empty-tip-all text-[13px] text-nim-faint bg-transparent border-none cursor-pointer font-[inherit] transition-colors duration-150 hover:text-nim-muted hover:underline"
        onClick={() => {
          posthog?.capture('tip_all_tips_opened', {
            from_tip_id: activeTip.id,
            surface: 'files_empty',
          });
          setShowAllTipsDialog(true);
        }}
      >
        All tips
      </button>
    </>
  );

  return (
    <div className="files-empty-tip-display mt-5 w-full" data-component="FilesEmptyTipDisplay">
      <TipCard
        tip={displayTip}
        onAction={() => void handleAction()}
        onSecondaryAction={activeTip.content.secondaryAction ? handleSecondaryAction : undefined}
        variant="inline"
        inlineFooterExtras={footerExtras}
      />
      <AllTipsDialog
        isOpen={showAllTipsDialog}
        onClose={() => setShowAllTipsDialog(false)}
        tipDefinitions={eligibleTips}
        onShowTip={handleShowTip}
      />
    </div>
  );
}
