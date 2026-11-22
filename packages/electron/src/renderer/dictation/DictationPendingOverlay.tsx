import React, { useLayoutEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { FloatingPortal, flip, offset, shift, useFloating } from '@floating-ui/react';
import { dictationOverlayAtom } from '../store/atoms/dictation';
import { getDictationTarget } from './dictationTargets';

/**
 * Muted, uncommitted dictation text shown at the caret of an editor that
 * cannot paint it as a decoration itself (the Lexical markdown editor). The
 * document is not touched until the engine commits a final. Mounted once.
 */
export function DictationPendingOverlay() {
  const overlay = useAtomValue(dictationOverlayAtom);
  const reference = useMemo(() => {
    if (!overlay) return null;
    const target = getDictationTarget(overlay.targetKey);
    const rect = target?.getCaretRect?.();
    if (!rect) return null;
    return { getBoundingClientRect: () => rect };
    // Re-measure on every partial: the caret moves when a final commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay?.targetKey, overlay?.text]);

  const { refs, floatingStyles } = useFloating({
    placement: 'right',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  useLayoutEffect(() => {
    refs.setPositionReference(reference);
  }, [refs, reference]);

  if (!overlay || !reference) return null;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="dictation-pending-overlay pointer-events-none z-50 max-w-[480px] truncate px-1 rounded text-[var(--nim-text-muted)] bg-[var(--nim-bg-secondary)] italic"
        aria-live="polite"
        data-testid="dictation-pending-overlay"
      >
        {overlay.text}
      </div>
    </FloatingPortal>
  );
}
