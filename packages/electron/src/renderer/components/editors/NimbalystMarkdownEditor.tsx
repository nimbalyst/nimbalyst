/**
 * NimbalystMarkdownEditor - Pre-configured MarkdownEditor for extensions.
 *
 * Wraps the raw MarkdownEditor with Nimbalyst platform integrations so
 * extensions get the full editing experience without manual wiring:
 * - Image double-click opens in default app
 * - Image drag triggers native drag
 * - Toolbar enabled by default
 *
 * Extensions import this as `MarkdownEditor` from '@nimbalyst/runtime'.
 */

import React, { useCallback } from 'react';
import { MarkdownEditor, type MarkdownEditorProps } from '@nimbalyst/runtime/editors';

export function NimbalystMarkdownEditor({
  host,
  config = {},
  ...rest
}: MarkdownEditorProps): React.ReactElement {
  const handleImageDoubleClick = useCallback(async (src: string, _nodeKey: string) => {
    try {
      await window.electronAPI.openImageInDefaultApp(src);
    } catch (error) {
      console.error('[NimbalystMarkdownEditor] Failed to open image:', error);
    }
  }, []);

  const handleImageDragStart = useCallback(async (src: string, _event: DragEvent) => {
    try {
      await window.electronAPI.startImageDrag(src);
    } catch (error) {
      console.error('[NimbalystMarkdownEditor] Failed to start image drag:', error);
    }
  }, []);

  return (
    <MarkdownEditor
      host={host}
      config={{
        showToolbar: true,
        editable: host.readOnly ? false : true,
        onImageDoubleClick: handleImageDoubleClick,
        onImageDragStart: handleImageDragStart,
        ...config, // Extension overrides take precedence
      }}
      {...rest}
    />
  );
}
