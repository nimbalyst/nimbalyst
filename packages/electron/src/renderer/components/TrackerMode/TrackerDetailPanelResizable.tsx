/**
 * The region that holds `TrackerItemDetail` in Tracker Mode.
 *
 * It has two shapes: a fixed-width, drag-resizable panel on the right of the
 * list (the ordinary presentation), and a fill-the-space document surface
 * (`fill`). Both come out of *one* component so the detail -- and the body
 * editor inside it, with its Y.Doc provider -- keeps its React identity when
 * the user switches between the two. Rendering the two shapes as separate JSX
 * branches would give the detail a different parent each way, and React would
 * remount it (plan: tracker-document-mode, checkbox 24).
 *
 * Lives in its own module (rather than inside `TrackerMainView`) so the shell
 * can import it without a cycle.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

const MIN_WIDTH = 300;
const MAX_WIDTH = 1200;

interface TrackerDetailPanelResizableProps {
  /** Fill the remaining space instead of sitting at a fixed width. */
  fill: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  children: React.ReactNode;
}

export const TrackerDetailPanelResizable: React.FC<TrackerDetailPanelResizableProps> = ({
  fill,
  width,
  onWidthChange,
  children,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [currentWidth, setCurrentWidth] = useState(width);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  useEffect(() => { setCurrentWidth(width); }, [width]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = currentWidth;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [currentWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      // Dragging left increases width, dragging right decreases
      const deltaX = startXRef.current - e.clientX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidthRef.current + deltaX));
      setCurrentWidth(newWidth);
    };
    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onWidthChange(currentWidth);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, currentWidth, onWidthChange]);

  return (
    <div
      className={fill ? 'tracker-detail-region flex min-w-0 flex-1' : 'tracker-detail-region flex shrink-0'}
      style={fill ? undefined : { width: `${currentWidth}px` }}
      data-testid="tracker-detail-region"
      data-fill={fill}
    >
      {!fill && (
        <div
          className={`relative w-0.5 cursor-ew-resize bg-nim-border shrink-0 transition-colors duration-150 hover:bg-nim-accent ${isDragging ? 'bg-nim-accent' : ''}`}
          onMouseDown={handleMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize detail panel"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
};
