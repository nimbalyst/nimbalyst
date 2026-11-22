/**
 * Custom widget for the capture_editor_screenshot MCP tool
 *
 * Displays a preview of the captured editor screenshot with:
 * - Large inline image preview (click to open lightbox)
 * - File path information
 * - Success/error status badge
 * - Full-size lightbox modal
 *
 * Handles both inline base64 images and persisted-output files
 * (when Claude Code saves large outputs to files).
 */

import React, { useState } from 'react';
import type { CustomToolWidgetProps } from './index';
import { FullscreenModal } from '../FullscreenModal';
import { ZoomableImageSurface } from '../ZoomableImageSurface';
import { useEditorScreenshotImage } from './editorScreenshotImage';
import { useRememberedImageHeight } from './rememberedImageHeight';
import { useTranscriptImageGallery } from '../transcriptImageGalleryContext';
import { screenshotFileName, screenshotImageKey } from '../../utils/transcriptImages';

/**
 * Check if the tool result indicates an error
 */
function isToolError(result: any, message: any): boolean {
  // Check message-level error flag
  if (message.isError) return true;

  // Check result-level isError flag (MCP response format)
  if (result?.isError === true) return true;

  return false;
}

/**
 * Extract error message from tool result
 */
function extractErrorMessage(result: any, message: any): string | null {
  // Only extract error message if there's actually an error
  if (!isToolError(result, message)) return null;

  if (message.errorMessage) {
    return message.errorMessage;
  }

  if (!result) return null;

  // Handle array of content blocks - look for error text
  if (Array.isArray(result)) {
    for (const block of result) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }

  // Handle content wrapper object
  if (result.content && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }

  // Handle direct error field
  if (result.error) {
    return typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
  }

  return null;
}

export const EditorScreenshotWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  workspacePath,
  readFile
}) => {
  const [showLightbox, setShowLightbox] = useState(false);
  const gallery = useTranscriptImageGallery();
  const { parsedResult, imageSrc, loading: loadingPersistedFile, persistedLoadError } = useEditorScreenshotImage(message, readFile);
  const imageHeight = useRememberedImageHeight(screenshotImageKey(message.id));

  const tool = message.toolCall;
  if (!tool) return null;

  const args = tool.arguments as Record<string, any> | undefined;
  const filePath = (args?.file_path || args?.filePath || '') as string;
  const fileName = screenshotFileName(message);
  const openLightbox = () => {
    if (!gallery?.openImage(screenshotImageKey(message.id))) setShowLightbox(true);
  };

  const hasError = isToolError(parsedResult, message);
  const errorMessage = extractErrorMessage(parsedResult, message) || persistedLoadError;

  return (
    <div className="editor-screenshot-widget rounded bg-nim-secondary border border-nim overflow-hidden">
      <div className="flex items-center gap-2 p-2">
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="text-xs text-nim-faint font-medium">Editor Screenshot</span>
          <span className="font-mono text-sm text-nim font-semibold overflow-hidden text-ellipsis whitespace-nowrap" title={filePath}>
            {fileName}
          </span>
        </div>
        {/* Loading spinner when loading from persisted file */}
        {loadingPersistedFile && (
          <div className="w-5 h-5 shrink-0 flex items-center justify-center" title="Loading image...">
            <div className="w-4 h-4 border-2 border-nim border-t-nim-primary rounded-full animate-spin" />
          </div>
        )}
        {/* Show error badge if there was an error */}
        {hasError && !loadingPersistedFile && (
          <span className="text-[0.7rem] font-semibold py-0.5 px-2 rounded-full uppercase tracking-wide shrink-0 text-nim-error bg-[color-mix(in_srgb,var(--nim-error)_15%,transparent)]">
            Failed
          </span>
        )}
      </div>

      {/* Large inline image preview */}
      <div ref={imageHeight.ref} style={imageHeight.style} className="editor-screenshot-preview">
        {imageSrc && !loadingPersistedFile && (
          <button
            className="w-full p-0 m-0 border-0 border-t border-nim bg-nim-tertiary cursor-pointer overflow-hidden block transition-opacity duration-200 hover:opacity-90"
            onClick={openLightbox}
            title="Click to enlarge"
          >
            <img
              src={imageSrc}
              alt={fileName}
              className="w-full max-h-[400px] object-contain object-top-left"
              onLoad={imageHeight.onImageLoad}
              onError={imageHeight.onImageError}
            />
          </button>
        )}
      </div>

      {errorMessage && (
        <div className="mx-2 mb-2 p-2 bg-[color-mix(in_srgb,var(--nim-error)_10%,transparent)] border border-[color-mix(in_srgb,var(--nim-error)_30%,transparent)] rounded text-nim-error text-xs leading-relaxed">
          {errorMessage}
        </div>
      )}

      {/* Lightbox modal. Portaled to document.body so a transformed or
          contained transcript ancestor can't clip it to the transcript pane. */}
      {imageSrc && (
        <FullscreenModal
          isOpen={showLightbox}
          onClose={() => setShowLightbox(false)}
          ariaLabel="Image preview"
          contentClassName="h-[92dvh] w-[96vw] max-w-[1400px] overflow-hidden rounded-lg border border-nim bg-nim shadow-2xl"
        >
            <ZoomableImageSurface
              src={imageSrc}
              alt={fileName}
              toolbarLabel={(
                <div className="min-w-0 truncate font-mono text-sm text-nim" title={fileName}>
                  {fileName}
                </div>
              )}
              toolbarExtras={(
                <button
                  type="button"
                  className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-xs text-[var(--nim-text)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                  onClick={() => setShowLightbox(false)}
                  aria-label="Close (Escape)"
                  title="Close (Escape)"
                >
                  Close
                </button>
              )}
            />
        </FullscreenModal>
      )}
    </div>
  );
};

/** @deprecated Use EditorScreenshotWidget instead */
export const MockupScreenshotWidget = EditorScreenshotWidget;
