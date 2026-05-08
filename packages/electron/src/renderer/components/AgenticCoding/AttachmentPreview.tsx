import React, { useState, useEffect, useRef } from 'react';
import type { ChatAttachment } from '@nimbalyst/runtime';
import { getFileIcon } from '@nimbalyst/runtime';
import { nimAssetUrl } from '../../utils/assetUrl';

interface ProcessingAttachmentPreviewProps {
  filename: string;
}

/**
 * Shows a loading indicator for an attachment that is being processed (e.g., compressed).
 */
export function ProcessingAttachmentPreview({ filename }: ProcessingAttachmentPreviewProps) {
  return (
    <div className="attachment-preview attachment-preview-processing flex items-center gap-2 p-2 border border-[var(--nim-border)] rounded-md bg-[var(--nim-bg-secondary)] min-w-[200px] max-w-[250px] relative transition-colors duration-150 opacity-80">
      <div className="attachment-preview-thumbnail shrink-0 w-10 h-10 flex items-center justify-center rounded bg-[var(--nim-bg-tertiary)] overflow-hidden">
        <div className="attachment-preview-spinner w-5 h-5 border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
      </div>
      <div className="attachment-preview-info flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="attachment-preview-filename text-[13px] font-medium text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis" title={filename}>
          {filename}
        </div>
        <div className="attachment-preview-size attachment-preview-processing-text text-[11px] text-[var(--nim-text-faint)] italic">
          Processing...
        </div>
      </div>
    </div>
  );
}

interface AttachmentPreviewProps {
  attachment: ChatAttachment;
  onRemove: (attachmentId: string) => void;
  onConvertToText?: (attachment: ChatAttachment) => void;
}

export function AttachmentPreview({ attachment, onRemove, onConvertToText }: AttachmentPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Handle Escape key to close expanded image
  useEffect(() => {
    if (!isExpanded) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsExpanded(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded]);

  // Handle click outside to close context menu
  useEffect(() => {
    if (!showContextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowContextMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showContextMenu]);

  const handleThumbnailClick = () => {
    if (attachment.type === 'image') {
      setIsExpanded(true);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    // Only show context menu for document attachments (text files)
    if (attachment.type !== 'document' || !onConvertToText) return;

    e.preventDefault();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  const handleConvertToText = () => {
    setShowContextMenu(false);
    if (onConvertToText) {
      onConvertToText(attachment);
    }
  };

  return (
    <>
      <div className="attachment-preview flex items-center gap-2 p-2 border border-[var(--nim-border)] rounded-md bg-[var(--nim-bg-secondary)] min-w-[200px] max-w-[250px] relative transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]" onContextMenu={handleContextMenu}>
        <div
          className="attachment-preview-thumbnail shrink-0 w-10 h-10 flex items-center justify-center rounded bg-[var(--nim-bg-tertiary)] overflow-hidden"
          onClick={handleThumbnailClick}
          style={{ cursor: attachment.type === 'image' ? 'pointer' : attachment.type === 'document' ? 'context-menu' : 'default' }}
          title={attachment.type === 'image' ? 'Click to enlarge' : attachment.type === 'document' ? 'Right-click for options' : undefined}
        >
          {attachment.type === 'image' ? (
            <img
              src={nimAssetUrl(attachment.filepath)}
              alt={attachment.filename}
              className="attachment-preview-image w-full h-full object-cover"
            />
          ) : (
            <span className="attachment-preview-icon text-2xl text-[var(--nim-text-muted)]">
              {getFileIcon(attachment.filename, 18)}
            </span>
          )}
        </div>

      <div className="attachment-preview-info flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="attachment-preview-filename text-[13px] font-medium text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="attachment-preview-size text-[11px] text-[var(--nim-text-faint)]">
          {formatFileSize(attachment.size)}
        </div>
      </div>

      <button
        className="attachment-preview-remove shrink-0 w-5 h-5 p-0 border-none bg-transparent cursor-pointer flex items-center justify-center rounded-sm transition-colors duration-150 text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
        onClick={() => onRemove(attachment.id)}
        title="Remove attachment"
        aria-label="Remove attachment"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>

      {/* Expanded image modal */}
      {isExpanded && attachment.type === 'image' && (
        <div
          className="attachment-preview-modal-overlay fixed inset-0 bg-black/85 flex items-center justify-center z-[10000] backdrop-blur-sm"
          onClick={() => setIsExpanded(false)}
        >
          <div
            className="attachment-preview-modal relative max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="attachment-preview-modal-close absolute -top-10 right-0 w-8 h-8 p-0 border-none bg-white/10 text-white cursor-pointer flex items-center justify-center rounded transition-colors duration-150 hover:bg-white/20"
              onClick={() => setIsExpanded(false)}
              aria-label="Close"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <img
              src={nimAssetUrl(attachment.filepath)}
              alt={attachment.filename}
              className="attachment-preview-modal-image max-w-[90vw] max-h-[80vh] object-contain rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
            />
            <div className="attachment-preview-modal-caption text-white text-sm text-center py-2 px-4 bg-black/50 rounded max-w-[90vw] overflow-hidden text-ellipsis whitespace-nowrap">
              {attachment.filename}
            </div>
          </div>
        </div>
      )}

      {/* Context menu for text attachments */}
      {showContextMenu && (
        <div
          ref={contextMenuRef}
          className="attachment-context-menu bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)] py-1 min-w-[140px]"
          style={{
            position: 'fixed',
            left: contextMenuPosition.x,
            top: contextMenuPosition.y,
            zIndex: 10000
          }}
        >
          <button
            className="attachment-context-menu-item block w-full py-2 px-3 border-none bg-transparent text-[13px] text-[var(--nim-text)] text-left cursor-pointer transition-colors duration-100 hover:bg-[var(--nim-bg-hover)]"
            onClick={handleConvertToText}
          >
            Insert as text
          </button>
        </div>
      )}
    </>
  );
}
