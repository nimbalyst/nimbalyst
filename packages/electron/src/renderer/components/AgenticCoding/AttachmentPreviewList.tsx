import React from 'react';
import type { ChatAttachment } from '@nimbalyst/runtime';
import { AttachmentPreview, ProcessingAttachmentPreview } from './AttachmentPreview';
// import './AttachmentPreview.css';

export interface ProcessingAttachment {
  id: string;
  filename: string;
}

interface AttachmentPreviewListProps {
  attachments: ChatAttachment[];
  onRemove: (attachmentId: string) => void;
  onConvertToText?: (attachment: ChatAttachment) => void;
  processingAttachments?: ProcessingAttachment[];
}

export function AttachmentPreviewList({ attachments, onRemove, onConvertToText, processingAttachments = [] }: AttachmentPreviewListProps) {
  if (attachments.length === 0 && processingAttachments.length === 0) {
    return null;
  }

  return (
    <div className="attachment-preview-list">
      {/* Show processing attachments first */}
      {processingAttachments.map(processing => (
        <ProcessingAttachmentPreview
          key={processing.id}
          filename={processing.filename}
        />
      ))}
      {/* Then show completed attachments */}
      {attachments.map(attachment => (
        <AttachmentPreview
          key={attachment.id}
          attachment={attachment}
          onRemove={onRemove}
          onConvertToText={onConvertToText}
        />
      ))}
    </div>
  );
}
