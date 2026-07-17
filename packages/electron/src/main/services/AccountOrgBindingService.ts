/**
 * Local projection of the explicit personal-account -> team membership link.
 *
 * The server-authoritative copy lives in the org's TeamRoom `member_roles`
 * row. These helpers intentionally use only scalar columns so PGLite and
 * better-sqlite3 behave identically (see DATABASE.md).
 */

import { logger } from '../utils/logger';
import type { ProjectionDb } from './OrgProjectionService';

export type AccountOrgBindingSource = 'server-create' | 'server-exchange' | 'server-sync' | 'email-backfill';

export interface AccountOrgBinding {
  personalOrgId: string;
  teamOrgId: string;
  teamMemberId: string;
  source: AccountOrgBindingSource;
}

export type BindingRepairOutcome =
  | 'repaired'
  | 'no-match'
  | 'ambiguous'
  | 'already-attempted';

function nowIso(): string {
  return new Date().toISOString();
}

export async function upsertAccountOrgBinding(
  db: ProjectionDb,
  binding: AccountOrgBinding,
): Promise<void> {
  if (!binding.personalOrgId || !binding.teamOrgId || !binding.teamMemberId) {
    throw new Error('Account/org binding requires personalOrgId, teamOrgId, and teamMemberId');
  }
  const ts = nowIso();
  await db.query(
    `INSERT INTO account_org_bindings
       (personal_org_id, team_org_id, team_member_id, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (personal_org_id, team_org_id) DO UPDATE SET
       team_member_id = EXCLUDED.team_member_id,
       source = EXCLUDED.source,
       updated_at = EXCLUDED.updated_at`,
    [binding.personalOrgId, binding.teamOrgId, binding.teamMemberId, binding.source, ts],
  );
}

export async function resolveAccountOrgBinding(
  db: ProjectionDb,
  personalOrgId: string,
  teamOrgId: string,
): Promise<string | null> {
  const result = await db.query<{ team_member_id: string }>(
    `SELECT team_member_id FROM account_org_bindings
      WHERE personal_org_id = $1 AND team_org_id = $2`,
    [personalOrgId, teamOrgId],
  );
  return result.rows[0]?.team_member_id ?? null;
}

export interface ResolvedTeamOrgAccountBinding {
  personalOrgId: string;
  teamMemberId: string;
}

/**
 * Resolve the signed-in account assigned to a team org without consulting the
 * sync-account singleton. The stable ordering makes the result independent of
 * account switching if legacy data contains more than one local binding.
 */
export async function resolveTeamOrgAccountBinding(
  db: ProjectionDb,
  teamOrgId: string,
  signedInPersonalOrgIds: readonly string[],
): Promise<ResolvedTeamOrgAccountBinding | null> {
  const eligible = new Set(signedInPersonalOrgIds);
  const result = await db.query<{ personal_org_id: string; team_member_id: string }>(
    `SELECT personal_org_id, team_member_id FROM account_org_bindings
      WHERE team_org_id = $1
      ORDER BY personal_org_id ASC`,
    [teamOrgId],
  );
  const matches = result.rows.filter((row) => eligible.has(row.personal_org_id));
  if (matches.length > 1) {
    logger.main.warn('[AccountOrgBinding] Multiple signed-in accounts bind the same team org; using stable binding order', {
      teamOrgId,
      personalOrgIds: matches.map((row) => row.personal_org_id),
    });
  }
  const match = matches[0];
  return match
    ? { personalOrgId: match.personal_org_id, teamMemberId: match.team_member_id }
    : null;
}

/**
 * One-time repair for installs that predate explicit bindings.
 *
 * Email is consulted at most once per account/team pair. Exactly one roster
 * match is required; zero or multiple matches are recorded as terminal repair
 * outcomes and never create a binding. Every actual email-based attempt logs.
 */
export async function repairAccountOrgBindingFromEmail(
  db: ProjectionDb,
  personalOrgId: string,
  teamOrgId: string,
  email: string,
): Promise<{ outcome: BindingRepairOutcome; teamMemberId: string | null }> {
  const prior = await db.query<{ outcome: string }>(
    `SELECT outcome FROM account_org_binding_repairs
      WHERE personal_org_id = $1 AND team_org_id = $2`,
    [personalOrgId, teamOrgId],
  );
  if (prior.rows.length > 0) {
    return { outcome: 'already-attempted', teamMemberId: null };
  }

  const matches = await db.query<{ user_id: string }>(
    `SELECT user_id FROM org_members
      WHERE org_id = $1 AND lower(email) = lower($2)`,
    [teamOrgId, email.trim()],
  );
  const matchedCount = matches.rows.length;
  const attemptedAt = nowIso();

  if (matchedCount === 1) {
    const teamMemberId = matches.rows[0].user_id;
    await upsertAccountOrgBinding(db, {
      personalOrgId,
      teamOrgId,
      teamMemberId,
      source: 'email-backfill',
    });
    await db.query(
      `INSERT INTO account_org_binding_repairs
         (personal_org_id, team_org_id, attempted_at, outcome, matched_count)
       VALUES ($1, $2, $3, 'repaired', 1)
       ON CONFLICT (personal_org_id, team_org_id) DO NOTHING`,
      [personalOrgId, teamOrgId, attemptedAt],
    );
    logger.main.warn('[AccountOrgBinding] EMAIL BACKFILL USED for explicit account/org binding', {
      personalOrgId,
      teamOrgId,
      teamMemberId,
    });
    return { outcome: 'repaired', teamMemberId };
  }

  const outcome: BindingRepairOutcome = matchedCount === 0 ? 'no-match' : 'ambiguous';
  await db.query(
    `INSERT INTO account_org_binding_repairs
       (personal_org_id, team_org_id, attempted_at, outcome, matched_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (personal_org_id, team_org_id) DO NOTHING`,
    [personalOrgId, teamOrgId, attemptedAt, outcome, matchedCount],
  );
  logger.main.error('[AccountOrgBinding] EMAIL BACKFILL FAILED; no binding persisted', {
    personalOrgId,
    teamOrgId,
    outcome,
    matchedCount,
  });
  return { outcome, teamMemberId: null };
}
