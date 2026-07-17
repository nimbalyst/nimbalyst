import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

interface ResizeDragShieldOptions {
  cursor?: string;
  onMove: (event: PointerEvent) => void;
  onEnd?: () => void;
}

/**
 * Keeps a panel resize drag in the host document when the pointer crosses an
 * iframe-backed editor. Iframes have their own document, so document-level
 * move/up listeners in the host stop receiving input while the pointer is over
 * them. The temporary fixed shield stays above editor content for the duration
 * of the drag and owns all subsequent pointer events.
 */
export function useResizeDragShield({
  cursor = 'col-resize',
  onMove,
  onEnd,
}: ResizeDragShieldOptions): (event: ReactPointerEvent<HTMLElement>) => void {
  const callbacksRef = useRef({ onMove, onEnd });
  callbacksRef.current = { onMove, onEnd };

  const cleanupRef = useRef<((notifyEnd: boolean) => void) | null>(null);

  useEffect(() => {
    return () => cleanupRef.current?.(false);
  }, []);

  return useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    cleanupRef.current?.(false);

    const body = document.body;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;
    const shield = document.createElement('div');
    shield.className = 'resize-drag-shield';
    shield.dataset.testid = 'resize-drag-shield';
    shield.setAttribute('aria-hidden', 'true');
    Object.assign(shield.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      cursor,
      touchAction: 'none',
    });

    body.style.cursor = cursor;
    body.style.userSelect = 'none';
    body.appendChild(shield);

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      pointerEvent.preventDefault();
      callbacksRef.current.onMove(pointerEvent);
    };

    const finish = () => cleanupRef.current?.(true);

    const cleanup = (notifyEnd: boolean) => {
      if (cleanupRef.current !== cleanup) return;
      cleanupRef.current = null;
      shield.removeEventListener('pointermove', handlePointerMove);
      shield.removeEventListener('pointerup', finish);
      shield.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      shield.remove();
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
      if (notifyEnd) callbacksRef.current.onEnd?.();
    };

    cleanupRef.current = cleanup;
    shield.addEventListener('pointermove', handlePointerMove);
    shield.addEventListener('pointerup', finish);
    shield.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  }, [cursor]);
}
