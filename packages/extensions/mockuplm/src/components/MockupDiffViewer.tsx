import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderMockupHtml } from '../utils/mockupDomUtils';

interface MockupDiffViewerProps {
  originalHtml: string;
  updatedHtml: string;
  fileName: string;
}

/**
 * MockupDiffViewer - Visual diff comparison for mockup files
 *
 * This component provides the slider-based visual diff UI for comparing
 * original vs modified mockups. Accept/reject actions are handled by
 * the unified diff header (UnifiedDiffHeader) in TabEditor.
 */
export const MockupDiffViewer: React.FC<MockupDiffViewerProps> = ({
  originalHtml,
  updatedHtml,
  fileName,
}) => {
  const [sliderPosition, setSliderPosition] = useState(50);
  const beforeFrameRef = useRef<HTMLIFrameElement>(null);
  const afterFrameRef = useRef<HTMLIFrameElement>(null);
  const sliderStageRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  // Detect if this is a new file (no original content to diff against)
  const isNewFile = useMemo(() => {
    const result = !originalHtml || originalHtml.trim() === '';
    console.log('[MockupDiffViewer] isNewFile check:', {
      result,
      originalHtmlLength: originalHtml?.length,
      originalHtmlPreview: originalHtml?.substring(0, 100),
    });
    return result;
  }, [originalHtml]);

  const loadBefore = useCallback(() => {
    if (!isNewFile) {
      renderMockupHtml(beforeFrameRef.current, originalHtml);
    }
  }, [originalHtml, isNewFile]);

  const loadAfter = useCallback(() => {
    renderMockupHtml(afterFrameRef.current, updatedHtml);
  }, [updatedHtml]);

  useEffect(() => {
    loadBefore();
  }, [loadBefore]);

  const updateSliderFromPointer = useCallback((clientX: number) => {
    const stage = sliderStageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const relative = ((clientX - rect.left) / rect.width) * 100;
    setSliderPosition(Math.max(0, Math.min(100, relative)));
  }, []);

  useEffect(() => {
    loadAfter();
  }, [loadAfter]);

  useEffect(() => {
    const handlePointerUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!isDraggingRef.current) return;
      updateSliderFromPointer(event.clientX);
    };

    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointermove', handlePointerMove);
    return () => {
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointermove', handlePointerMove);
    };
  }, [updateSliderFromPointer]);

  const handleSliderPointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    updateSliderFromPointer(event.clientX);
  }, [updateSliderFromPointer]);

  return (
    <div className="mockup-diff-viewer flex flex-col flex-1 h-full w-full min-h-0 bg-[var(--nim-bg)]">
      <div
        className="mockup-diff-content flex-1 flex flex-col min-h-0 overflow-hidden bg-[#111]"
        role="region"
        aria-label={isNewFile ? 'New mockup preview' : 'Mockup diff preview'}
      >
        {isNewFile ? (
          // New file: simple preview without slider
          <div className="mockup-diff-new-file-wrapper relative flex-1 min-h-0 m-4">
            <div className="mockup-diff-new-file-stage absolute inset-0 rounded-lg overflow-hidden bg-black">
              <iframe
                ref={afterFrameRef}
                title="New mockup preview"
                sandbox="allow-scripts allow-same-origin"
                className="absolute inset-0 w-full h-full border-none"
              />
            </div>
          </div>
        ) : (
          // Modified file: show slider diff view
          <div className="mockup-diff-slider-wrapper relative flex-1 min-h-0 m-4">
            <div
              className={`mockup-diff-slider-stage absolute inset-0 rounded-lg overflow-hidden bg-black cursor-ew-resize ${isDragging ? 'dragging cursor-grabbing' : ''}`}
              ref={sliderStageRef}
            >
              <iframe
                ref={afterFrameRef}
                title="Updated mockup preview"
                sandbox="allow-scripts allow-same-origin"
                className="absolute inset-0 w-full h-full border-none"
              />
              <div
                className="mockup-diff-slider-before absolute inset-0 w-full h-full overflow-hidden border-r border-white/50 pointer-events-none"
                style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
              >
                <iframe
                  ref={beforeFrameRef}
                  title="Original mockup preview"
                  sandbox="allow-scripts allow-same-origin"
                  className="absolute inset-0 w-full h-full border-none"
                />
              </div>
              <div
                className="mockup-diff-slider-handle absolute top-0 bottom-0 w-0.5 bg-white/80 border border-gray-500/75 pointer-events-auto cursor-ew-resize z-[6]"
                style={{ left: `${sliderPosition}%` }}
                role="slider"
                aria-valuenow={sliderPosition}
                aria-valuemin={0}
                aria-valuemax={100}
                onPointerDown={handleSliderPointerDown}
              >
                <div className="mockup-diff-slider-handle-bar absolute top-1/2 -left-2.5 w-5 h-10 bg-white/90 rounded-full border-2 border-gray-500/75 -translate-y-1/2 -translate-x-1/2" />
              </div>
              <div className="mockup-diff-slider-label before absolute top-3 left-4 py-1 px-2.5 text-[11px] uppercase tracking-wide rounded-full text-white z-[6]" style={{ backgroundColor: 'rgba(0, 0, 0, 0.8)', boxShadow: '0 2px 4px rgba(0,0,0,0.3)' }}>Before</div>
              <div className="mockup-diff-slider-label after absolute top-3 right-4 py-1 px-2.5 text-[11px] uppercase tracking-wide rounded-full text-white z-[6]" style={{ backgroundColor: 'rgba(0, 0, 0, 0.8)', boxShadow: '0 2px 4px rgba(0,0,0,0.3)' }}>After</div>
              <div className="mockup-diff-slider-hint absolute bottom-3 left-1/2 -translate-x-1/2 text-white text-xs py-1 px-2.5 rounded-full pointer-events-none z-[6]" style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}>Drag anywhere to compare</div>
              <div
                className="mockup-diff-slider-overlay absolute inset-0 z-[5] cursor-ew-resize"
                onPointerDown={handleSliderPointerDown}
                aria-hidden="true"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
