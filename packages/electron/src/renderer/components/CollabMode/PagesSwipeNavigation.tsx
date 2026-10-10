/**
 * Two-finger swipe Back and Forward over Pages' tab content (`swipeNavigation.ts`
 * recognizes the gesture). An arrow slides in from the edge the swipe pulls
 * from and fills as the swipe nears the point where it navigates.
 *
 * The arrows are styled directly from the wheel handler: a swipe is dozens of
 * events a second, and none of them should re-render Pages.
 */

import React, { useEffect, useRef, type RefObject } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTabsActions } from '../../contexts/TabsContext';
import {
  SWIPE_GESTURE_GAP_MS,
  SwipeNavigationRecognizer,
  canScrollHorizontally,
  type SwipeDirection,
} from './swipeNavigation';

// How far the arrow travels in from outside the edge, in px.
const ARROW_TRAVEL = 52;

interface PagesSwipeNavigationProps {
  /** The element whose wheel events count: the tab content, not the sidebar. */
  targetRef: RefObject<HTMLElement | null>;
  onStep: (direction: SwipeDirection) => void;
}

export function PagesSwipeNavigation({ targetRef, onStep }: PagesSwipeNavigationProps) {
  const { getSnapshot } = useTabsActions();
  const backRef = useRef<HTMLDivElement>(null);
  const forwardRef = useRef<HTMLDivElement>(null);
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const arrowFor = (direction: SwipeDirection) => (direction === -1 ? backRef.current : forwardRef.current);
    const showArrow = (direction: SwipeDirection, progress: number, armed: boolean) => {
      const arrow = arrowFor(direction);
      if (!arrow) return;
      const offset = Math.min(progress, 1) * ARROW_TRAVEL * -direction;
      arrow.style.transition = armed ? 'transform 120ms ease-out, opacity 200ms ease-in 80ms' : 'none';
      arrow.style.transform = `translate(${offset}px, -50%)`;
      arrow.style.opacity = armed ? '0' : String(Math.min(1, progress * 1.5));
      arrow.dataset.armed = armed ? 'true' : 'false';
    };
    const hideArrows = () => {
      for (const arrow of [backRef.current, forwardRef.current]) {
        if (!arrow || arrow.dataset.armed === 'true') continue;
        arrow.style.transition = 'transform 150ms ease-out, opacity 150ms ease-out';
        arrow.style.transform = 'translate(0, -50%)';
        arrow.style.opacity = '0';
      }
    };

    const recognizer = new SwipeNavigationRecognizer({
      canNavigate: (direction) => {
        const { activeTabId, tabs } = getSnapshot();
        const history = activeTabId ? tabs.get(activeTabId)?.history : undefined;
        return direction === -1 ? Boolean(history?.back.length) : Boolean(history?.forward.length);
      },
    });

    let gestureEnd: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      // Pinch zoom arrives as ctrl+wheel; Shift turns a mouse wheel sideways;
      // line and page deltas come from mouse wheels, not trackpads.
      if (event.ctrlKey || event.shiftKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
      const update = recognizer.feed({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        time: event.timeStamp,
        contentScrolls: () => canScrollHorizontally(event.target as Element, target, event.deltaX < 0 ? -1 : 1),
      });
      if (update.kind === 'progress') showArrow(update.direction, update.progress, false);
      if (update.kind === 'navigate') {
        showArrow(update.direction, 1, true);
        onStepRef.current(update.direction);
      }
      clearTimeout(gestureEnd);
      gestureEnd = setTimeout(() => {
        recognizer.reset();
        hideArrows();
        for (const arrow of [backRef.current, forwardRef.current]) if (arrow) arrow.dataset.armed = 'false';
      }, SWIPE_GESTURE_GAP_MS);
    };

    target.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      target.removeEventListener('wheel', onWheel);
      clearTimeout(gestureEnd);
    };
  }, [getSnapshot, targetRef]);

  const arrowClass = 'pages-swipe-arrow pointer-events-none absolute top-1/2 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-nim bg-nim-secondary text-nim shadow-md opacity-0 data-[armed=true]:bg-nim-accent data-[armed=true]:text-white';
  return (
    <>
      <div ref={backRef} className={`${arrowClass} -left-10`} style={{ transform: 'translate(0, -50%)' }} data-testid="pages-swipe-back" aria-hidden>
        <MaterialSymbol icon="arrow_back" size={18} />
      </div>
      <div ref={forwardRef} className={`${arrowClass} -right-10`} style={{ transform: 'translate(0, -50%)' }} data-testid="pages-swipe-forward" aria-hidden>
        <MaterialSymbol icon="arrow_forward" size={18} />
      </div>
    </>
  );
}
