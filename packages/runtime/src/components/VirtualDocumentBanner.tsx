import React from 'react';
import './VirtualDocumentBanner.css';

interface VirtualDocumentBannerProps {
  onDismiss?: () => void;
}

export function VirtualDocumentBanner({ onDismiss }: VirtualDocumentBannerProps) {
  return (
    <div className="virtual-document-banner">
      <div className="virtual-document-banner-content">
        <span className="virtual-document-banner-icon">ⓘ</span>
        <span className="virtual-document-banner-text">
          This is a read-only welcome document. Changes will not be saved.
        </span>
        {onDismiss && (
          <button
            className="virtual-document-banner-dismiss"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}