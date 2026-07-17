import React, { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useResizeDragShield } from '../../hooks/useResizeDragShield';

interface ResizablePanelProps {
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  leftWidth: number;
  minWidth?: number;
  maxWidth?: number;
  onWidthChange: (width: number) => void;
  collapsed?: boolean;
}

export const ResizablePanel: React.FC<ResizablePanelProps> = ({
  leftPanel,
  rightPanel,
  leftWidth,
  minWidth = 180,
  maxWidth = 400,
  onWidthChange,
  collapsed = false
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [currentWidth, setCurrentWidth] = useState(leftWidth);
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(leftWidth);
  const currentWidthRef = useRef(leftWidth);

  // Update current width when prop changes
  useEffect(() => {
    setCurrentWidth(leftWidth);
    currentWidthRef.current = leftWidth;
  }, [leftWidth]);

  const startResizeDrag = useResizeDragShield({
    cursor: 'ew-resize',
    onMove: (event) => {
      const deltaX = event.clientX - startXRef.current;
      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + deltaX));
      currentWidthRef.current = newWidth;
      setCurrentWidth(newWidth);
    },
    onEnd: () => {
      setIsDragging(false);
      onWidthChange(currentWidthRef.current);
    },
  });

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    setIsDragging(true);
    startXRef.current = event.clientX;
    startWidthRef.current = currentWidthRef.current;
    startResizeDrag(event);
  }, [startResizeDrag]);

  const displayWidth = collapsed ? 0 : currentWidth;

  return (
    <div className="resizable-panel-container flex flex-1 overflow-hidden h-full" ref={containerRef}>
      {!collapsed && (
        <>
          <div
            className="resizable-panel-left flex flex-col overflow-hidden bg-nim border-r border-nim"
            style={{ width: `${displayWidth}px`, flexShrink: 0 }}
          >
            {leftPanel}
          </div>
          <div
            className={`resizable-panel-divider relative w-0.5 cursor-ew-resize bg-nim-border shrink-0 transition-colors duration-150 hover:bg-nim-accent ${isDragging ? 'bg-nim-accent' : ''}`}
            data-testid="agent-history-resize-handle"
            onPointerDown={handlePointerDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize session history panel"
            aria-valuenow={currentWidth}
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
          >
            <div className="resizable-panel-divider-handle absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-10 bg-transparent pointer-events-none" />
          </div>
        </>
      )}
      <div className="resizable-panel-right flex-1 flex flex-col overflow-hidden bg-nim">
        {rightPanel}
      </div>
    </div>
  );
};
