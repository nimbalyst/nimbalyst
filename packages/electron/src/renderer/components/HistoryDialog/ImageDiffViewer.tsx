import React, { useState } from 'react';
import { nimAssetUrl } from '../../utils/assetUrl';

interface ImageDiffViewerProps {
  oldImagePath: string;
  newImagePath: string;
  filePath: string;
}

type ViewMode = 'side-by-side' | 'swipe' | 'onion-skin';

export function ImageDiffViewer({
  oldImagePath,
  newImagePath,
  filePath
}: ImageDiffViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  const [swipePosition, setSwipePosition] = useState(50);
  const [opacity, setOpacity] = useState(50);

  return (
    <div className="image-diff-viewer flex flex-col h-full w-full overflow-hidden bg-[var(--nim-bg-secondary)]">
      <div className="image-diff-controls flex items-center gap-4 px-4 py-3 border-b border-[var(--nim-border)] bg-[var(--nim-bg)]">
        <div className="image-diff-mode-toggle flex gap-1">
          <button
            className={`image-diff-mode-button px-3 py-1.5 text-[13px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-all duration-200 hover:bg-[var(--nim-bg-hover)] ${viewMode === 'side-by-side' ? 'active !bg-[var(--nim-primary)] !text-white !border-[var(--nim-primary)]' : ''}`}
            onClick={() => setViewMode('side-by-side')}
          >
            Side by Side
          </button>
          <button
            className={`image-diff-mode-button px-3 py-1.5 text-[13px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-all duration-200 hover:bg-[var(--nim-bg-hover)] ${viewMode === 'swipe' ? 'active !bg-[var(--nim-primary)] !text-white !border-[var(--nim-primary)]' : ''}`}
            onClick={() => setViewMode('swipe')}
          >
            Swipe
          </button>
          <button
            className={`image-diff-mode-button px-3 py-1.5 text-[13px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-all duration-200 hover:bg-[var(--nim-bg-hover)] ${viewMode === 'onion-skin' ? 'active !bg-[var(--nim-primary)] !text-white !border-[var(--nim-primary)]' : ''}`}
            onClick={() => setViewMode('onion-skin')}
          >
            Overlay
          </button>
        </div>

        {viewMode === 'swipe' && (
          <div className="image-diff-slider-container flex items-center gap-2 ml-auto">
            <label className="text-[13px] text-[var(--nim-text-muted)]">Position</label>
            <input
              type="range"
              min="0"
              max="100"
              value={swipePosition}
              onChange={(e) => setSwipePosition(Number(e.target.value))}
              className="image-diff-slider w-[150px]"
            />
          </div>
        )}

        {viewMode === 'onion-skin' && (
          <div className="image-diff-slider-container flex items-center gap-2 ml-auto">
            <label className="text-[13px] text-[var(--nim-text-muted)]">Opacity</label>
            <input
              type="range"
              min="0"
              max="100"
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="image-diff-slider w-[150px]"
            />
          </div>
        )}
      </div>

      <div className="image-diff-content flex-1 overflow-auto flex items-center justify-center">
        {viewMode === 'side-by-side' && (
          <div className="image-diff-side-by-side flex gap-4 w-full h-full p-4">
            <div className="image-diff-panel flex-1 flex flex-col min-w-0">
              <div className="image-diff-label text-[13px] font-medium text-[var(--nim-text-muted)] mb-2 text-center">Old Version</div>
              <div className="image-diff-container flex-1 flex items-center justify-center bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded overflow-auto p-4 [&_img]:max-w-full [&_img]:max-h-full [&_img]:object-contain [&_img]:block">
                <img src={nimAssetUrl(oldImagePath)} alt="Old version" />
              </div>
            </div>
            <div className="image-diff-panel flex-1 flex flex-col min-w-0">
              <div className="image-diff-label text-[13px] font-medium text-[var(--nim-text-muted)] mb-2 text-center">New Version</div>
              <div className="image-diff-container flex-1 flex items-center justify-center bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded overflow-auto p-4 [&_img]:max-w-full [&_img]:max-h-full [&_img]:object-contain [&_img]:block">
                <img src={nimAssetUrl(newImagePath)} alt="New version" />
              </div>
            </div>
          </div>
        )}

        {viewMode === 'swipe' && (
          <div className="image-diff-swipe w-full h-full flex items-center justify-center p-4">
            <div className="image-diff-swipe-container relative max-w-full max-h-full inline-block">
              <img
                src={nimAssetUrl(newImagePath)}
                alt="New version"
                className="image-diff-swipe-new block max-w-full max-h-[calc(100vh-300px)] object-contain"
              />
              <div
                className="image-diff-swipe-old-wrapper absolute top-0 left-0 w-full h-full overflow-hidden"
                style={{ clipPath: `inset(0 ${100 - swipePosition}% 0 0)` }}
              >
                <img
                  src={nimAssetUrl(oldImagePath)}
                  alt="Old version"
                  className="image-diff-swipe-old block max-w-full max-h-[calc(100vh-300px)] object-contain"
                />
              </div>
              <div
                className="image-diff-swipe-divider absolute top-0 bottom-0 w-0.5 bg-[var(--nim-primary)] cursor-ew-resize z-10 before:content-[''] before:absolute before:top-1/2 before:left-1/2 before:-translate-x-1/2 before:-translate-y-1/2 before:w-8 before:h-8 before:bg-[var(--nim-primary)] before:rounded-full before:shadow-[0_2px_8px_rgba(0,0,0,0.2)]"
                style={{ left: `${swipePosition}%` }}
              />
            </div>
          </div>
        )}

        {viewMode === 'onion-skin' && (
          <div className="image-diff-overlay w-full h-full flex items-center justify-center p-4">
            <div className="image-diff-overlay-container relative max-w-full max-h-full inline-block">
              <img
                src={nimAssetUrl(newImagePath)}
                alt="New version"
                className="image-diff-overlay-new block max-w-full max-h-[calc(100vh-300px)] object-contain"
              />
              <img
                src={nimAssetUrl(oldImagePath)}
                alt="Old version"
                className="image-diff-overlay-old absolute top-0 left-0 block max-w-full max-h-[calc(100vh-300px)] object-contain mix-blend-difference"
                style={{ opacity: opacity / 100 }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
