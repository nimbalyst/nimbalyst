/**
 * Custom Editor Types
 *
 * All custom editors now use the EditorHost API from @nimbalyst/runtime.
 * This file re-exports the necessary types for backward compatibility.
 */

import type { ComponentType } from 'react';
import type { EditorHostProps } from '@nimbalyst/runtime';

// Re-export for use in custom editors
export type { EditorHostProps };

/**
 * Custom editor component type - accepts EditorHostProps
 */
export type CustomEditorComponent = ComponentType<EditorHostProps>;

/**
 * Custom editor registration entry
 */
export interface CustomEditorRegistration {
  // File extensions this editor handles (e.g., ['.mockup.html'])
  extensions: string[];

  // The React component to render
  component: CustomEditorComponent;

  // Optional: Display name for debugging
  name?: string;

  // Optional: Whether this editor supports AI editing via EditorRegistry
  supportsAI?: boolean;

  // Optional: Whether this editor supports source mode (viewing/editing raw content in Monaco)
  supportsSourceMode?: boolean;

  // Optional: Whether this editor supports the host AI diff review UI
  supportsDiffMode?: boolean;

  // Optional: Whether to show the host-provided document header above the editor
  showDocumentHeader?: boolean;

  // Optional: Whether this editor renders inline in the agent transcript for AI edits
  supportsTranscriptEmbed?: boolean;

  // Optional: Preferred height (px) for the inline transcript embed (default 360)
  transcriptEmbedHeight?: number;

  // Optional: Extension ID for error attribution (added automatically for extension-provided editors)
  extensionId?: string;

  // Optional: Component name for error attribution
  componentName?: string;

  // Optional: Collaboration support, mirrors the manifest contribution. When
  // `supported: true`, opening this file via a `collab://` URI routes through
  // `CollaborativeTabEditor` and the editor receives a populated
  // `host.collaboration` (extension uses `useCollaborativeEditor` from the SDK).
  collaboration?: {
    supported: boolean;
    awarenessFields?: string[];
  };
}
