/**
 * ImageViewer - Simple image display component for standalone image files
 *
 * Displays image files (PNG, JPG, GIF, SVG, etc.) in the editor area.
 * Does not use Lexical - this is for viewing image files directly.
 */

import React, { useEffect, useState } from 'react';
import { nimAssetUrl } from '../utils/assetUrl';

interface ImageViewerProps {
  filePath: string;
  fileName: string;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({ filePath, fileName }) => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const loadImage = async () => {
      try {
        // Issue #146: route through `nim-asset://` so the renderer stays
        // same-origin (lets `webSecurity: true` stay on the main window).
        // The main-process handler validates the path against allowlisted
        // workspace + userData roots.
        const absolute = filePath.startsWith('file://') ? filePath.replace(/^file:\/\//, '') : filePath;
        setImageSrc(nimAssetUrl(absolute));
        setError(null);
      } catch (err) {
        setError('Failed to load image');
        console.error('Error loading image:', err);
      }
    };

    loadImage();
  }, [filePath]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setDimensions({
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  };

  const handleImageError = () => {
    setError('Failed to load image');
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-nim-muted">
        <div className="text-center">
          <div className="text-5xl mb-4">📷</div>
          <div>{error}</div>
          <div className="text-xs mt-2 opacity-70">{fileName}</div>
        </div>
      </div>
    );
  }

  if (!imageSrc) {
    return (
      <div className="flex items-center justify-center h-full text-nim-muted">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-nim">
      {/* Info bar */}
      {dimensions && (
        <div className="px-4 py-2 bg-nim-secondary border-b border-nim text-nim-muted text-xs flex gap-4">
          <span>{fileName}</span>
          <span>
            {dimensions.width} × {dimensions.height}
          </span>
        </div>
      )}

      {/* Image container */}
      <div className="flex-1 flex items-center justify-center p-4">
        <img
          src={imageSrc}
          alt={fileName}
          onLoad={handleImageLoad}
          onError={handleImageError}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    </div>
  );
};
