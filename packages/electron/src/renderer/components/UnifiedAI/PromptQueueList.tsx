import React from 'react';

interface QueuedPromptAttachment {
  id: string;
  filename: string;
  type: 'image' | 'pdf' | 'document';
}

export interface QueuedPrompt {
  id: string;
  prompt: string;
  timestamp: number;
  attachments?: QueuedPromptAttachment[];
}

interface PromptQueueListProps {
  queue: QueuedPrompt[];
  onCancel: (id: string) => void;
  onEdit?: (id: string, prompt: string) => void;
  onSendNow?: (id: string, prompt: string) => void;
}

function AttachmentIndicator({ attachments }: { attachments: QueuedPromptAttachment[] }) {
  const imageCount = attachments.filter(a => a.type === 'image').length;
  const fileCount = attachments.length - imageCount;

  const label = attachments.map(a => a.filename).join(', ');

  return (
    <span className="prompt-queue-attachments shrink-0 flex items-center gap-1 text-[11px] text-nim-muted" title={label}>
      {imageCount > 0 && (
        <span className="flex items-center gap-0.5">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            <circle cx="5.5" cy="6.5" r="1" stroke="currentColor" strokeWidth="1"/>
            <path d="M2 11l3-3 2 2 3-3 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {imageCount > 1 && <span>{imageCount}</span>}
        </span>
      )}
      {fileCount > 0 && (
        <span className="flex items-center gap-0.5">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6L9 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {fileCount > 1 && <span>{fileCount}</span>}
        </span>
      )}
    </span>
  );
}

/**
- PromptQueueList - Displays queued prompts waiting to be processed
 */
export function PromptQueueList({ queue, onCancel, onEdit, onSendNow }: PromptQueueListProps) {
  if (queue.length === 0) {
    return null;
  }

  return (
    <div className="prompt-queue-list px-3 py-2 border-b border-nim bg-nim-secondary">
      <div className="prompt-queue-header flex items-center mb-1.5">
        <span className="prompt-queue-count text-[11px] font-medium text-nim-muted uppercase tracking-wide">{queue.length} queued</span>
      </div>
      <div className="prompt-queue-items flex flex-col gap-1 max-h-[30vh] overflow-y-auto">
        {queue.map((item, index) => (
          <div key={item.id} className="prompt-queue-item flex items-center gap-2 px-2 py-1.5 bg-nim-tertiary border border-nim rounded text-[13px]">
            <span className="prompt-queue-number shrink-0 w-[18px] h-[18px] flex items-center justify-center bg-nim-tertiary rounded-full text-[11px] font-medium text-nim-muted">{index + 1}</span>
            <span className="prompt-queue-text flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-nim-primary" title={item.prompt}>{item.prompt}</span>
            {item.prompt.includes('\n') && (
              <span className="prompt-queue-lines shrink-0 text-[10px] text-nim-muted bg-nim-secondary rounded px-1 py-0.5" title={`${item.prompt.split('\n\n').length} messages bundled`}>
                +{item.prompt.split('\n\n').length - 1} more
              </span>
            )}
            {item.attachments && item.attachments.length > 0 && (
              <AttachmentIndicator attachments={item.attachments} />
            )}
            {onSendNow && (
              <button
                className="prompt-queue-send-now shrink-0 w-5 h-5 flex items-center justify-center bg-transparent border-none rounded text-nim-muted cursor-pointer text-sm leading-none p-0 transition-all duration-150 hover:bg-nim-hover hover:text-nim-accent"
                onClick={() => onSendNow(item.id, item.prompt)}
                title="Interrupt and send now"
                type="button"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 1L3 9h4.5l-1 6L13 7H8.5L9 1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
            {onEdit && (
              <button
                className="prompt-queue-edit shrink-0 w-5 h-5 flex items-center justify-center bg-transparent border-none rounded text-nim-muted cursor-pointer text-sm leading-none p-0 transition-all duration-150 hover:bg-nim-hover hover:text-nim-primary"
                onClick={() => onEdit(item.id, item.prompt)}
                title="Edit this prompt"
                type="button"
              >
                &#x270E;
              </button>
            )}
            <button
              className="prompt-queue-cancel shrink-0 w-5 h-5 flex items-center justify-center bg-transparent border-none rounded text-nim-muted cursor-pointer text-lg leading-none p-0 transition-all duration-150 hover:bg-nim-hover hover:text-nim-primary"
              onClick={() => onCancel(item.id)}
              title="Cancel this prompt"
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
