import { describe, expect, it } from 'vitest';

import { summarizeDatabaseQueryStats } from '../dashboardStats';

describe('summarizeDatabaseQueryStats', () => {
  it('supports the legacy per-table read/write summary shape', () => {
    const stats = summarizeDatabaseQueryStats({
      ai_sessions: {
        reads: { count: 3, p50: 4, p95: 9, p99: 10, max: 12, totalMs: 25, blockedP50: 0, blockedP95: 0, blockedMax: 0, blockedTotalMs: 0 },
        writes: { count: 1, p50: 7, p95: 7, p99: 7, max: 7, totalMs: 7, blockedP50: 0, blockedP95: 0, blockedMax: 0, blockedTotalMs: 0 },
      },
    });

    expect(stats.totalReads).toBe(3);
    expect(stats.totalWrites).toBe(1);
    expect(stats.tableCount).toBe(1);
    expect(stats.legacyRows).toHaveLength(1);
    expect(stats.sqliteRows).toHaveLength(0);
  });

  it('supports the SQLite instrumentation snapshot shape', () => {
    const stats = summarizeDatabaseQueryStats({
      windowMs: 300000,
      byTable: {
        ai_sessions: { reads: 5, writes: 2, totalMs: 31, p99: 12 },
        history: { reads: 7, writes: 0, totalMs: 19, p99: 6 },
      },
    });

    expect(stats.totalReads).toBe(12);
    expect(stats.totalWrites).toBe(2);
    expect(stats.tableCount).toBe(2);
    expect(stats.legacyRows).toHaveLength(0);
    expect(stats.sqliteRows).toEqual([
      { table: 'ai_sessions', reads: 5, writes: 2, totalMs: 31, p99: 12 },
      { table: 'history', reads: 7, writes: 0, totalMs: 19, p99: 6 },
    ]);
  });

  it('tolerates malformed payloads without throwing', () => {
    const stats = summarizeDatabaseQueryStats({
      byTable: {
        broken: { reads: 'oops', writes: null },
      },
    });

    expect(stats.totalReads).toBe(0);
    expect(stats.totalWrites).toBe(0);
    expect(stats.tableCount).toBe(1);
    expect(stats.sqliteRows).toEqual([
      { table: 'broken', reads: 0, writes: 0, totalMs: 0, p99: 0 },
    ]);
  });
});
