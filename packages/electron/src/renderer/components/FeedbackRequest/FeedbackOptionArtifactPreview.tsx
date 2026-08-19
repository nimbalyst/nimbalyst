/**
 * The desktop app's answer to "what does this option look like".
 *
 * Renders the artifact itself -- the real shared document, through its real
 * editor -- scaled into the option card's preview panel. That is the whole
 * point of binding a resource to an option: "which of these three do you like"
 * is a visual question, and three labels do not answer it.
 *
 * What it deliberately does *not* do is guess. Every step here can decline:
 *
 * - a non-`document` ref has nothing to open (a `file` ref never reaches a
 *   recipient; publishing rewrites it)
 * - the shared-document index may not have this id yet
 * - the document's type may have no registered editor in this build
 * - the mount may be gated by visibility or the concurrent-preview cap
 *
 * Every one of those returns `undefined`, and the card falls through to its
 * titled placeholder. An empty scaled frame reads as a preview that broke; a
 * titled card reads as a preview that was never promised.
 */

import React from 'react';
import { useAtomValue } from 'jotai';
import type { FeedbackAskArtifact } from '@nimbalyst/collab-protocol';
import {
  FeedbackOptionPlaceholderPreview,
  ScaledPreviewFrame,
  useLivePreviewSlot,
} from '@nimbalyst/collab-client/feedback-ui';

import { sharedDocumentsAtom } from '../../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { resolveCollaborativeEmbedRequest } from '../EmbedFrame/resolveCollaborativeEmbedRequest';

/**
 * Lazy on purpose, and not for bundle size.
 *
 * `CollaborativeEmbedEditor` pulls the whole collaborative editor tree behind
 * it. A static import here puts that tree in the module graph of everything
 * that reaches the Inbox, including its tests, which turns a fast render test
 * into a multi-second module import. Most requests bind no artifact at all, so
 * the tree should load when a preview actually mounts and not before.
 *
 * Renderer-only. The no-dynamic-import rule covers the Electron main process.
 */
const CollaborativeEmbedEditor = React.lazy(async () => ({
  default: (await import('../EmbedFrame/CollaborativeEmbedEditor')).CollaborativeEmbedEditor,
}));

export const FeedbackOptionArtifactPreview: React.FC<{
  artifact: FeedbackAskArtifact;
  optionLabel: string;
}> = ({
  artifact,
  optionLabel,
}) => {
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const workspacePath = useAtomValue(activeWorkspacePathAtom);

  const resolution = React.useMemo(() => {
    if (artifact.ref.kind !== 'document' || !workspacePath) return null;
    const document = sharedDocuments.find(
      (candidate) => candidate.documentId === artifact.ref.sourceId,
    );
    if (!document) return null;
    const resolved = resolveCollaborativeEmbedRequest({
      orgId: artifact.ref.orgId,
      documentId: artifact.ref.sourceId,
      workspacePath,
      sharedTitle: document.title,
      sharedDocumentType: document.documentType,
      sharedFileExtension: document.fileExtension,
      sharedEditorId: document.editorId,
      fallbackTitle: artifact.label,
    });
    return resolved.status === 'ready' ? resolved : null;
  }, [artifact, sharedDocuments, workspacePath]);

  // The ref is attached whether or not we end up mounting, so the observer has
  // something to watch while the preview is still just a placeholder.
  const { ref, mounted } = useLivePreviewSlot<HTMLDivElement>(resolution !== null);

  return (
    <div ref={ref} className="feedback-option-artifact-preview h-full w-full">
      {mounted && resolution ? (
        <ScaledPreviewFrame>
          {/* The placeholder is the suspense fallback too, so the card looks
              the same while the editor chunk loads as it does when there is
              nothing to load. */}
          <React.Suspense
            fallback={(
              <FeedbackOptionPlaceholderPreview
                label={optionLabel}
                artifactLabel={artifact.label}
              />
            )}
          >
            <CollaborativeEmbedEditor
              registration={resolution.registration}
              request={resolution.request}
            />
          </React.Suspense>
        </ScaledPreviewFrame>
      ) : (
        // Covers both endings and deliberately looks the same for each: the
        // artifact cannot be rendered here, or has not been mounted yet. An
        // empty frame would read as a preview that broke.
        <FeedbackOptionPlaceholderPreview
          label={optionLabel}
          artifactLabel={artifact.label}
        />
      )}
    </div>
  );
};

/*
 * The `renderOptionPreview` a respond surface hands down lives in
 * `lazyFeedbackOptionPreview.tsx`, one module boundary out: the resolution
 * imports above are synchronous and reach the custom-editor registry, and a
 * surface that shows a request should not carry that tree for options that
 * usually bind no artifact at all. That module keeps the "no artifact means no
 * preview" contract.
 */
