import { describe, it, expect, vi } from 'vitest';
import { errorNotificationService, notificationDedupKey } from '../ErrorNotificationService';

describe('notificationDedupKey', () => {
  it('collapses a SQLite worker stall onto one key regardless of title or request', () => {
    // A stalled worker fails every queued request at once, each under whatever
    // title its caller used. Keying on title+message let a handful of those
    // through as separate toasts for what is one incident.
    const a = notificationDedupKey(
      'error',
      'Unhandled Promise Rejection',
      "Error invoking remote method 'collab-backup:content-changed': SQLite worker request 'query' timed out after 60000ms",
    );
    const b = notificationDedupKey(
      'error',
      'Failed to record document open',
      "SQLite worker request 'query' timed out after 60000ms",
    );
    expect(a).toBe(b);
  });

  it('keeps unrelated failures on distinct keys', () => {
    expect(notificationDedupKey('error', 'Save failed', 'disk full')).not.toBe(
      notificationDedupKey('error', 'Save failed', 'permission denied'),
    );
  });
});

describe('errorNotificationService.dismiss', () => {
  it('tells listeners so the on-screen toast goes away, once per notice', () => {
    // The toast list lives in React state and only learns of removals from this signal (#282).
    const dismissed = vi.fn();
    const stopListening = errorNotificationService.addDismissListener(dismissed);

    const id = errorNotificationService.showInfo('Checking', 'dismiss test notice');
    errorNotificationService.dismiss(id);
    errorNotificationService.dismiss(id);
    errorNotificationService.dismiss('not-a-real-id');

    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(dismissed).toHaveBeenCalledWith(id);
    expect(errorNotificationService.getAll().some(n => n.id === id)).toBe(false);
    stopListening();
  });
});
