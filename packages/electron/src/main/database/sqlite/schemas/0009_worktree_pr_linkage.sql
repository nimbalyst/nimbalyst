-- ----------------------------------------------------------------------------
-- 0009_worktree_pr_linkage
--
-- PR review panel cache. Adds:
--   * pull_requests          — list/detail cache, one row per (workspace, remote, number)
--   * pull_request_files     — per-file diff metadata (path, status, patch)
--   * pull_request_commits   — per-commit metadata (sha, message, author, time, +/-)
--   * pull_request_checks    — per-check-run metadata (name, status, conclusion)
--   * worktrees.pr_*         — nullable columns binding a worktree to a PR (1:1)
--
-- Patterns mirror 0001_initial.sql:
--   * TIMESTAMPTZ stored as TEXT (ISO-8601 via strftime('%Y-%m-%dT%H:%M:%fZ'))
--   * JSON columns stored as TEXT (defensive parse on read per DATABASE.md)
--   * Compound unique on (workspace_id, remote, number) keeps upserts idempotent
--
-- No PR row is ever written or read without an associated workspace_id, so
-- listing PRs scoped to a project remains a single-index lookup.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  remote TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0,
  author_login TEXT,
  author_avatar_url TEXT,
  head_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  mergeable TEXT,
  comments_count INTEGER NOT NULL DEFAULT 0,
  review_comments_count INTEGER NOT NULL DEFAULT 0,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  changed_files INTEGER NOT NULL DEFAULT 0,
  ci_status TEXT,
  reviewers TEXT NOT NULL DEFAULT '[]',
  labels TEXT NOT NULL DEFAULT '[]',
  raw TEXT NOT NULL,
  etag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_requests_workspace_remote_number
  ON pull_requests(workspace_id, remote, number);
CREATE INDEX IF NOT EXISTS idx_pull_requests_workspace_state
  ON pull_requests(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_pull_requests_updated
  ON pull_requests(updated_at);
CREATE INDEX IF NOT EXISTS idx_pull_requests_author
  ON pull_requests(author_login);

CREATE TABLE IF NOT EXISTS pull_request_files (
  pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  patch TEXT,
  previous_path TEXT,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (pr_id, path)
);

CREATE INDEX IF NOT EXISTS idx_pull_request_files_pr ON pull_request_files(pr_id);

CREATE TABLE IF NOT EXISTS pull_request_commits (
  pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  author_login TEXT,
  authored_at TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pr_id, sha)
);

CREATE INDEX IF NOT EXISTS idx_pull_request_commits_pr ON pull_request_commits(pr_id);

CREATE TABLE IF NOT EXISTS pull_request_checks (
  pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  details_url TEXT,
  started_at TEXT,
  completed_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (pr_id, check_name)
);

CREATE INDEX IF NOT EXISTS idx_pull_request_checks_pr ON pull_request_checks(pr_id);

-- ----------------------------------------------------------------------------
-- Worktree <-> PR linkage. One worktree may be bound to at most one PR.
-- Columns are nullable: pre-existing worktrees stay unaffected.
-- ----------------------------------------------------------------------------

ALTER TABLE worktrees ADD COLUMN pr_number INTEGER;
ALTER TABLE worktrees ADD COLUMN pr_remote TEXT;
ALTER TABLE worktrees ADD COLUMN pr_url TEXT;

CREATE INDEX IF NOT EXISTS idx_worktrees_pr_lookup
  ON worktrees(workspace_id, pr_remote, pr_number)
  WHERE pr_number IS NOT NULL;
