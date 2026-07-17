-- Workstream A1: explicit personal-account -> team-member binding.
--
-- The server-authoritative copy lives in the org's TeamRoom Durable Object.
-- This local projection replaces email matching in the access gate. The repair
-- ledger makes the legacy email backfill a one-time, auditable operation.

CREATE TABLE IF NOT EXISTS account_org_bindings (
  personal_org_id TEXT NOT NULL,
  team_org_id     TEXT NOT NULL,
  team_member_id  TEXT NOT NULL,
  source          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (personal_org_id, team_org_id)
);

CREATE TABLE IF NOT EXISTS account_org_binding_repairs (
  personal_org_id TEXT NOT NULL,
  team_org_id     TEXT NOT NULL,
  attempted_at    TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  matched_count   INTEGER NOT NULL,
  PRIMARY KEY (personal_org_id, team_org_id)
);

CREATE INDEX IF NOT EXISTS idx_account_org_bindings_team
  ON account_org_bindings (team_org_id, team_member_id);
