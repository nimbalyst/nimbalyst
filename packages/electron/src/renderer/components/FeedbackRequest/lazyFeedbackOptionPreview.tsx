/**
 * The option-card preview renderer, one module boundary further out.
 *
 * `FeedbackOptionArtifactPreview` already loads the collaborative *editor*
 * lazily, but resolving which editor to mount is synchronous and reaches the
 * custom-editor registry, which reaches the renderer logger, which reaches
 * `electron-log/renderer`. That chain lands in the module graph of every
 * surface that can show a request — the Inbox, the shared area's feedback list —
 * whether or not any option has an artifact bound to it, and most requests bind
 * none.
 *
 * So the preview module itself is behind a lazy boundary here, and the
 * "no artifact means no preview" contract is preserved above it: an unbound
 * option still returns `undefined` synchronously and keeps the card's own
 * placeholder path, and a bound one shows the same placeholder as the Suspense
 * fallback while the chunk loads.
 *
 * Renderer-only. The no-dynamic-import rule covers the Electron main process.
 */

import React from 'react';
import type {
  FeedbackAskArtifact,
  StructuredInputSingleSelectOption,
} from '@nimbalyst/collab-protocol';
import { FeedbackOptionPlaceholderPreview } from '@nimbalyst/collab-client/feedback-ui';

const LazyFeedbackOptionArtifactPreview = React.lazy(async () => ({
  default: (await import('./FeedbackOptionArtifactPreview'))
    .FeedbackOptionArtifactPreview,
}));

export function renderLazyFeedbackOptionPreview(
  option: StructuredInputSingleSelectOption,
  _index: number,
  artifact?: FeedbackAskArtifact,
): React.ReactNode {
  if (!artifact) return undefined;
  return (
    <React.Suspense
      key={artifact.ref.sourceId}
      fallback={(
        <FeedbackOptionPlaceholderPreview
          label={option.label}
          artifactLabel={artifact.label}
        />
      )}
    >
      <LazyFeedbackOptionArtifactPreview
        artifact={artifact}
        optionLabel={option.label}
      />
    </React.Suspense>
  );
}
