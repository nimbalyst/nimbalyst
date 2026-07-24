import { useMemo } from 'react';
import { useFloating, offset, shift, size, FloatingPortal, autoUpdate } from '@floating-ui/react';
import { CommitDetailContent, type CommitDetail } from './CommitDetailContent';

interface CommitHoverCardProps {
  detail: CommitDetail | null;
  loading: boolean;
  anchorRect: DOMRect;
  author: string;
  date: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function CommitHoverCard({ detail, loading, anchorRect, author, date, onMouseEnter, onMouseLeave }: CommitHoverCardProps) {
  const virtualRef = useMemo(() => ({
    getBoundingClientRect: () => anchorRect,
  }), [anchorRect]);

  const { refs, floatingStyles } = useFloating({
    elements: { reference: virtualRef as unknown as Element },
    // No flip — this lives in a bottom panel and must ALWAYS open upward.
    placement: 'top-start',
    // Recompute position when the card resizes (e.g. content loads after loading state)
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          // Object.assign is the correct floating-ui pattern — React state causes
          // oscillating re-renders that corrupt the position calculation.
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.min(420, Math.max(120, availableHeight))}px`,
          });
        },
      }),
    ],
  });

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="git-hover-card"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <CommitDetailContent detail={detail} loading={loading} author={author} date={date} layout="horizontal" />
      </div>
    </FloatingPortal>
  );
}
