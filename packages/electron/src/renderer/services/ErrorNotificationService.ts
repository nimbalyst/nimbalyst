/**
 * Global Error Notification Service
 *
 * Provides a centralized way to show errors to users instead of silent console.log failures
 */

import posthog from 'posthog-js';

export type ErrorSeverity = 'error' | 'warning' | 'info';

export interface NotificationAction {
  label: string;
  onClick: () => void;
}

export interface ErrorNotification {
  id: string;
  title: string;
  message: string;
  severity: ErrorSeverity;
  timestamp: number;
  details?: string;
  stack?: string;
  context?: Record<string, any>;
  dismissible?: boolean;
  duration?: number; // Auto-dismiss after this many ms (0 = never)
  action?: NotificationAction; // Optional action button (e.g., Undo)
}

type ErrorListener = (notification: ErrorNotification) => void;

class ErrorNotificationService {
  private listeners: Set<ErrorListener> = new Set();
  private notifications: ErrorNotification[] = [];
  private nextId = 1;
  // Deduplication: track recent error keys to suppress duplicates
  private recentErrorKeys = new Map<string, { count: number; firstSeen: number }>();
  private static DEDUP_WINDOW_MS = 5000; // Suppress identical errors within 5s

  /**
   * Register a listener for error notifications
   */
  addListener(listener: ErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Show an error notification
   */
  showError(
    title: string,
    message: string,
    options?: {
      details?: string;
      stack?: string;
      context?: Record<string, any>;
      duration?: number;
    }
  ): string {
    return this.notify({
      title,
      message,
      severity: 'error',
      ...options
    });
  }

  /**
   * Show a warning notification
   */
  showWarning(
    title: string,
    message: string,
    options?: {
      details?: string;
      duration?: number;
      action?: NotificationAction;
    }
  ): string {
    return this.notify({
      title,
      message,
      severity: 'warning',
      ...options
    });
  }

  /**
   * Show an info notification
   */
  showInfo(
    title: string,
    message: string,
    options?: {
      details?: string;
      duration?: number;
      action?: NotificationAction;
    }
  ): string {
    return this.notify({
      title,
      message,
      severity: 'info',
      duration: options?.duration ?? 5000, // Auto-dismiss info after 5s by default
      ...options
    });
  }

  /**
   * Show a notification from an Error object
   */
  showFromError(
    error: Error,
    title: string = 'An error occurred',
    context?: Record<string, any>
  ): string {
    return this.showError(title, error.message, {
      stack: error.stack,
      context
    });
  }

  /**
   * Internal notify method
   */
  private notify(options: {
    title: string;
    message: string;
    severity: ErrorSeverity;
    details?: string;
    stack?: string;
    context?: Record<string, any>;
    duration?: number;
    action?: NotificationAction;
  }): string {
    // Deduplicate: suppress identical title+message within the dedup window
    const dedupKey = `${options.severity}:${options.title}:${options.message}`;
    const now = Date.now();
    const existing = this.recentErrorKeys.get(dedupKey);
    if (existing && (now - existing.firstSeen) < ErrorNotificationService.DEDUP_WINDOW_MS) {
      existing.count++;
      // Still log to console so devs can see the repeat count
      console.debug(`[ErrorNotificationService] Suppressed duplicate (x${existing.count}): ${options.title}: ${options.message}`);
      return ''; // Suppressed
    }
    // Track this error for dedup
    this.recentErrorKeys.set(dedupKey, { count: 1, firstSeen: now });
    // Clean up old entries periodically
    if (this.recentErrorKeys.size > 50) {
      for (const [key, entry] of this.recentErrorKeys) {
        if (now - entry.firstSeen > ErrorNotificationService.DEDUP_WINDOW_MS) {
          this.recentErrorKeys.delete(key);
        }
      }
    }

    const notification: ErrorNotification = {
      id: `error-${this.nextId++}`,
      timestamp: Date.now(),
      dismissible: true,
      duration: options.duration ?? (options.severity === 'error' ? 0 : 10000),
      ...options
    };

    this.notifications.push(notification);

    // Log to console as well
    const consoleMethod = options.severity === 'error' ? console.error :
                         options.severity === 'warning' ? console.warn :
                         console.info;

    consoleMethod(`[${options.severity.toUpperCase()}] ${options.title}: ${options.message}`, {
      details: options.details,
      stack: options.stack,
      context: options.context
    });

    // Notify all listeners
    this.listeners.forEach(listener => listener(notification));

    return notification.id;
  }

  /**
   * Dismiss a notification
   */
  dismiss(id: string): void {
    this.notifications = this.notifications.filter(n => n.id !== id);
  }

  /**
   * Get all active notifications
   */
  getAll(): ErrorNotification[] {
    return [...this.notifications];
  }

  /**
   * Clear all notifications
   */
  clearAll(): void {
    this.notifications = [];
  }
}

// Singleton instance
export const errorNotificationService = new ErrorNotificationService();

/**
 * Categorize an error by its constructor name.
 * Returns a safe category that doesn't include PII.
 */
function categorizeError(error: unknown): string {
  if (error instanceof Error) {
    // Use the error constructor name (TypeError, ReferenceError, etc.)
    return error.constructor.name || 'Error';
  }
  if (typeof error === 'string') {
    return 'StringError';
  }
  if (error === null) {
    return 'NullError';
  }
  if (error === undefined) {
    return 'UndefinedError';
  }
  return 'UnknownError';
}

// Global error handler
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    const message = event.error?.message || event.message;
    const stack = event.error?.stack || '';

    // Skip errors with no meaningful message (e.g., DOM Event objects passed as errors,
    // or WebSocket errors that produce empty/undefined error events)
    if (!message || message === 'undefined' || message === 'null') {
      console.debug('[ErrorNotificationService] Ignoring error with empty message:', event.error);
      return;
    }

    // Ignore benign ResizeObserver errors from virtualization libraries (virtua)
    // This error occurs when ResizeObserver callbacks trigger layout changes that cause more resize events
    if (message === 'ResizeObserver loop completed with undelivered notifications.') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // Ignore Monaco editor's internal widget errors - these occur when disposing editors
    // while async operations (like find/replace state changes) are in progress
    if (stack.includes('_FindWidget') || stack.includes('FindReplaceState')) {
      console.debug('[ErrorNotificationService] Ignoring Monaco FindWidget error:', message);
      return;
    }

    // Track in PostHog - DO NOT include the message as it may contain PII
    posthog.capture('uncaught_error', {
      errorType: 'exception',
      errorCategory: categorizeError(event.error),
    });

    errorNotificationService.showError(
      'Uncaught Error',
      message,
      {
        stack: event.error?.stack,
        context: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        }
      }
    );
  }, { capture: true });

  window.addEventListener('unhandledrejection', (event) => {
    // Ignore Monaco editor's internal "Canceled" errors - these are benign
    // Monaco uses cancellation tokens for async operations and throws "Canceled" when disposing
    const reason = event.reason;
    const message = reason?.message || String(reason);

    if (message === 'Canceled' || message === 'Canceled: Canceled') {
      // This is a Monaco internal cancellation, not a real error
      // Prevent it from appearing in the console as an uncaught error
      event.preventDefault();
      return;
    }

    // Track in PostHog - DO NOT include the message as it may contain PII
    posthog.capture('uncaught_error', {
      errorType: 'unhandled_rejection',
      errorCategory: categorizeError(reason),
    });

    errorNotificationService.showError(
      'Unhandled Promise Rejection',
      message,
      {
        stack: reason?.stack
      }
    );
  });
}
