/**
 * AllTipsDialog
 *
 * Modal listing every defined tip, with a "Show" button that promotes the
 * selected tip into the active inline-display slot. Useful as a discovery
 * surface for users who've dismissed past tips or want to revisit them.
 */

import React from 'react';
import { useSetAtom } from 'jotai';
import { activeTipIdAtom } from './atoms';
import { recordTipShown } from './TipService';
import { tips } from './definitions';
import type { TipDefinition } from './types';

interface AllTipsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  tipDefinitions?: readonly TipDefinition[];
  onShowTip?: (tip: TipDefinition) => void;
}

export function AllTipsDialog({
  isOpen,
  onClose,
  tipDefinitions = tips,
  onShowTip,
}: AllTipsDialogProps): React.ReactElement | null {
  const setActiveTipId = useSetAtom(activeTipIdAtom);

  if (!isOpen) return null;

  const sorted = [...tipDefinitions].sort(
    (a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0)
  );

  const handleShow = (tip: TipDefinition) => {
    if (onShowTip) {
      onShowTip(tip);
    } else {
      setActiveTipId(tip.id);
      recordTipShown(tip.id, tip.version);
    }
    onClose();
  };

  return (
    <div
      className="all-tips-overlay nim-overlay z-[10001] backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div
        className="all-tips-dialog nim-modal w-[90%] max-w-[600px] max-h-[80vh] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="all-tips-header flex items-center justify-between px-6 py-5 border-b border-[var(--nim-border)]">
          <h2 className="m-0 text-lg font-semibold text-[var(--nim-text)]">All Tips</h2>
          <button
            className="all-tips-close nim-btn-icon w-8 h-8 text-[28px] leading-none rounded transition-all duration-200"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="all-tips-content overflow-y-auto p-6 flex flex-col gap-3">
          {sorted.map((tip) => (
            <div
              key={tip.id}
              className="all-tips-item flex items-start gap-3 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg px-4 py-3"
            >
              {tip.content.icon && (
                <div className="w-9 h-9 rounded-lg bg-[color-mix(in_srgb,var(--nim-primary)_10%,transparent)] border border-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] flex items-center justify-center shrink-0 text-[var(--nim-primary)]">
                  {tip.content.icon}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold text-[var(--nim-text)] leading-snug">
                  {tip.content.title}
                </div>
                <div className="text-[12.5px] text-[var(--nim-text-muted)] mt-1 leading-relaxed line-clamp-3">
                  {tip.content.body.replace(/\*\*/g, '')}
                </div>
              </div>
              <button
                className="shrink-0 px-3 py-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)] rounded-md text-[12.5px] font-medium cursor-pointer hover:bg-[var(--nim-bg-hover)] transition-colors"
                onClick={() => handleShow(tip)}
              >
                Show
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
