import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';

const PROJECT_DRAG_TYPE = 'application/x-nimbalyst-rail-project';

/** Native drag with an insertion marker and frame-based scrolling at list edges. */
export function useProjectRailDrag(
  listRef: RefObject<HTMLDivElement | null>,
  move: (input: { path: string; beforePath: string | null }) => void,
) {
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [beforePath, setBeforePath] = useState<string | null | undefined>();
  const drag = useRef<{ path: string; y: number; inside: boolean } | null>(null);
  const frame = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setDraggedPath(null);
    setBeforePath(undefined);
  }, []);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const targetAt = useCallback((y: number) => {
    const items = listRef.current?.querySelectorAll<HTMLElement>('.project-rail-item');
    for (const item of items ?? []) {
      if (item.dataset.projectPath === drag.current?.path) continue;
      const rect = item.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return item.dataset.projectPath!;
    }
    return null;
  }, [listRef]);

  const tick = useCallback(() => {
    const list = listRef.current;
    const current = drag.current;
    if (!list || !current?.inside) { frame.current = null; return; }
    const rect = list.getBoundingClientRect();
    const edge = Math.min(32, rect.height / 4);
    const speed = current.y < rect.top + edge
      ? -Math.min(10, (rect.top + edge - current.y) / 3)
      : current.y > rect.bottom - edge
        ? Math.min(10, (current.y - rect.bottom + edge) / 3)
        : 0;
    if (speed) {
      list.scrollTop += speed;
      setBeforePath(targetAt(current.y));
    }
    frame.current = requestAnimationFrame(tick);
  }, [listRef, targetAt]);

  const onDragStart = useCallback((event: DragEvent, path: string) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, path);
    drag.current = { path, y: event.clientY, inside: false };
    setDraggedPath(path);
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    if (!drag.current) return; // Files and drags from other windows are not rail moves.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    drag.current.y = event.clientY;
    drag.current.inside = true;
    setBeforePath(targetAt(event.clientY));
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [targetAt, tick]);

  const onDragLeave = useCallback((event: DragEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    // Native drags can report a null relatedTarget between children.
    if (event.clientX >= bounds.left && event.clientX < bounds.right
      && event.clientY >= bounds.top && event.clientY < bounds.bottom) return;
    if (drag.current) drag.current.inside = false;
    setBeforePath(undefined);
  }, []);

  const onDrop = useCallback((event: DragEvent) => {
    if (!drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    move({ path: drag.current.path, beforePath: targetAt(event.clientY) });
    clear();
  }, [move, targetAt, clear]);

  return { draggedPath, beforePath, onDragStart, onDragEnd: clear, listProps: { onDragOver, onDragLeave, onDrop } };
}
