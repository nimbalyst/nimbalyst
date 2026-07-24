import React, { useEffect, useState, useCallback, useRef } from 'react';
import { copyToClipboard } from '@nimbalyst/runtime';
import { errorNotificationService, type ErrorNotification } from '../../services/ErrorNotificationService';

const severityStyles = {
  error: 'border-l-[#dc3545] bg-[#fff5f5] dark:bg-[#3d1f1f]',
  warning: 'border-l-[#ffc107] bg-[#fffbf0] dark:bg-[#3d3419]',
  info: 'border-l-[#17a2b8] bg-[#f0f9ff] dark:bg-[#1a2d35]',
};

export function ErrorToastContainer() {
  const [notifications, setNotifications] = useState<ErrorNotification[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleDismiss = useCallback((id: string) => {
    // Clear any pending timer
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setNotifications(prev => prev.filter(n => n.id !== id));
    errorNotificationService.dismiss(id);
  }, []);

  const startDismissTimer = useCallback((notification: ErrorNotification) => {
    if (notification.duration && notification.duration > 0) {
      const timer = setTimeout(() => {
        handleDismiss(notification.id);
      }, notification.duration);
      timersRef.current.set(notification.id, timer);
    }
  }, [handleDismiss]);

  const pauseDismissTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const resumeDismissTimer = useCallback((notification: ErrorNotification) => {
    startDismissTimer(notification);
  }, [startDismissTimer]);

  useEffect(() => {
    // Pick up any notifications that were fired before this component mounted
    const existing = errorNotificationService.getAll();
    if (existing.length > 0) {
      setNotifications(existing);
      existing.forEach(startDismissTimer);
    }

    const unsubscribe = errorNotificationService.addListener((notification) => {
      setNotifications(prev => [...prev, notification]);
      startDismissTimer(notification);
    });

    return () => {
      unsubscribe();
      // Clean up all timers on unmount
      timersRef.current.forEach(timer => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, [startDismissTimer]);

  const handleCopyDetails = useCallback((notification: ErrorNotification) => {
    const details = `
# ${notification.title}

**Severity:** ${notification.severity}
**Time:** ${new Date(notification.timestamp).toLocaleString()}

## Message
${notification.message}

${notification.details ? `
## Details
${notification.details}
` : ''}

${notification.stack ? `
## Stack Trace
\`\`\`
${notification.stack}
\`\`\`
` : ''}

${notification.context ? `
## Context
\`\`\`json
${JSON.stringify(notification.context, null, 2)}
\`\`\`
` : ''}
`.trim();

    copyToClipboard(details);
  }, []);

  const handleActionClick = useCallback((notification: ErrorNotification) => {
    if (notification.action) {
      notification.action.onClick();
      handleDismiss(notification.id);
    }
  }, [handleDismiss]);

  if (notifications.length === 0) return null;

  return (
    <div className="error-toast-container fixed top-10 right-5 z-[10000] flex flex-col gap-3 max-w-[500px] pointer-events-none">
      {notifications.map(notification => (
        <div
          key={notification.id}
          className={`error-toast error-toast--${notification.severity} rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.15)] p-4 pointer-events-auto animate-[slideIn_0.3s_ease-out] border-l-4 ${severityStyles[notification.severity]}`}
          role="alert"
          onMouseEnter={() => pauseDismissTimer(notification.id)}
          onMouseLeave={() => resumeDismissTimer(notification)}
        >
          <div className="error-toast-header flex items-center gap-2 mb-2">
            <div className="error-toast-icon text-xl leading-none">
              {notification.severity === 'error' && '🚨'}
              {notification.severity === 'warning' && '⚠️'}
              {notification.severity === 'info' && 'ℹ️'}
            </div>
            <div className="error-toast-title flex-1 font-semibold text-sm text-[var(--nim-text)]">{notification.title}</div>
            {notification.dismissible && (
              <button
                className="error-toast-close bg-transparent border-none text-2xl leading-none cursor-pointer p-0 w-6 h-6 flex items-center justify-center text-[var(--nim-text-muted)] rounded transition-colors duration-200 hover:bg-black/5"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDismiss(notification.id);
                }}
                aria-label="Dismiss"
                type="button"
              >
                x
              </button>
            )}
          </div>

          <div className="error-toast-message text-[13px] text-[var(--nim-text)] leading-normal mb-2">{notification.message}</div>

          {(notification.action || notification.details || notification.stack || notification.context) && (
            <div className="error-toast-actions flex gap-2 mt-3">
              {notification.action && (
                <button
                  className="error-toast-action-btn bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] border border-[var(--nim-border)] px-3 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors duration-200 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border-focus)]"
                  onClick={() => handleActionClick(notification)}
                >
                  {notification.action.label}
                </button>
              )}
              {(notification.details || notification.stack || notification.context) && (
                <button
                  className="error-toast-copy-btn bg-[var(--nim-primary)] text-white border-none px-3 py-1.5 rounded text-xs cursor-pointer transition-colors duration-200 hover:bg-[var(--nim-primary-hover)]"
                  onClick={() => handleCopyDetails(notification)}
                >
                  Copy Details
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
