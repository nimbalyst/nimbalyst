interface SampleSummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  totalMs: number;
  blockedP50: number;
  blockedP95: number;
  blockedMax: number;
  blockedTotalMs: number;
}

export interface LegacyDbTableRow {
  table: string;
  reads: SampleSummary;
  writes: SampleSummary;
}

export interface SqliteDbTableRow {
  table: string;
  reads: number;
  writes: number;
  totalMs: number;
  p99: number;
}

export interface NormalizedDbStats {
  totalReads: number;
  totalWrites: number;
  tableCount: number;
  legacyRows: LegacyDbTableRow[];
  sqliteRows: SqliteDbTableRow[];
}

const EMPTY_SAMPLE_SUMMARY: SampleSummary = {
  count: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  max: 0,
  totalMs: 0,
  blockedP50: 0,
  blockedP95: 0,
  blockedMax: 0,
  blockedTotalMs: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeSampleSummary(value: unknown): SampleSummary {
  if (!isRecord(value)) return EMPTY_SAMPLE_SUMMARY;
  return {
    count: toNumber(value.count),
    p50: toNumber(value.p50),
    p95: toNumber(value.p95),
    p99: toNumber(value.p99),
    max: toNumber(value.max),
    totalMs: toNumber(value.totalMs),
    blockedP50: toNumber(value.blockedP50),
    blockedP95: toNumber(value.blockedP95),
    blockedMax: toNumber(value.blockedMax),
    blockedTotalMs: toNumber(value.blockedTotalMs),
  };
}

function getLegacyRows(queryStats: unknown): LegacyDbTableRow[] {
  if (!isRecord(queryStats)) return [];

  return Object.entries(queryStats).flatMap(([table, value]) => {
    if (!isRecord(value)) return [];
    if (!('reads' in value) && !('writes' in value)) return [];
    return [{
      table,
      reads: normalizeSampleSummary(value.reads),
      writes: normalizeSampleSummary(value.writes),
    }];
  });
}

function getSqliteRows(queryStats: unknown): SqliteDbTableRow[] {
  if (!isRecord(queryStats) || !isRecord(queryStats.byTable)) return [];

  return Object.entries(queryStats.byTable).flatMap(([table, value]) => {
    if (!isRecord(value)) return [];
    return [{
      table,
      reads: toNumber(value.reads),
      writes: toNumber(value.writes),
      totalMs: toNumber(value.totalMs),
      p99: toNumber(value.p99),
    }];
  });
}

export function summarizeDatabaseQueryStats(queryStats: unknown): NormalizedDbStats {
  const legacyRows = getLegacyRows(queryStats);
  if (legacyRows.length > 0) {
    return {
      totalReads: legacyRows.reduce((sum, row) => sum + row.reads.count, 0),
      totalWrites: legacyRows.reduce((sum, row) => sum + row.writes.count, 0),
      tableCount: legacyRows.length,
      legacyRows,
      sqliteRows: [],
    };
  }

  const sqliteRows = getSqliteRows(queryStats);
  return {
    totalReads: sqliteRows.reduce((sum, row) => sum + row.reads, 0),
    totalWrites: sqliteRows.reduce((sum, row) => sum + row.writes, 0),
    tableCount: sqliteRows.length,
    legacyRows: [],
    sqliteRows,
  };
}
