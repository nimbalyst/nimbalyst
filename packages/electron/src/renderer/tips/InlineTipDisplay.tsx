/**
 * InlineTipDisplay
 *
 * Renders the currently active tip in the empty panel of a new AI session.
 * The active tip is chosen by TipProvider based on tip eligibility, or by
 * an explicit user action like browsing tips.
 *
 * Lifecycle:
 *  - On mount, it only registers that an inline tip surface exists.
 *  - TipProvider decides whether an eligible tip should be activated.
 *  - Action clears the active tip; Next is explicit user browsing. Tips are
 *    not dismissible -- the empty-session surface always offers a tip.
 *
 * Footer controls:
 *  - "Next" cycles forward.
 *  - "All tips" opens a dialog listing every tip; selecting one promotes
 *    it into the active slot.
 *
 * Note: `emptyTranscriptVisibleCountAtom` is still incremented while mounted
 * so the dormant TipProvider eval loop (kept for the floating-card surface)
 * stays aware of inline surfaces.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { TipCard } from './TipCard';
import { tips } from './definitions';
import { markTipCompleted, recordTipShown } from './TipService';
import { activeTipIdAtom, emptyTranscriptVisibleCountAtom } from './atoms';
import { AllTipsDialog } from './AllTipsDialog';

const orderedTips = [...tips].sort(
  (a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0)
);

function nextTipAfter(tipId: string | null) {
  if (orderedTips.length === 0) return null;
  if (!tipId) return orderedTips[0];
  const idx = orderedTips.findIndex((t) => t.id === tipId);
  if (idx < 0) return orderedTips[0];
  return orderedTips[(idx + 1) % orderedTips.length];
}

interface InlineTipDisplayProps {
  /**
   * Inserts text into the session composer (e.g. a slash command). Provided
   * only when there is somewhere to insert -- i.e. a claude-code session.
   * When absent, tips whose action is an `insertPrompt` hide that button.
   */
  onInsertPrompt?: (text: string) => void;
}

export function InlineTipDisplay({ onInsertPrompt }: InlineTipDisplayProps = {}) {
  const posthog = usePostHog();
  const [activeTipId, setActiveTipId] = useAtom(activeTipIdAtom);
  const setVisibleCount = useSetAtom(emptyTranscriptVisibleCountAtom);
  const [showAllTipsDialog, setShowAllTipsDialog] = useState(false);

  // Register this surface so TipProvider knows it exists (the eval loop is
  // a no-op while activeTipId is set, but we still maintain the count).
  useEffect(() => {
    setVisibleCount((n) => n + 1);
    return () => setVisibleCount((n) => Math.max(0, n - 1));
  }, [setVisibleCount]);

  const activeTip = useMemo(() => {
    if (!activeTipId) return null;
    return orderedTips.find((t) => t.id === activeTipId) ?? null;
  }, [activeTipId]);

  // An insert-prompt action needs somewhere to insert. When that's
  // unavailable (non-claude-code session), strip the action so TipCard
  // doesn't render a dead button.
  const displayTip = useMemo(() => {
    if (!activeTip) return null;
    if (activeTip.content.action?.insertPrompt && !onInsertPrompt) {
      return { ...activeTip, content: { ...activeTip.content, action: undefined } };
    }
    return activeTip;
  }, [activeTip, onInsertPrompt]);

  const advance = useCallback(
    (eventName: string, extra?: Record<string, unknown>) => {
      const next = nextTipAfter(activeTip?.id ?? null);
      if (!next) return;
      if (activeTip && extra) {
        posthog?.capture(eventName, {
          from_tip_id: activeTip.id,
          to_tip_id: next.id,
          surface: 'inline_empty_transcript',
          ...extra,
        });
      }
      setActiveTipId(next.id);
      recordTipShown(next.id, next.version);
    },
    [activeTip, posthog, setActiveTipId]
  );

  const handleAction = useCallback(() => {
    const action = activeTip?.content.action;
    if (!activeTip || !action) return;
    posthog?.capture('tip_action_clicked', {
      tip_id: activeTip.id,
      tip_name: activeTip.name,
      action_label: action.label,
      surface: 'inline_empty_transcript',
    });
    if (action.insertPrompt && onInsertPrompt) {
      onInsertPrompt(action.insertPrompt);
    }
    action.onClick?.();
    markTipCompleted(activeTip.id, activeTip.version);
    setActiveTipId(null);
  }, [activeTip, onInsertPrompt, posthog, setActiveTipId]);

  const handleSecondaryAction = useCallback(() => {
    if (!activeTip?.content.secondaryAction) return;
    posthog?.capture('tip_action_clicked', {
      tip_id: activeTip.id,
      tip_name: activeTip.name,
      action_label: activeTip.content.secondaryAction.label,
      action_type: 'secondary',
      surface: 'inline_empty_transcript',
    });
    activeTip.content.secondaryAction.onClick?.();
  }, [activeTip, posthog]);

  const handleNext = useCallback(() => {
    if (orderedTips.length <= 1) return;
    advance('tip_navigated', { direction: 'next', reason: 'next_button' });
  }, [advance]);

  const handleOpenAllTips = useCallback(() => {
    posthog?.capture('tip_all_tips_opened', {
      from_tip_id: activeTip?.id ?? null,
      surface: 'inline_empty_transcript',
    });
    setShowAllTipsDialog(true);
  }, [activeTip, posthog]);

  if (!activeTip) return null;

  const footerExtras = (
    <>
      {orderedTips.length > 1 && (
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2.5 py-1 text-[12.5px] text-[var(--nim-text-muted)] bg-transparent border border-[var(--nim-border)] rounded-md cursor-pointer transition-all duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
          onClick={handleNext}
          aria-label="Next tip"
          title="Next tip"
        >
          Next
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="inline-flex items-center gap-1 px-2.5 py-1 text-[12.5px] text-[var(--nim-text-muted)] bg-transparent border border-[var(--nim-border)] rounded-md cursor-pointer transition-all duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
        onClick={handleOpenAllTips}
        aria-label="Show all tips"
        title="Show all tips"
      >
        All tips
      </button>
    </>
  );

  return (
    <>
      <TipCard
        tip={displayTip ?? activeTip}
        onAction={handleAction}
        onSecondaryAction={activeTip.content.secondaryAction ? handleSecondaryAction : undefined}
        variant="inline"
        inlineFooterExtras={footerExtras}
      />
      <AllTipsDialog
        isOpen={showAllTipsDialog}
        onClose={() => setShowAllTipsDialog(false)}
      />
    </>
  );
}
