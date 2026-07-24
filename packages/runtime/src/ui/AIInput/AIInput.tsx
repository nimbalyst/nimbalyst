import React, { useRef, useEffect, KeyboardEvent, useState, useCallback } from 'react';
import type { ChatAttachment } from '../../ai/server/types';
import './AIInput.css';

export interface AIInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (message: string) => void;
  disabled?: boolean;
  isLoading?: boolean;
  placeholder?: string;

  // Cancel support (shows cancel button when loading)
  onCancel?: () => void;

  // Attachment support (optional)
  attachments?: ChatAttachment[];
  onAttachmentAdd?: (attachment: ChatAttachment) => void;
  onAttachmentRemove?: (attachmentId: string) => void;

  // Simple mode (for mobile)
  simpleMode?: boolean;
}

/**
 * Simplified AI input component optimized for mobile.
 * Supports:
 * - Auto-resize textarea
 * - Send button
 * - Basic attachment support
 * - Mobile-friendly keyboard handling
 */
export function AIInput({
  value,
  onChange,
  onSend,
  disabled,
  isLoading,
  placeholder = "Type your message... (Enter to send, Shift+Enter for new line)",
  onCancel,
  attachments = [],
  onAttachmentAdd,
  onAttachmentRemove,
  simpleMode = false
}: AIInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragActive, setDragActive] = useState(false);

  // Auto-resize textarea
  useEffect(() => {
    if (!textareaRef.current) return;

    const textarea = textareaRef.current;
    const rafId = requestAnimationFrame(() => {
      textarea.style.height = 'auto';
      const maxHeight = simpleMode ? 150 : 200;
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    });

    return () => cancelAnimationFrame(rafId);
  }, [value, simpleMode]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle Enter to send (Shift+Enter for new line)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) {
        onSend(value);
      }
    }
  };

  // Handle file attachment (mobile)
  const handleFileAttachment = useCallback(async (file: File) => {
    if (!onAttachmentAdd) return;

    // For mobile, we'll let the parent handle the file upload
    // since we don't have access to window.electronAPI
    console.log('[AIInput] File attachment not implemented for mobile:', file.name);
  }, [onAttachmentAdd]);

  // Drag and drop handlers (desktop only)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!onAttachmentAdd || simpleMode) return;
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, [onAttachmentAdd, simpleMode]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!onAttachmentAdd || simpleMode) return;
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      await handleFileAttachment(file);
    }
  }, [onAttachmentAdd, handleFileAttachment, simpleMode]);

  // Paste handler for images (desktop only)
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    if (!onAttachmentAdd || simpleMode) return;

    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          // Generate unique filename for pasted images
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const ext = file.type.split('/')[1] || 'png';
          const uniqueName = `pasted-image-${timestamp}.${ext}`;
          const renamedFile = new File([file], uniqueName, { type: file.type });
          await handleFileAttachment(renamedFile);
        }
      }
    }
  }, [onAttachmentAdd, handleFileAttachment, simpleMode]);

  // Handle attachment removal
  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    if (onAttachmentRemove) {
      onAttachmentRemove(attachmentId);
    }
  }, [onAttachmentRemove]);

  const handleSend = () => {
    if (value.trim() && !disabled) {
      onSend(value);
    }
  };

  return (
    <div className={`ai-input-container ${simpleMode ? 'simple-mode' : ''}`}>
      {/* Attachment preview list */}
      {attachments && attachments.length > 0 && (
        <div className="ai-input-attachments">
          {attachments.map(attachment => (
            <div key={attachment.id} className="ai-input-attachment">
              <span className="ai-input-attachment-name">{attachment.filename}</span>
              <button
                className="ai-input-attachment-remove"
                onClick={() => handleRemoveAttachment(attachment.id)}
                aria-label="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input container with drag/drop support */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`ai-input-wrapper ${dragActive ? 'drag-active' : ''}`}
      >
        <textarea
          ref={textareaRef}
          className="ai-input-field"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
        />
        {isLoading && onCancel ? (
          <button
            className="ai-input-cancel-button"
            onClick={onCancel}
            title="Cancel request"
            aria-label="Cancel request"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        ) : (
          <button
            className="ai-input-send-button"
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            title="Send message (Enter)"
            aria-label="Send message"
          >
            {isLoading ? (
              <svg className="ai-input-spinner" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="10 30" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 8L14 2L11 14L8 9L2 8Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
