import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { warnMock, errorMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { main: { warn: warnMock, error: errorMock } },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  repairAccountOrgBindingFromEmail,
  resolveAccountOrgBinding,
} from '../AccountOrgBindingService';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');

describe('AccountOrgBindingService', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-account-binding-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
    await db.query(`INSERT INTO orgs (id, stytch_org_id, slug, flavor) VALUES ('team','stytch-team','team','team')`);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('applies migration 25 and performs a logged one-time unique email repair', async () => {
    await db.query(
      `INSERT INTO org_members (org_id, user_id, email, role)
       VALUES ('team','team-member','USER@example.com','member')`,
    );

    const first = await repairAccountOrgBindingFromEmail(
      db,
      'personal-org',
      'team',
      'user@example.com',
    );
    expect(first).toEqual({ outcome: 'repaired', teamMemberId: 'team-member' });
    await expect(resolveAccountOrgBinding(db, 'personal-org', 'team')).resolves.toBe('team-member');
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('EMAIL BACKFILL USED'),
      expect.objectContaining({ personalOrgId: 'personal-org', teamOrgId: 'team' }),
    );

    const second = await repairAccountOrgBindingFromEmail(
      db,
      'personal-org',
      'team',
      'user@example.com',
    );
    expect(second).toEqual({ outcome: 'already-attempted', teamMemberId: null });

    const migration = await db.query<{ version: number }>(
      `SELECT version FROM _migrations WHERE version = 25`,
    );
    expect(migration.rows).toHaveLength(1);
  });

  it('records an ambiguous repair once and never persists a guessed binding', async () => {
    await db.query(
      `INSERT INTO org_members (org_id, user_id, email, role) VALUES
       ('team','member-a','same@example.com','member'),
       ('team','member-b','same@example.com','member')`,
    );

    await expect(repairAccountOrgBindingFromEmail(
      db,
      'personal-org',
      'team',
      'same@example.com',
    )).resolves.toEqual({ outcome: 'ambiguous', teamMemberId: null });
    await expect(resolveAccountOrgBinding(db, 'personal-org', 'team')).resolves.toBeNull();
    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining('no binding persisted'),
      expect.objectContaining({ outcome: 'ambiguous', matchedCount: 2 }),
    );

    await expect(repairAccountOrgBindingFromEmail(
      db,
      'personal-org',
      'team',
      'same@example.com',
    )).resolves.toEqual({ outcome: 'already-attempted', teamMemberId: null });
    expect(errorMock).toHaveBeenCalledTimes(1);
  });
});
