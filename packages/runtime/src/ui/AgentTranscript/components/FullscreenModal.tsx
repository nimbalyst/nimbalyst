/**
 * FullscreenModal - A portal-based modal that renders centered on the screen
 *
 * Uses createPortal to render to document.body, ensuring the modal is:
 * - Positioned relative to the viewport (not any scroll container)
 * - Properly centered on screen regardless of where it's called from
 * - Above all other content with high z-index
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface FullscreenModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Callback when the modal should close (clicking backdrop or pressing Escape) */
  onClose: () => void;
  /** Modal content */
  children: React.ReactNode;
  /** Optional className for the content container */
  contentClassName?: string;
  /** Optional aria-label for accessibility */
  ariaLabel?: string;
}

/**
 * A fullscreen modal that renders via portal to document.body.
 * Handles Escape key, backdrop clicks, and proper centering.
 */
export const FullscreenModal: React.FC<FullscreenModalProps> = ({
  isOpen,
  onClose,
  children,
  contentClassName = '',
  ariaLabel = 'Modal'
}) => {
  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const modalContent = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 cursor-pointer"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className={`relative cursor-default ${contentClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
