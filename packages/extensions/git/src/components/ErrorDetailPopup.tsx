import { useEffect, useState } from 'react';
import {
  useFloating,
  FloatingPortal,
  FloatingOverlay,
  FloatingFocusManager,
  useDismiss,
  useRole,
  useInteractions,
} from '@floating-ui/react';

interface ErrorDetailPopupProps {
  command: string;
  error: string;
  onClose: () => void;
}

const COPY_FEEDBACK_MS = 1500;

export function ErrorDetailPopup({ command, error, onClose }: ErrorDetailPopupProps) {
  const [copied, setCopied] = useState(false);

  const { refs, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });

  const dismiss = useDismiss(context, {
    outsidePress: true,
    escapeKey: true,
  });
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(error);
      setCopied(true);
    } catch {
      // ignore
    }
  };

  return (
    <FloatingPortal>
      <FloatingOverlay className="git-error-popup-overlay" lockScroll>
        <FloatingFocusManager context={context} modal>
          <div
            ref={refs.setFloating}
            className="git-error-popup"
            {...getFloatingProps()}
          >
            <div className="git-error-popup-header">
              <div className="git-error-popup-title">
                <span className="git-error-popup-label">Error</span>
                <code className="git-error-popup-command">{command}</code>
              </div>
              <div className="git-error-popup-actions">
                <button
                  type="button"
                  className="git-error-popup-btn"
                  onClick={handleCopy}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="git-error-popup-btn git-error-popup-btn--close"
                  onClick={onClose}
                  aria-label="Close"
                >
                  &times;
                </button>
              </div>
            </div>
            <pre className="git-error-popup-body">{error}</pre>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}
