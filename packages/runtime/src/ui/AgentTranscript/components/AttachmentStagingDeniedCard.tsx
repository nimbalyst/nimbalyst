import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { SystemMessagePayload, UserMessagePayload } from '../../../ai/server/transcript/types';
import { interactiveWidgetHostAtom } from '../../../store/atoms/interactiveWidgetHost';
import { MaterialSymbol } from '../../icons/MaterialSymbol';

interface AttachmentStagingDeniedCardProps {
  sessionId: string;
  systemMessage: SystemMessagePayload;
  prompt: string;
  attachments: NonNullable<UserMessagePayload['attachments']>;
}

export function AttachmentStagingDeniedCard({
  sessionId,
  systemMessage,
  prompt,
  attachments,
}: AttachmentStagingDeniedCardProps) {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const [gitignoreOffered, setGitignoreOffered] = useState(false);
  const [addGitignore, setAddGitignore] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void host?.getAttachmentStagingGitignoreStatus?.().then((status) => {
      if (!cancelled) setGitignoreOffered(status.shouldOffer);
    });
    return () => { cancelled = true; };
  }, [host]);

  const retry = async () => {
    if (!host?.retryAttachmentStaging || attachments.length === 0 || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await host.retryAttachmentStaging(prompt, attachments, gitignoreOffered && addGitignore);
      if (!result.success) setError(result.error ?? 'Could not re-stage the attachment.');
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="attachment-staging-denied-card mx-3 my-2 rounded-lg border border-[var(--nim-warning)] bg-[var(--nim-bg-secondary)] p-3">
      <div className="flex items-start gap-2">
        <MaterialSymbol icon="folder_off" size={20} className="mt-0.5 shrink-0 text-[var(--nim-warning)]" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[var(--nim-text)]">Attachment directory blocked</div>
          <p className="select-text m-0 mt-1 text-sm text-[var(--nim-text-muted)]">
            Claude Code could not read {systemMessage.attachmentFilename ?? 'an attachment'} from the current staging directory.
          </p>
          {systemMessage.attachmentDenyRule && (
            <p className="select-text m-0 mt-1 break-all font-mono text-xs text-[var(--nim-text-faint)]">
              {systemMessage.attachmentDenyRule}
            </p>
          )}
          {gitignoreOffered && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-[var(--nim-text-muted)]">
              <input
                type="checkbox"
                checked={addGitignore}
                onChange={(event) => setAddGitignore(event.target.checked)}
              />
              Add nimbalyst-local/attachments/ to .gitignore
            </label>
          )}
          {error && <p className="select-text m-0 mt-2 text-sm text-[var(--nim-error)]">{error}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="nim-btn-primary"
              disabled={submitting || !host?.retryAttachmentStaging || attachments.length === 0}
              onClick={retry}
            >
              {submitting ? 'Moving attachments…' : 'Move attachments into the workspace and retry'}
            </button>
            <button
              type="button"
              className="nim-btn-secondary"
              onClick={() => host?.openAttachmentSettings?.()}
            >
              Attachment settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
