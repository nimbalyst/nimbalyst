/**
 * Codex's built-in image tool (`imageGeneration` app-server item). The parser
 * reduces the item to `{ savedPath, revisedPrompt }` (or `{ data }` when Codex
 * wrote no file); this widget shows that image through VisualDisplayWidget so
 * it gets the same gallery, lightbox, and load-error handling as
 * `display_to_user`.
 */

import React from 'react';
import { VisualDisplayWidget } from './VisualDisplayWidget';
import type { CustomToolWidgetProps } from './index';

export interface ImageGenerationResult {
  savedPath?: string;
  data?: string;
  revisedPrompt?: string;
}

// A PNG's base64 starts with these characters (the encoded file signature).
const PNG_BASE64_PREFIX = 'iVBORw0KGgo';

export function parseImageGenerationResult(result: unknown): ImageGenerationResult | null {
  if (typeof result !== 'string') return null;
  // A parser older than this widget passes Codex's raw base64 PNG through as
  // the result (a main process not yet restarted, or an older synced client).
  if (result.startsWith(PNG_BASE64_PREFIX)) return { data: result };
  if (!result.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(result) as ImageGenerationResult;
    return parsed.savedPath || parsed.data ? parsed : null;
  } catch {
    return null;
  }
}

export const CodexImageGenerationWidget: React.FC<CustomToolWidgetProps> = (props) => {
  const tool = props.message.toolCall;
  if (!tool) return null;

  const image = parseImageGenerationResult(tool.result);
  if (!image) {
    const failed = props.message.isError;
    const errorText = typeof tool.result === 'string' && tool.result.length <= 500 ? tool.result : '';
    return (
      <div className="codex-image-generation-widget text-sm py-1">
        <span className={failed ? 'text-nim-error' : 'text-nim-muted'}>
          {failed
            ? errorText || 'Image generation failed'
            : tool.result ? 'Generated an image (no preview available)' : 'Generating image...'}
        </span>
      </div>
    );
  }

  const displayMessage = {
    ...props.message,
    toolCall: {
      ...tool,
      arguments: {
        items: [{
          description: image.revisedPrompt || 'Generated image',
          image: { path: image.savedPath || 'generated-image.png', data: image.data, mimeType: 'image/png' },
        }],
      },
    },
  };

  return (
    <div className="codex-image-generation-widget">
      <VisualDisplayWidget {...props} message={displayMessage} />
    </div>
  );
};
