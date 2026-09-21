// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { summarizeSyncStatus, type SyncStatusSnapshot } from '../syncStatusSummary';

const NOW = 1_700_000_000_000;

function snapshot(overrides: Partial<SyncStatusSnapshot> = {}): SyncStatusSnapshot {
  return {
    appConfigured: true,
    projectEnabled: true,
    connected: true,
    syncing: false,
    error: null,
    lastSyncedAt: NOW,
    ...overrides,
  };
}

describe('summarizeSyncStatus', () => {
  it('has nothing to say when the user is not signed in', () => {
    expect(summarizeSyncStatus(snapshot({ appConfigured: false }), NOW)).toBeNull();
  });

  it('reports connected state with the age of the last sync', () => {
    expect(summarizeSyncStatus(snapshot(), NOW)).toEqual({
      tone: 'ok',
      detail: 'Synced just now',
      needsAttention: false,
    });
    const detail = (lastSyncedAt: number | null) =>
      summarizeSyncStatus(snapshot({ lastSyncedAt }), NOW)?.detail;
    expect(detail(NOW - 5 * 60_000)).toBe('Synced 5m ago');
    expect(detail(NOW - 3 * 3_600_000)).toBe('Synced 3h ago');
    expect(detail(NOW - 2 * 86_400_000)).toBe('Synced 2d ago');
    // Connected but never synced must not read as "Synced null".
    expect(detail(null)).toBe('Connected');
  });

  it('reports skipped rows as an advisory while sync stays healthy', () => {
    const result = summarizeSyncStatus(snapshot({ skippedRowCount: 2 }), NOW);
    expect(result).toMatchObject({ tone: 'ok', needsAttention: false });
    expect(result?.notice).toContain('2 synced sessions');
  });

  it.each([{}, { skippedRowCount: 0 }])('omits the notice when no skipped sessions are reported (%j)', overrides => {
    expect(summarizeSyncStatus(snapshot(overrides), NOW)?.notice).toBeUndefined();
  });

  it('does not flag a project the user deliberately opted out of', () => {
    // Opting out outranks every other state: a disabled project reports its own
    // disconnection, and treating that as a fault would leave the avatar
    // permanently warning about a choice the user made.
    const off = summarizeSyncStatus(
      snapshot({ projectEnabled: false, connected: false, error: 'stale error' }),
      NOW,
    );
    expect(off).toEqual({ tone: 'idle', detail: 'Off for this project', needsAttention: false });
  });

  it('flags errors and silent disconnection, which is what the removed gutter icon did', () => {
    expect(summarizeSyncStatus(snapshot({ error: 'Token expired' }), NOW)).toEqual({
      tone: 'error',
      detail: 'Token expired',
      needsAttention: true,
    });
    expect(summarizeSyncStatus(snapshot({ connected: false }), NOW)).toEqual({
      tone: 'warning',
      detail: 'Disconnected',
      needsAttention: true,
    });
  });

  it('treats an in-flight sync as healthy, not as attention-worthy', () => {
    expect(summarizeSyncStatus(snapshot({ syncing: true, connected: false }), NOW)).toEqual({
      tone: 'ok',
      detail: 'Syncing…',
      needsAttention: false,
    });
  });
});
