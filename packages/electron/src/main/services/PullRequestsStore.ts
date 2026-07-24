/**
 * PullRequestsStore - Database CRUD for the PR review panel cache.
 *
 * Backs the `pull_requests`, `pull_request_files`, `pull_request_commits`,
 * and `pull_request_checks` tables from migration 0009. Pattern follows
 * WorktreeStore — a factory that takes the PGLite/SQLite handle and returns a
 * typed object with CRUD methods.
 *
 * The store is main-process only; the renderer reads via the `pr:list` /
 * `pr:get` / `pr:files` IPC channels.
 *
 * Dual-backend caveat: `data->'key'` sub-extraction returns a parsed object
 * on PGLite but a JSON string on SQLite. We always select whole rows and
 * defensively parse JSON columns to stay symmetric.
 */

import log from 'electron-log/main';
import { toMillis } from '../utils/timestampUtils';

const logger = log.scope('PullRequestsStore');

export interface Reviewer {
  login: string;
  state: string;
}

export interface PullRequestRow {
  id: string;
  workspaceId: string;
  remote: string;           // "owner/repo"
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown' | null;
  commentsCount: number;
  reviewCommentsCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  ciStatus: 'success' | 'failure' | 'pending' | null;
  reviewers: Reviewer[];
  labels: string[];
  raw: unknown;
  etag: string | null;
  createdAt: number;
  updatedAt: number;
  fetchedAt: number;
}

export interface PullRequestFileRow {
  prId: string;
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch: string | null;
  previousPath: string | null;
  fetchedAt: number;
}

export interface PullRequestCommitRow {
  prId: string;
  sha: string;
  message: string;
  authorLogin: string | null;
  authoredAt: number;
  additions: number;
  deletions: number;
}

export interface PullRequestCheckRow {
  prId: string;
  checkName: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  detailsUrl: string | null;
  startedAt: number | null;
  completedAt: number | null;
  fetchedAt: number;
}

export interface PullRequestListFilters {
  state?: 'open' | 'closed' | 'all';
  authorLogin?: string;
}

interface PullRequestDbRow {
  id: string;
  workspace_id: string;
  remote: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  is_draft: boolean | number;
  author_login: string | null;
  author_avatar_url: string | null;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  mergeable: string | null;
  comments_count: number;
  review_comments_count: number;
  additions: number;
  deletions: number;
  changed_files: number;
  ci_status: string | null;
  reviewers: unknown;
  labels: unknown;
  raw: unknown;
  etag: string | null;
  created_at: Date | string | number;
  updated_at: Date | string | number;
  fetched_at: Date | string | number;
}

interface PullRequestFileDbRow {
  pr_id: string;
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  previous_path: string | null;
  fetched_at: Date | string | number;
}

interface PullRequestCommitDbRow {
  pr_id: string;
  sha: string;
  message: string;
  author_login: string | null;
  authored_at: Date | string | number;
  additions: number;
  deletions: number;
}

interface PullRequestCheckDbRow {
  pr_id: string;
  check_name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  started_at: Date | string | number | null;
  completed_at: Date | string | number | null;
  fetched_at: Date | string | number;
}

type PGliteLike = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

/**
 * Defensive parse for JSONB sub-extraction (PGLite returns objects, SQLite
 * returns JSON strings). The full row select still yields a parsed value on
 * PGLite, but on SQLite the JSON column comes back as a string. Per
 * packages/electron/DATABASE.md, always wrap.
 */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    if (value.length === 0) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      logger.warn('Failed to parse JSON column, using fallback', { value });
      return fallback;
    }
  }
  return value as T;
}

function rowToPullRequest(row: PullRequestDbRow): PullRequestRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    remote: row.remote,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state as PullRequestRow['state'],
    isDraft: Boolean(row.is_draft),
    authorLogin: row.author_login,
    authorAvatarUrl: row.author_avatar_url,
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    mergeable: row.mergeable as PullRequestRow['mergeable'],
    commentsCount: row.comments_count,
    reviewCommentsCount: row.review_comments_count,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changed_files,
    ciStatus: row.ci_status as PullRequestRow['ciStatus'],
    reviewers: parseJson<Reviewer[]>(row.reviewers, []),
    labels: parseJson<string[]>(row.labels, []),
    raw: parseJson<unknown>(row.raw, null),
    etag: row.etag,
    createdAt: toMillis(row.created_at) ?? 0,
    updatedAt: toMillis(row.updated_at) ?? 0,
    fetchedAt: toMillis(row.fetched_at) ?? 0,
  };
}

function rowToFile(row: PullRequestFileDbRow): PullRequestFileRow {
  return {
    prId: row.pr_id,
    path: row.path,
    status: row.status as PullRequestFileRow['status'],
    additions: row.additions,
    deletions: row.deletions,
    patch: row.patch,
    previousPath: row.previous_path,
    fetchedAt: toMillis(row.fetched_at) ?? 0,
  };
}

function rowToCommit(row: PullRequestCommitDbRow): PullRequestCommitRow {
  return {
    prId: row.pr_id,
    sha: row.sha,
    message: row.message,
    authorLogin: row.author_login,
    authoredAt: toMillis(row.authored_at) ?? 0,
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
  };
}

function rowToCheck(row: PullRequestCheckDbRow): PullRequestCheckRow {
  return {
    prId: row.pr_id,
    checkName: row.check_name,
    status: row.status as PullRequestCheckRow['status'],
    conclusion: row.conclusion as PullRequestCheckRow['conclusion'],
    detailsUrl: row.details_url,
    startedAt: toMillis(row.started_at),
    completedAt: toMillis(row.completed_at),
    fetchedAt: toMillis(row.fetched_at) ?? 0,
  };
}

export function createPullRequestsStore(db: PGliteLike, ensureDbReady?: EnsureReadyFn) {
  const ensureReady = async (): Promise<void> => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  return {
    /**
     * Upsert a PR row. Compound unique on (workspace_id, remote, number)
     * resolves the conflict and updates every mutable column.
     */
    async upsertOne(row: PullRequestRow): Promise<void> {
      await ensureReady();

      const reviewersJson = JSON.stringify(row.reviewers ?? []);
      const labelsJson = JSON.stringify(row.labels ?? []);
      const rawJson = JSON.stringify(row.raw ?? null);

      await db.query(
        `INSERT INTO pull_requests (
          id, workspace_id, remote, number, title, body, state, is_draft,
          author_login, author_avatar_url, head_ref, head_sha, base_ref,
          mergeable, comments_count, review_comments_count, additions, deletions,
          changed_files, ci_status, reviewers, labels, raw, etag,
          created_at, updated_at, fetched_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24,
          $25, $26, $27
        )
        ON CONFLICT (workspace_id, remote, number) DO UPDATE SET
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          state = EXCLUDED.state,
          is_draft = EXCLUDED.is_draft,
          author_login = EXCLUDED.author_login,
          author_avatar_url = EXCLUDED.author_avatar_url,
          head_ref = EXCLUDED.head_ref,
          head_sha = EXCLUDED.head_sha,
          base_ref = EXCLUDED.base_ref,
          mergeable = EXCLUDED.mergeable,
          comments_count = EXCLUDED.comments_count,
          review_comments_count = EXCLUDED.review_comments_count,
          additions = EXCLUDED.additions,
          deletions = EXCLUDED.deletions,
          changed_files = EXCLUDED.changed_files,
          ci_status = EXCLUDED.ci_status,
          reviewers = EXCLUDED.reviewers,
          labels = EXCLUDED.labels,
          raw = EXCLUDED.raw,
          etag = EXCLUDED.etag,
          updated_at = EXCLUDED.updated_at,
          fetched_at = EXCLUDED.fetched_at`,
        [
          row.id,
          row.workspaceId,
          row.remote,
          row.number,
          row.title,
          row.body,
          row.state,
          row.isDraft,
          row.authorLogin,
          row.authorAvatarUrl,
          row.headRef,
          row.headSha,
          row.baseRef,
          row.mergeable,
          row.commentsCount,
          row.reviewCommentsCount,
          row.additions,
          row.deletions,
          row.changedFiles,
          row.ciStatus,
          reviewersJson,
          labelsJson,
          rawJson,
          row.etag,
          new Date(row.createdAt),
          new Date(row.updatedAt),
          new Date(row.fetchedAt),
        ],
      );
    },

    /**
     * Upsert many PRs sequentially. Caller is responsible for grouping by
     * workspace; this method does no implicit filtering.
     */
    async upsertList(rows: PullRequestRow[]): Promise<void> {
      await ensureReady();
      for (const row of rows) {
        await this.upsertOne(row);
      }
    },

    async list(workspaceId: string, filters: PullRequestListFilters = {}): Promise<PullRequestRow[]> {
      await ensureReady();

      const clauses: string[] = ['workspace_id = $1'];
      const values: unknown[] = [workspaceId];

      if (filters.state && filters.state !== 'all') {
        clauses.push(`state = $${values.length + 1}`);
        values.push(filters.state);
      }
      if (filters.authorLogin) {
        clauses.push(`author_login = $${values.length + 1}`);
        values.push(filters.authorLogin);
      }

      const sql = `
        SELECT * FROM pull_requests
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
      `;

      const { rows } = await db.query<PullRequestDbRow>(sql, values);
      return rows.map(rowToPullRequest);
    },

    async getByNumber(
      workspaceId: string,
      remote: string,
      number: number,
    ): Promise<PullRequestRow | null> {
      await ensureReady();

      const { rows } = await db.query<PullRequestDbRow>(
        `SELECT * FROM pull_requests
         WHERE workspace_id = $1 AND remote = $2 AND number = $3
         LIMIT 1`,
        [workspaceId, remote, number],
      );

      return rows.length === 0 ? null : rowToPullRequest(rows[0]);
    },

    async deleteByNumber(workspaceId: string, remote: string, number: number): Promise<void> {
      await ensureReady();
      await db.query(
        `DELETE FROM pull_requests
         WHERE workspace_id = $1 AND remote = $2 AND number = $3`,
        [workspaceId, remote, number],
      );
    },

    /**
     * Replace the file set for a PR. Used when the head_sha changes (e.g.
     * after a force-push) — the cached files for the previous sha must not
     * leak into the new commit's diff.
     */
    async replaceFiles(prId: string, files: PullRequestFileRow[]): Promise<void> {
      await ensureReady();

      await db.query('DELETE FROM pull_request_files WHERE pr_id = $1', [prId]);

      // Dedupe by PK (pr_id, path); ON CONFLICT guards a concurrent replace
      // racing the same pr_id (e.g. tab open + detail poll) from throwing a
      // unique-constraint violation.
      const seen = new Set<string>();
      for (const file of files) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        await db.query(
          `INSERT INTO pull_request_files (
            pr_id, path, status, additions, deletions, patch, previous_path, fetched_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (pr_id, path) DO NOTHING`,
          [
            file.prId,
            file.path,
            file.status,
            file.additions,
            file.deletions,
            file.patch,
            file.previousPath,
            new Date(file.fetchedAt),
          ],
        );
      }
    },

    async getFiles(prId: string): Promise<PullRequestFileRow[]> {
      await ensureReady();
      const { rows } = await db.query<PullRequestFileDbRow>(
        `SELECT * FROM pull_request_files WHERE pr_id = $1 ORDER BY path ASC`,
        [prId],
      );
      return rows.map(rowToFile);
    },

    async replaceCommits(prId: string, commits: PullRequestCommitRow[]): Promise<void> {
      await ensureReady();

      await db.query('DELETE FROM pull_request_commits WHERE pr_id = $1', [prId]);

      // Dedupe by PK (pr_id, sha); ON CONFLICT guards a concurrent replace
      // (tab open + detail poll) from a unique-constraint violation.
      const seen = new Set<string>();
      for (const commit of commits) {
        if (seen.has(commit.sha)) continue;
        seen.add(commit.sha);
        await db.query(
          `INSERT INTO pull_request_commits (
            pr_id, sha, message, author_login, authored_at, additions, deletions
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (pr_id, sha) DO NOTHING`,
          [
            commit.prId,
            commit.sha,
            commit.message,
            commit.authorLogin,
            new Date(commit.authoredAt),
            commit.additions,
            commit.deletions,
          ],
        );
      }
    },

    async getCommits(prId: string): Promise<PullRequestCommitRow[]> {
      await ensureReady();
      const { rows } = await db.query<PullRequestCommitDbRow>(
        `SELECT * FROM pull_request_commits WHERE pr_id = $1 ORDER BY authored_at ASC`,
        [prId],
      );
      return rows.map(rowToCommit);
    },

    async replaceChecks(prId: string, checks: PullRequestCheckRow[]): Promise<void> {
      await ensureReady();

      await db.query('DELETE FROM pull_request_checks WHERE pr_id = $1', [prId]);

      // Dedupe by PK (pr_id, check_name); ON CONFLICT guards a concurrent
      // replace. Check runs can legitimately repeat a name across the
      // check-runs + legacy-status endpoints, so dedupe matters here too.
      const seen = new Set<string>();
      for (const check of checks) {
        if (seen.has(check.checkName)) continue;
        seen.add(check.checkName);
        await db.query(
          `INSERT INTO pull_request_checks (
            pr_id, check_name, status, conclusion, details_url,
            started_at, completed_at, fetched_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (pr_id, check_name) DO NOTHING`,
          [
            check.prId,
            check.checkName,
            check.status,
            check.conclusion,
            check.detailsUrl,
            check.startedAt != null ? new Date(check.startedAt) : null,
            check.completedAt != null ? new Date(check.completedAt) : null,
            new Date(check.fetchedAt),
          ],
        );
      }
    },

    async getChecks(prId: string): Promise<PullRequestCheckRow[]> {
      await ensureReady();
      const { rows } = await db.query<PullRequestCheckDbRow>(
        `SELECT * FROM pull_request_checks WHERE pr_id = $1 ORDER BY check_name ASC`,
        [prId],
      );
      return rows.map(rowToCheck);
    },
  };
}

export type PullRequestsStore = ReturnType<typeof createPullRequestsStore>;
