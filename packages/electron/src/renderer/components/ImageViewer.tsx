/**
 * ImageViewer - Simple image display component for standalone image files
 *
 * Displays image files (PNG, JPG, GIF, SVG, etc.) in the editor area.
 * Does not use Lexical - this is for viewing image files directly.
 */

import React, { useEffect, useState } from 'react';
import { ZoomableImageSurface } from '@nimbalyst/runtime/ui/AgentTranscript/components/ZoomableImageSurface';
import { nimAssetUrl } from '../utils/assetUrl';
import { DiskChangeSubscription } from '../services/document-model/DiskChangeSubscription';

interface ImageViewerProps {
  filePath: string;
  fileName: string;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({ filePath, fileName }) => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const absolute = filePath.startsWith('file://') ? filePath.replace(/^file:\/\//, '') : filePath;
    // #1543: the path stays the same after an overwrite. A new URL forces a
    // fresh image request, including after remounts and renderer reloads.
    const freshUrl = () => `${nimAssetUrl(absolute)}?revision=${crypto.randomUUID()}`;
    const showImage = (url: string) => {
      setImageSrc(url);
      setError(null);
      setDimensions(null);
    };
    showImage(freshUrl());
    const subscription = new DiskChangeSubscription(
      absolute,
      // The asset protocol streams the bytes; don't decode binary images as
      // text through DocumentModel just to invalidate their preview.
      async () => freshUrl(),
      ({ content }) => showImage(content as string),
      () => setError('Image file no longer exists'),
    );
    return () => subscription.dispose();
  }, [filePath]);

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
    <div className="h-full bg-nim">
      <ZoomableImageSurface
        src={imageSrc}
        alt={fileName}
        copyFilePath={filePath}
        className="h-full"
        toolbarLabel={(
          <div className="flex min-w-0 items-center gap-3 text-xs text-nim-muted">
            <span className="truncate text-sm text-nim" title={fileName}>{fileName}</span>
            {dimensions ? (
              <span className="shrink-0 font-mono">
                {dimensions.width} × {dimensions.height}
              </span>
            ) : null}
          </div>
        )}
        onImageLoad={setDimensions}
        onImageError={handleImageError}
        imageClassName="shadow-none"
      />
    </div>
  );
};
