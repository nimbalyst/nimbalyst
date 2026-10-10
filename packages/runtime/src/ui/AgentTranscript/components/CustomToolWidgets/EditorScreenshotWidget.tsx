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

import React, { useState, useEffect, useMemo } from 'react';
import type { CustomToolWidgetProps } from './index';
import { parseToolResult } from '../../../../ai/server/transcript/toolResultParser';
import { FullscreenModal } from '../FullscreenModal';
import { ZoomableImageSurface } from '../ZoomableImageSurface';

/**
 * Extract a display name from a file path
 * e.g., "/path/to/my_mockup.mockup.html" -> "my_mockup.mockup.html"
 *       "/path/to/diagram.excalidraw" -> "diagram.excalidraw"
 */
function extractFileName(filePath: string): string {
  if (!filePath) return 'screenshot';

  // Get the filename from the path
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1] || '';

  return filename || 'screenshot';
}

/**
 * Extract the base64 image data from the tool result
 *
 * The MCP format returns: { type: 'image', source: { type: 'base64', data: '...', media_type: 'image/png' } }
 */
function extractImageData(result: any): { imageBase64: string; mimeType: string } | null {
  if (!result) return null;

  // Handle array of content blocks (MCP format)
  if (Array.isArray(result)) {
    for (const block of result) {
      // New MCP format: { type: 'image', source: { type: 'base64', data: '...', media_type: '...' } }
      if (block.type === 'image' && block.source?.data) {
        return {
          imageBase64: block.source.data,
          mimeType: block.source.media_type || 'image/png'
        };
      }
      // Old format: { type: 'image', data: '...', mimeType: '...' }
      if (block.type === 'image' && block.data) {
        return {
          imageBase64: block.data,
          mimeType: block.mimeType || 'image/png'
        };
      }
    }
    return null;
  }

  // Handle content wrapper object
  if (result.content && Array.isArray(result.content)) {
    for (const block of result.content) {
      // New MCP format
      if (block.type === 'image' && block.source?.data) {
        return {
          imageBase64: block.source.data,
          mimeType: block.source.media_type || 'image/png'
        };
      }
      // Old format
      if (block.type === 'image' && block.data) {
        return {
          imageBase64: block.data,
          mimeType: block.mimeType || 'image/png'
        };
      }
    }
    return null;
  }

  // Handle direct image data
  if (result.imageBase64) {
    return {
      imageBase64: result.imageBase64,
      mimeType: result.mimeType || 'image/png'
    };
  }

  return null;
}

/**
 * Check if the tool result contains a persisted-output reference
 * Claude Code saves large outputs to files with this format:
 * <persisted-output>Output too large (2MB). Full output saved to: /path/to/file</persisted-output>
 */
function isPersistedOutput(result: any): boolean {
  if (typeof result === 'string') {
    return result.includes('<persisted-output>');
  }

  // Handle array of content blocks
  if (Array.isArray(result)) {
    for (const block of result) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.includes('<persisted-output>')) {
        return true;
      }
    }
  }

  // Handle content wrapper object
  if (result?.content && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.includes('<persisted-output>')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract the file path from a persisted-output reference
 */
function extractPersistedFilePath(result: any): string | null {
  const extractFromText = (text: string): string | null => {
    const match = text.match(/<persisted-output>[^]*?Full output saved to:\s*([^\s<]+)/);
    return match ? match[1] : null;
  };

  if (typeof result === 'string') {
    return extractFromText(result);
  }

  // Handle array of content blocks
  if (Array.isArray(result)) {
    for (const block of result) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const path = extractFromText(block.text);
        if (path) return path;
      }
    }
  }

  // Handle content wrapper object
  if (result?.content && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const path = extractFromText(block.text);
        if (path) return path;
      }
    }
  }

  return null;
}

/**
 * Parse image data from a persisted output file's JSON content
 */
function parsePersistedImageData(fileContent: string): { imageBase64: string; mimeType: string } | null {
  try {
    const parsed = JSON.parse(fileContent);

    // The file contains an array of MCP content blocks
    const blocks = Array.isArray(parsed) ? parsed : parsed?.content;
    if (!Array.isArray(blocks)) return null;

    for (const block of blocks) {
      // MCP format: { type: 'image', source: { type: 'base64', data: '...', media_type: '...' } }
      if (block.type === 'image' && block.source?.data) {
        return {
          imageBase64: block.source.data,
          mimeType: block.source.media_type || 'image/png'
        };
      }
      // Old format: { type: 'image', data: '...', mimeType: '...' }
      if (block.type === 'image' && block.data) {
        return {
          imageBase64: block.data,
          mimeType: block.mimeType || 'image/png'
        };
      }
    }
  } catch {
    // Failed to parse JSON
  }

  return null;
}

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
  const [loadingPersistedFile, setLoadingPersistedFile] = useState(false);
  const [persistedImageData, setPersistedImageData] = useState<{ imageBase64: string; mimeType: string } | null>(null);
  const [persistedLoadError, setPersistedLoadError] = useState<string | null>(null);

  const tool = message.toolCall;

  // Canonical transcript stores tool results as strings -- JSON-stringified for
  // MCP content arrays (including image blocks). Parse once so the array/object
  // helpers below can match. The result can be ~700 KB of base64, so parse and
  // build the data URL only when it changes, not on every transcript render.
  const hasTool = !!tool;
  const toolResult = tool?.result;
  const parsedResult = useMemo(() => (hasTool ? parseToolResult(toolResult) : undefined), [hasTool, toolResult]);

  // Check if result is a persisted-output reference
  const isPersisted = tool ? isPersistedOutput(parsedResult) : false;
  const persistedFilePath = isPersisted && tool ? extractPersistedFilePath(parsedResult) : null;

  // Load image data from persisted file
  useEffect(() => {
    if (!persistedFilePath) return;
    if (!readFile) {
      setPersistedLoadError('File reading not available');
      return;
    }

    const loadPersistedFile = async () => {
      setLoadingPersistedFile(true);
      setPersistedLoadError(null);

      try {
        const result = await readFile(persistedFilePath);
        if (!result.success || !result.content) {
          throw new Error(result.error || 'Failed to read file');
        }

        const imageData = parsePersistedImageData(result.content);
        if (!imageData) {
          throw new Error('Could not parse image data from file');
        }

        setPersistedImageData(imageData);
      } catch (err) {
        setPersistedLoadError(err instanceof Error ? err.message : 'Failed to load image');
      } finally {
        setLoadingPersistedFile(false);
      }
    };

    loadPersistedFile();
  }, [persistedFilePath, readFile]);

  const inlineImageData = useMemo(() => extractImageData(parsedResult), [parsedResult]);
  const imageData = inlineImageData || persistedImageData;
  const imageSrc = useMemo(
    () => (imageData ? `data:${imageData.mimeType};base64,${imageData.imageBase64}` : null),
    [imageData],
  );

  if (!tool) return null;

  // Extract file path from arguments and get display name
  const args = tool.arguments as Record<string, any> | undefined;
  const filePath = (args?.file_path || args?.filePath || '') as string;
  const fileName = extractFileName(filePath);

  // Log image source and size for debugging
  if (imageData) {
    const source = inlineImageData ? 'inline' : 'file-system';
    const sizeBytes = Math.floor((imageData.imageBase64.length * 3) / 4);
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
    // console.log(`[EditorScreenshotWidget] Image loaded: ${sizeMB} MB, source: ${source}, mimeType: ${imageData.mimeType}`);
  }

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
      {imageSrc && !loadingPersistedFile && (
        <button
          className="w-full p-0 m-0 border-0 border-t border-nim bg-nim-tertiary cursor-pointer overflow-hidden block transition-opacity duration-200 hover:opacity-90"
          onClick={() => setShowLightbox(true)}
          title="Click to enlarge"
        >
          <img
            src={imageSrc}
            alt={fileName}
            className="w-full max-h-[400px] object-contain object-top-left"
          />
        </button>
      )}

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
